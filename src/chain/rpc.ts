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

/** The transport surface FailoverRpc needs — one method, trivially mockable. */
export interface RpcCaller {
  call(api: string, method: string, params?: unknown): Promise<unknown>;
}

/**
 * Dependency-free JSON-RPC caller speaking the appbase `call` envelope Steem
 * nodes accept:
 *
 *   {"id":"0","jsonrpc":"2.0","method":"call","params":[<api>,<method>,<params>]}
 *
 * (Byte-compatible with the transport this replaced — same envelope, same
 * error propagation — minus the third-party dependency tree.) One attempt per
 * call: rotation, cooldowns and timeouts are FailoverRpc's job; the AbortController
 * here just guarantees a hung socket never outlives `timeoutMs`.
 */
export function createJsonRpcCaller(url: string, timeoutMs: number): RpcCaller {
  return {
    async call(api: string, method: string, params?: unknown): Promise<unknown> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': 'sce-engine/1.0',
          },
          body: JSON.stringify({ id: '0', jsonrpc: '2.0', method: 'call', params: [api, method, params ?? []] }),
          signal: controller.signal,
        });

        const text = await response.text();
        let payload: {
          jsonrpc?: unknown;
          result?: unknown;
          error?: { code?: number; message?: string };
        } | null = null;
        try {
          payload = JSON.parse(text);
        } catch {
          /* not JSON — handled below */
        }

        if (payload !== null && payload.jsonrpc === '2.0') {
          if (payload.error) {
            // FC-style error: message already carries the node's explanation.
            throw new RpcError(
              payload.error.message ?? `rpc error (code ${payload.error.code ?? '?'}) from ${url}`,
              'RPC_ERROR',
            );
          }
          return payload.result;
        }
        if (!response.ok) throw new RpcError(`HTTP ${response.status} from ${url}`, 'HTTP_ERROR');
        throw new RpcError(`malformed rpc response from ${url} (no jsonrpc envelope)`, 'BAD_RESPONSE');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Endpoint selection policy for the next primary request when no schedule window
 * pins the load (see {@link RpcScheduleWindow}):
 *
 *  - `rotate` (default) — round-robin across healthy endpoints, so steady-state
 *    request load is divided evenly over the configured list instead of pinning
 *    every call to one node;
 *  - `sticky` — always start at the last endpoint that answered (classic
 *    primary-with-failover behaviour).
 *
 * Either way a failing endpoint is taken out of rotation with backoff and the
 * request walks the remaining candidates, so automatic failover holds in both modes.
 */
export type RpcStrategy = 'rotate' | 'sticky';

/** One `STEEM_RPC_SCHEDULE` window: while the clock is inside it, all load prefers `url`. */
export interface RpcScheduleWindow {
  /** Inclusive start: minutes since 00:00 UTC (0..1439). */
  startMin: number;
  /** Exclusive end: minutes since 00:00 UTC (1..1440 — `1440` = 24:00). `endMin < startMin` wraps past midnight. */
  endMin: number;
  /** Endpoint to pin — validated at config load to be one of the configured endpoints. */
  url: string;
}

export interface FailoverOptions {
  timeoutMs?: number;
  /** How long a failing endpoint is taken out of rotation. */
  cooldownMs?: number;
  logger?: Logger;
  /** Injected for tests. */
  clientFactory?: (url: string) => RpcCaller;
  /** Endpoint selection policy (default `rotate` — round-robin load division). */
  strategy?: RpcStrategy;
  /** Time windows pinning all load to one endpoint (default: none). Failover still applies inside a window. */
  schedule?: readonly RpcScheduleWindow[];
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
  client: RpcCaller;
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
  /** Last endpoint that answered — the start of rotation in `sticky` mode. */
  private preferred = 0;
  /** Round-robin cursor: where the next policy-driven request starts (schedule pins leave it alone). */
  private rrCursor = 0;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly log: Logger;
  private readonly factory: (url: string) => RpcCaller;
  private readonly quorumDepth: number;
  private readonly now: () => number;
  private readonly strategy: RpcStrategy;
  private readonly schedule: readonly RpcScheduleWindow[];
  /** Most recent head height this client observed (set by getHead — the indexer polls it every cycle). */
  private lastHead: { height: number; at: number } | null = null;

  constructor(endpoints: string[], options: FailoverOptions = {}) {
    if (endpoints.length === 0) throw new Error('at least one RPC endpoint is required');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.log = options.logger ?? nullLogger;
    this.factory = options.clientFactory ?? ((url) => createJsonRpcCaller(url, this.timeoutMs));
    this.quorumDepth = options.quorumDepth ?? 0;
    this.now = options.now ?? Date.now;
    this.strategy = options.strategy ?? 'rotate';
    this.schedule = options.schedule ?? [];
    this.endpoints = endpoints.map((url) => ({
      url,
      client: this.factory(url),
      consecutiveFailures: 0,
      cooldownUntil: 0,
      lastError: null,
    }));
  }

  get endpointsSnapshot(): { url: string; failures: number; coolingDown: boolean; lastError: string | null }[] {
    const now = this.now();
    return this.endpoints.map((e) => ({
      url: e.url,
      failures: e.consecutiveFailures,
      coolingDown: e.cooldownUntil > now,
      lastError: e.lastError,
    }));
  }

  /** Minutes since midnight UTC at the injected clock's current time. */
  private minutesNow(): number {
    const d = new Date(this.now());
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  /**
   * Index of the endpoint the active schedule window pins to, or -1 (no pin).
   * A pinned endpoint that is currently cooling down does not pin — a window's whole
   * point is that its load lands somewhere, and the regular policy below then picks
   * a healthy endpoint (the pinned one is retried once its cooldown expires, so the
   * window re-forms automatically).
   */
  private scheduledIndex(): number {
    if (this.schedule.length === 0) return -1;
    const m = this.minutesNow();
    for (const window of this.schedule) {
      const inWindow =
        window.startMin < window.endMin
          ? m >= window.startMin && m < window.endMin
          : m >= window.startMin || m < window.endMin;
      if (!inWindow) continue;
      const index = this.endpoints.findIndex((e) => e.url === window.url);
      if (index >= 0 && this.endpoints[index].cooldownUntil <= this.now()) return index;
    }
    return -1;
  }

  /** Where the active strategy would start the next request (no schedule applied). */
  private policyStart(): number {
    return this.strategy === 'sticky' ? this.preferred : this.rrCursor;
  }

  /** Index the next primary request starts at: schedule pin first, then the strategy. */
  private currentStart(): number {
    const pin = this.scheduledIndex();
    return pin >= 0 ? pin : this.policyStart();
  }

  /**
   * Candidates for a request that must start at `start`: healthy endpoints first
   * (every endpoint when all are cooling — total failure still walks the whole list),
   * rotated so the first element is `start` itself, or the next healthy endpoint
   * at-or-after `start` when `start` is cooling down.
   */
  private orderFrom(start: number): EndpointState[] {
    const now = this.now();
    const available = this.endpoints.filter((e) => e.cooldownUntil <= now);
    const pool = available.length > 0 ? available : this.endpoints;
    let base = 0;
    for (let offset = 0; offset < this.endpoints.length; offset += 1) {
      const position = pool.indexOf(this.endpoints[(start + offset) % this.endpoints.length]);
      if (position >= 0) {
        base = position;
        break;
      }
    }
    const out: EndpointState[] = [];
    for (let i = 0; i < pool.length; i += 1) {
      out.push(pool[(base + i) % pool.length]);
    }
    return out;
  }

  private rotation(): EndpointState[] {
    return this.orderFrom(this.currentStart());
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
    if (this.strategy === 'rotate') {
      // Hand the next request to the endpoint after the one that just served — that
      // is what divides steady-state load across the healthy set (orderFrom skips
      // cooling members, so a degraded pool stays evenly spread too).
      this.rrCursor = (this.preferred + 1) % this.endpoints.length;
    }
  }

  private markFailure(endpoint: EndpointState, err: unknown, call: string): void {
    endpoint.consecutiveFailures += 1;
    const message = err instanceof Error ? err.message : String(err);
    endpoint.lastError = message;
    const backoff = Math.min(this.cooldownMs * 2 ** (endpoint.consecutiveFailures - 1), 5 * 60_000);
    endpoint.cooldownUntil = this.now() + backoff;
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
    const attempts = this.orderFrom(this.currentStart());
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
    if (block == null) {
      // A negative answer is consensus-relevant testimony, not a free success.
      // Inside the quorum window a witness must corroborate that the height is
      // genuinely missing before the indexer may treat it as such; a peer that
      // denies an existing block is rotated out like any other liar. (requestFrom
      // already markSuccess'd the null-er — without this corroboration one peer's
      // bare null could steer the reorg ancestor walk into a false fail-closed
      // halt, or pin itself preferred and stall the tip check forever.)
      if (this.quorumEnabledFor(height)) {
        const order = this.witnessOrder([index]);
        const first = order[0];
        if (first !== undefined) {
          const verdict = await this.witnessVerdict(first, height);
          if (verdict !== null && verdict.block !== null) {
            // A witness holds the block: the null-er denied an existing height.
            this.markFailure(
              this.endpoints[index],
              new RpcError(`endpoint denied existing block ${height}`, 'QUORUM_NULL_DISAGREE'),
              `get_block#${height}`,
            );
            this.log.warn('rpc endpoint denied an existing block', {
              endpoint: this.endpoints[index].url,
              height,
            });
            return await this.quorumVerify(height, verdict.block, first);
          }
          if (verdict !== null && verdict.fp === 'missing') {
            // Independent, non-lagging agreement that the height does not exist.
            this.markSuccess(this.endpoints[first]);
            return null;
          }
          // No usable testimony (witness behind or transport-failed): the negative
          // answer stands as before — witness failures were already logged.
        }
      }
      return null;
    }
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
   * Canonical fingerprint of a peer-supplied block, or null when the body is not
   * canonical JSON (a fractional, over-wide, or non-finite number anywhere — the
   * throw lives in blockFingerprint -> canonical.normalize). A canonicalisation
   * failure is peer misbehaviour, not a transient error: callers must treat null
   * exactly like any other malformed payload and mark the serving endpoint down,
   * so one hostile peer cannot re-serve the same unpenalised throw on every retry
   * while `preferred` keeps selecting it (the historical permanent ingestion wedge).
   */
  private safeFingerprint(block: RawBlock): string | null {
    try {
      return blockFingerprint(block);
    } catch {
      return null;
    }
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

  /**
   * One witness's testimony for a height: the fingerprint (cross-checkable) of its
   * block, `missing` when a non-lagging witness says the height does not exist, or
   * null when the witness could not testify (transport failure, lagging head,
   * malformed or non-canonical body — each already logged/penalised here).
   */
  private async witnessVerdict(
    index: number,
    height: number,
  ): Promise<{ fp: string; block: RawBlock | null } | null> {
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
    const fp = this.safeFingerprint(block);
    if (fp === null) {
      this.markFailure(
        this.endpoints[index],
        new RpcError('non-canonical witness block', 'BAD_RESPONSE'),
        'get_block (witness)',
      );
      return null;
    }
    return { fp, block };
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
   * A non-canonical primary body is penalised (BAD_RESPONSE) before verification so
   * failover advances instead of repeating an unpenalised canonicalisation throw.
   */
  private async quorumVerify(height: number, primary: RawBlock, primaryIndex: number): Promise<RawBlock> {
    if (!this.quorumEnabledFor(height)) return primary;
    const expected = this.safeFingerprint(primary);
    if (expected === null) {
      this.markFailure(
        this.endpoints[primaryIndex],
        new RpcError(`non-canonical block response at height ${height}`, 'BAD_RESPONSE'),
        `get_block#${height}`,
      );
      throw new RpcError(`non-canonical block response at height ${height}`, 'BAD_RESPONSE');
    }
    const order = this.witnessOrder([primaryIndex]);
    const first = order[0];
    if (first === undefined) return primary;

    const w1 = await this.witnessVerdict(first, height);
    if (w1 === null) return primary; // no usable testimony — primary stands (already logged)
    if (w1.fp === expected) {
      this.markSuccess(this.endpoints[first]);
      return primary;
    }

    // Disagreement: ask a third endpoint before trusting anyone.
    const second = order[1];
    if (second === undefined) return this.disagree(height, primaryIndex, first);

    const w2 = await this.witnessVerdict(second, height);
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
