import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

import { computeStateChecksum } from '../../src/api/checksum';
import { PrismaStateStore } from '../../src/db/prismaStateStore';
import type { Indexer } from '../../src/indexer/indexer';
import { MemoryStore } from '../../src/state/memoryStore';
import type { EngineStore } from '../../src/state/store';
import type {
  BlockRecord,
  Collection,
  Instance,
  JournalEntry,
  MarketOrder,
  Param,
  Token,
  TransactionLogRecord,
} from '../../src/types/domain';
import { ParamSchema } from '../../src/types/domain';

/**
 * Postgres parity suite for {@link PrismaStateStore}.
 *
 * Skipped unless `TEST_DATABASE_URL` points at a *throwaway* database, because the suite
 * applies migrations and writes fixture rows:
 *
 *   $env:TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/sce_test'
 *   npx jest --runInBand tests/integration/postgresStore.test.ts
 *
 * Every behaviour asserted here is also asserted against MemoryStore in the unit suite, so
 * the two back-ends are held to the same contract (reads, ordering, pagination, journal
 * semantics, transactional rollback).
 */
const TEST_URL = process.env.TEST_DATABASE_URL ?? null;
const describeDb = TEST_URL ? describe : describe.skip;

if (!TEST_URL) {
  // eslint-disable-next-line no-console
  console.warn('[postgresStore] TEST_DATABASE_URL not set — skipping Postgres parity suite');
}

const H1 = 9_000_001; // fixture block heights live outside any plausible real range

function collection(symbol: string): Collection {
  return {
    symbol,
    name: 'Parity Collection',
    issuer: 'alice',
    url: 'https://example.com/parity',
    orgName: 'SteemPro',
    productName: 'Parity',
    metadata: { note: 'parity' },
    maxSupply: '10',
    supply: '2',
    burned: '0',
    circulatingSupply: '2',
    authorizedIssuingAccounts: ['gamekey'],
    authorizedIssuingContracts: [],
    properties: {
      level: {
        type: 'number',
        isReadOnly: false,
        authorizedEditingAccounts: ['alice'],
        authorizedEditingContracts: [],
      },
    },
    groupBy: [],
    royaltyBps: '500',
    royaltyRecipient: 'alice',
    createdAtBlock: H1,
    createdAt: '2026-01-01T00:00:00',
  };
}

function instance(id: string, symbol: string, seq: number, owner: string): Instance {
  return {
    id,
    symbol,
    seq,
    owner,
    properties: { level: seq },
    listedOrderId: null,
    previousAccount: null,
    createdAtBlock: H1,
    createdAt: '2026-01-01T00:00:00',
  };
}

function order(id: string, symbol: string, instanceId: string, seller: string, createdAtBlock: number): MarketOrder {
  return {
    id,
    symbol,
    instanceId,
    seller,
    price: '12.345',
    priceSymbol: 'SCE',
    status: 'OPEN',
    royaltyBps: '500',
    royaltyRecipient: 'alice',
    createdAtBlock,
    updatedAtBlock: createdAtBlock,
    filledAtBlock: null,
    fillBy: null,
    settlement: null,
  };
}

function token(symbol: string, issuer = 'tstalice'): Token {
  return {
    symbol,
    name: 'Parity Token',
    precision: 3,
    maxSupply: '9007199254740991',
    supply: '1000.000',
    issuer,
    url: 'https://example.com/token',
    metadata: '{"tag":"parity"}',
    createdAtBlock: H1,
    createdAt: '2026-01-01T00:00:00',
  };
}

function balance(account: string, symbol: string, quantity: string) {
  return { account, symbol, quantity };
}

function param(): Param {
  return {
    admin: 'tstadmin',
    treasury: 'tstadmin',
    fees: {
      nftCreationFee: '20',
      addPropertyFee: '20',
      tokenCreationFee: '0',
      issueFee: '0',
      fillOrderFeeBps: '200',
    },
    feeTokens: ['SCE'],
  };
}

function block(height: number, blockId: string): BlockRecord {
  return {
    height,
    blockId,
    previous: '0'.repeat(40),
    timestamp: '2026-01-01T00:00:00',
    txCount: 1,
    opCount: 1,
    appliedAt: '2026-01-01T00:00:01.000Z',
  };
}

function log(id: string, height: number, actor: string): TransactionLogRecord {
  return {
    id,
    height,
    blockId: 'b'.repeat(40),
    txId: `tx-${id}`,
    opIndex: 0,
    action: 'issue',
    actor,
    authLevel: 'active',
    symbol: 'TST',
    instanceId: 'TST:1',
    status: 'APPLIED',
    params: { symbol: 'TST' },
    error: null,
    mutations: [{ entity: 'instance', key: 'TST:1' }],
    events: [{ type: 'NFT_MINTED' }],
    timestamp: '2026-01-01T00:00:00',
  };
}

describeDb('PrismaStateStore (Postgres parity)', () => {
  jest.setTimeout(120_000);

  let client: PrismaClient;
  let store: EngineStore;
  let reference: MemoryStore;

  beforeAll(async () => {
    // Bring the throwaway database up to the checked-in schema.
    execFileSync(
      process.execPath,
      [path.join(__dirname, '..', '..', 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
      { env: { ...process.env, DATABASE_URL: TEST_URL as string }, stdio: 'pipe' },
    );

    client = new PrismaClient({ datasources: { db: { url: TEST_URL as string } } });
    store = PrismaStateStore.root(client);
    reference = new MemoryStore();

    // Clear leftovers from a previous run.
    await client.settingRecord.deleteMany({ where: { key: { startsWith: 'TST' } } });
    await client.accountRecord.deleteMany({ where: { name: { startsWith: 'tst' } } });
    await client.marketOrderRecord.deleteMany({ where: { id: { startsWith: 'ORD-TST' } } });
    await client.instanceRecord.deleteMany({ where: { symbol: 'TST' } });
    await client.collectionRecord.deleteMany({ where: { symbol: 'TST' } });
    await client.tokenRecord.deleteMany({ where: { issuer: 'tstalice' } });
    await client.balanceRecord.deleteMany({ where: { key: { startsWith: 'tst' } } });
    // Fixture params live under a TST_* key — never the seeded `param` row.
    await client.paramRecord.deleteMany({ where: { key: { startsWith: 'TST' } } });
    await client.transactionLogRecord.deleteMany({ where: { height: { gte: H1 } } });
    await client.journalEntry.deleteMany({ where: { height: { gte: H1 } } });
    await client.blockRecord.deleteMany({ where: { height: { gte: H1 } } });
  });

  afterAll(async () => {
    if (client) {
      await client.settingRecord.deleteMany({ where: { key: { startsWith: 'TST' } } });
      await client.accountRecord.deleteMany({ where: { name: { startsWith: 'tst' } } });
      await client.marketOrderRecord.deleteMany({ where: { id: { startsWith: 'ORD-TST' } } });
      await client.instanceRecord.deleteMany({ where: { symbol: 'TST' } });
      await client.collectionRecord.deleteMany({ where: { symbol: 'TST' } });
      await client.tokenRecord.deleteMany({ where: { issuer: 'tstalice' } });
      await client.balanceRecord.deleteMany({ where: { key: { startsWith: 'tst' } } });
      await client.paramRecord.deleteMany({ where: { key: { startsWith: 'TST' } } });
      await client.transactionLogRecord.deleteMany({ where: { height: { gte: H1 } } });
      await client.journalEntry.deleteMany({ where: { height: { gte: H1 } } });
      await client.blockRecord.deleteMany({ where: { height: { gte: H1 } } });
      await client.$disconnect();
    }
    await store?.close();
    await reference?.close();
  });

  it('seeded the genesis param row via migration 0003 (fee bootstrap: all fees 0)', async () => {
    const seeded = await client.paramRecord.findUnique({ where: { key: 'param' } });
    expect(seeded).not.toBeNull();
    const parsed = ParamSchema.parse({
      admin: seeded!.admin,
      treasury: seeded!.treasury,
      fees: seeded!.fees,
      feeTokens: seeded!.feeTokens,
    });
    expect(parsed.admin).toBe('steempro.com');
    expect(parsed.treasury).toBe('steempro.com');
    expect(parsed.feeTokens).toEqual(['SCE']);
    // Fee bootstrap: SCE cannot pay fees before it exists — genesis raises these
    // via setParam after tokens.create/issue of SCE.
    expect(parsed.fees).toEqual({
      nftCreationFee: '0',
      addPropertyFee: '0',
      tokenCreationFee: '0',
      issueFee: '0',
      fillOrderFeeBps: '0',
    });
  });

  it('round-trips every entity partition byte-for-byte', async () => {
    const accounts = { name: 'tstalice', createdAtBlock: H1, createdAt: '2026-01-01T00:00:00' };

    await store.put('collection', 'TST', collection('TST'));
    await store.put('instance', 'TST:1', instance('1', 'TST', 1, 'tstbob'));
    await store.put('account', 'tstalice', accounts);
    await store.put('order', 'ORD-TST0001', order('ORD-TST0001', 'TST', 'TST:1', 'tstbob', H1));
    await store.put('token', 'TST', token('TST'));
    await store.put('balance', 'tstbob:TST', balance('tstbob', 'TST', '10.500'));
    await store.put('param', 'TST_param', param());
    await store.put('meta', 'order_seq', '1');

    // Same writes through MemoryStore: the two back-ends must be indistinguishable.
    await reference.put('collection', 'TST', collection('TST'));
    await reference.put('instance', 'TST:1', instance('1', 'TST', 1, 'tstbob'));
    await reference.put('account', 'tstalice', accounts);
    await reference.put('order', 'ORD-TST0001', order('ORD-TST0001', 'TST', 'TST:1', 'tstbob', H1));
    await reference.put('token', 'TST', token('TST'));
    await reference.put('balance', 'tstbob:TST', balance('tstbob', 'TST', '10.500'));
    await reference.put('param', 'TST_param', param());
    await reference.put('meta', 'order_seq', '1');

    for (const [entity, key] of [
      ['collection', 'TST'],
      ['instance', 'TST:1'],
      ['account', 'tstalice'],
      ['order', 'ORD-TST0001'],
      ['token', 'TST'],
      ['balance', 'tstbob:TST'],
      ['param', 'TST_param'],
      ['meta', 'order_seq'],
    ] as const) {
      expect(await store.get(entity, key)).toEqual(await reference.get(entity, key));
      expect(await store.get(entity, key)).not.toBeNull();
    }

    await store.delete('balance', 'tstbob:TST');
    expect(await store.get('balance', 'tstbob:TST')).toBeNull();
    await store.put('balance', 'tstbob:TST', balance('tstbob', 'TST', '10.500'));
    await store.delete('meta', 'order_seq');
    expect(await store.get('meta', 'order_seq')).toBeNull();
    await store.put('meta', 'order_seq', '1');
  });

  it('computes the identical state checksum as MemoryStore (cross-node verification)', async () => {
    // Two nodes syncing the same blocks must fingerprint their state identically —
    // this is the primitive operators use to verify a freshly synced node
    // (docs/NODE-OPERATOR.md). Same rows through both back-ends ⇒ same digest.
    const accounts = { name: 'tstalice', createdAtBlock: H1, createdAt: '2026-01-01T00:00:00' };
    const fixture = async (target: EngineStore): Promise<void> => {
      await target.put('collection', 'TST', collection('TST'));
      await target.put('instance', 'TST:1', instance('1', 'TST', 1, 'tstbob'));
      await target.put('instance', 'TST:2', instance('2', 'TST', 2, 'tstcarol'));
      await target.put('account', 'tstalice', accounts);
      await target.put('order', 'ORD-TST0001', order('ORD-TST0001', 'TST', 'TST:1', 'tstbob', H1));
      await target.put('token', 'TST', token('TST'));
      await target.put('token', 'TSZ', token('TSZ'));
      await target.put('balance', 'tstbob:TST', balance('tstbob', 'TST', '10.500'));
      await target.put('balance', 'tstcarol:TST', balance('tstcarol', 'TST', '1.000'));
    };
    await fixture(store);
    await fixture(reference);

    const indexer = { cursor: async () => ({ height: H1, blockId: 'fixture' }) } as unknown as Indexer;
    const fromPostgres = await computeStateChecksum(store, indexer, 'postgres');
    const fromMemory = await computeStateChecksum(reference, indexer, 'memory');

    expect(fromMemory.height).toBe(H1);
    expect(fromPostgres.height).toBe(fromMemory.height);
    expect(fromPostgres.entities).toEqual(fromMemory.entities);
    expect(fromPostgres.checksum).toBe(fromMemory.checksum);
  });

  it('matches MemoryStore on filtered, ordered and paginated reads', async () => {
    await store.put('instance', 'TST:2', instance('2', 'TST', 2, 'tstcarol'));
    await reference.put('instance', 'TST:2', instance('2', 'TST', 2, 'tstcarol'));

    expect(await store.listCollections(10, 0)).toEqual(await reference.listCollections(10, 0));
    expect(await store.listInstances({ owner: 'tstbob', limit: 10, offset: 0 })).toEqual(
      await reference.listInstances({ owner: 'tstbob', limit: 10, offset: 0 }),
    );
    expect(await store.listInstances({ symbol: 'TST', limit: 1, offset: 1 })).toEqual(
      await reference.listInstances({ symbol: 'TST', limit: 1, offset: 1 }),
    );
    expect(await store.countInstances({ symbol: 'TST' })).toBe(2);
    expect(await store.listOrders({ status: 'OPEN', limit: 10, offset: 0 })).toEqual(
      await reference.listOrders({ status: 'OPEN', limit: 10, offset: 0 }),
    );
    expect(await store.countOrders({ symbol: 'TST' })).toBe(1);
    await store.put('token', 'TSZ', token('TSZ'));
    await reference.put('token', 'TSZ', token('TSZ'));
    expect(await store.listTokens({ issuer: 'tstalice', limit: 10, offset: 0 })).toEqual(
      await reference.listTokens({ issuer: 'tstalice', limit: 10, offset: 0 }),
    );
    expect(await store.listTokens({ limit: 1, offset: 1 })).toEqual(
      await reference.listTokens({ limit: 1, offset: 1 }),
    );
    await store.put('balance', 'tstcarol:TST', balance('tstcarol', 'TST', '1.000'));
    await reference.put('balance', 'tstcarol:TST', balance('tstcarol', 'TST', '1.000'));
    expect(await store.listBalances({ symbol: 'TST', limit: 10, offset: 0 })).toEqual(
      await reference.listBalances({ symbol: 'TST', limit: 10, offset: 0 }),
    );
    expect(await store.countBalances({ account: 'tstcarol' })).toBe(
      await reference.countBalances({ account: 'tstcarol' }),
    );
    expect(await store.listLogs({ actor: 'nobody', limit: 10, offset: 0 })).toEqual(
      await reference.listLogs({ actor: 'nobody', limit: 10, offset: 0 }),
    );
  });

  it('persists blocks, logs and the undo journal with MemoryStore semantics', async () => {
    await store.putBlock(block(H1, 'a'.repeat(40)));
    await store.putBlock(block(H1 + 1, 'b'.repeat(40)));
    expect(await store.getBlock(H1)).toMatchObject({ height: H1, blockId: 'a'.repeat(40) });
    expect(await store.getLatestBlock()).toMatchObject({ height: H1 + 1 });

    const entry = log('9000001:tx1:0', H1, 'tstbob');
    await store.putLog(entry);
    await reference.putLog(entry);
    expect(await store.listLogs({ height: H1, limit: 10, offset: 0 })).toHaveLength(1);
    expect(await store.listLogs({ actor: 'tstbob', limit: 10, offset: 0 })).toEqual(
      await reference.listLogs({ actor: 'tstbob', limit: 10, offset: 0 }),
    );
    // Newest-first ordering, identical to MemoryStore.
    expect((await store.listLogs({ limit: 10, offset: 0 }))[0]).toEqual(entry);

    const emptyJournal: JournalEntry[] = [];
    await store.putJournal(H1, emptyJournal);
    // Empty block => sentinel row (never indistinguishable from a pruned journal).
    const loaded = await store.getJournal(H1);
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(1);
    await store.deleteJournalFrom(H1);
    expect(await store.getJournal(H1)).toBeNull();

    const entries: JournalEntry[] = [
      { seq: 0, entity: 'instance', key: 'TST:1', before: null },
      { seq: 1, entity: 'collection', key: 'TST', before: collection('TST') },
    ];
    await store.putJournal(H1, entries);
    expect(await store.getJournal(H1)).toEqual(entries);

    // pruneJournal(keepFromHeight) KEEPS journals from that height up (undo-buffer
    // semantics, indexer.ts) — everything below goes, the keep height itself stays.
    await store.putJournal(H1 + 1, entries);
    await store.pruneJournal(H1 + 1);
    expect(await store.getJournal(H1)).toBeNull();
    expect(await store.getJournal(H1 + 1)).toEqual(entries);
  });

  it('commits a transaction atomically and rolls it back on failure', async () => {
    await store.transaction(async (tx) => {
      await tx.acquireIndexLock();
      await tx.put('meta', 'TST_counter', '42');
      expect(await tx.get('meta', 'TST_counter')).toBe('42');
    });
    expect(await store.get('meta', 'TST_counter')).toBe('42');

    await expect(
      store.transaction(async (tx) => {
        await tx.put('meta', 'TST_counter', '43');
        await tx.delete('collection', 'TST');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Both the write and the delete must have been rolled back.
    expect(await store.get('meta', 'TST_counter')).toBe('42');
    expect(await store.get('collection', 'TST')).not.toBeNull();

    await store.delete('meta', 'TST_counter');
    await store.delete('meta', 'order_seq');
  });

  it('supports nested transaction calls without opening a second unit of work', async () => {
    await store.transaction(async (outer) => {
      await outer.put('meta', 'TST_outer', '1');
      await outer.transaction(async (inner) => {
        await inner.put('meta', 'TST_inner', '2');
      });
      expect(await outer.get('meta', 'TST_inner')).toBe('2');
    });
    expect(await store.get('meta', 'TST_outer')).toBeTruthy();
    await store.delete('meta', 'TST_outer');
    await store.delete('meta', 'TST_inner');
  });
});
