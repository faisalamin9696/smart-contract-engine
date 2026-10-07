import type { Logger } from '../logger';
import { nullLogger } from '../logger';
import type { SteemRpc } from './rpc';

export interface StreamOptions {
  /** Cadence used when the engine is fully caught up with the head (Steem: 3s). */
  pollIntervalMs: number;
  /** Abort signal support so shutdown is prompt. */
  logger?: Logger;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Sequential block streamer.
 *
 * Yields strictly increasing heights with no gaps: `from`, `from+1`, ... A poll delay of
 * `pollIntervalMs` applies only while the engine is at the head of the chain; during
 * initial sync / catch-up the stream keeps draining without artificial throttling (RPC
 * health checks still bound the rate).
 *
 * The consumer owns the cursor: on a re-org it stops the generator and starts a new one
 * at the rewind height.
 */
export class BlockStreamer {
  constructor(
    private readonly rpc: SteemRpc,
    private readonly opts: StreamOptions,
  ) {}

  private get log(): Logger {
    return this.opts.logger ?? nullLogger;
  }

  async *heights(from: number, signal?: AbortSignal): AsyncGenerator<number, void, void> {
    if (from < 1) throw new Error('block heights start at 1');
    let next = from;
    while (!signal?.aborted) {
      let headHeight: number;
      try {
        ({ height: headHeight } = await this.rpc.getHead());
      } catch (err) {
        this.log.warn('head poll failed, retrying', { error: (err as Error).message });
        await sleep(this.opts.pollIntervalMs, signal);
        continue;
      }
      if (headHeight < next) {
        // Caught up (or ahead of a node that is still syncing): wait for production.
        await sleep(this.opts.pollIntervalMs, signal);
        continue;
      }
      yield next;
      next += 1;
    }
  }
}
