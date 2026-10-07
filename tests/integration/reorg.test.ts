import { Indexer } from '../../src/indexer/indexer';
import { EngineEventBus } from '../../src/indexer/events';
import { MemoryStore } from '../../src/state/memoryStore';
import { DeepForkError } from '../../src/chain/reorg';
import { createSandbox, type Sandbox } from '../../src/vm/sandbox';
import { nullLogger } from '../../src/logger';
import { MockRpc, active, customJsonTx } from '../helpers/chain';
import type { RawTransaction } from '../../src/chain/rpc';
import { fingerprint } from '../../src/utils/canonical';

interface Harness {
  indexer: Indexer;
  store: MemoryStore;
  sandbox: Sandbox;
  bus: EngineEventBus;
  rpc: MockRpc;
}

async function harness(
  rpc: MockRpc,
  options: { undoBufferDepth?: number; startBlockHeight?: number | null; failOnDeepFork?: boolean } = {},
): Promise<Harness> {
  const store = new MemoryStore();
  const sandbox = await createSandbox({ provider: 'node-vm', timeoutMs: 1000, memoryLimitMb: 128 });
  const bus = new EngineEventBus();
  const indexer = new Indexer(
    store,
    rpc,
    sandbox,
    bus,
    {
      pollIntervalMs: 1000,
      undoBufferDepth: options.undoBufferDepth ?? 30,
      opId: 'steem_nft_v1',
      startBlockHeight: options.startBlockHeight === undefined ? 1 : options.startBlockHeight,
      failOnDeepFork: options.failOnDeepFork ?? true,
    },
    nullLogger,
  );
  return { indexer, store, sandbox, bus, rpc };
}

// ---- reusable transaction payloads (identical bytes => identical block ids) ----

const createTx = customJsonTx(
  {
    action: 'create',
    params: {
      symbol: 'RAID',
      name: 'Raid Gear',
      maxSupply: '50',
      authorizedIssuingAccounts: ['gamekey'],
      royaltyBps: '1000',
    },
  },
  active('alice'),
);

const mintBobTx = customJsonTx({ action: 'issue', params: { symbol: 'RAID', to: 'bob' } }, active('gamekey'));
const mintCarolTx = customJsonTx({ action: 'issue', params: { symbol: 'RAID', to: 'carol' } }, active('gamekey'));
const mintZoeTx = customJsonTx({ action: 'issue', params: { symbol: 'RAID', to: 'zoe' } }, active('gamekey'));
const transferTx = customJsonTx(
  { action: 'transfer', params: { to: 'carol', nfts: [{ symbol: 'RAID', ids: ['1'] }] } },
  active('bob'),
);
const burnTx = customJsonTx(
  { action: 'burn', params: { nfts: [{ symbol: 'RAID', ids: ['2'] }] } },
  active('carol'),
);
const invalidTx = customJsonTx({ action: 'issue', params: { symbol: 'raid', to: 'NOBODY' } }, active('gamekey'));

function txs(...list: RawTransaction[]): RawTransaction[] {
  return list;
}

describe('micro-fork (re-org) integration', () => {
  jest.setTimeout(60_000);

  it('ingests blocks sequentially, tolerates invalid ops and persists cursors', async () => {
    const rpc = new MockRpc();
    rpc.mine({ transactions: txs(createTx) });
    rpc.mine({ transactions: txs(mintBobTx, invalidTx) });
    rpc.mine({ transactions: txs(transferTx) });
    rpc.mine({ transactions: txs(mintCarolTx, burnTx) });

    const h = await harness(rpc);
    const events: string[] = [];
    h.bus.onEvent((e) => events.push(e.type));

    await h.indexer.catchUp();

    expect(await h.store.getLatestBlock()).toMatchObject({ height: 4, blockId: rpc.idAt(4) });
    // RAID:1 minted to bob then transferred to carol; RAID:2 minted to carol then burned.
    expect(await h.store.get('instance', 'RAID:1')).toMatchObject({ owner: 'carol', id: '1' });
    expect(await h.store.get('instance', 'RAID:2')).toBeNull();
    // supply counts tokens ever issued (ids are never recycled)
    expect(await h.store.get('collection', 'RAID')).toMatchObject({
      supply: '2',
      burned: '1',
      circulatingSupply: '1',
    });

    // invalid payload was logged as FAILED without halting ingestion
    const logs = await h.store.listLogs({ height: 2, limit: 10, offset: 0 });
    expect(logs).toHaveLength(2);
    expect(logs.find((l) => l.status === 'FAILED')).toMatchObject({ action: 'issue' });
    expect(h.indexer.stats.opsFailed).toBe(1);
    expect(h.indexer.stats.opsApplied).toBe(5);

    // undo journal is retained for every applied block
    expect(await h.store.getJournal(4)).not.toBeNull();
    expect(events).toContain('BLOCK_APPLIED');
    expect(events).toContain('TX_FAILED');

    await h.sandbox.dispose();
    await h.store.close();
  });

  it('rolls back a micro-fork and reaches the same state as a from-scratch sync', async () => {
    const rpc = new MockRpc();
    rpc.mine({ transactions: txs(createTx) });
    rpc.mine({ transactions: txs(mintBobTx) });
    rpc.mine({ transactions: txs(mintCarolTx) });
    rpc.mine({ transactions: txs(transferTx) });
    rpc.mine({ transactions: txs(burnTx) });

    const h = await harness(rpc);
    await h.indexer.catchUp();
    const preForkState = fingerprint((h.store as MemoryStore).dump());
    // pre-fork: #1 transferred to carol, #2 minted to carol then burned at height 5
    expect(await h.store.get('instance', 'RAID:1')).toMatchObject({ owner: 'carol' });
    expect(await h.store.get('instance', 'RAID:2')).toBeNull();

    // ---- micro-fork: heights 3..5 are replaced by a different branch --------------
    rpc.rewind(3);
    rpc.mine({ transactions: txs(mintZoeTx) }); // RAID-00000002 goes to zoe instead
    rpc.mine({ transactions: txs(transferTx) });
    rpc.mine({ transactions: txs(mintZoeTx) });

    const outcome = await h.indexer.step();
    expect(outcome.kind).toBe('reorg');
    if (outcome.kind === 'reorg') {
      expect(outcome.resolution.status).toBe('rolled-back');
      expect(outcome.resolution.ancestor).toBe(2);
    }

    await h.indexer.catchUp();

    // state after re-org must equal a clean sync of the winning chain
    const referenceRpc = rpc.clone();
    const reference = await harness(referenceRpc);
    await reference.indexer.catchUp();

    expect(fingerprint((h.store as MemoryStore).dump())).toEqual(
      fingerprint((reference.store as MemoryStore).dump()),
    );
    expect(fingerprint((h.store as MemoryStore).dump())).not.toEqual(preForkState);

    // lineage bookkeeping: old blocks are gone, new ones are recorded
    expect(await h.store.getBlock(3)).toMatchObject({ blockId: rpc.idAt(3) });
    expect(await h.store.getBlock(5)).toMatchObject({ blockId: rpc.idAt(5) });
    expect((await h.store.listLogs({ height: 3, limit: 10, offset: 0 })).every((l) => l.blockId === rpc.idAt(3))).toBe(
      true,
    );
    // instance minted only on the losing branch is gone, winner's instance exists
    expect(await h.store.get('instance', 'RAID:3')).toMatchObject({ owner: 'zoe' });
    expect(h.indexer.stats.reorgs).toBe(1);
    expect(h.indexer.stats.blocksRolledBack).toBe(3);

    await h.sandbox.dispose();
    await h.store.close();
    await reference.sandbox.dispose();
    await reference.store.close();
  });

  it('re-applies the original branch through the redo buffer when the fork flips back', async () => {
    const rpc = new MockRpc();
    rpc.mine({ transactions: txs(createTx) });
    rpc.mine({ transactions: txs(mintBobTx) });
    const branchA3 = rpc.mine({ transactions: txs(mintCarolTx) });
    const branchA4 = rpc.mine({ transactions: txs(transferTx) });

    const h = await harness(rpc);
    await h.indexer.catchUp();
    const stateOnA = fingerprint((h.store as MemoryStore).dump());
    expect(h.indexer.reorg.redoSize).toBe(4); // every applied block is parked for redo

    // ---- switch to branch B -------------------------------------------------------
    rpc.rewind(3);
    rpc.mine({ transactions: txs(mintZoeTx) });
    rpc.mine({ transactions: txs(mintZoeTx) });
    await h.indexer.catchUp();
    const stateOnB = fingerprint((h.store as MemoryStore).dump());
    expect(stateOnB).not.toEqual(stateOnA);

    // ---- the network flips back to branch A ---------------------------------------
    rpc.rewind(3);
    const restored3 = rpc.mine({ transactions: txs(mintCarolTx) });
    const restored4 = rpc.mine({ transactions: txs(transferTx) });
    expect(restored3.block_id).toBe(branchA3.block_id);
    expect(restored4.block_id).toBe(branchA4.block_id);

    const outcome = await h.indexer.step();
    expect(outcome.kind).toBe('reorg');
    await h.indexer.catchUp();

    // replaying branch A must reproduce its original state bit-for-bit
    expect(fingerprint((h.store as MemoryStore).dump())).toEqual(stateOnA);
    expect(await h.store.getLatestBlock()).toMatchObject({ height: 4, blockId: branchA4.block_id });
    expect(h.indexer.stats.reorgs).toBe(2);

    await h.sandbox.dispose();
    await h.store.close();
  });

  it('halts instead of corrupting state when the fork is deeper than the undo buffer', async () => {
    const rpc = new MockRpc();
    for (let i = 0; i < 8; i++) {
      rpc.mine({ transactions: i === 0 ? txs(createTx) : txs(mintBobTx) });
    }

    const h = await harness(rpc, { undoBufferDepth: 3 });
    await h.indexer.catchUp();
    const before = fingerprint((h.store as MemoryStore).dump());

    // fork 6 blocks deep (> buffer of 3)
    rpc.rewind(3);
    rpc.mine({ transactions: txs(mintZoeTx) });
    rpc.mine({ transactions: txs(mintZoeTx) });
    rpc.mine({ transactions: txs(mintZoeTx) });
    rpc.mine({ transactions: txs(mintZoeTx) });
    rpc.mine({ transactions: txs(mintZoeTx) });
    rpc.mine({ transactions: txs(mintZoeTx) });

    await expect(h.indexer.step()).rejects.toThrow(DeepForkError);
    // state must be untouched: partial rollback is never committed
    expect(fingerprint((h.store as MemoryStore).dump())).toEqual(before);

    await h.sandbox.dispose();
    await h.store.close();
  });

  it('prunes the undo journal to the configured rolling depth', async () => {
    const rpc = new MockRpc();
    for (let i = 0; i < 40; i++) {
      rpc.mine({ transactions: i === 0 ? txs(createTx) : [] });
    }

    const h = await harness(rpc, { undoBufferDepth: 30 });
    await h.indexer.catchUp();

    expect(await h.store.getJournal(40)).not.toBeNull();
    expect(await h.store.getJournal(11)).not.toBeNull();
    expect(await h.store.getJournal(10)).toBeNull(); // pruned: older than 30 blocks
    expect(h.indexer.reorg.redoSize).toBe(30); // rolling buffer is capped

    await h.sandbox.dispose();
    await h.store.close();
  });

  it('publishes per-account notifications only after the block commits', async () => {
    const rpc = new MockRpc();
    rpc.mine({ transactions: txs(createTx) });
    rpc.mine({ transactions: txs(mintBobTx) });

    const h = await harness(rpc);
    const received: string[] = [];
    h.bus.onChannel('account:bob', (e) => received.push(e.type));
    const all: string[] = [];
    h.bus.onEvent((e) => all.push(e.type));

    await h.indexer.catchUp();

    expect(received).toEqual(['NFT_MINTED', 'NFT_RECEIVED']);
    expect(all).toContain('COLLECTION_CREATED');
    expect(all).toContain('BLOCK_APPLIED');

    await h.sandbox.dispose();
    await h.store.close();
  });
});
