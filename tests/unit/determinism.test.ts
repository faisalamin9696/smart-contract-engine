import { TestEngine } from '../helpers/engine';
import { active, posting } from '../helpers/chain';
import { fingerprint } from '../../src/utils/canonical';
import type { SandboxOptions } from '../../src/vm/sandbox';

interface ScenarioResult {
  state: string;
  mutations: string;
  logs: string;
  createdAt: string;
}

/**
 * Deterministic execution: the same chain must produce byte-identical state regardless
 * of how many times it is replayed, how the input JSON is ordered, or which sandbox
 * provider executes it.
 */
async function runScenario(provider: SandboxOptions['provider']): Promise<ScenarioResult> {
  const engine = await TestEngine.create({ provider });
  const header = { blockId: 'b'.repeat(40), timestamp: '2026-03-03T04:05:06' };

  const createParams = {
    symbol: 'QUEST',
    name: 'Quest Items',
    maxSupply: '1000',
    authorizedIssuingAccounts: ['gamekey'],
    royaltyBps: '1000',
  };

  await engine.execOk('create', createParams, active('alice'), { ...header, height: 1 });
  await engine.execOk(
    'addProperty',
    {
      symbol: 'QUEST',
      name: 'xp',
      type: 'number',
      authorizedEditingAccounts: ['alice', 'gamekey'],
    },
    active('alice'),
    { ...header, height: 1 },
  );
  await engine.execOk('issue', { symbol: 'QUEST', to: 'bob', properties: { xp: 10 } }, active('gamekey'), {
    ...header,
    height: 2,
  });
  await engine.execOk(
    'issueMultiple',
    {
      instances: [
        { symbol: 'QUEST', to: 'bob' },
        { symbol: 'QUEST', to: 'carol', properties: { xp: 7 } },
        { symbol: 'QUEST', to: 'dave' },
      ],
    },
    active('gamekey'),
    { ...header, height: 3 },
  );
  await engine.execOk('transfer', { to: 'carol', nfts: [{ symbol: 'QUEST', ids: ['1'] }] }, active('bob'), {
    ...header,
    height: 4,
  });
  await engine.execOk(
    'setProperties',
    { symbol: 'QUEST', nfts: [{ id: '2', properties: { xp: 42 } }] },
    active('gamekey'),
    { ...header, height: 5 },
  );
  await engine.execOk('burn', { nfts: [{ symbol: 'QUEST', ids: ['4'] }] }, active('dave'), {
    ...header,
    height: 6,
  });
  // step 4 settlement: the buyer pays in SCE, so the price token must exist first
  await engine.execOk(
    'create',
    { symbol: 'SCE', name: 'Smart Contract Engine', precision: 3 },
    active('alice'),
    { ...header, height: 7 },
    'tokens',
  );
  await engine.execOk(
    'issue',
    { symbol: 'SCE', to: 'erin', quantity: '100' },
    active('alice'),
    { ...header, height: 7 },
    'tokens',
  );
  await engine.execOk('placeOrder', { symbol: 'QUEST', id: '3', price: '9.999' }, active('carol'), {
    ...header,
    height: 7,
  });
  await engine.execOk('fillOrder', { orderId: 'ORD-00000001' }, active('erin'), { ...header, height: 8 });
  // a failing op must be part of the deterministic record too
  await engine.execFail(
    'transfer',
    { to: 'mallory', nfts: [{ symbol: 'QUEST', ids: ['1'] }] },
    active('mallory'),
    { ...header, height: 9 },
  );
  // fungible market: rest a sell, cross it with a partial buy, cancel the
  // remainder, and record a failing market op. The BigNumber escrow math, ceil
  // rounding, price-time ordering and fee routing are the most complex numeric
  // surface in the contract — they must fingerprint identically across providers
  // and repeated runs, exactly like the NFT path above.
  await engine.execOk(
    'create',
    { symbol: 'GLD', name: 'Gold', precision: 2 },
    active('alice'),
    { ...header, height: 10 },
    'tokens',
  );
  await engine.execOk(
    'issue',
    { symbol: 'GLD', to: 'alice', quantity: '100' },
    active('alice'),
    { ...header, height: 10 },
    'tokens',
  );
  await engine.execOk(
    'issue',
    { symbol: 'SCE', to: 'bob', quantity: '50' },
    active('alice'),
    { ...header, height: 10 },
    'tokens',
  );
  await engine.execOk(
    'sell',
    { symbol: 'GLD', quote: 'SCE', quantity: '10', price: '2' },
    active('alice'),
    { ...header, height: 11 },
    'market',
  );
  await engine.execOk(
    'buy',
    { symbol: 'GLD', quote: 'SCE', quantity: '4', price: '2' },
    active('bob'),
    { ...header, height: 11 },
    'market',
  );
  await engine.execOk('cancel', { orderId: 'MKT-00000001' }, active('alice'), { ...header, height: 12 }, 'market');
  // WSTEEM-shaped peg-out legs (docs/BRIDGE.md): the fungible transfer-in to the
  // bridge and the burn that destroys the wrapper move balances and supply with
  // BigNumber decimal math — exactly what the bridge settles real custody on.
  // Both guards (overdraw burn, self-transfer) must fingerprint identically
  // across providers and replays, like every other leg above.
  await engine.execOk(
    'transfer',
    { symbol: 'GLD', to: 'bob', quantity: '3' },
    active('alice'),
    { ...header, height: 13 },
    'tokens',
  );
  await engine.execOk(
    'burn',
    { symbol: 'GLD', quantity: '5' },
    active('alice'),
    { ...header, height: 14 },
    'tokens',
  );
  await engine.execFail(
    'burn',
    { symbol: 'GLD', quantity: '1000000' },
    active('bob'),
    { ...header, height: 15 },
    'tokens',
  );
  await engine.execFail(
    'transfer',
    { symbol: 'GLD', to: 'alice', quantity: '1' },
    active('alice'),
    { ...header, height: 16 },
    'tokens',
  );
  await engine.execFail('cancel', { orderId: 'MKT-99999999' }, active('dave'), { ...header, height: 12 }, 'market');

  const state = fingerprint(engine.store.dump());
  const mutations = fingerprint(engine.outcomes.map((o) => o.log.mutations));
  const logs = fingerprint(engine.outcomes.map((o) => o.log));
  const created = (await engine.collection('QUEST'))?.createdAt as string;
  await engine.dispose();
  return { state, mutations, logs, createdAt: created };
}

describe('deterministic execution', () => {
  it('replays to an identical state fingerprint on repeated runs', async () => {
    const first = await runScenario('node-vm');
    const second = await runScenario('node-vm');
    expect(second).toEqual(first);
  });

  it('produces identical results on isolated-vm when available', async () => {
    let hasIsolatedVm = true;
    try {
      require.resolve('isolated-vm');
    } catch {
      hasIsolatedVm = false;
    }
    if (!hasIsolatedVm) return; // optional native dependency

    const viaNodeVm = await runScenario('node-vm');
    const viaIsolate = await runScenario('isolated-vm');
    expect(viaIsolate).toEqual(viaNodeVm);
  });

  it('is insensitive to JSON key ordering in the payload', async () => {
    const engine = await TestEngine.create({ provider: 'node-vm' });
    const reordered = {
      royaltyBps: '1000',
      authorizedIssuingAccounts: ['gamekey'],
      maxSupply: '1000',
      name: 'Quest Items',
      symbol: 'QUEST',
    };
    await engine.execOk('create', reordered, active('alice'), { height: 1 });
    const collection = await engine.collection('QUEST');
    expect(collection).toMatchObject({ symbol: 'QUEST', royaltyBps: '1000', maxSupply: '1000' });
    expect(fingerprint(collection)).toBe(
      fingerprint({
        symbol: 'QUEST',
        name: 'Quest Items',
        issuer: 'alice',
        url: '',
        orgName: '',
        productName: '',
        metadata: {},
        maxSupply: '1000',
        supply: '0',
        burned: '0',
        circulatingSupply: '0',
        authorizedIssuingAccounts: ['gamekey'],
        authorizedIssuingContracts: [],
        properties: {},
        groupBy: [],
        royaltyBps: '1000',
        royaltyRecipient: 'alice',
        createdAtBlock: 1,
        createdAt: '2026-01-01T00:00:00',
      }),
    );
    await engine.dispose();
  });

  it('takes time from the block header, never from the host clock', async () => {
    const engine = await TestEngine.create({ provider: 'node-vm' });
    await engine.execOk('create', { symbol: 'CLOCK', name: 'Clock' }, active('alice'), {
      height: 7,
      timestamp: '1999-12-31T23:59:59',
    });
    expect(await engine.collection('CLOCK')).toMatchObject({
      createdAtBlock: 7,
      createdAt: '1999-12-31T23:59:59',
    });
    await engine.dispose();
  });

  it('never uses the host clock or ambient randomness for ids', async () => {
    // posting authority alone must not create anything: keeps the no-auth path honest
    const engine = await TestEngine.create({ provider: 'node-vm' });
    const failed = await engine.execFail('create', { symbol: 'NOPE', name: 'Nope' }, posting('alice'));
    expect(failed.log.error?.code).toBe('ACTIVE_AUTH_REQUIRED');
    await engine.dispose();
  });
});
