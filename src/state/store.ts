import {
  AccountSchema,
  balanceKey,
  BalanceSchema,
  BookOrderSchema,
  CollectionSchema,
  InstanceSchema,
  MarketOrderSchema,
  ParamSchema,
  PARAM_KEY,
  TokenSchema,
  type Account,
  type Balance,
  type BlockRecord,
  type BookOrder,
  type BookOrderStatus,
  type Collection,
  type EntityKind,
  type Instance,
  type JsonValue,
  type JournalEntry,
  type MarketOrder,
  type OrderStatus,
  type Param,
  type Token,
  type TransactionLogRecord,
  type TxStatus,
} from '../types/domain';
import { bn } from '../utils/bn';

/**
 * Sentinel for `putJournal(height, [])`: an empty block still has a journal, so the
 * backends write this placeholder row instead of nothing — `getJournal` must never
 * return `null` for a height that WAS journaled (null means "pruned / never seen",
 * which the re-org path treats as a deep-fork error). Shared by MemoryStore and
 * PrismaStateStore so both backends produce the identical shape.
 */
export const EMPTY_JOURNAL_ENTITY: EntityKind = 'meta';
export const EMPTY_JOURNAL_KEY = '__journal_empty__';

export interface ListInstancesQuery {
  owner?: string;
  symbol?: string;
  limit: number;
  offset: number;
}

export interface ListTokensQuery {
  issuer?: string;
  limit: number;
  offset: number;
}

export interface BalanceFilter {
  account?: string;
  symbol?: string;
}

export interface ListBalancesQuery extends BalanceFilter {
  limit: number;
  offset: number;
  /**
   * Row order: 'account' (default — the keyed order existing callers expect) or
   * 'quantity' (biggest holder first — the holders view a token page renders).
   */
  order?: 'account' | 'quantity';
}

export interface ListOrdersQuery {
  status?: OrderStatus;
  symbol?: string;
  seller?: string;
  limit: number;
  offset: number;
}

/** Filters for the fungible `market` book (all optional; combined with AND). */
export interface ListBookOrdersQuery {
  symbol?: string;
  quote?: string;
  account?: string;
  side?: 'BUY' | 'SELL';
  status?: BookOrderStatus;
  limit: number;
  offset: number;
}

export type BookOrderFilter = Omit<ListBookOrdersQuery, 'limit' | 'offset'>;

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
export interface EngineTransactionOptions {
  /**
   * Pin every read in the callback — including the block cursor — to one committed
   * snapshot. The state-checksum digest uses `repeatableRead` so its rows and its
   * height label cannot disagree while the indexer keeps committing. Postgres applies
   * the level; MemoryStore serialises transactions against its process lock, which
   * already provides the same single-snapshot guarantee.
   */
  isolationLevel?: 'repeatableRead';
  /** Per-transaction timeout; defaults to the store's block-application budget (60s). */
  timeoutMs?: number;
}

export interface EngineStore {
  get(entity: EntityKind, key: string): Promise<JsonValue | null>;
  put(entity: EntityKind, key: string, value: JsonValue): Promise<void>;
  delete(entity: EntityKind, key: string): Promise<void>;

  listCollections(limit: number, offset: number): Promise<Collection[]>;
  listInstances(q: ListInstancesQuery): Promise<Instance[]>;
  countInstances(q: CountQuery): Promise<number>;
  listOrders(q: ListOrdersQuery): Promise<MarketOrder[]>;
  countOrders(q: CountQuery): Promise<number>;
  listBookOrders(q: ListBookOrdersQuery): Promise<BookOrder[]>;
  countBookOrders(q: BookOrderFilter): Promise<number>;
  listTokens(q: ListTokensQuery): Promise<Token[]>;
  listBalances(q: ListBalancesQuery): Promise<Balance[]>;
  countBalances(q: BalanceFilter): Promise<number>;
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

  transaction<T>(
    fn: (tx: EngineStore) => Promise<T>,
    opts?: EngineTransactionOptions,
  ): Promise<T>;
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

export async function getBookOrder(store: EngineStore, id: string): Promise<BookOrder | null> {
  const raw = await store.get('marketOrder', id);
  return raw === null ? null : BookOrderSchema.parse(raw);
}

export async function getToken(store: EngineStore, symbol: string): Promise<Token | null> {
  const raw = await store.get('token', symbol);
  return raw === null ? null : TokenSchema.parse(raw);
}

/**
 * Icon URL projected from a token's `metadata` string (the wiki/Hive-Engine
 * `metadata.icon` convention — issuer sets it via `tokens.updateMetadata`).
 * Read-side only: metadata stays free-form on the consensus row; this parse
 * gives REST/GraphQL consumers a stable `icon` field that is '' when absent
 * or malformed, so a bad metadata string can never break a token list.
 */
export function tokenIcon(metadata: string): string {
  if (!metadata) return '';
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const icon = (parsed as Record<string, unknown>).icon;
      if (typeof icon === 'string') return icon;
    }
  } catch {
    /* malformed metadata — no icon */
  }
  return '';
}

export async function getBalance(
  store: EngineStore,
  account: string,
  symbol: string,
): Promise<Balance | null> {
  const raw = await store.get('balance', balanceKey(account, symbol));
  return raw === null ? null : BalanceSchema.parse(raw);
}

/** Reads the single `param` row (genesis admin/treasury + fee schedule). */
export async function getParam(store: EngineStore): Promise<Param | null> {
  const raw = await store.get('param', PARAM_KEY);
  return raw === null ? null : ParamSchema.parse(raw);
}

/* ------------------------------------------- market read models (REST/GraphQL) */

/** One aggregated price level of the fungible book. */
export interface BookLevel {
  price: string;
  /** Summed remaining base quantity at this price (exact decimal arithmetic). */
  quantity: string;
  /** Number of resting orders contributing to the level. */
  orders: number;
}

export interface BookDepth {
  /** BUY levels, best (highest) price first. */
  bids: BookLevel[];
  /** SELL levels, best (lowest) price first. */
  asks: BookLevel[];
}

/** Depth levels per side returned by {@link computeBookDepth}. */
export const BOOK_DEPTH_LEVELS = 50;
/** Open rows aggregated per side — safety valve against a pathological book. */
export const BOOK_DEPTH_ROW_CAP = 1000;

/**
 * Aggregated depth for one trading pair: open orders summed per price level with
 * exact decimal math (bignumber.js — never floats). The result is the ladder a
 * trading UI renders; both the REST and GraphQL surfaces share this helper.
 */
export async function computeBookDepth(
  store: EngineStore,
  symbol: string,
  quote: string,
): Promise<BookDepth> {
  const [bids, asks] = await Promise.all([
    store.listBookOrders({ symbol, quote, status: 'OPEN', side: 'BUY', limit: BOOK_DEPTH_ROW_CAP, offset: 0 }),
    store.listBookOrders({ symbol, quote, status: 'OPEN', side: 'SELL', limit: BOOK_DEPTH_ROW_CAP, offset: 0 }),
  ]);
  const levels = (rows: BookOrder[], bestFirst: boolean): BookLevel[] => {
    const byPrice = new Map<string, BookLevel>();
    for (const row of rows) {
      const level = byPrice.get(row.price) ?? { price: row.price, quantity: '0', orders: 0 };
      level.quantity = bn(level.quantity).plus(row.quantity).toFixed();
      level.orders += 1;
      byPrice.set(row.price, level);
    }
    return [...byPrice.values()]
      .sort((a, b) => {
        const cmp = bn(a.price).comparedTo(b.price) ?? 0;
        return bestFirst ? -cmp : cmp;
      })
      .slice(0, BOOK_DEPTH_LEVELS);
  };
  return { bids: levels(bids, true), asks: levels(asks, false) };
}

/** One fill between a BUY and a SELL order (flattened from a `MARKET_FILLED` event). */
export interface MarketTrade {
  height: number;
  timestamp: string;
  txId: string;
  opIndex: number;
  buyOrderId: string;
  sellOrderId: string;
  buyer: string;
  seller: string;
  /** Base token. */
  base: string;
  /** Quote/settlement token. */
  quote: string;
  quantity: string;
  /** Execution price (the resting order's price — maker priority). */
  price: string;
  cost: string;
  /** Treasury cut of the quote proceeds (`param.fees.tradeFeeBps`). */
  fee: string;
}

/**
 * Recent fills of the fungible `market` contract, flattened from the
 * `MARKET_FILLED` events recorded on applied buy/sell ops (the log rows are the
 * durable trade history — no separate trade table to re-org).
 *
 * Pagination is per *operation*: one op may emit several fills and they are never
 * split across pages. Newest ops first (listLogs order).
 */
export async function listMarketTrades(
  store: EngineStore,
  q: { symbol?: string; quote?: string; limit: number; offset: number },
): Promise<MarketTrade[]> {
  const logs = await store.listLogs({
    symbol: q.symbol,
    status: 'APPLIED',
    limit: q.limit,
    offset: q.offset,
  });
  const trades: MarketTrade[] = [];
  for (const log of logs) {
    if (!Array.isArray(log.events)) continue;
    for (const raw of log.events) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const event = raw as Record<string, unknown>;
      if (event.type !== 'MARKET_FILLED') continue;
      const data = (event.data ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string => (typeof v === 'string' ? v : '');
      const tradeQuote = str(data.quote);
      if (q.quote !== undefined && tradeQuote !== q.quote) continue;
      trades.push({
        height: log.height,
        timestamp: log.timestamp,
        txId: log.txId,
        opIndex: log.opIndex,
        buyOrderId: str(data.buyOrderId),
        sellOrderId: str(data.sellOrderId),
        buyer: str(data.buyer),
        seller: str(data.seller),
        base: str(event.symbol),
        quote: tradeQuote,
        quantity: str(data.quantity),
        price: typeof event.price === 'string' ? event.price : '',
        cost: str(data.cost),
        fee: str(data.fee),
      });
    }
  }
  return trades;
}

export function entityKey(entity: EntityKind, key: string): string {
  return `${entity}:${key}`;
}
