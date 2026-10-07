import {
  AccountSchema,
  CollectionSchema,
  InstanceSchema,
  MarketOrderSchema,
  type Account,
  type BlockRecord,
  type Collection,
  type EntityKind,
  type Instance,
  type JsonValue,
  type JournalEntry,
  type MarketOrder,
  type OrderStatus,
  type TransactionLogRecord,
  type TxStatus,
} from '../types/domain';

export interface ListInstancesQuery {
  owner?: string;
  symbol?: string;
  limit: number;
  offset: number;
}

export interface ListOrdersQuery {
  status?: OrderStatus;
  symbol?: string;
  seller?: string;
  limit: number;
  offset: number;
}

export interface ListLogsQuery {
  actor?: string;
  instanceId?: string;
  symbol?: string;
  height?: number;
  status?: TxStatus;
  limit: number;
  offset: number;
}

export interface CountQuery {
  owner?: string;
  symbol?: string;
}

/**
 * Persistence port of the engine.
 *
 * Two responsibilities:
 *  1. a generic key/value partition (`get`/`put`/`delete`) covering all *mutable* state —
 *     every write goes through the journaling layer so it can be rolled back on a fork;
 *  2. append-only bookkeeping (blocks, undo journal, transaction logs) plus indexed
 *     read models used by the APIs.
 *
 * `transaction()` gives block application atomicity: either the whole block (state
 * mutations + journal + logs + block cursor) commits, or nothing does.
 */
export interface EngineStore {
  get(entity: EntityKind, key: string): Promise<JsonValue | null>;
  put(entity: EntityKind, key: string, value: JsonValue): Promise<void>;
  delete(entity: EntityKind, key: string): Promise<void>;

  listCollections(limit: number, offset: number): Promise<Collection[]>;
  listInstances(q: ListInstancesQuery): Promise<Instance[]>;
  countInstances(q: CountQuery): Promise<number>;
  listOrders(q: ListOrdersQuery): Promise<MarketOrder[]>;
  countOrders(q: CountQuery): Promise<number>;
  listLogs(q: ListLogsQuery): Promise<TransactionLogRecord[]>;

  putBlock(block: BlockRecord): Promise<void>;
  getBlock(height: number): Promise<BlockRecord | null>;
  getLatestBlock(): Promise<BlockRecord | null>;
  deleteBlocksFrom(height: number): Promise<void>;

  putJournal(height: number, entries: JournalEntry[]): Promise<void>;
  getJournal(height: number): Promise<JournalEntry[] | null>;
  deleteJournalFrom(height: number): Promise<void>;
  /** Drops undo records older than the rolling buffer. */
  pruneJournal(keepFromHeight: number): Promise<void>;

  putLog(log: TransactionLogRecord): Promise<void>;
  deleteLogsFrom(height: number): Promise<void>;

  /** Serialises block processing across processes (Postgres advisory lock). */
  acquireIndexLock(): Promise<void>;

  transaction<T>(fn: (tx: EngineStore) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Memoises entity reads for the lifetime of a single prefetch pass. */
export class ReadCache {
  private readonly cache = new Map<string, JsonValue | null>();
  constructor(private readonly store: EngineStore) {}

  async get(entity: EntityKind, key: string): Promise<JsonValue | null> {
    const cacheKey = `${entity}:${key}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) ?? null;
    const value = await this.store.get(entity, key);
    this.cache.set(cacheKey, value);
    return value;
  }
}

export async function getCollection(store: EngineStore, symbol: string): Promise<Collection | null> {
  const raw = await store.get('collection', symbol);
  return raw === null ? null : CollectionSchema.parse(raw);
}

/**
 * Resolves an instance from its global reference `<SYMBOL>:<id>`, or from a bare wiki
 * token id when the owning symbol is supplied (ids are only unique per symbol).
 * A bare id without a symbol is ambiguous and resolves to `null`.
 */
export async function getInstance(
  store: EngineStore,
  id: string,
  symbol?: string,
): Promise<Instance | null> {
  const key = id.includes(':') ? id : symbol !== undefined && symbol !== '' ? `${symbol}:${id}` : null;
  if (key === null) return null;
  const raw = await store.get('instance', key);
  return raw === null ? null : InstanceSchema.parse(raw);
}

export async function getAccount(store: EngineStore, name: string): Promise<Account | null> {
  const raw = await store.get('account', name);
  return raw === null ? null : AccountSchema.parse(raw);
}

export async function getOrder(store: EngineStore, id: string): Promise<MarketOrder | null> {
  const raw = await store.get('order', id);
  return raw === null ? null : MarketOrderSchema.parse(raw);
}

export function entityKey(entity: EntityKind, key: string): string {
  return `${entity}:${key}`;
}
