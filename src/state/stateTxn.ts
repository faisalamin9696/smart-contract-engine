import { deepEqual } from '../utils/canonical';
import type { EntityKind, JournalEntry, JsonValue, Mutation, StateSnapshot } from '../types/domain';
import { entityKey } from './store';
import type { EngineStore } from './store';

export class GuardError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GuardError';
  }
}

/**
 * Journaled write-set for one block.
 *
 * Applying a mutation list happens in two phases so a guard violation can never leave a
 * half-written operation behind:
 *
 *  1. **verify + record** — for every mutation the store's current value must match what
 *     the sandbox was shown (`readSet`). Writing a key that was never read is rejected
 *     outright, which makes "create without read" safe (derived ids) while still
 *     preventing the sandbox from clobbering state it never observed;
 *  2. **commit** — perform the writes in order.
 *
 * Each mutation records a **before image**; those images are the undo journal used by the
 * micro-fork handler (applied newest-first to reverse a block).
 */
export class StateTxn {
  private readonly journal: JournalEntry[] = [];

  constructor(private readonly store: EngineStore) {}

  get entries(): JournalEntry[] {
    return this.journal.slice();
  }

  get writeCount(): number {
    return this.journal.length;
  }

  async apply(mutations: readonly Mutation[], readSet: StateSnapshot): Promise<void> {
    const planned: Mutation[] = [];
    const startIndex = this.journal.length;

    // Phase 1: verify read/write integrity and capture before images.
    try {
      for (const mutation of mutations) {
        const key = entityKey(mutation.entity, mutation.key);
        const actual = await this.store.get(mutation.entity, mutation.key);
        const snapshotValue = (readSet[mutation.entity] as Record<string, JsonValue | null>)[
          mutation.key
        ];

        if (snapshotValue === undefined) {
          if (actual !== null) {
            throw new GuardError(
              'GUARD_UNREAD_WRITE',
              `sandbox tried to overwrite ${key} without reading it first`,
            );
          }
        } else if (!deepEqual(actual, snapshotValue)) {
          throw new GuardError(
            'GUARD_STALE_READ',
            `sandbox wrote ${key} based on a value it was not shown (lost update detected)`,
          );
        }

        this.journal.push({
          seq: this.journal.length,
          entity: mutation.entity,
          key: mutation.key,
          before: actual,
        });
        planned.push(mutation);
      }
    } catch (err) {
      // Nothing was written during verification — drop the tentative journal entries.
      this.journal.length = startIndex;
      throw err;
    }

    // Phase 2: write in order (chained writes inside one op keep their relative order).
    try {
      for (const mutation of planned) {
        const value = mutation.value as unknown as JsonValue | null;
        if (value === null) await this.store.delete(mutation.entity, mutation.key);
        else await this.store.put(mutation.entity, mutation.key, value);
      }
    } catch (err) {
      // Storage failure: unwind everything this call recorded so the caller can fail the
      // single operation without corrupting the block.
      await this.rollbackFrom(startIndex);
      throw err;
    }
  }

  /** Reverts recorded mutations (newest first) — used on mid-block failures. */
  async rollbackFrom(index: number): Promise<void> {
    for (let i = this.journal.length - 1; i >= index; i--) {
      const entry = this.journal[i];
      if (entry.before === null) await this.store.delete(entry.entity as EntityKind, entry.key);
      else await this.store.put(entry.entity as EntityKind, entry.key, entry.before);
    }
    this.journal.length = Math.max(index, 0);
  }

  async rollbackAll(): Promise<void> {
    await this.rollbackFrom(0);
  }
}

/** Applies an undo journal (newest first) — the inverse of {@link StateTxn.apply}. */
export async function applyUndo(store: EngineStore, entries: readonly JournalEntry[]): Promise<void> {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.before === null) await store.delete(entry.entity as EntityKind, entry.key);
    else await store.put(entry.entity as EntityKind, entry.key, entry.before);
  }
}
