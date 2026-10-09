import { Client } from '@steempro/dsteem';
import type { Logger } from '../logger';
import { nullLogger } from '../logger';
import { fingerprint } from '../utils/canonical';

export type SteemOperation = [string, Record<string, unknown>];

export interface RawTransaction {
  operations: SteemOperation[];
  [key: string]: unknown;
}

export interface RawBlock {
  previous: string;
  timestamp: string;
  block_id: string;
  witness: string;
  transaction_merkle_root: string;
  transaction_ids?: string[];
  transactions: RawTransaction[];
  extensions?: unknown[];
}

export interface HeadInfo {
  height: number;
  /** ISO timestamp of the current head block. */
  timestamp: string;
}

/** Minimal chain access surface consumed by the indexer (mockable in tests). */
export interface SteemRpc {
  getHead(): Promise<HeadInfo>;
  getBlock(height: number): Promise<RawBlock | null>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface FailoverOptions {
  timeoutMs?: number;
  /** How long a failing endpoint is taken out of rotation. */
  cooldownMs?: number;
  logger?: Logger;
  /** Injected for tests. */
  clientFactory?: (url: string) => Pick<Client, 'call'>;
  /**
   * Blocks within this many heights of the known head are cross-checked against at
   * least one other endpoint before being applied (0 = disabled). Deep-history sync
   * is exempt by construction (those heights sit far below the head).
   */
  quorumDepth?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** A witnessed head poll older than this no longer vouches for quorum checks. */
const QUORUM_HEAD_FRESH_MS = 15_000;

/**
 * Deterministic fingerprint of every consensus-relevant field a `get_block` response
 * can carry. Two honest endpoints serving the same height must produce the identical
 * fingerprint; ANY difference (header, ids, ordering, operation bodies) is a split
 * view and must not be applied before a third opinion resolves it.
 */
export function blockFingerprint(block: RawBlock): string {
  return fingerprint({
    block_id: block.block_id,
    previous: block.previous,
    timestamp: block.timestamp,
    witness: block.witness,
    transaction_merkle_root: block.transaction_merkle_root,
    transaction_ids: block.transaction_ids ?? null,
    transactions: block.transactions,
    extensions: block.extensions ?? null,
  });
}

interface EndpointState {
  url: string;
  client: Pick<Client, 'call'>;
  consecutiveFailures: number;
  cooldownUntil: number;
  lastError: string | null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RpcError(`${label} timed out after ${ms}ms`, 'TIMEOUT')), ms);
        // Never keep the process alive purely for a timeout timer.
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Failover-aware Steem JSON-RPC client.
 *
 * Endpoints are tried in rotation; a failing node is put on cooldown (with exponential
 * back-off) instead of being hammered on every call. All requests carry a hard timeout
 * so a hung node can never stall block ingestion.
 */
export class FailoverRpc implements SteemRpc {
  private readonly endpoints: EndpointState[];
  private preferred = 0;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly log: Logger;
  private readonly factory: (url: string) => Pick<Client, 'call'>;
  private readonly quorumDepth: number;
  private readonly now: () => number;
  /** Most recent head height this client observed (set by getHead — the indexer polls it every cycle). */
  private lastHead: { height: number; at: number } | null = null;

  constructor(endpoints: string[], options: FailoverOptions = {}) {
    if (endpoints.length === 0) throw new Error('at least one RPC endpoint is required');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.log = options.logger ?? nullLogger;
    this.factory = options.clientFactory ?? ((url) => new Client(url, { timeout: this.timeoutMs }));
    this.quorumDepth = options.quorumDepth ?? 0;
    this.now = options.now ?? Date.now;
    this.endpoints = endpoints.map((url) => ({
      url,
      client: this.factory(url),
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastError: null,
    }));
  }

  get endpointsSnapshot(): { url: string; failures: number; coolingDown: boolean; lastError: string | null }[] {
    const now = Date.now();
    return this.endpoints.map((e) => ({
      url: e.url,
      failures: e.consecutiveFailures,
      coolingDown: e.cooldownUntil > now,
      lastError: e.lastError,
    }));
  }

  private rotation(): EndpointState[] {
    const now = Date.now();
    const available = this.endpoints.filter((e) => e.cooldownUntil <= now);
    const pool = available.length > 0 ? available : this.endpoints;
    const out: EndpointState[] = [];
    for (let i = 0; i < pool.length; i++) {
      out.push(pool[(this.preferred + i) % pool.length]);
    }
    return out;
  }

  private markSuccess(endpoint: EndpointState): void {
    if (endpoint.consecutiveFailures > 0) {
      this.log.info('rpc endpoint recovered', {
        endpoint: endpoint.url,
        afterFailures: endpoint.consecutiveFailures,
        lastError: endpoint.lastError,
      });
    }
    endpoint.consecutiveFailures = 0;
    endpoint.cooldownUntil = 0;
    endpoint.lastError = null;
    this.preferred = this.endpoints.indexOf(endpoint);
  }

  private markFailure(endpoint: EndpointState, err: unknown, call: string): void {
    endpoint.consecutiveFailures += 1;
    const message = err instanceof Error ? err.message : String(err);
    endpoint.lastError = message;
    const backoff = Math.min(this.cooldownMs * 2 ** (endpoint.consecutiveFailures - 1), 5 * 60_000);
    endpoint.cooldownUntil = Date.now() + backoff;
    this.log.warn('rpc endpoint failed', {
      endpoint: endpoint.url,
      call,
      failures: endpoint.consecutiveFailures,
      cooldownMs: backoff,
      error: message,
    });
  }

  async request<T>(api: string, method: string, params?: unknown): Promise<T> {
    const { value } = await this.requestFrom<T>(api, method, params);
    return value;
  }

  /** Like {@link request}, but also reports which endpoint served the answer. */
  private async requestFrom<T>(
    api: string,
    method: string,
    params?: unknown,
    labelSuffix = '',
  ): Promise<{ value: T; index: number }> {
    const attempts = this.rotation();
    let lastError: unknown = null;
    for (const endpoint of attempts) {
      try {
        const result = (await withTimeout(
          endpoint.client.call(api, method, params),
          this.timeoutMs,
          `${api}.${method}${labelSuffix}`,
        )) as T;
        this.markSuccess(endpoint);
        return { value: result, index: this.endpoints.indexOf(endpoint) };
      } catch (err) {
        this.markFailure(endpoint, err, `${api}.${method}${labelSuffix}`);
        lastError = err;
      }
    }
    throw new RpcError(
      `all RPC endpoints failed for ${api}.${method}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      'RPC_UNAVAILABLE',
    );
  }

  async getHead(): Promise<HeadInfo> {
    const props = await this.request<{
      head_block_number: number;
      time: string;
    }>('condenser_api', 'get_dynamic_global_properties');
    if (typeof props?.head_block_number !== 'number') {
      throw new RpcError('malformed get_dynamic_global_properties response', 'BAD_RESPONSE');
    }
    this.lastHead = { height: props.head_block_number, at: this.now() };
    return { height: props.head_block_number, timestamp: props.time };
  }

  async getBlock(height: number): Promise<RawBlock | null> {
    const { value: block, index } = await this.requestFrom<RawBlock | null>('condenser_api', 'get_block', [height]);
    if (block == null) return null;
    if (
      typeof block.block_id !== 'string' ||
      typeof block.previous !== 'string' ||
      typeof block.timestamp !== 'string' ||
      typeof block.transaction_merkle_root !== 'string'
    ) {
      // A malformed payload is as good as a lie: rotate this endpoint out.
      this.markFailure(
        this.endpoints[index],
        new RpcError(`malformed block response at height ${height}`, 'BAD_RESPONSE'),
        `get_block#${height}`,
      );
      throw new RpcError(`malformed block response at height ${height}`, 'BAD_RESPONSE');
    }
    return await this.quorumVerify(height, block, index);
  }

  /* ------------------------------------------------------- quorum verification */

  private quorumEnabledFor(height: number): boolean {
    if (this.quorumDepth <= 0 || this.endpoints.length < 2) return false;
    const head = this.lastHead;
    if (head === null || this.now() - head.at > QUORUM_HEAD_FRESH_MS) return false;
    // Deep-history sync is exempt: those heights are beyond the head window.
    return height >= head.height - this.quorumDepth;
  }

  /**
   * Witness order for cross-checks: healthy endpoints first, then cooling ones —
   * a cooldown throttles request RATE, it must not strip an endpoint of its standing
   * as a witness (an endpoint that just contradicted us may itself be cooling down).
   */
  private witnessOrder(exclude: number[]): number[] {
    const healthy = this.rotation().map((e) => this.endpoints.indexOf(e));
    const cooling = this.endpoints.map((_, i) => i).filter((i) => !healthy.includes(i));
    return [...healthy, ...cooling].filter((i) => !exclude.includes(i));
  }

  private async callWitness<T>(
    index: number,
    api: string,
    method: string,
    params: unknown,
    height: number,
  ): Promise<{ ok: true; value: T | null } | { ok: false }> {
    const endpoint = this.endpoints[index];
    try {
      const value = (await withTimeout(
        endpoint.client.call(api, method, params),
        this.timeoutMs,
        `${api}.${method} (witness)`,
      )) as T;
      return { ok: true, value };
    } catch (err) {
      // Transport-level failure is not testimony — mark the endpoint down and move on.
      this.markFailure(endpoint, err, `${method}#${height} (witness)`);
      return { ok: false };
    }
  }

  /** True when the witness endpoint is simply behind the requested height (not contradicting us). */
  private async witnessIsBehind(index: number, height: number): Promise<boolean> {
    const res = await this.callWitness<{ head_block_number?: number }>(
      index,
      'condenser_api',
      'get_dynamic_global_properties',
      [],
      height,
    );
    if (!res.ok || res.value === null || typeof res.value.head_block_number !== 'number') return true;
    return res.value.head_block_number < height;
  }

  private disagree(height: number, ...indices: number[]): never {
    for (const index of indices) {
      this.markFailure(
        this.endpoints[index],
        new RpcError(`endpoints disagree on block ${height}`, 'QUORUM_DISAGREE'),
        `get_block#${height}`,
      );
    }
    throw new RpcError(
      `RPC endpoints disagree on the contents of block ${height} — refusing to apply an unverified block`,
      'QUORUM_DISAGREE',
    );
  }

  /**
   * Cross-endpoint verification: the primary answer must be corroborated by a second
   * endpoint within {@link quorumDepth} of the head. Agreement returns immediately;
   * disagreement pulls a third opinion (majority wins, dissenters are marked down);
   * an unresolvable split throws {@link RpcError} `QUORUM_DISAGREE` so the indexer
   * stalls loudly instead of applying a block one endpoint may have fabricated.
   */
  private async quorumVerify(height: number, primary: RawBlock, primaryIndex: number): Promise<RawBlock> {
    if (!this.quorumEnabledFor(height)) return primary;
    const expected = blockFingerprint(primary);
    const order = this.witnessOrder([primaryIndex]);
    const first = order[0];
    if (first === undefined) return primary;

    type Verdict = { fp: string; block: RawBlock | null };
    const verdictFor = async (index: number): Promise<Verdict | null> => {
      const res = await this.callWitness<RawBlock | null>(index, 'condenser_api', 'get_block', [height], height);
      if (!res.ok) return null; // transport failure — no testimony either way
      const block = res.value;
      if (block === null) {
        // Distinguish "still syncing" from "claims this height does not exist".
        if (await this.witnessIsBehind(index, height)) return null;
        return { fp: 'missing', block: null };
      }
      if (
        typeof block.block_id !== 'string' ||
        typeof block.previous !== 'string' ||
        typeof block.timestamp !== 'string' ||
        typeof block.transaction_merkle_root !== 'string'
      ) {
        this.markFailure(this.endpoints[index], new RpcError('malformed witness block', 'BAD_RESPONSE'), 'get_block (witness)');
        return null;
      }
      return { fp: blockFingerprint(block), block };
    };

    const w1 = await verdictFor(first);
    if (w1 === null) return primary; // no usable testimony — primary stands (already logged)
    if (w1.fp === expected) {
      this.markSuccess(this.endpoints[first]);
      return primary;
    }

    // Disagreement: ask a third endpoint before trusting anyone.
    const second = order[1];
    if (second === undefined) return this.disagree(height, primaryIndex, first);

    const w2 = await verdictFor(second);
    if (w2 === null) return this.disagree(height, primaryIndex, first);

    if (w2.fp === expected) {
      // Majority = primary + second → the first witness was the outlier.
      this.markFailure(
        this.endpoints[first],
        new RpcError(`divergent view of block ${height}`, 'QUORUM_MISMATCH'),
        `get_block#${height}`,
      );
      this.log.warn('rpc endpoint served a divergent block', {
        endpoint: this.endpoints[first].url,
        height,
        expected,
        actual: w1.fp,
      });
      this.markSuccess(this.endpoints[second]);
      return primary;
    }
    if (w2.fp === w1.fp && w1.block !== null) {
      // Majority = the two witnesses → the primary was the outlier; take their view.
      this.markFailure(
        this.endpoints[primaryIndex],
        new RpcError(`divergent view of block ${height}`, 'QUORUM_MISMATCH'),
        `get_block#${height}`,
      );
      this.log.warn('primary rpc endpoint served a divergent block — taking witness view', {
        endpoint: this.endpoints[primaryIndex].url,
        height,
        expected,
        actual: w2.fp,
      });
      this.markSuccess(this.endpoints[first]);
      this.markSuccess(this.endpoints[second]);
      return w1.block;
    }
    return this.disagree(height, primaryIndex, first, second);
  }
}
