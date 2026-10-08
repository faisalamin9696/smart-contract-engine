import { readFileSync } from 'node:fs';
import path from 'node:path';

import { getBalance, getParam, getToken } from '../../src/state/store';
import { MemoryStore } from '../../src/state/memoryStore';
import { applyUndo, GuardError, StateTxn } from '../../src/state/stateTxn';
import {
  balanceKey,
  BalanceSchema,
  emptySnapshot,
  PARAM_KEY,
  parseEntityValue,
  ParamSchema,
  TokenSchema,
  type Balance,
  type EntityKind,
  type Param,
  type StateSnapshot,
  type Token,
} from '../../src/types/domain';
import { MutationGuardError, validateMutations } from '../../src/vm/guard';

/**
 * Phase 1 (docs/TOKENS-DESIGN.md build order step 1): the `token`/`balance`/`param`
 * state partitions — migration 0003 + the store layer.
 *
 * The fee *charging* logic is deliberately absent (later steps), so this suite pins
 * the foundation: genesis seed shape, schema validation, KV/journal/rollback
 * semantics on the new partitions, and that no NFT action can touch them yet.
 */

const MIGRATION_DIR = path.join(__dirname, '..', '..', 'prisma', 'migrations', '0003_tokens');
const MIGRATION_SQL = readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8');
const PRISMA_SCHEMA = readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

/** Genesis shape: exactly what migration 0003 inserts (fee bootstrap = all zero). */
const GENESIS_PARAM: Param = {
  admin: 'steempro.com',
  treasury: 'steempro.com',
  fees: {
    nftCreationFee: '0',
    addPropertyFee: '0',
    tokenCreationFee: '0',
    issueFee: '0',
    fillOrderFeeBps: '0',
  },
  feeTokens: ['SCE'],
};

const SCE_TOKEN: Token = {
  symbol: 'SCE',
  name: 'Smart Contract Engine',
  precision: 3,
  maxSupply: '9007199254740991',
  supply: '1000000.000',
  issuer: 'steempro.com',
  url: 'https://steempro.com',
  metadata: '',
  createdAtBlock: 1,
  createdAt: '2026-10-07T00:00:00',
};

const TREASURY_BALANCE: Balance = {
  account: 'steempro.com',
  symbol: 'SCE',
  quantity: '1000000.000',
};

function snapshotWith(partial: Partial<StateSnapshot>): StateSnapshot {
  return { ...emptySnapshot(), ...partial };
}

describe('token/balance/param schemas', () => {
  it('accepts the genesis token, balance and param shapes', () => {
    expect(TokenSchema.parse(SCE_TOKEN)).toEqual(SCE_TOKEN);
    expect(BalanceSchema.parse(TREASURY_BALANCE)).toEqual(TREASURY_BALANCE);
    expect(ParamSchema.parse(GENESIS_PARAM)).toEqual(GENESIS_PARAM);
  });

  it('rejects values outside the wiki limits', () => {
    expect(() => TokenSchema.parse({ ...SCE_TOKEN, precision: 9 })).toThrow();
    expect(() => TokenSchema.parse({ ...SCE_TOKEN, precision: 2.5 })).toThrow();
    expect(() => TokenSchema.parse({ ...SCE_TOKEN, symbol: 'sce' })).toThrow();
    expect(() => BalanceSchema.parse({ ...TREASURY_BALANCE, quantity: '1.123456789' })).toThrow();
    expect(() =>
      ParamSchema.parse({ ...GENESIS_PARAM, fees: { ...GENESIS_PARAM.fees, fillOrderFeeBps: '10001' } }),
    ).toThrow();
    expect(() => ParamSchema.parse({ ...GENESIS_PARAM, unexpected: true })).toThrow();
  });

  it('covers the new partitions in parseEntityValue', () => {
    expect(parseEntityValue('token', SCE_TOKEN)).toEqual(SCE_TOKEN);
    expect(parseEntityValue('balance', TREASURY_BALANCE)).toEqual(TREASURY_BALANCE);
    expect(parseEntityValue('param', GENESIS_PARAM)).toEqual(GENESIS_PARAM);
    expect(() => parseEntityValue('bogus' as EntityKind, {})).toThrow(/unknown entity/);
  });

  it('balance keys join account and symbol', () => {
    expect(balanceKey('steempro.com', 'SCE')).toBe('steempro.com:SCE');
    expect(PARAM_KEY).toBe('param');
  });
});

describe('memory store: token/balance/param partitions', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
  });

  afterEach(async () => {
    await store.close();
  });

  it('seeds the genesis param row on construction (migration 0003 parity)', async () => {
    expect(await getParam(store)).toEqual(GENESIS_PARAM);
    expect(store.dump().param).toEqual({ param: GENESIS_PARAM });
  });

  it('round-trips through the typed helpers', async () => {
    await store.put('token', SCE_TOKEN.symbol, SCE_TOKEN);
    await store.put('balance', balanceKey('steempro.com', 'SCE'), TREASURY_BALANCE);
    await store.put('param', PARAM_KEY, GENESIS_PARAM);

    expect(await getToken(store, 'SCE')).toEqual(SCE_TOKEN);
    expect(await getBalance(store, 'steempro.com', 'SCE')).toEqual(TREASURY_BALANCE);
    expect(await getParam(store)).toEqual(GENESIS_PARAM);

    await store.delete('token', 'SCE');
    expect(await getToken(store, 'SCE')).toBeNull();

    // The seeded partitions are part of the deterministic dump too.
    const dump = store.dump();
    expect(dump.balance).toEqual({ 'steempro.com:SCE': TREASURY_BALANCE });
    expect(dump.param).toEqual({ param: GENESIS_PARAM });
  });

  it('lists and filters tokens like the other indexed read models', async () => {
    await store.put('token', 'SCE', SCE_TOKEN);
    await store.put('token', 'ZED', { ...SCE_TOKEN, symbol: 'ZED', issuer: 'alice' });
    await store.put('token', 'AAA', { ...SCE_TOKEN, symbol: 'AAA', issuer: 'alice' });

    const all = await store.listTokens({ limit: 10, offset: 0 });
    expect(all.map((t) => t.symbol)).toEqual(['AAA', 'SCE', 'ZED']);
    expect(await store.listTokens({ issuer: 'alice', limit: 10, offset: 0 })).toHaveLength(2);
    expect((await store.listTokens({ limit: 1, offset: 1 })).map((t) => t.symbol)).toEqual(['SCE']);
  });

  it('lists and counts balances by account or symbol', async () => {
    const aliceSce: Balance = { account: 'alice', symbol: 'SCE', quantity: '5.000' };
    const aliceGold: Balance = { account: 'alice', symbol: 'GOLD', quantity: '7' };
    await store.put('balance', balanceKey('steempro.com', 'SCE'), TREASURY_BALANCE);
    await store.put('balance', balanceKey('alice', 'SCE'), aliceSce);
    await store.put('balance', balanceKey('alice', 'GOLD'), aliceGold);

    expect((await store.listBalances({ account: 'alice', limit: 10, offset: 0 })).map((b) => b.symbol)).toEqual([
      'GOLD',
      'SCE',
    ]);
    expect(await store.countBalances({ account: 'alice' })).toBe(2);
    expect(await store.countBalances({ symbol: 'SCE' })).toBe(2);
    expect((await store.listBalances({ symbol: 'SCE', limit: 1, offset: 0 })).map((b) => b.account)).toEqual([
      'alice',
    ]);
    expect((await store.listBalances({ symbol: 'SCE', limit: 1, offset: 1 })).map((b) => b.account)).toEqual([
      'steempro.com',
    ]);
  });

  it('rolls a failed transaction back across the new partitions', async () => {
    await expect(
      store.transaction(async (tx) => {
        await tx.put('token', 'SCE', SCE_TOKEN);
        await tx.put('balance', balanceKey('steempro.com', 'SCE'), TREASURY_BALANCE);
        await tx.put('param', PARAM_KEY, GENESIS_PARAM);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await getToken(store, 'SCE')).toBeNull();
    expect(await getBalance(store, 'steempro.com', 'SCE')).toBeNull();
    // The param partition is seeded at construction (memory-mode parity with migration
    // 0003), so the rollback restores the genesis row rather than an empty partition.
    expect(await getParam(store)).toEqual(GENESIS_PARAM);
  });
});

describe('journal + undo over the new partitions', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
  });

  afterEach(async () => {
    await store.close();
  });

  it('reverses token/balance/param writes exactly (state before === state after undo)', async () => {
    const baseline = structuredClone(store.dump());
    const txn = new StateTxn(store);

    await txn.apply(
      [
        { entity: 'token', key: 'SCE', value: SCE_TOKEN },
        { entity: 'balance', key: balanceKey('steempro.com', 'SCE'), value: TREASURY_BALANCE },
        { entity: 'param', key: PARAM_KEY, value: { ...GENESIS_PARAM, feeTokens: ['SCE', 'STEEM'] } },
      ],
      snapshotWith({
        token: { SCE: null },
        balance: { 'steempro.com:SCE': null },
        // Seeded at construction — the read set must reflect the stored genesis row.
        param: { param: GENESIS_PARAM },
      }),
    );
    expect(await getToken(store, 'SCE')).toEqual(SCE_TOKEN);
    expect(txn.entries.map((e) => e.entity)).toEqual(['token', 'balance', 'param']);

    await applyUndo(store, txn.entries);
    expect(store.dump()).toEqual(baseline);
  });

  it('refuses writes to partitions the sandbox never read', async () => {
    await store.put('token', 'SCE', SCE_TOKEN);
    const txn = new StateTxn(store);
    await expect(
      txn.apply(
        [{ entity: 'token', key: 'SCE', value: { ...SCE_TOKEN, supply: '9' } }],
        emptySnapshot(), // read set does not contain SCE
      ),
    ).rejects.toThrow(GuardError);
    expect(await getToken(store, 'SCE')).toEqual(SCE_TOKEN);
    expect(txn.entries).toHaveLength(0);
  });
});

describe('guard: ledger partitions stay write-protected for `nft` actions', () => {
  it('no NFT action may mutate token/balance/param (tokens actions get their own allow list)', () => {
    const cases: [EntityKind, Parameters<typeof validateMutations>[1]][] = [
      ['token', 'create'],
      ['balance', 'transfer'],
      ['param', 'placeOrder'],
    ];
    for (const [entity, action] of cases) {
      let caught: unknown;
      try {
        validateMutations('nft', action, [{ entity, key: 'x', value: {} }], emptySnapshot());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MutationGuardError);
      expect((caught as MutationGuardError).code).toBe('GUARD_ENTITY_DENIED');
    }
  });
});

describe('migration 0003_tokens (additive)', () => {
  it('only creates — no drops, truncates or deletes of existing state', () => {
    expect(MIGRATION_SQL).not.toMatch(/\bDROP\b|\bTRUNCATE\b|DELETE FROM/i);
    expect(MIGRATION_SQL).toMatch(/CREATE TABLE "TokenRecord"/);
    expect(MIGRATION_SQL).toMatch(/CREATE TABLE "BalanceRecord"/);
    expect(MIGRATION_SQL).toMatch(/CREATE TABLE "ParamRecord"/);
    // and the Prisma schema carries the matching models
    for (const model of ['TokenRecord', 'BalanceRecord', 'ParamRecord']) {
      expect(PRISMA_SCHEMA).toMatch(new RegExp(`model ${model} `));
    }
  });

  it('seeds the genesis admin/treasury param row with all fees at zero', () => {
    const insert = MIGRATION_SQL.match(
      /INSERT INTO "ParamRecord"[\s\S]*?'param',\s*'([^']+)',\s*'([^']+)',\s*'(\{[^']+\})'::jsonb,\s*ARRAY\[([^\]]+)\]/,
    );
    expect(insert).not.toBeNull();
    const [, admin, treasury, feesJson, feeTokensArray] = insert as RegExpMatchArray;

    const seeded = ParamSchema.parse({
      admin,
      treasury,
      fees: JSON.parse(feesJson),
      feeTokens: [...feeTokensArray.matchAll(/'([^']+)'/g)].map((m) => m[1]),
    });
    expect(seeded.admin).toBe('steempro.com');
    expect(seeded.treasury).toBe('steempro.com');
    expect(seeded.feeTokens).toEqual(['SCE']);
    // Fee bootstrap: all fees stay 0 until genesis creates SCE and raises them
    // via setParam (the catch-22: SCE cannot pay fees before it exists).
    expect(seeded.fees).toEqual({
      nftCreationFee: '0',
      addPropertyFee: '0',
      tokenCreationFee: '0',
      issueFee: '0',
      fillOrderFeeBps: '0',
    });
  });
});
