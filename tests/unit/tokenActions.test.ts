import { TestEngine } from '../helpers/engine';
import { active, posting } from '../helpers/chain';
import { emptySnapshot, type Balance, type Token } from '../../src/types/domain';
import { MutationGuardError, validateMutations } from '../../src/vm/guard';

/**
 * End-to-end action semantics for the fungible `tokens` contract
 * (https://github.com/hive-engine/steemsmartcontracts-wiki/blob/master/Tokens-Contract.md,
 * v1 scope of docs/TOKENS-DESIGN.md): contract-scoped dispatch over the shared op id,
 * the wiki authorisation matrix, decimal/precision rules, supply accounting and the
 * events the WS layer will later route (TOKEN_*).
 *
 * Fees: see fees.test.ts — during the bootstrap window every fee is "0", so
 * `feeSymbol` is only validated once the admin raises the schedule through
 * `engine.setParam`.
 */
describe('tokens contract (wiki Tokens-Contract, v1)', () => {
  let engine: TestEngine;
  let height = 0;
  const next = () => ({ height: ++height });

  beforeAll(async () => {
    engine = await TestEngine.create();
  });

  afterAll(async () => {
    await engine.dispose();
  });

  /* ------------------------------------------------- contract-scoped dispatch */

  it('resolves shared action names per contract (one op id, two contracts)', async () => {
    await engine.execOk('create', { symbol: 'HERO', name: 'Steem Knights' }, active('alice'), next(), 'nft');
    await engine.execOk(
      'create',
      { symbol: 'SCE', name: 'SteemCraft Engine', precision: 3, maxSupply: '1000000' },
      active('steempro.com'),
      next(),
      'tokens',
    );

    expect(await engine.collection('HERO')).not.toBeNull();
    expect(await engine.token('SCE')).not.toBeNull();
    // Same symbol namespace, separate partitions: no cross-contamination.
    expect(await engine.collection('SCE')).toBeNull();
    expect(await engine.token('HERO')).toBeNull();
    expect((await engine.token('SCE'))?.precision).toBe(3);
    expect((await engine.token('SCE'))?.supply).toBe('0');
    expect((await engine.token('SCE'))?.metadata).toBe('');
  });

  it('rejects actions that belong to the other contract inside the VM too', async () => {
    const nftOnly = await engine.execFail(
      'updatePrecision',
      { symbol: 'SCE', precision: 4 },
      active('steempro.com'),
      next(),
      'nft',
    );
    expect(nftOnly.log.error?.code).toBe('UNKNOWN_ACTION');

    const tokensOnly = await engine.execFail(
      'addProperty',
      { symbol: 'HERO', name: 'xp', type: 'number' },
      active('alice'),
      next(),
      'tokens',
    );
    expect(tokensOnly.log.error?.code).toBe('UNKNOWN_ACTION');
  });

  /* -------------------------------------------------------------------- create */

  it('rejects duplicate symbols, posting-only signers and bad create params', async () => {
    const duplicate = await engine.execFail(
      'create',
      { symbol: 'SCE', name: 'dup', precision: 3 },
      active('bob'),
      next(),
      'tokens',
    );
    expect(duplicate.log.error?.code).toBe('TOKEN_EXISTS');

    const noActive = await engine.execFail(
      'create',
      { symbol: 'SHIELD', name: 'Shields', precision: 0 },
      posting('carol'),
      next(),
      'tokens',
    );
    expect(noActive.log.error?.code).toBe('ACTIVE_AUTH_REQUIRED');

    for (const bad of [
      { symbol: 'SCE2', name: 'x', precision: 1.5 },
      { symbol: 'SCE2', name: 'x', precision: 9 },
      { symbol: 'SCE2', name: 'x' }, // wiki: precision is required
      { symbol: 'SCE2', name: 'x', precision: 3, maxSupply: '0' },
      { symbol: 'SCE2', name: 'x', precision: 3, url: 'u'.repeat(256) },
      { symbol: 'lower', name: 'x', precision: 3 },
      { symbol: 'SCE2', name: 'bad/name', precision: 3 },
    ]) {
      const failed = await engine.execFail('create', bad, active('steempro.com'), next(), 'tokens');
      expect(failed.log.error?.code).toMatch(/BAD_SYMBOL|BAD_PRECISION|BAD_MAX_SUPPLY|BAD_URL|BAD_NAME/);
    }
  });

  /* -------------------------------------------------------------------- issue */

  it('credits balances and grows supply (issuer only)', async () => {
    const first = await engine.execOk(
      'issue',
      { symbol: 'SCE', to: 'alice', quantity: '100' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect(first.events.some((e) => e.type === 'TOKEN_ISSUED' && e.account === 'alice')).toBe(true);

    await engine.execOk(
      'issue',
      { symbol: 'SCE', to: 'alice', quantity: '50.5' },
      active('steempro.com'),
      next(),
      'tokens',
    );

    expect(await engine.balance('alice', 'SCE')).toMatchObject({ quantity: '150.5' });
    expect((await engine.token('SCE'))?.supply).toBe('150.5');
    expect(await engine.balance('steempro.com', 'SCE')).toBeNull();
    // Account rows are created for every credited holder.
    expect(await engine.store.get('account', 'alice')).not.toBeNull();
  });

  it('rejects non-issuers, bad quantities and precision violations', async () => {
    const notIssuer = await engine.execFail(
      'issue',
      { symbol: 'SCE', to: 'bob', quantity: '1' },
      active('bob'),
      next(),
      'tokens',
    );
    expect(notIssuer.log.error?.code).toBe('NOT_AUTHORIZED');

    const postingIssuer = await engine.execFail(
      'issue',
      { symbol: 'SCE', to: 'bob', quantity: '1' },
      posting('steempro.com'),
      next(),
      'tokens',
    );
    expect(postingIssuer.log.error?.code).toBe('NOT_AUTHORIZED');

    for (const [quantity, code] of [
      ['1.2345', 'PRECISION_EXCEEDED'], // precision 3 -> max 3 decimals
      ['0', 'BAD_QUANTITY'],
      ['-5', 'BAD_QUANTITY'],
      ['abc', 'BAD_QUANTITY'],
    ] as const) {
      const failed = await engine.execFail(
        'issue',
        { symbol: 'SCE', to: 'alice', quantity },
        active('steempro.com'),
        next(),
        'tokens',
      );
      expect(failed.log.error?.code).toBe(code);
    }

    const toNull = await engine.execFail(
      'issue',
      { symbol: 'SCE', to: 'null', quantity: '1' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect(toNull.log.error?.code).toBe('USE_BURN');

    const missingToken = await engine.execFail(
      'issue',
      { symbol: 'NOPE', to: 'alice', quantity: '1' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect(missingToken.log.error?.code).toBe('TOKEN_NOT_FOUND');
  });

  it('enforces maxSupply on issuance', async () => {
    await engine.execOk(
      'create',
      { symbol: 'CAP', name: 'Capped', precision: 2, maxSupply: '10' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    await engine.execOk(
      'issue',
      { symbol: 'CAP', to: 'alice', quantity: '10' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect((await engine.token('CAP'))?.supply).toBe('10');

    const over = await engine.execFail(
      'issue',
      // precision 2 => '0.01' is the smallest step that crosses the cap.
      { symbol: 'CAP', to: 'alice', quantity: '0.01' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect(over.log.error?.code).toBe('MAX_SUPPLY_REACHED');
  });

  /* ----------------------------------------------------------------- transfer */

  it('moves balances between holders with active authority (supply untouched)', async () => {
    const outcome = await engine.execOk(
      'transfer',
      { symbol: 'SCE', to: 'bob', quantity: '20.5' },
      active('alice'),
      next(),
      'tokens',
    );
    expect(outcome.events.some((e) => e.type === 'TOKEN_TRANSFERRED' && e.account === 'bob')).toBe(true);
    const event = outcome.events.find((e) => e.type === 'TOKEN_TRANSFERRED');
    expect(event?.data).toMatchObject({ from: 'alice', quantity: '20.5' });

    expect(await engine.balance('alice', 'SCE')).toMatchObject({ quantity: '130' });
    expect(await engine.balance('bob', 'SCE')).toMatchObject({ quantity: '20.5' });
    expect((await engine.token('SCE'))?.supply).toBe('150.5'); // transfers never mint
    expect(await engine.store.get('account', 'bob')).not.toBeNull();
  });

  it('refuses insufficient balances, self transfers, posting-only and null recipients', async () => {
    const insufficient = await engine.execFail(
      'transfer',
      { symbol: 'SCE', to: 'bob', quantity: '99999' },
      active('alice'),
      next(),
      'tokens',
    );
    expect(insufficient.log.error?.code).toBe('INSUFFICIENT_BALANCE');

    const self = await engine.execFail(
      'transfer',
      { symbol: 'SCE', to: 'alice', quantity: '1' },
      active('alice'),
      next(),
      'tokens',
    );
    expect(self.log.error?.code).toBe('SAME_ACCOUNT');

    const noActive = await engine.execFail(
      'transfer',
      { symbol: 'SCE', to: 'bob', quantity: '1' },
      posting('alice'),
      next(),
      'tokens',
    );
    expect(noActive.log.error?.code).toBe('ACTIVE_AUTH_REQUIRED');

    const toNull = await engine.execFail(
      'transfer',
      { symbol: 'SCE', to: 'null', quantity: '1' },
      active('alice'),
      next(),
      'tokens',
    );
    expect(toNull.log.error?.code).toBe('USE_BURN');

    // Nothing moved.
    expect(await engine.balance('alice', 'SCE')).toMatchObject({ quantity: '130' });
    expect(await engine.balance('bob', 'SCE')).toMatchObject({ quantity: '20.5' });
  });

  /* --------------------------------------------------------------------- burn */

  it('destroys holder tokens and decreases supply (engine extension)', async () => {
    const outcome = await engine.execOk(
      'burn',
      { symbol: 'SCE', quantity: '30' },
      active('alice'),
      next(),
      'tokens',
    );
    expect(outcome.events.some((e) => e.type === 'TOKEN_BURNED' && e.account === 'alice')).toBe(true);

    expect(await engine.balance('alice', 'SCE')).toMatchObject({ quantity: '100' });
    expect((await engine.token('SCE'))?.supply).toBe('120.5'); // 150.5 - 30

    const insufficient = await engine.execFail(
      'burn',
      { symbol: 'SCE', quantity: '21' },
      active('bob'),
      next(),
      'tokens',
    );
    expect(insufficient.log.error?.code).toBe('INSUFFICIENT_BALANCE');

    const noActive = await engine.execFail(
      'burn',
      { symbol: 'SCE', quantity: '1' },
      posting('alice'),
      next(),
      'tokens',
    );
    expect(noActive.log.error?.code).toBe('ACTIVE_AUTH_REQUIRED');
    expect((await engine.token('SCE'))?.supply).toBe('120.5');
  });

  /* ------------------------------------------------- updateUrl / updateMetadata */

  it('edits url and metadata with posting authority only (wiki: active not required)', async () => {
    await engine.execOk(
      'updateUrl',
      { symbol: 'SCE', url: 'https://steempro.com' },
      posting('steempro.com'),
      next(),
      'tokens',
    );
    expect((await engine.token('SCE'))?.url).toBe('https://steempro.com');

    const notOwner = await engine.execFail(
      'updateUrl',
      { symbol: 'SCE', url: 'https://evil.example' },
      posting('bob'),
      next(),
      'tokens',
    );
    expect(notOwner.log.error?.code).toBe('NOT_AUTHORIZED');

    const longUrl = await engine.execFail(
      'updateUrl',
      { symbol: 'SCE', url: 'u'.repeat(256) },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect(longUrl.log.error?.code).toBe('BAD_URL');

    const metadata = { description: 'platform token', url: 'steempro.com' };
    await engine.execOk(
      'updateMetadata',
      { symbol: 'SCE', metadata },
      posting('steempro.com'),
      next(),
      'tokens',
    );
    // Stored stringified (token table column is a string, wiki: <= 1000 chars).
    expect((await engine.token('SCE'))?.metadata).toBe(JSON.stringify(metadata));

    const floats = await engine.execFail(
      'updateMetadata',
      { symbol: 'SCE', metadata: { supply: 1.5 } },
      posting('steempro.com'),
      next(),
      'tokens',
    );
    expect(floats.log.error?.code).toBe('FLOAT_FORBIDDEN');

    const huge = await engine.execFail(
      'updateMetadata',
      { symbol: 'SCE', metadata: { blob: 'x'.repeat(1100) } },
      posting('steempro.com'),
      next(),
      'tokens',
    );
    expect(huge.log.error?.code).toBe('METADATA_TOO_LARGE');
  });

  /* ------------------------------------------------------------ updatePrecision */

  it('increases precision only, with active authority of the owner', async () => {
    const postingOnly = await engine.execFail(
      'updatePrecision',
      { symbol: 'SCE', precision: 4 },
      posting('steempro.com'),
      next(),
      'tokens',
    );
    expect(postingOnly.log.error?.code).toBe('NOT_AUTHORIZED');

    const notOwner = await engine.execFail(
      'updatePrecision',
      { symbol: 'SCE', precision: 4 },
      active('bob'),
      next(),
      'tokens',
    );
    expect(notOwner.log.error?.code).toBe('NOT_AUTHORIZED');

    for (const precision of [3, 2, 9, 1.5]) {
      const failed = await engine.execFail(
        'updatePrecision',
        { symbol: 'SCE', precision },
        active('steempro.com'),
        next(),
        'tokens',
      );
      expect(failed.log.error?.code).toMatch(/PRECISION_NOT_INCREASED|BAD_PRECISION/);
    }

    await engine.execOk(
      'updatePrecision',
      { symbol: 'SCE', precision: 4 },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect((await engine.token('SCE'))?.precision).toBe(4);

    // The raised precision is now honoured for new issuance.
    await engine.execOk(
      'issue',
      { symbol: 'SCE', to: 'alice', quantity: '1.2345' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect(await engine.balance('alice', 'SCE')).toMatchObject({ quantity: '101.2345' });
    expect((await engine.token('SCE'))?.supply).toBe('121.7345');
  });

  /* -------------------------------------------------------- transferOwnership */

  it('moves the issuer with active authority of the current owner only', async () => {
    const postingOnly = await engine.execFail(
      'transferOwnership',
      { symbol: 'SCE', to: 'alice' },
      posting('steempro.com'),
      next(),
      'tokens',
    );
    expect(postingOnly.log.error?.code).toBe('NOT_AUTHORIZED');

    const notOwner = await engine.execFail(
      'transferOwnership',
      { symbol: 'SCE', to: 'bob' },
      active('bob'),
      next(),
      'tokens',
    );
    expect(notOwner.log.error?.code).toBe('NOT_AUTHORIZED');

    const sameOwner = await engine.execFail(
      'transferOwnership',
      { symbol: 'SCE', to: 'steempro.com' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect(sameOwner.log.error?.code).toBe('SAME_OWNER');

    const event = await engine.execOk(
      'transferOwnership',
      { symbol: 'SCE', to: 'alice' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect(event.events.some((e) => e.type === 'TOKEN_UPDATED' && e.account === 'alice')).toBe(true);
    expect((await engine.token('SCE'))?.issuer).toBe('alice');

    const oldIssuer = await engine.execFail(
      'issue',
      { symbol: 'SCE', to: 'bob', quantity: '1' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    expect(oldIssuer.log.error?.code).toBe('NOT_AUTHORIZED');

    await engine.execOk(
      'issue',
      { symbol: 'SCE', to: 'bob', quantity: '2' },
      active('alice'),
      next(),
      'tokens',
    );
    expect(await engine.balance('bob', 'SCE')).toMatchObject({ quantity: '22.5' });
  });
});

/**
 * Guard-level ledger invariants (docs/TOKENS-DESIGN.md decision 3): the honest handlers
 * above can never trip these — they exist so a buggy or malicious isolate cannot mint
 * value, break precision or mis-key rows even if it bypassed every other check.
 */
describe('guard: conservation + fungible invariants', () => {
  function tokenRow(over: Partial<Token> = {}): Token {
    return {
      symbol: 'SCE',
      name: 'SteemCraft Engine',
      precision: 3,
      maxSupply: '0',
      supply: '100',
      issuer: 'steempro.com',
      url: '',
      metadata: '',
      createdAtBlock: 1,
      createdAt: '2026-01-01T00:00:00',
      ...over,
    };
  }

  function balanceRow(account: string, quantity: string): Balance {
    return { account, symbol: 'SCE', quantity };
  }

  function snapshotWith(rows: {
    token?: Token | null;
    balances?: Record<string, Balance | null>;
  }): ReturnType<typeof emptySnapshot> {
    const snapshot = emptySnapshot();
    snapshot.token.SCE = rows.token === undefined ? tokenRow() : rows.token;
    for (const [key, row] of Object.entries(rows.balances ?? {})) snapshot.balance[key] = row;
    return snapshot;
  }

  function guardError(fn: () => unknown): MutationGuardError {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(MutationGuardError);
      return err as MutationGuardError;
    }
    throw new Error('expected a guard error, but validation passed');
  }

  it('accepts balanced moves: transfer nets zero, issue/burn move supply together', () => {
    // transfer: -40 / +40 across holders, supply untouched.
    expect(
      validateMutations(
        'tokens',
        'transfer',
        [
          { entity: 'balance', key: 'alice:SCE', value: balanceRow('alice', '60') },
          { entity: 'balance', key: 'bob:SCE', value: balanceRow('bob', '40') },
        ],
        snapshotWith({ balances: { 'alice:SCE': balanceRow('alice', '100'), 'bob:SCE': null } }),
      ),
    ).toHaveLength(2);

    // issue: +25 to a holder and +25 to supply.
    expect(
      validateMutations(
        'tokens',
        'issue',
        [
          { entity: 'balance', key: 'bob:SCE', value: balanceRow('bob', '25') },
          { entity: 'token', key: 'SCE', value: tokenRow({ supply: '125' }) },
        ],
        snapshotWith({ balances: { 'bob:SCE': null } }),
      ),
    ).toHaveLength(2);

    // burn: -25 from a holder and -25 from supply.
    expect(
      validateMutations(
        'tokens',
        'burn',
        [
          { entity: 'balance', key: 'alice:SCE', value: balanceRow('alice', '75') },
          { entity: 'token', key: 'SCE', value: tokenRow({ supply: '75' }) },
        ],
        snapshotWith({ balances: { 'alice:SCE': balanceRow('alice', '100') } }),
      ),
    ).toHaveLength(2);
  });

  it('rejects balances minted out of thin air', () => {
    const error = guardError(() =>
      validateMutations(
        'tokens',
        'transfer',
        [{ entity: 'balance', key: 'alice:SCE', value: balanceRow('alice', '110') }],
        snapshotWith({ balances: { 'alice:SCE': balanceRow('alice', '100') } }),
      ),
    );
    expect(error.code).toBe('GUARD_CONSERVATION');
  });

  it('rejects supply changes that do not move balances', () => {
    const error = guardError(() =>
      validateMutations(
        'tokens',
        'issue',
        [{ entity: 'token', key: 'SCE', value: tokenRow({ supply: '150' }) }],
        snapshotWith({}),
      ),
    );
    expect(error.code).toBe('GUARD_CONSERVATION');
  });

  it('requires a brand-new token row to start at zero supply', () => {
    const error = guardError(() =>
      validateMutations(
        'tokens',
        'create',
        [{ entity: 'token', key: 'SCE', value: tokenRow({ supply: '5' }) }],
        snapshotWith({ token: null }),
      ),
    );
    expect(error.code).toBe('GUARD_TOKEN_INITIAL_SUPPLY');
  });

  it('rejects precision decreases and supply above maxSupply', () => {
    const precision = guardError(() =>
      validateMutations(
        'tokens',
        'updatePrecision',
        [{ entity: 'token', key: 'SCE', value: tokenRow({ precision: 2 }) }],
        snapshotWith({ token: tokenRow({ precision: 4 }) }),
      ),
    );
    expect(precision.code).toBe('GUARD_PRECISION_DECREASE');

    const capped = guardError(() =>
      validateMutations(
        'tokens',
        'issue',
        [{ entity: 'token', key: 'SCE', value: tokenRow({ maxSupply: '100', supply: '101' }) }],
        snapshotWith({ token: tokenRow({ maxSupply: '100', supply: '100' }) }),
      ),
    );
    expect(capped.code).toBe('GUARD_MAX_SUPPLY');
  });

  it('rejects rows whose storage key disagrees with their own fields', () => {
    const balance = guardError(() =>
      validateMutations(
        'tokens',
        'transfer',
        [{ entity: 'balance', key: 'alice:SCE', value: balanceRow('mallory', '100') }],
        snapshotWith({ balances: { 'alice:SCE': balanceRow('alice', '100') } }),
      ),
    );
    expect(balance.code).toBe('GUARD_KEY_MISMATCH');

    const token = guardError(() =>
      validateMutations(
        'tokens',
        'updatePrecision',
        // Schema-valid symbol, but not the one stored under key 'SCE'.
        [{ entity: 'token', key: 'SCE', value: tokenRow({ symbol: 'HERO' }) }],
        snapshotWith({}),
      ),
    );
    expect(token.code).toBe('GUARD_KEY_MISMATCH');
  });

  it('keeps balance quantities within the token precision', () => {
    const error = guardError(() =>
      validateMutations(
        'tokens',
        'issue',
        [{ entity: 'balance', key: 'bob:SCE', value: balanceRow('bob', '1.2345') }],
        snapshotWith({ balances: { 'bob:SCE': null } }),
      ),
    );
    expect(error.code).toBe('GUARD_BALANCE_PRECISION');
  });
});
