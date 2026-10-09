import { MemoryStore } from '../../src/state/memoryStore';
import { applyUndo, GuardError, StateTxn } from '../../src/state/stateTxn';
import {
  emptySnapshot,
  type Collection,
  type JournalEntry,
  type StateSnapshot,
} from '../../src/types/domain';

const COLLECTION: Collection = {
  symbol: 'ATOM',
  name: 'Atoms',
  issuer: 'alice',
  url: '',
  orgName: '',
  productName: '',
  metadata: {},
  maxSupply: '10',
  supply: '0',
  burned: '0',
  circulatingSupply: '0',
  authorizedIssuingAccounts: ['alice'],
  authorizedIssuingContracts: [],
  properties: {},
  groupBy: [],
  royaltyBps: '500',
  royaltyRecipient: 'alice',
  createdAtBlock: 1,
  createdAt: '2026-01-01T00:00:00',
};

function snapshotWith(partial: Partial<StateSnapshot>): StateSnapshot {
  return { ...emptySnapshot(), ...partial };
}

describe('undo journal (micro-fork reverse path)', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
  });

  afterEach(async () => {
    await store.close();
  });

  it('records before images for creates, updates and deletes', async () => {
    const txn = new StateTxn(store);

    // create
    await txn.apply(
      [{ entity: 'collection', key: 'ATOM', value: COLLECTION }],
      snapshotWith({ collection: { ATOM: null } }),
    );
    // update
    const updated = { ...COLLECTION, supply: '2' };
    await txn.apply(
      [{ entity: 'collection', key: 'ATOM', value: updated }],
      snapshotWith({ collection: { ATOM: COLLECTION } }),
    );
    // delete
    await txn.apply(
      [{ entity: 'collection', key: 'ATOM', value: null }],
      snapshotWith({ collection: { ATOM: updated } }),
    );

    expect(txn.entries.map((e) => e.before)).toEqual([null, COLLECTION, updated]);
    expect(await store.get('collection', 'ATOM')).toBeNull();
  });

  it('reverses a block exactly (state before === state after undo)', async () => {
    await store.put('account', 'alice', { name: 'alice', createdAtBlock: 1, createdAt: 't' });

    const baseline = structuredClone(store.dump());
    const txn = new StateTxn(store);
    await txn.apply(
      [
        { entity: 'collection', key: 'ATOM', value: COLLECTION },
        { entity: 'meta', key: 'order_seq', value: '1' },
        { entity: 'account', key: 'bob', value: { name: 'bob', createdAtBlock: 2, createdAt: 't' } },
      ],
      snapshotWith({ collection: { ATOM: null }, meta: { order_seq: null }, account: { bob: null } }),
    );
    expect((await store.get('meta', 'order_seq'))).toBe('1');

    await applyUndo(store, txn.entries);
    expect(store.dump()).toEqual(baseline);
  });

  it('restores an entity that the block deleted', async () => {
    const instance = {
      id: '1',
      symbol: 'ATOM',
      seq: 1,
      owner: 'alice',
      properties: {},
      listedOrderId: null,
      previousAccount: null,
      createdAtBlock: 1,
      createdAt: 't',
    };
    await store.put('instance', 'ATOM:1', instance);
    const txn = new StateTxn(store);
    await txn.apply(
      [{ entity: 'instance', key: 'ATOM:1', value: null }],
      snapshotWith({ instance: { 'ATOM:1': instance } }),
    );
    expect(await store.get('instance', 'ATOM:1')).toBeNull();

    await applyUndo(store, txn.entries);
    expect(await store.get('instance', 'ATOM:1')).toEqual(instance);
  });

  it('rejects overwriting a key the sandbox never read', async () => {
    await store.put('collection', 'ATOM', COLLECTION);
    const txn = new StateTxn(store);
    await expect(
      txn.apply(
        [{ entity: 'collection', key: 'ATOM', value: { ...COLLECTION, supply: '9' } }],
        emptySnapshot(), // read set does not contain ATOM
      ),
    ).rejects.toThrow(GuardError);
    expect(await store.get('collection', 'ATOM')).toEqual(COLLECTION);
    expect(txn.entries).toHaveLength(0);
  });

  it('rejects writes based on a stale read (lost update)', async () => {
    await store.put('collection', 'ATOM', { ...COLLECTION, supply: '5' });
    const txn = new StateTxn(store);
    await expect(
      txn.apply(
        [{ entity: 'collection', key: 'ATOM', value: { ...COLLECTION, supply: '6' } }],
        snapshotWith({ collection: { ATOM: COLLECTION } }), // sandbox saw supply '0'
      ),
    ).rejects.toThrow(/lost update/);
    expect(txn.entries).toHaveLength(0);
  });

  it('keeps multi-write blocks consistent when partially rolled back', async () => {
    await store.put('account', 'zed', { name: 'zed', createdAtBlock: 1, createdAt: 't' });
    const baseline = structuredClone(store.dump());
    const txn = new StateTxn(store);
    await txn.apply(
      [
        { entity: 'collection', key: 'ATOM', value: COLLECTION },
        { entity: 'meta', key: 'order_seq', value: '1' },
      ],
      snapshotWith({ collection: { ATOM: null }, meta: { order_seq: null } }),
    );

    // A guard violation must not undo the successful writes that happened before it.
    await expect(
      txn.apply(
        [{ entity: 'account', key: 'zed', value: { name: 'zed', createdAtBlock: 9, createdAt: 'x' } }],
        emptySnapshot(), // never read 'zed'
      ),
    ).rejects.toThrow(GuardError);

    expect(await store.get('collection', 'ATOM')).toEqual(COLLECTION);
    expect(txn.entries).toHaveLength(2);
    await txn.rollbackAll();
    expect(store.dump()).toEqual(baseline);
  });
});

describe('journal storage contract (shared with PrismaStateStore)', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(async () => {
    await store.close();
  });

  const entries: JournalEntry[] = [
    { seq: 0, entity: 'collection', key: 'ATOM', before: null },
    { seq: 1, entity: 'meta', key: 'order_seq', before: '0' },
  ];

  it('an empty journal is the sentinel row, never null (null = pruned)', async () => {
    expect(await store.getJournal(7)).toBeNull(); // never journaled
    await store.putJournal(7, []);
    expect(await store.getJournal(7)).toEqual([
      { seq: 0, entity: 'meta', key: '__journal_empty__', before: null },
    ]);
  });

  it('deleteJournalFrom removes that height and everything above', async () => {
    await store.putJournal(7, entries);
    await store.putJournal(8, entries);
    await store.deleteJournalFrom(8);
    expect(await store.getJournal(7)).toEqual(entries);
    expect(await store.getJournal(8)).toBeNull();
  });

  it('pruneJournal keeps the keep height and drops everything below', async () => {
    await store.putJournal(7, entries);
    await store.putJournal(8, entries);
    await store.pruneJournal(8);
    expect(await store.getJournal(7)).toBeNull();
    expect(await store.getJournal(8)).toEqual(entries);
  });

  it('undoing the sentinel is a harmless no-op', async () => {
    await store.putJournal(7, []);
    const loaded = (await store.getJournal(7)) as JournalEntry[];
    const baseline = structuredClone(store.dump());
    await applyUndo(store, loaded);
    expect(store.dump()).toEqual(baseline);
  });
});
