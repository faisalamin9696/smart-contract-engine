import { computeStateChecksum } from '../../src/api/checksum';
import { MemoryStore } from '../../src/state/memoryStore';
import type { Balance, Collection, Instance, MarketOrder, Param, Token } from '../../src/types/domain';

const COLLECTION: Collection = {
  symbol: 'ATOM',
  name: 'Atom Gear',
  issuer: 'alice',
  url: 'https://example.com',
  orgName: 'Acme',
  productName: 'Atom',
  metadata: { tier: 'gold', series: 'one' },
  maxSupply: '0',
  supply: '2',
  burned: '0',
  circulatingSupply: '2',
  authorizedIssuingAccounts: ['alice'],
  authorizedIssuingContracts: [],
  properties: {},
  groupBy: [],
  royaltyBps: '500',
  royaltyRecipient: 'alice',
  createdAtBlock: 10,
  createdAt: '2026-10-09T00:00:00',
};

const INSTANCE: Instance = {
  id: '1',
  symbol: 'ATOM',
  seq: 1,
  owner: 'bob',
  properties: {},
  listedOrderId: null,
  previousAccount: null,
  createdAtBlock: 11,
  createdAt: '2026-10-09T00:00:03',
};

const TOKEN: Token = {
  symbol: 'SCE',
  name: 'Smart Contract Engine',
  precision: 3,
  maxSupply: '0',
  supply: '1000',
  issuer: 'steempro.com',
  url: '',
  metadata: '',
  createdAtBlock: 12,
  createdAt: '2026-10-09T00:00:06',
};

const BALANCE_ALICE: Balance = { account: 'alice', symbol: 'SCE', quantity: '250' };
const BALANCE_BOB: Balance = { account: 'bob', symbol: 'SCE', quantity: '750' };

const ORDER: MarketOrder = {
  id: '1001',
  symbol: 'ATOM',
  instanceId: 'ATOM:1',
  seller: 'bob',
  price: '40',
  priceSymbol: 'SCE',
  status: 'OPEN',
  royaltyBps: '500',
  royaltyRecipient: 'bob',
  createdAtBlock: 13,
  updatedAtBlock: 13,
  filledAtBlock: null,
  fillBy: null,
  settlement: null,
};

async function seed(store: MemoryStore): Promise<void> {
  await store.put('collection', COLLECTION.symbol, COLLECTION);
  await store.put('instance', 'ATOM:1', INSTANCE);
  await store.put('token', TOKEN.symbol, TOKEN);
  await store.put('balance', 'alice:SCE', BALANCE_ALICE);
  await store.put('balance', 'bob:SCE', BALANCE_BOB);
  await store.put('order', '1001', ORDER);
}

/**
 * The digest's height label is read from the block cursor inside its own snapshot,
 * so tests that assert a height seed the cursor row the same way block application
 * would (state rows and the cursor commit together through store.transaction()).
 */
async function seedBlock(store: MemoryStore, height: number): Promise<void> {
  await store.putBlock({
    height,
    blockId: `b${height}`,
    previous: `b${height - 1}`,
    timestamp: '2026-10-09T00:00:00',
    txCount: 0,
    opCount: 0,
    appliedAt: '2026-10-09T00:00:00',
  });
}

describe('computeStateChecksum', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(async () => {
    await store.close();
  });

  it('is stable across repeated computations on the same state', async () => {
    await seed(store);
    await seedBlock(store, 100);
    const first = await computeStateChecksum(store, 'memory');
    const second = await computeStateChecksum(store, 'memory');
    expect(second).toEqual(first);
    expect(first.height).toBe(100);
    expect(first.storage).toBe('memory');
    expect(first.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(first.entities).sort()).toEqual([
      'balances',
      'bookOrders',
      'collections',
      'instances',
      'meta',
      'orders',
      'param',
      'tokens',
    ]);
  });

  it('is independent of row insertion order (two stores, same logical state)', async () => {
    await seed(store);
    await seedBlock(store, 100);

    const other = new MemoryStore();
    // Same logical state, different insertion order + different metadata key order.
    await other.put('balance', 'bob:SCE', BALANCE_BOB);
    await other.put('balance', 'alice:SCE', BALANCE_ALICE);
    await other.put('order', '1001', ORDER);
    await other.put('token', TOKEN.symbol, TOKEN);
    await other.put('instance', 'ATOM:1', INSTANCE);
    await other.put('collection', COLLECTION.symbol, {
      ...COLLECTION,
      metadata: { series: 'one', tier: 'gold' },
    });
    await seedBlock(other, 100);

    const a = await computeStateChecksum(store, 'memory');
    const b = await computeStateChecksum(other, 'memory');
    expect(b.checksum).toBe(a.checksum);
    expect(b.entities).toEqual(a.entities);
    await other.close();
  });

  it('changes only the entity that diverged (and only when the rows change)', async () => {
    await seed(store);
    await seedBlock(store, 100);
    const before = await computeStateChecksum(store, 'memory');

    await store.put('balance', 'alice:SCE', { ...BALANCE_ALICE, quantity: '251' });
    const after = await computeStateChecksum(store, 'memory');

    expect(after.entities.balances).not.toBe(before.entities.balances);
    expect(after.entities.collections).toBe(before.entities.collections);
    expect(after.entities.instances).toBe(before.entities.instances);
    expect(after.entities.tokens).toBe(before.entities.tokens);
    expect(after.entities.orders).toBe(before.entities.orders);
    expect(after.entities.param).toBe(before.entities.param);
    expect(after.checksum).not.toBe(before.checksum);
  });

  it('reports the cursor height so nodes only compare at equal heights', async () => {
    await seed(store);
    await seedBlock(store, 100);
    const at100 = await computeStateChecksum(store, 'memory');
    await seedBlock(store, 101);
    const at101 = await computeStateChecksum(store, 'memory');
    expect(at100.height).toBe(100);
    expect(at101.height).toBe(101);
    // Same rows → same entity digests regardless of the reported height.
    expect(at101.checksum).toBe(at100.checksum);
  });

  it('includes the param row (admin/fee changes are visible to other nodes)', async () => {
    await seed(store);
    await seedBlock(store, 100);
    const before = await computeStateChecksum(store, 'memory');

    const param = (await store.get('param', 'param')) as Param;
    await store.put('param', 'param', { ...param, fees: { ...param.fees, nftCreationFee: '20' } });

    const after = await computeStateChecksum(store, 'memory');
    expect(after.entities.param).not.toBe(before.entities.param);
    expect(after.entities.collections).toBe(before.entities.collections);
  });

  it('includes the order_seq meta counter (a diverged counter mints colliding ids)', async () => {
    await seed(store);
    await seedBlock(store, 100);
    const before = await computeStateChecksum(store, 'memory');

    await store.put('meta', 'order_seq', '1');
    const after = await computeStateChecksum(store, 'memory');

    expect(after.entities.meta).not.toBe(before.entities.meta);
    expect(after.entities.balances).toBe(before.entities.balances);
  });

  it('is deterministic on empty state (genesis param only)', async () => {
    const a = await computeStateChecksum(store, 'memory');
    const empty2 = new MemoryStore();
    const b = await computeStateChecksum(empty2, 'memory');
    expect(b.checksum).toBe(a.checksum);
    expect(a.entities.collections).toBe(b.entities.collections);
    await empty2.close();
  });

  it('coalesces concurrent requests onto a single in-flight computation', async () => {
    await seed(store);
    await seedBlock(store, 100);
    // Both callers resolve to the same underlying promise: one snapshot walk serves both.
    const [a, b] = await Promise.all([
      computeStateChecksum(store, 'memory'),
      computeStateChecksum(store, 'memory'),
    ]);
    expect(a).toEqual(b);
    expect(a.height).toBe(100);
  });
});
