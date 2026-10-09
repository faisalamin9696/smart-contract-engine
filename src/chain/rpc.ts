import { Client } from '@steempro/dsteem';
import type { Logger } from '../logger';
import { nullLogger } from '../logger';

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

  constructor(endpoints: string[], options: FailoverOptions = {}) {
    if (endpoints.length === 0) throw new Error('at least one RPC endpoint is required');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.log = options.logger ?? nullLogger;
    this.factory = options.clientFactory ?? ((url) => new Client(url, { timeout: this.timeoutMs }));
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
    const attempts = this.rotation();
    let lastError: unknown = null;
    for (const endpoint of attempts) {
      try {
        const result = (await withTimeout(
          endpoint.client.call(api, method, params),
          this.timeoutMs,
          `${api}.${method}`,
        )) as T;
        this.markSuccess(endpoint);
        return result;
      } catch (err) {
        this.markFailure(endpoint, err, `${api}.${method}`);
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
    return { height: props.head_block_number, timestamp: props.time };
  }

  async getBlock(height: number): Promise<RawBlock | null> {
    const block = await this.request<RawBlock | null>('condenser_api', 'get_block', [height]);
    if (block == null) return null;
    if (typeof block.block_id !== 'string' || typeof block.previous !== 'string') {
      throw new RpcError(`malformed block response at height ${height}`, 'BAD_RESPONSE');
    }
    return block;
  }
}
