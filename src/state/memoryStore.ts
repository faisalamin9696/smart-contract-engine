import {
  BalanceSchema,
  CollectionSchema,
  InstanceSchema,
  MarketOrderSchema,
  PARAM_KEY,
  TokenSchema,
  genesisParam,
  type Balance,
  type BlockRecord,
  type Collection,
  type EntityKind,
  type Instance,
  type JsonValue,
  type JournalEntry,
  type MarketOrder,
  type Token,
  type TransactionLogRecord,
} from '../types/domain';
import type {
  BalanceFilter,
  CountQuery,
  EngineStore,
  ListBalancesQuery,
  ListInstancesQuery,
  ListLogsQuery,
  ListOrdersQuery,
  ListTokensQuery,
} from './store';
import { EMPTY_JOURNAL_ENTITY, EMPTY_JOURNAL_KEY } from './store';

const ENTITIES: EntityKind[] = [
  'collection',
  'instance',
  'account',
  'order',
  'token',
  'balance',
  'param',
  'meta',
];

interface Snapshot {
  kv: Record<string, [string, JsonValue][]>;
  blocks: [number, BlockRecord][];
  journals: [number, JournalEntry[]][];
  logs: TransactionLogRecord[];
}

/**
 * In-memory {@link EngineStore}.
 *
 * Used by unit/integration tests and by `STORAGE=memory` demo runs. It implements the
 * exact same semantics as the Prisma-backed store (including transactional rollback via
 * snapshot/restore), so fork-replay tests exercise real production logic.
 */
export class MemoryStore implements EngineStore {
  private readonly kv: Record<EntityKind, Map<string, JsonValue>> = {
    collection: new Map(),
    instance: new Map(),
    account: new Map(),
    order: new Map(),
    token: new Map(),
    balance: new Map(),
    param: new Map(),
    meta: new Map(),
  };
  private blocks = new Map<number, BlockRecord>();
  private journals = new Map<number, JournalEntry[]>();
  private logs: TransactionLogRecord[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor() {
    // Mirror migration 0003: a migrated database always has the genesis fee row, so
    // memory-mode stores must too (the VM reads it on every fee-bearing action).
    this.kv.param.set(PARAM_KEY, genesisParam());
  }

  async get(entity: EntityKind, key: string): Promise<JsonValue | null> {
    return this.kv[entity].get(key) ?? null;
  }

  async put(entity: EntityKind, key: string, value: JsonValue): Promise<void> {
    this.assertOpen();
    this.kv[entity].set(key, value);
  }

  async delete(entity: EntityKind, key: string): Promise<void> {
    this.assertOpen();
    this.kv[entity].delete(key);
  }

  // ---- indexed read models -------------------------------------------------

  async listCollections(limit: number, offset: number): Promise<Collection[]> {
    return [...this.kv.collection.entries()]
      .map(([, v]) => CollectionSchema.parse(v))
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .slice(offset, offset + limit);
  }

  async listInstances(q: ListInstancesQuery): Promise<Instance[]> {
    let rows = [...this.kv.instance.entries()].map(([, v]) => InstanceSchema.parse(v));
    if (q.owner) rows = rows.filter((r) => r.owner === q.owner);
    if (q.symbol) rows = rows.filter((r) => r.symbol === q.symbol);
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.seq - b.seq);
    return rows.slice(q.offset, q.offset + q.limit);
  }

  async countInstances(q: CountQuery): Promise<number> {
    let count = 0;
    for (const raw of this.kv.instance.values()) {
      const row = InstanceSchema.parse(raw);
      if (q.owner && row.owner !== q.owner) continue;
      if (q.symbol && row.symbol !== q.symbol) continue;
      count += 1;
    }
    return count;
  }

  async listOrders(q: ListOrdersQuery): Promise<MarketOrder[]> {
    let rows = [...this.kv.order.entries()].map(([, v]) => MarketOrderSchema.parse(v));
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    if (q.symbol) rows = rows.filter((r) => r.symbol === q.symbol);
    if (q.seller) rows = rows.filter((r) => r.seller === q.seller);
    rows.sort((a, b) => a.createdAtBlock - b.createdAtBlock || a.id.localeCompare(b.id));
    if (q.status === 'OPEN') rows = rows.reverse();
    return rows.slice(q.offset, q.offset + q.limit);
  }

  async countOrders(q: CountQuery): Promise<number> {
    let count = 0;
    for (const raw of this.kv.order.values()) {
      const row = MarketOrderSchema.parse(raw);
      if (q.symbol && row.symbol !== q.symbol) continue;
      count += 1;
    }
    return count;
  }

  async listTokens(q: ListTokensQuery): Promise<Token[]> {
    let rows = [...this.kv.token.entries()].map(([, v]) => TokenSchema.parse(v));
    if (q.issuer) rows = rows.filter((r) => r.issuer === q.issuer);
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return rows.slice(q.offset, q.offset + q.limit);
  }

  async listBalances(q: ListBalancesQuery): Promise<Balance[]> {
    let rows = [...this.kv.balance.entries()].map(([, v]) => BalanceSchema.parse(v));
    if (q.account) rows = rows.filter((r) => r.account === q.account);
    if (q.symbol) rows = rows.filter((r) => r.symbol === q.symbol);
    rows.sort((a, b) => a.account.localeCompare(b.account) || a.symbol.localeCompare(b.symbol));
    return rows.slice(q.offset, q.offset + q.limit);
  }

  async countBalances(q: BalanceFilter): Promise<number> {
    let count = 0;
    for (const raw of this.kv.balance.values()) {
      const row = BalanceSchema.parse(raw);
      if (q.account && row.account !== q.account) continue;
      if (q.symbol && row.symbol !== q.symbol) continue;
      count += 1;
    }
    return count;
  }

  async listLogs(q: ListLogsQuery): Promise<TransactionLogRecord[]> {
    let rows = this.logs.slice();
    if (q.actor) rows = rows.filter((r) => r.actor === q.actor);
    if (q.instanceId) rows = rows.filter((r) => r.instanceId === q.instanceId);
    if (q.symbol) rows = rows.filter((r) => r.symbol === q.symbol);
    if (q.height !== undefined) rows = rows.filter((r) => r.height === q.height);
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    rows.sort((a, b) => b.height - a.height || a.txId.localeCompare(b.txId) || a.opIndex - b.opIndex);
    return rows.slice(q.offset, q.offset + q.limit);
  }

  // ---- append-only bookkeeping --------------------------------------------

  async putBlock(block: BlockRecord): Promise<void> {
    this.assertOpen();
    this.blocks.set(block.height, block);
  }

  async getBlock(height: number): Promise<BlockRecord | null> {
    return this.blocks.get(height) ?? null;
  }

  async getLatestBlock(): Promise<BlockRecord | null> {
    const heights = [...this.blocks.keys()];
    if (heights.length === 0) return null;
    const latest = Math.max(...heights);
    return this.blocks.get(latest) ?? null;
  }

  async deleteBlocksFrom(height: number): Promise<void> {
    this.assertOpen();
    for (const key of [...this.blocks.keys()]) if (key >= height) this.blocks.delete(key);
  }

  async putJournal(height: number, entries: JournalEntry[]): Promise<void> {
    this.assertOpen();
    if (entries.length === 0) {
      // Empty block => sentinel entry, byte-identical to PrismaStateStore's row
      // (see EMPTY_JOURNAL_KEY in store.ts): getJournal must never return null
      // for a height that WAS journaled.
      this.journals.set(height, [
        { seq: 0, entity: EMPTY_JOURNAL_ENTITY, key: EMPTY_JOURNAL_KEY, before: null },
      ]);
      return;
    }
    this.journals.set(height, entries.map((e, i) => ({ ...e, seq: i })));
  }

  async getJournal(height: number): Promise<JournalEntry[] | null> {
    return this.journals.get(height) ?? null;
  }

  async deleteJournalFrom(height: number): Promise<void> {
    this.assertOpen();
    for (const key of [...this.journals.keys()]) if (key >= height) this.journals.delete(key);
  }

  async pruneJournal(keepFromHeight: number): Promise<void> {
    this.assertOpen();
    for (const key of [...this.journals.keys()]) if (key < keepFromHeight) this.journals.delete(key);
  }

  async putLog(log: TransactionLogRecord): Promise<void> {
    this.assertOpen();
    const idx = this.logs.findIndex((l) => l.id === log.id);
    if (idx >= 0) this.logs[idx] = log;
    else this.logs.push(log);
  }

  async deleteLogsFrom(height: number): Promise<void> {
    this.assertOpen();
    this.logs = this.logs.filter((l) => l.height < height);
  }

  // ---- concurrency + transactions ------------------------------------------

  async acquireIndexLock(): Promise<void> {
    // In-process transactions are serialised in transaction(); nothing else to do here.
  }

  async transaction<T>(fn: (tx: EngineStore) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const snapshot = this.snapshot();
      try {
        return await fn(this);
      } catch (err) {
        this.restore(snapshot);
        throw err;
      }
    };
    const result = this.lock.then(run, run);
    this.lock = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('store is closed');
  }

  /** Full state dump (test/diagnostics helper): entity -> key -> value. */
  dump(): Record<string, Record<string, JsonValue>> {
    const out: Record<string, Record<string, JsonValue>> = {};
    for (const entity of ENTITIES) {
      out[entity] = {};
      for (const [key, value] of this.kv[entity].entries()) out[entity][key] = value;
    }
    return out;
  }

  private snapshot(): Snapshot {
    const kv: Record<string, [string, JsonValue][]> = {};
    for (const entity of ENTITIES) kv[entity] = [...this.kv[entity].entries()];
    return structuredClone({
      kv,
      blocks: [...this.blocks.entries()],
      journals: [...this.journals.entries()],
      logs: this.logs,
    });
  }

  private restore(snapshot: Snapshot): void {
    for (const entity of ENTITIES) {
      this.kv[entity] = new Map(snapshot.kv[entity] as [string, JsonValue][]);
    }
    this.blocks = new Map(snapshot.blocks);
    this.journals = new Map(snapshot.journals);
    this.logs = snapshot.logs;
  }
}
