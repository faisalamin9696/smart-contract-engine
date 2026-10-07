import { Prisma, PrismaClient } from '@prisma/client';
import type {
  AccountRecord as PrismaAccountRow,
  BlockRecord as PrismaBlockRow,
  CollectionRecord as PrismaCollectionRow,
  InstanceRecord as PrismaInstanceRow,
  MarketOrderRecord as PrismaOrderRow,
  TransactionLogRecord as PrismaLogRow,
} from '@prisma/client';

import type {
  Account,
  BlockRecord,
  Collection,
  EntityKind,
  Instance,
  JsonMap,
  JsonValue,
  JournalEntry,
  MarketOrder,
  TransactionLogRecord,
  TxStatus,
} from '../types/domain';
import type {
  CountQuery,
  EngineStore,
  ListInstancesQuery,
  ListLogsQuery,
  ListOrdersQuery,
} from '../state/store';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Advisory-lock key used to serialise block processing across connections and replicas
 * ("STEEMCNF" read as a big-endian int8).
 *
 * The engine is a single-writer pipeline by design; if two replicas ever pointed at the
 * same database, this lock guarantees exactly one of them can advance the block cursor.
 */
const BLOCK_PROCESSING_LOCK_KEY = 0x535445454d434e46; // 6004500367143030342

/** Poll interval while another process holds the block-processing lock. */
const INDEX_LOCK_POLL_MS = 100;

/**
 * Upper bound for waiting on the block-processing lock.
 *
 * `transaction()` gives a block 60s; waiting must fail *inside* that window with a
 * precise message rather than letting Prisma abort the whole transaction generically.
 */
const INDEX_LOCK_TIMEOUT_MS = 55_000;

/**
 * Sentinel journal row written when a block performed zero mutations.
 *
 * Without it, a "successfully applied but empty" block would be indistinguishable from a
 * journal that had been pruned away, so the re-org handler could either refuse to undo a
 * legitimate empty block or silently succeed on a pruned one. The sentinel undoes to a
 * harmless delete of a key that never exists.
 */
const EMPTY_JOURNAL_ENTITY: EntityKind = 'meta';
const EMPTY_JOURNAL_KEY = '__journal_empty__';

/* ------------------------------------------------------------------ converters */
/* Entity <-> row. Timestamps are stored as plain strings so values round-trip
 * byte-for-byte; a DateTime conversion would normalise them and break the state
 * fingerprints used by the determinism tests. */

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function readJson(value: Prisma.JsonValue | undefined | null): JsonValue {
  return (value === undefined || value === null ? null : value) as JsonValue;
}

function readMap(value: Prisma.JsonValue | undefined | null): JsonMap {
  return readJson(value) as JsonMap;
}

function collectionToRow(c: Collection) {
  return {
    symbol: c.symbol,
    name: c.name,
    issuer: c.issuer,
    url: c.url,
    orgName: c.orgName,
    productName: c.productName,
    maxSupply: c.maxSupply,
    supply: c.supply,
    burned: c.burned,
    circulatingSupply: c.circulatingSupply,
    authorizedIssuingAccounts: c.authorizedIssuingAccounts,
    authorizedIssuingContracts: c.authorizedIssuingContracts,
    properties: asJson(c.properties),
    groupBy: c.groupBy,
    royaltyBps: c.royaltyBps,
    royaltyRecipient: c.royaltyRecipient,
    metadata: asJson(c.metadata),
    createdAtBlock: c.createdAtBlock,
    createdAt: c.createdAt,
  };
}

function collectionFromRow(r: PrismaCollectionRow): Collection {
  return {
    symbol: r.symbol,
    name: r.name,
    issuer: r.issuer,
    url: r.url,
    orgName: r.orgName,
    productName: r.productName,
    maxSupply: r.maxSupply,
    supply: r.supply,
    burned: r.burned,
    circulatingSupply: r.circulatingSupply,
    authorizedIssuingAccounts: r.authorizedIssuingAccounts,
    authorizedIssuingContracts: r.authorizedIssuingContracts,
    properties: readMap(r.properties) as Collection['properties'],
    groupBy: r.groupBy,
    royaltyBps: r.royaltyBps,
    royaltyRecipient: r.royaltyRecipient,
    metadata: readMap(r.metadata),
    createdAtBlock: r.createdAtBlock,
    createdAt: r.createdAt,
  };
}

/** Instances are keyed by the composite `<SYMBOL>:<id>` (wiki ids are per-symbol). */
function instanceKeyOf(i: Instance): string {
  return `${i.symbol}:${i.id}`;
}

function instanceToRow(i: Instance) {
  return {
    key: instanceKeyOf(i),
    id: i.id,
    symbol: i.symbol,
    seq: i.seq,
    owner: i.owner,
    properties: asJson(i.properties),
    listedOrderId: i.listedOrderId,
    previousAccount: i.previousAccount,
    createdAtBlock: i.createdAtBlock,
    createdAt: i.createdAt,
  };
}

function instanceFromRow(r: PrismaInstanceRow): Instance {
  return {
    id: r.id,
    symbol: r.symbol,
    seq: r.seq,
    owner: r.owner,
    properties: readMap(r.properties),
    listedOrderId: r.listedOrderId,
    previousAccount: r.previousAccount,
    createdAtBlock: r.createdAtBlock,
    createdAt: r.createdAt,
  };
}

function accountToRow(a: Account) {
  return { name: a.name, createdAtBlock: a.createdAtBlock, createdAt: a.createdAt };
}

function accountFromRow(r: PrismaAccountRow): Account {
  return { name: r.name, createdAtBlock: r.createdAtBlock, createdAt: r.createdAt };
}

function orderToRow(o: MarketOrder) {
  return {
    id: o.id,
    symbol: o.symbol,
    instanceId: o.instanceId,
    seller: o.seller,
    price: o.price,
    currency: o.currency,
    status: o.status,
    royaltyBps: o.royaltyBps,
    royaltyRecipient: o.royaltyRecipient,
    createdAtBlock: o.createdAtBlock,
    updatedAtBlock: o.updatedAtBlock,
    filledAtBlock: o.filledAtBlock,
    fillBy: o.fillBy,
    settlement: o.settlement === null ? Prisma.DbNull : asJson(o.settlement),
  };
}

function orderFromRow(r: PrismaOrderRow): MarketOrder {
  return {
    id: r.id,
    symbol: r.symbol,
    instanceId: r.instanceId,
    seller: r.seller,
    price: r.price,
    currency: r.currency as MarketOrder['currency'],
    status: r.status as MarketOrder['status'],
    royaltyBps: r.royaltyBps,
    royaltyRecipient: r.royaltyRecipient,
    createdAtBlock: r.createdAtBlock,
    updatedAtBlock: r.updatedAtBlock,
    filledAtBlock: r.filledAtBlock,
    fillBy: r.fillBy,
    settlement: r.settlement === null ? null : (readJson(r.settlement) as MarketOrder['settlement']),
  };
}

function blockFromRow(r: PrismaBlockRow): BlockRecord {
  return {
    height: r.height,
    blockId: r.blockId,
    previous: r.previous,
    timestamp: r.timestamp,
    txCount: r.txCount,
    opCount: r.opCount,
    appliedAt: r.appliedAt,
  };
}

function logFromRow(r: PrismaLogRow): TransactionLogRecord {
  return {
    id: r.id,
    height: r.height,
    blockId: r.blockId,
    txId: r.txId,
    opIndex: r.opIndex,
    action: r.action,
    actor: r.actor,
    authLevel: r.authLevel as TransactionLogRecord['authLevel'],
    symbol: r.symbol,
    instanceId: r.instanceId,
    status: r.status as TxStatus,
    params: readMap(r.params),
    error: r.error === null ? null : (readJson(r.error) as TransactionLogRecord['error']),
    mutations: r.mutations === null ? null : readJson(r.mutations),
    events: r.events === null ? null : readJson(r.events),
    timestamp: r.timestamp,
  };
}

function logToRow(t: TransactionLogRecord) {
  return {
    id: t.id,
    height: t.height,
    blockId: t.blockId,
    txId: t.txId,
    opIndex: t.opIndex,
    action: t.action,
    actor: t.actor,
    authLevel: t.authLevel,
    symbol: t.symbol,
    instanceId: t.instanceId,
    status: t.status,
    params: asJson(t.params),
    error: t.error === null ? Prisma.DbNull : asJson(t.error),
    mutations: t.mutations === null ? Prisma.DbNull : asJson(t.mutations),
    events: t.events === null ? Prisma.DbNull : asJson(t.events),
    timestamp: t.timestamp,
  };
}

/* ------------------------------------------------------------------- the store */

/**
 * PostgreSQL-backed implementation of {@link EngineStore}.
 *
 * The store returned by `transaction()` wraps a Prisma interactive-transaction client, so
 * every mutation inside the callback — state writes, undo/redo performed by the re-org
 * handler, journal rows, logs and the block cursor — commits as one atomic unit. A crash
 * mid-block leaves the previous consistent cursor untouched.
 */
export class PrismaStateStore implements EngineStore {
  private constructor(
    private readonly client: Client,
    private readonly root: PrismaClient | null,
  ) {}

  static root(client: PrismaClient): PrismaStateStore {
    return new PrismaStateStore(client, client);
  }

  private inside(client: Prisma.TransactionClient): PrismaStateStore {
    return new PrismaStateStore(client, this.root);
  }

  /* -------------------------------------------------------------- KV accessors */

  async get(entity: EntityKind, key: string): Promise<JsonValue | null> {
    const c = this.client;
    switch (entity) {
      case 'collection': {
        const r = await c.collectionRecord.findUnique({ where: { symbol: key } });
        return r ? (collectionFromRow(r) as JsonValue) : null;
      }
      case 'instance': {
        const r = await c.instanceRecord.findUnique({ where: { key } });
        return r ? (instanceFromRow(r) as JsonValue) : null;
      }
      case 'account': {
        const r = await c.accountRecord.findUnique({ where: { name: key } });
        return r ? (accountFromRow(r) as JsonValue) : null;
      }
      case 'order': {
        const r = await c.marketOrderRecord.findUnique({ where: { id: key } });
        return r ? (orderFromRow(r) as JsonValue) : null;
      }
      case 'meta': {
        const r = await c.settingRecord.findUnique({ where: { key } });
        return r ? r.value : null;
      }
    }
  }

  async put(entity: EntityKind, key: string, value: JsonValue): Promise<void> {
    const c = this.client;
    switch (entity) {
      case 'collection': {
        const data = collectionToRow(value as unknown as Collection);
        await c.collectionRecord.upsert({ where: { symbol: key }, create: data, update: data });
        return;
      }
      case 'instance': {
        const data = instanceToRow(value as unknown as Instance);
        await c.instanceRecord.upsert({ where: { key }, create: data, update: data });
        return;
      }
      case 'account': {
        const data = accountToRow(value as unknown as Account);
        await c.accountRecord.upsert({ where: { name: key }, create: data, update: data });
        return;
      }
      case 'order': {
        const data = orderToRow(value as unknown as MarketOrder);
        await c.marketOrderRecord.upsert({ where: { id: key }, create: data, update: data });
        return;
      }
      case 'meta': {
        const v = String(value);
        await c.settingRecord.upsert({
          where: { key },
          create: { key, value: v },
          update: { value: v },
        });
        return;
      }
    }
  }

  async delete(entity: EntityKind, key: string): Promise<void> {
    const c = this.client;
    switch (entity) {
      case 'collection':
        await c.collectionRecord.deleteMany({ where: { symbol: key } });
        return;
      case 'instance':
        await c.instanceRecord.deleteMany({ where: { key } });
        return;
      case 'account':
        await c.accountRecord.deleteMany({ where: { name: key } });
        return;
      case 'order':
        await c.marketOrderRecord.deleteMany({ where: { id: key } });
        return;
      case 'meta':
        await c.settingRecord.deleteMany({ where: { key } });
        return;
    }
  }

  /* -------------------------------------------------------- indexed read models */

  async listCollections(limit: number, offset: number): Promise<Collection[]> {
    const rows = await this.client.collectionRecord.findMany({
      orderBy: { symbol: 'asc' },
      skip: offset,
      take: limit,
    });
    return rows.map(collectionFromRow);
  }

  async listInstances(q: ListInstancesQuery): Promise<Instance[]> {
    const where: Prisma.InstanceRecordWhereInput = {};
    if (q.owner) where.owner = q.owner;
    if (q.symbol) where.symbol = q.symbol;
    const rows = await this.client.instanceRecord.findMany({
      where,
      orderBy: [{ symbol: 'asc' }, { seq: 'asc' }],
      skip: q.offset,
      take: q.limit,
    });
    return rows.map(instanceFromRow);
  }

  async countInstances(q: CountQuery): Promise<number> {
    const where: Prisma.InstanceRecordWhereInput = {};
    if (q.owner) where.owner = q.owner;
    if (q.symbol) where.symbol = q.symbol;
    return this.client.instanceRecord.count({ where });
  }

  async listOrders(q: ListOrdersQuery): Promise<MarketOrder[]> {
    const where: Prisma.MarketOrderRecordWhereInput = {};
    if (q.status) where.status = q.status;
    if (q.symbol) where.symbol = q.symbol;
    if (q.seller) where.seller = q.seller;
    // Mirrors MemoryStore: open orders are surfaced newest-first (the live book).
    const dir = q.status === 'OPEN' ? 'desc' : 'asc';
    const rows = await this.client.marketOrderRecord.findMany({
      where,
      orderBy:
        dir === 'desc'
          ? [{ createdAtBlock: 'desc' }, { id: 'desc' }]
          : [{ createdAtBlock: 'asc' }, { id: 'asc' }],
      skip: q.offset,
      take: q.limit,
    });
    return rows.map(orderFromRow);
  }

  async countOrders(q: CountQuery): Promise<number> {
    const where: Prisma.MarketOrderRecordWhereInput = {};
    if (q.symbol) where.symbol = q.symbol;
    return this.client.marketOrderRecord.count({ where });
  }

  async listLogs(q: ListLogsQuery): Promise<TransactionLogRecord[]> {
    const where: Prisma.TransactionLogRecordWhereInput = {};
    if (q.actor) where.actor = q.actor;
    if (q.instanceId) where.instanceId = q.instanceId;
    if (q.symbol) where.symbol = q.symbol;
    if (q.height !== undefined) where.height = q.height;
    if (q.status) where.status = q.status;
    const rows = await this.client.transactionLogRecord.findMany({
      where,
      orderBy: [{ height: 'desc' }, { txId: 'asc' }, { opIndex: 'asc' }],
      skip: q.offset,
      take: q.limit,
    });
    return rows.map(logFromRow);
  }

  /* -------------------------------------------------------------------- blocks */

  async putBlock(block: BlockRecord): Promise<void> {
    const data = { ...block };
    await this.client.blockRecord.upsert({
      where: { height: block.height },
      create: data,
      update: data,
    });
  }

  async getBlock(height: number): Promise<BlockRecord | null> {
    const r = await this.client.blockRecord.findUnique({ where: { height } });
    return r ? blockFromRow(r) : null;
  }

  async getLatestBlock(): Promise<BlockRecord | null> {
    const r = await this.client.blockRecord.findFirst({ orderBy: { height: 'desc' } });
    return r ? blockFromRow(r) : null;
  }

  async deleteBlocksFrom(height: number): Promise<void> {
    // Journal rows cascade with their block (onDelete: Cascade on JournalEntry.block).
    await this.client.blockRecord.deleteMany({ where: { height: { gte: height } } });
  }

  /* ------------------------------------------------------------------- journal */

  async putJournal(height: number, entries: JournalEntry[]): Promise<void> {
    if (entries.length === 0) {
      await this.client.journalEntry.create({
        data: {
          height,
          seq: 0,
          entity: EMPTY_JOURNAL_ENTITY,
          key: EMPTY_JOURNAL_KEY,
          before: Prisma.DbNull,
        },
      });
      return;
    }
    await this.client.journalEntry.createMany({
      data: entries.map((e) => ({
        height,
        seq: e.seq,
        entity: e.entity,
        key: e.key,
        before: e.before === null ? Prisma.DbNull : asJson(e.before),
      })),
    });
  }

  async getJournal(height: number): Promise<JournalEntry[] | null> {
    const rows = await this.client.journalEntry.findMany({
      where: { height },
      orderBy: { seq: 'asc' },
    });
    if (rows.length === 0) return null;
    return rows.map((r) => ({
      seq: r.seq,
      entity: r.entity as EntityKind,
      key: r.key,
      before: r.before === null ? null : readJson(r.before),
    }));
  }

  async deleteJournalFrom(height: number): Promise<void> {
    await this.client.journalEntry.deleteMany({ where: { height: { gte: height } } });
  }

  async pruneJournal(keepFromHeight: number): Promise<void> {
    await this.client.journalEntry.deleteMany({ where: { height: { lt: keepFromHeight } } });
  }

  /* ---------------------------------------------------------------------- logs */

  async putLog(log: TransactionLogRecord): Promise<void> {
    const data = logToRow(log);
    await this.client.transactionLogRecord.upsert({
      where: { id: log.id },
      create: data,
      update: data,
    });
  }

  async deleteLogsFrom(height: number): Promise<void> {
    await this.client.transactionLogRecord.deleteMany({ where: { height: { gte: height } } });
  }

  /* ------------------------------------------------------------------ locking */

  /**
   * Serialises block processing across processes/connections.
   *
   * Only meaningful when called inside `transaction()`: the advisory lock is then held for
   * the life of the database transaction, so no other engine instance can interleave
   * partial blocks.
   */
  async acquireIndexLock(): Promise<void> {
    // `pg_advisory_xact_lock()` returns PostgreSQL's `void`, a column type Prisma's query
    // engine refuses to deserialize ("Failed to deserialize column of type 'void'"), which
    // made every block apply throw before a single block could be stored. The try-variant
    // returns a plain boolean, so poll it instead: once it reports true the lock is held
    // until this transaction commits or rolls back — the same guarantee as the blocking call.
    const deadline = Date.now() + INDEX_LOCK_TIMEOUT_MS;
    for (;;) {
      const rows = await this.client.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${BLOCK_PROCESSING_LOCK_KEY}::bigint) AS locked`;
      if (rows[0]?.locked === true) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${INDEX_LOCK_TIMEOUT_MS}ms waiting for the block-processing lock`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, INDEX_LOCK_POLL_MS));
    }
  }

  /* -------------------------------------------------------------- transactions */

  async transaction<T>(fn: (tx: EngineStore) => Promise<T>): Promise<T> {
    if (!this.root) {
      // Already inside an interactive transaction (nested call): run in place, so the
      // nested work joins the outer atomic unit instead of opening a second one.
      return fn(this);
    }
    return this.root.$transaction(
      async (client) => fn(this.inside(client)),
      // Block application (parse -> sandbox -> guards -> writes) is far below this bound;
      // a hung statement then fails fast and rolls back instead of holding the lock.
      { timeout: 60_000, maxWait: 10_000 },
    );
  }

  async close(): Promise<void> {
    await this.root?.$disconnect();
  }
}
