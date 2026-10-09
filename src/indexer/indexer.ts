import { BlockStreamer, sleep } from '../chain/blockStreamer';
import { parseBlock, type OpResult } from '../chain/opParser';
import { DeepForkError, ReorgHandler, type AppliedBlock, type ReorgResolution } from '../chain/reorg';
import { type RawBlock, type SteemRpc } from '../chain/rpc';
import { StateTxn } from '../state/stateTxn';
import type { EngineStore } from '../state/store';
import type { BlockRecord, EngineEvent } from '../types/domain';
import { executeOp } from '../vm/executor';
import type { Sandbox } from '../vm/sandbox';
import { AsyncMutex } from '../utils/mutex';
import type { Logger } from '../logger';
import { nullLogger } from '../logger';
import { EngineEventBus } from './events';

export interface IndexerOptions {
  pollIntervalMs: number;
  undoBufferDepth: number;
  opId: string;
  startBlockHeight: number | null;
  failOnDeepFork: boolean;
}

export interface IndexerStats {
  blocksApplied: number;
  blocksRolledBack: number;
  opsApplied: number;
  opsFailed: number;
  reorgs: number;
  lastBlockAt: string | null;
  consecutiveFailures: number;
}

export type StepOutcome =
  | { kind: 'idle'; headHeight: number }
  | { kind: 'missing'; height: number; headHeight: number }
  | { kind: 'applied'; height: number; headHeight: number; blockId: string; applied: number; failed: number }
  | { kind: 'reorg'; resolution: ReorgResolution; headHeight: number }
  | { kind: 'error'; error: Error; headHeight: number };

/**
 * Ingestion orchestrator.
 *
 * Guarantees:
 *  - strictly sequential, gap-free block application (single mutex + Postgres advisory
 *    lock, so two workers can never process the same height);
 *  - a block is applied atomically: state mutations, undo journal, transaction logs and
 *    the block cursor commit together or not at all;
 *  - divergence is detected *before* applying anything new (previous-hash check, plus a
 *    tip re-check while idle) and resolved through the rolling undo/redo buffer;
 *  - events are published only after the block transaction commits.
 */
export class Indexer {
  private readonly mutex = new AsyncMutex();
  private readonly streamer: BlockStreamer;
  readonly reorg: ReorgHandler;
  private readonly log: Logger;
  private running = false;
  private abort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private headHeight = 0;

  readonly stats: IndexerStats = {
    blocksApplied: 0,
    blocksRolledBack: 0,
    opsApplied: 0,
    opsFailed: 0,
    reorgs: 0,
    lastBlockAt: null,
    consecutiveFailures: 0,
  };

  constructor(
    private readonly store: EngineStore,
    private readonly rpc: SteemRpc,
    private readonly sandbox: Sandbox,
    private readonly bus: EngineEventBus,
    private readonly opts: IndexerOptions,
    private readonly logger: Logger = nullLogger,
  ) {
    this.log = logger.child({ component: 'indexer' });
    this.streamer = new BlockStreamer(rpc, {
      pollIntervalMs: opts.pollIntervalMs,
      logger: this.log,
    });
    this.reorg = new ReorgHandler(store, rpc, {
      bufferDepth: opts.undoBufferDepth,
      failOnDeepFork: opts.failOnDeepFork,
      logger: this.log,
    });
  }

  status(): Record<string, unknown> {
    return {
      running: this.running,
      headHeight: this.headHeight,
      sandbox: this.sandbox.provider,
      // Self-identification: which custom_json namespace this instance consumes.
      // The API never lets you guess whether you're talking to mainnet
      // (sce-mainnet1) or a testnet (sce-testnet1).
      opId: this.opts.opId,
      buffer: { undoDepth: this.opts.undoBufferDepth, redoSize: this.reorg.redoSize },
      stats: { ...this.stats },
    };
  }

  async cursor(): Promise<{ height: number; blockId: string } | null> {
    const block = await this.store.getLatestBlock();
    return block ? { height: block.height, blockId: block.blockId } : null;
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.log.info('indexer started', {
      opId: this.opts.opId,
      pollIntervalMs: this.opts.pollIntervalMs,
      sandbox: this.sandbox.provider,
    });
    this.loopPromise = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      let outcome: StepOutcome;
      try {
        outcome = await this.step();
        this.stats.consecutiveFailures = 0;
      } catch (err) {
        const error = err as Error;
        if (error instanceof DeepForkError) {
          this.log.error('ingestion halted: re-org deeper than the undo buffer', { error: error.message });
          this.bus.publish([{ type: 'ENGINE_HALTED', block: 0, timestamp: new Date().toISOString(), data: { reason: error.message } }]);
          this.running = false;
          break;
        }
        this.stats.consecutiveFailures += 1;
        this.log.error('indexer step failed', {
          error: error.message,
          consecutive: this.stats.consecutiveFailures,
        });
        // Transient failures (DB blip, RPC outage, a hot deploy) must self-heal without a
        // redeploy: normal pacing for the first few attempts, then a hard backoff — but
        // never a permanent park. Only DeepForkError above stops ingestion, because that
        // one is a safety condition state cannot be reconstructed past the undo buffer.
        if (this.stats.consecutiveFailures === 10) {
          this.log.error('indexer degraded: too many consecutive failures — backing off to 60s', {
            consecutive: this.stats.consecutiveFailures,
          });
        }
        const backoffMs =
          this.stats.consecutiveFailures >= 10 ? 60_000 : this.opts.pollIntervalMs;
        await sleep(backoffMs, signal);
        continue;
      }

      const draining =
        (outcome.kind === 'applied' && outcome.headHeight > outcome.height) ||
        outcome.kind === 'reorg';
      if (!draining) await sleep(this.opts.pollIntervalMs, signal);
    }
  }

  /**
   * One ingestion step. Exposed for tests and for manual operations; the background loop
   * simply calls it repeatedly.
   */
  async step(): Promise<StepOutcome> {
    return this.mutex.runExclusive(async () => this.stepLocked());
  }

  /** Drains the chain up to the current head (bounded), useful for tests and catch-up. */
  async catchUp(maxSteps = 10_000): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      const outcome = await this.step();
      if (outcome.kind === 'idle' || outcome.kind === 'error') return;
      if (outcome.kind === 'applied' && outcome.headHeight <= outcome.height) return;
    }
  }

  private async stepLocked(): Promise<StepOutcome> {
    const last = await this.store.getLatestBlock();
    const head = await this.rpc.getHead();
    this.headHeight = head.height;

    if (!last) {
      const target = this.opts.startBlockHeight ?? head.height;
      if (head.height < target) return { kind: 'idle', headHeight: head.height };
      const block = await this.rpc.getBlock(target);
      if (!block) return { kind: 'missing', height: target, headHeight: head.height };
      const applied = await this.applyBlock(target, block);
      return {
        kind: 'applied',
        height: target,
        headHeight: head.height,
        blockId: block.block_id,
        ...applied,
      };
    }

    // Remote node behind our cursor: nothing to do (never interpret as a fork).
    if (head.height < last.height) return { kind: 'idle', headHeight: head.height };

    // Fully caught up: make sure our tip still exists on the network.
    if (head.height === last.height) {
      const remote = await this.rpc.getBlock(last.height);
      if (!remote) return { kind: 'idle', headHeight: head.height };
      if (remote.block_id !== last.blockId) {
        return this.resolveFork(last.height, head.height);
      }
      return { kind: 'idle', headHeight: head.height };
    }

    const nextHeight = last.height + 1;
    const block = await this.rpc.getBlock(nextHeight);
    if (!block) return { kind: 'missing', height: nextHeight, headHeight: head.height };

    // Primary divergence check: linkage to the block we already applied.
    if (block.previous !== last.blockId) {
      return this.resolveFork(last.height, head.height);
    }

    const applied = await this.applyBlock(nextHeight, block);
    return {
      kind: 'applied',
      height: nextHeight,
      headHeight: head.height,
      blockId: block.block_id,
      ...applied,
    };
  }

  private async resolveFork(height: number, headHeight: number): Promise<StepOutcome> {
    this.log.warn('fork detected', { height, headHeight });
    this.bus.publish([{ type: 'REORG_DETECTED', block: height, timestamp: new Date().toISOString() }]);
    const resolution = await this.reorg.resolve(height);
    if (resolution.status === 'rolled-back') {
      this.stats.reorgs += 1;
      this.stats.blocksRolledBack += resolution.removed.length;
      this.bus.publish(this.reorg.eventsFor(resolution, new Date().toISOString()));
    }
    return { kind: 'reorg', resolution, headHeight };
  }

  private async applyBlock(height: number, block: RawBlock): Promise<{ applied: number; failed: number }> {
    const header = {
      height,
      blockId: block.block_id,
      previous: block.previous,
      timestamp: block.timestamp,
    };

    // Redo path: a block that reappears after a fork-back reuses its parsed operations.
    const cached = this.reorg.takeRedo(height, block.block_id);
    const ops: OpResult[] = cached ?? parseBlock(block, this.opts.opId).ops;

    const events: EngineEvent[] = [];
    let applied = 0;
    let failed = 0;

    const record: BlockRecord = await this.store.transaction(async (tx) => {
      // Cross-process lock: guarantees a single block processor per chain segment.
      await tx.acquireIndexLock();
      const txn = new StateTxn(tx);

      for (const op of ops) {
        const outcome = await executeOp({ store: tx, sandbox: this.sandbox, txn, block: header, op });
        events.push(...outcome.events);
        if (outcome.applied) applied += 1;
        else failed += 1;
      }

      const blockRecord: BlockRecord = {
        height,
        blockId: block.block_id,
        previous: block.previous,
        timestamp: block.timestamp,
        txCount: block.transactions?.length ?? 0,
        opCount: ops.filter((op) => op.ok).length,
        appliedAt: new Date().toISOString(),
      };

      await tx.putBlock(blockRecord);
      await tx.putJournal(height, txn.entries);
      await tx.pruneJournal(Math.max(1, height - this.opts.undoBufferDepth + 1));
      return blockRecord;
    });

    this.reorg.rememberApplied({ record, ops });

    this.stats.blocksApplied += 1;
    this.stats.opsApplied += applied;
    this.stats.opsFailed += failed;
    this.stats.lastBlockAt = record.appliedAt;

    events.push({
      type: 'BLOCK_APPLIED',
      block: height,
      blockId: block.block_id,
      timestamp: block.timestamp,
      data: { applied, failed, txs: block.transactions?.length ?? 0 },
    });
    this.bus.publish(events);

    this.log.debug('block applied', { height, blockId: block.block_id, applied, failed });
    return { applied, failed };
  }
}
