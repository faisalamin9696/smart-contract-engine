import type { Logger } from '../logger';
import { nullLogger } from '../logger';
import type { OpResult } from './opParser';
import type { RawBlock } from './rpc';
import { applyUndo } from '../state/stateTxn';
import type { EngineStore } from '../state/store';
import type { BlockRecord, EngineEvent } from '../types/domain';

/** An applied block plus its parsed operations — the redo half of the buffer. */
export interface AppliedBlock {
  record: BlockRecord;
  ops: OpResult[];
}

export interface ReorgOptions {
  /** Rolling undo/redo buffer depth (default 30 blocks). */
  bufferDepth: number;
  failOnDeepFork: boolean;
  logger?: Logger;
}

export interface ReorgResolution {
  status: 'no-fork' | 'rolled-back' | 'too-deep';
  /** Common ancestor height after the rollback (undefined when the fork was too deep). */
  ancestor?: number;
  /** Blocks removed from the head of our chain, newest first. */
  removed: { height: number; blockId: string }[];
  /** Blocks parked in the redo buffer (re-appliable if the original chain wins). */
  redone: number;
}

export class DeepForkError extends Error {
  constructor(
    readonly depth: number,
    readonly limit: number,
  ) {
    super(
      `chain re-org of depth ${depth} exceeds the ${limit}-block undo buffer; manual state resync required`,
    );
    this.name = 'DeepForkError';
  }
}

interface RedoEntry {
  record: BlockRecord;
  ops: OpResult[];
}

/**
 * Micro-fork (re-org) manager.
 *
 * Maintains the rolling undo/redo buffer:
 *  - **undo**: per-block before-images persisted in the store allow any of the last
 *    `bufferDepth` blocks to be reversed exactly;
 *  - **redo**: the parsed operations of popped blocks are retained so that, if the
 *    original chain wins the fork, those blocks can be re-applied without refetching.
 *
 * Detection: a block whose `previous` no longer matches our stored tip, or a tip whose
 * `block_id` no longer exists on the network, means our view diverged. The common
 * ancestor is found by walking down (at most `bufferDepth` heights) until a stored block
 * id matches the network's — block ids are content hashes, so a match is definitive.
 */
export class ReorgHandler {
  private readonly redo: RedoEntry[] = [];
  private readonly log: Logger;

  constructor(
    private readonly store: EngineStore,
    private readonly rpc: { getBlock(height: number): Promise<RawBlock | null> },
    private readonly opts: ReorgOptions,
  ) {
    this.log = opts.logger ?? nullLogger;
  }

  get bufferDepth(): number {
    return this.opts.bufferDepth;
  }

  get redoSize(): number {
    return this.redo.length;
  }

  /** Parks a freshly applied block in the rolling redo buffer. */
  rememberApplied(applied: AppliedBlock): void {
    this.redo.push({ record: applied.record, ops: applied.ops });
    while (this.redo.length > this.opts.bufferDepth) this.redo.shift();
  }

  /** Returns the cached operations for a block that reappears after a fork-back. */
  takeRedo(height: number, blockId: string): OpResult[] | null {
    const entry = this.redo.find((e) => e.record.height === height && e.record.blockId === blockId);
    return entry ? entry.ops : null;
  }

  clear(): void {
    this.redo.length = 0;
  }

  /**
   * Finds the highest height <= `startHeight` where our stored block id still matches the
   * network, then reverses everything above it.
   */
  async resolve(startHeight: number): Promise<ReorgResolution> {
    const last = await this.store.getBlock(startHeight);
    if (!last) return { status: 'no-fork', removed: [], redone: 0 };

    const minAncestor = Math.max(0, startHeight - this.opts.bufferDepth);
    let ancestorHeight: number | null = null;

    for (let height = startHeight; height > minAncestor; height--) {
      const stored = await this.store.getBlock(height);
      if (!stored) continue;
      const remote = await this.rpc.getBlock(height);
      if (remote && remote.block_id === stored.blockId) {
        ancestorHeight = height;
        break;
      }
    }

    if (ancestorHeight === null) {
      const depth = startHeight - minAncestor;
      this.log.error('re-org deeper than undo buffer', { startHeight, limit: this.opts.bufferDepth });
      if (this.opts.failOnDeepFork) throw new DeepForkError(depth, this.opts.bufferDepth);
      return { status: 'too-deep', removed: [], redone: 0 };
    }

    const removed: { height: number; blockId: string }[] = [];
    const popped: RedoEntry[] = [];

    await this.store.transaction(async (tx) => {
      await tx.acquireIndexLock();
      for (let height = startHeight; height > ancestorHeight; height--) {
        const journal = await tx.getJournal(height);
        if (!journal) {
          throw new DeepForkError(startHeight - ancestorHeight, this.opts.bufferDepth);
        }
        await applyUndo(tx, journal);
        const record = await tx.getBlock(height);
        if (record) {
          removed.push({ height: record.height, blockId: record.blockId });
          popped.push({
            record,
            ops: this.redo.find((e) => e.record.height === height)?.ops ?? [],
          });
        }
      }
      await tx.deleteLogsFrom(ancestorHeight + 1);
      await tx.deleteJournalFrom(ancestorHeight + 1);
      await tx.deleteBlocksFrom(ancestorHeight + 1);
    });

    // Popped blocks are parked (newest first) so a fork-back can re-apply them.
    for (let i = popped.length - 1; i >= 0; i--) this.redo.push(popped[i]);
    while (this.redo.length > this.opts.bufferDepth) this.redo.shift();

    this.log.warn('re-org resolved', {
      ancestor: ancestorHeight,
      removed: removed.length,
      redoBuffer: this.redo.length,
    });

    return { status: 'rolled-back', ancestor: ancestorHeight, removed, redone: popped.length };
  }

  /** Events describing a resolution (published after the rollback transaction commits). */
  eventsFor(resolution: ReorgResolution, timestamp: string): EngineEvent[] {
    if (resolution.status !== 'rolled-back') return [];
    return [
      {
        type: 'REORG_DETECTED',
        block: resolution.ancestor ?? 0,
        timestamp,
        data: { removed: resolution.removed.length },
      },
      {
        type: 'REORG_APPLIED',
        block: resolution.ancestor ?? 0,
        timestamp,
        data: {
          ancestor: resolution.ancestor ?? 0,
          removed: resolution.removed.length,
          redoBuffer: resolution.redone,
        },
      },
    ];
  }
}
