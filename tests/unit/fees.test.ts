import { TestEngine } from '../helpers/engine';
import { active, posting } from '../helpers/chain';
import { emptySnapshot, PARAM_KEY, type Balance, type Param, type StateSnapshot } from '../../src/types/domain';
import { MutationGuardError, validateMutations } from '../../src/vm/guard';

/**
 * Fee engine end-to-end (build order step 3, docs/TOKENS-DESIGN.md):
 *
 *  - the `param` row is seeded with every fee at "0" (bootstrap, migration 0003),
 *  - `engine.setParam` (admin-only, active authority) patches the schedule,
 *  - `nft.create` / `nft.addProperty` (4th+) / `nft.issue` / `tokens.create` /
 *    `tokens.issue` debit the authorised payer and credit `param.treasury`,
 *  - fees always net to zero across balances, so guard conservation still holds.
 *
 * The tests share one engine and run in order — the scenario is the documented
 * genesis flow: zero-fee bootstrap -> create + issue SCE -> raise the schedule.
 * Quantities are unpadded decimal strings (BigNumber normal notation).
 */
describe('fee engine (build order step 3)', () => {
  let engine: TestEngine;
  let height = 0;
  const next = () => ({ height: ++height });

  const ZERO_FEES: Param['fees'] = {
    nftCreationFee: '0',
    addPropertyFee: '0',
    tokenCreationFee: '0',
    issueFee: '0',
    fillOrderFeeBps: '0',
    tradeFeeBps: '0',
  };

  beforeAll(async () => {
    engine = await TestEngine.create();
  });

  afterAll(async () => {
    await engine.dispose();
  });

  const expectSce = async (account: string, quantity: string): Promise<void> => {
    expect((await engine.balance(account, 'SCE'))?.quantity).toBe(quantity);
  };

  /* ------------------------------------------------------------- bootstrap */

  it('starts from the zero-fee genesis row (memory-mode parity with migration 0003)', async () => {
    expect(await engine.param()).toEqual({
      admin: 'steempro.com',
      treasury: 'steempro.com',
      fees: ZERO_FEES,
      feeTokens: ['SCE'],
    });
  });

  it('charges nothing while every scheduled fee is zero', async () => {
    await engine.execOk('create', { symbol: 'HERO', name: 'Steem Knights' }, active('alice'), next(), 'nft');
    for (const name of ['xp', 'class', 'level']) {
      await engine.execOk(
        'addProperty',
        { symbol: 'HERO', name, type: 'number' },
        active('alice'),
        next(),
        'nft',
      );
    }
    await engine.execOk(
      'create',
      { symbol: 'GLD', name: 'Gold', precision: 2 },
      active('alice'),
      next(),
      'tokens',
    );
    await engine.execOk(
      'issue',
      { symbol: 'GLD', to: 'alice', quantity: '50.00' },
      active('alice'),
      next(),
      'tokens',
    );
    await engine.execOk('issue', { symbol: 'HERO', to: 'bob', properties: {} }, active('alice'), next(), 'nft');

    // No SCE has moved anywhere: the zero-fee path touches no balance at all.
    expect(await engine.balance('alice', 'SCE')).toBeNull();
    expect(await engine.balance('steempro.com', 'SCE')).toBeNull();
    expect((await engine.balance('alice', 'GLD'))?.quantity).toBe('50');
    expect(await engine.param()).toEqual({
      admin: 'steempro.com',
      treasury: 'steempro.com',
      fees: ZERO_FEES,
      feeTokens: ['SCE'],
    });
  });

  /* -------------------------------------------------------------- setParam */

  it('setParam runs only for the admin with active authority', async () => {
    const byBob = await engine.execFail(
      'setParam',
      { fees: { nftCreationFee: '20' } },
      active('bob'),
      next(),
      'engine',
    );
    expect(byBob.log.error?.code).toBe('NOT_AUTHORIZED');

    const byPosting = await engine.execFail(
      'setParam',
      { fees: { nftCreationFee: '20' } },
      posting('steempro.com'),
      next(),
      'engine',
    );
    expect(byPosting.log.error?.code).toBe('NOT_AUTHORIZED');

    expect((await engine.param())?.fees.nftCreationFee).toBe('0');
  });

  it('setParam validates fee patches in the VM', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ fees: { unknownFee: '1' } }, 'BAD_FEE_KEY'],
      [{ fees: { fillOrderFeeBps: '10001' } }, 'BAD_FEE'],
      [{ fees: { nftCreationFee: 'twenty' } }, 'BAD_FEE'],
      [{ fees: {} }, 'BAD_FEES'],
      [{}, 'BAD_PARAMS'],
      [{ feeTokens: ['steem'] }, 'BAD_FEE_TOKENS'],
      [{ feeTokens: ['SCE', 'SCE'] }, 'BAD_FEE_TOKENS'],
      [{ fees: { nftCreationFee: '20' }, feeTokens: Array(11).fill('SCE') }, 'BAD_FEE_TOKENS'],
    ];
    for (const [params, code] of cases) {
      const outcome = await engine.execFail('setParam', params, active('steempro.com'), next(), 'engine');
      expect(outcome.log.error?.code).toBe(code);
    }
    expect((await engine.param())?.fees).toEqual(ZERO_FEES);
  });

  /* ---------------------------------------------------- genesis + raise */

  it('genesis flow: create + issue SCE for free, then raise the schedule', async () => {
    // 1. SCE exists while tokenCreationFee is still "0".
    await engine.execOk(
      'create',
      { symbol: 'SCE', name: 'Smart Contract Engine', precision: 3, url: 'https://steempro.com' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    // 2. The admin raises the schedule to its target values (the fillOrder cut is charged at settlement — step 4).
    const raised = await engine.execOk(
      'setParam',
      {
        fees: {
          nftCreationFee: '20',
          addPropertyFee: '20',
          tokenCreationFee: '20',
          issueFee: '1',
          fillOrderFeeBps: '200',
        },
      },
      active('steempro.com'),
      next(),
      'engine',
    );
    expect(raised.events.some((e) => e.type === 'PARAM_UPDATED' && e.account === 'steempro.com')).toBe(true);
    expect((await engine.param())?.fees).toEqual({
      nftCreationFee: '20',
      addPropertyFee: '20',
      tokenCreationFee: '20',
      issueFee: '1',
      fillOrderFeeBps: '200',
      // untouched by this patch — stays at the genesis zero.
      tradeFeeBps: '0',
    });
    // 3. Initial issue: the payer is the treasury itself, so the issue fee is a no-op
    //    rebate (SCE still costs nothing to mint into the treasury).
    await engine.execOk(
      'issue',
      { symbol: 'SCE', to: 'steempro.com', quantity: '1000000' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    await expectSce('steempro.com', '1000000');
    // 4. Working capital for the fee tests below.
    await engine.execOk(
      'transfer',
      { symbol: 'SCE', to: 'alice', quantity: '100' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    await expectSce('alice', '100');
    await expectSce('steempro.com', '999900');
  });

  /* ------------------------------------------------------------ charging */

  it('charges nft.create / tokens.create from the creator to the treasury', async () => {
    const broke = await engine.execFail(
      'create',
      { symbol: 'BOBC', name: 'Broke Club' },
      active('bob'),
      next(),
      'nft',
    );
    expect(broke.log.error?.code).toBe('INSUFFICIENT_BALANCE');
    expect(await engine.collection('BOBC')).toBeNull();
    expect(await engine.balance('bob', 'SCE')).toBeNull();
    await expectSce('steempro.com', '999900');

    await engine.execOk('create', { symbol: 'ALCE', name: 'Alice Club' }, active('alice'), next(), 'nft');
    await expectSce('alice', '80');
    await expectSce('steempro.com', '999920');

    await engine.execOk(
      'create',
      { symbol: 'ALD', name: 'Alice Token', precision: 4 },
      active('alice'),
      next(),
      'tokens',
    );
    await expectSce('alice', '60');
    await expectSce('steempro.com', '999940');
  });

  it('addProperty: first three definitions free, fourth and later charge', async () => {
    // HERO already has xp/class/level (added while the fee was "0").
    await engine.execOk(
      'addProperty',
      { symbol: 'HERO', name: 'guild', type: 'string' },
      active('alice'),
      next(),
      'nft',
    );
    await expectSce('alice', '40');
    await expectSce('steempro.com', '999960');

    await engine.execOk(
      'addProperty',
      { symbol: 'HERO', name: 'rank', type: 'number' },
      active('alice'),
      next(),
      'nft',
    );
    await expectSce('alice', '20');
    await expectSce('steempro.com', '999980');
  });

  it('issue: charges the issuer, honours feeSymbol against param.feeTokens', async () => {
    await engine.execOk(
      'issue',
      { symbol: 'HERO', to: 'bob', properties: { xp: 1 }, feeSymbol: 'SCE' },
      active('alice'),
      next(),
      'nft',
    );
    await expectSce('alice', '19');
    await expectSce('steempro.com', '999981');

    const badSymbol = await engine.execFail(
      'issue',
      { symbol: 'HERO', to: 'bob', properties: { xp: 2 }, feeSymbol: 'BTC' },
      active('alice'),
      next(),
      'nft',
    );
    expect(badSymbol.log.error?.code).toBe('FEE_TOKEN_UNSUPPORTED');
    await expectSce('alice', '19'); // nothing moved on the failed issue
    await expectSce('steempro.com', '999981');
  });

  it('the account the contract authorises pays (authorized-issuer routing)', async () => {
    // steempro.com is the treasury, so its own create fee is a rebate no-op.
    await engine.execOk(
      'create',
      { symbol: 'ENVO', name: 'Envoy Club', authorizedIssuingAccounts: ['gamekey'] },
      active('steempro.com'),
      next(),
      'nft',
    );
    await expectSce('steempro.com', '999981');

    await engine.execOk(
      'transfer',
      { symbol: 'SCE', to: 'gamekey', quantity: '10' },
      active('steempro.com'),
      next(),
      'tokens',
    );
    await expectSce('gamekey', '10');
    await expectSce('steempro.com', '999971');

    // gamekey is not the collection issuer but signs as an authorised issuer — the fee
    // must hit gamekey's balance (proves the routing prefetch covers the payer set).
    await engine.execOk(
      'issue',
      { symbol: 'ENVO', to: 'carol', properties: {}, feeSymbol: 'SCE' },
      active('gamekey'),
      next(),
      'nft',
    );
    await expectSce('gamekey', '9');
    await expectSce('steempro.com', '999972');
  });

  it('issueMultiple charges once per issued item', async () => {
    const outcome = await engine.execOk(
      'issueMultiple',
      {
        instances: [
          { symbol: 'HERO', to: 'bob', properties: { xp: 3 } },
          { symbol: 'HERO', to: 'carol', properties: { xp: 4 } },
        ],
      },
      active('alice'),
      next(),
      'nft',
    );
    // A per-item fee failure would be masked as ITEM_FAILED while the op still applies.
    expect(outcome.events.filter((e) => e.type === 'ITEM_FAILED')).toHaveLength(0);
    await expectSce('alice', '17');
    await expectSce('steempro.com', '999974');
  });

  it('a fee-token without a token row fails cleanly (feeTokens widened first)', async () => {
    const widened = await engine.execOk(
      'setParam',
      { feeTokens: ['SCE', 'STEEM'] },
      active('steempro.com'),
      next(),
      'engine',
    );
    expect(widened.events.some((e) => e.type === 'PARAM_UPDATED')).toBe(true);
    expect((await engine.param())?.feeTokens).toEqual(['SCE', 'STEEM']);

    // STEEM is now allowed but has no token row: chargeFee stops before any write.
    const missing = await engine.execFail(
      'issue',
      { symbol: 'HERO', to: 'bob', properties: { xp: 5 }, feeSymbol: 'STEEM' },
      active('alice'),
      next(),
      'nft',
    );
    expect(missing.log.error?.code).toBe('TOKEN_NOT_FOUND');
    await expectSce('alice', '17');
    await expectSce('steempro.com', '999974');

    // Restore the single-token schedule.
    await engine.execOk('setParam', { feeTokens: ['SCE'] }, active('steempro.com'), next(), 'engine');
    expect((await engine.param())?.feeTokens).toEqual(['SCE']);
  });

  /* ---------------------------------------------------------------- guard */

  describe('guard integration', () => {
    const ADMIN_PARAM: Param = {
      admin: 'steempro.com',
      treasury: 'steempro.com',
      fees: { ...ZERO_FEES },
      feeTokens: ['SCE'],
    };

    const snapshotWithParam = (): StateSnapshot => ({
      ...emptySnapshot(),
      param: { [PARAM_KEY]: ADMIN_PARAM },
    });

    const balance = (account: string, quantity: string): Balance => ({ account, symbol: 'SCE', quantity });

    it('accepts a balanced fee movement and rejects an unbalanced one', () => {
      const payerBefore = balance('alice', '100');
      const payerAfter = balance('alice', '80');
      const treasuryBefore = balance('steempro.com', '0');
      const treasuryAfter = balance('steempro.com', '20');
      const snapshot: StateSnapshot = {
        ...emptySnapshot(),
        balance: { 'alice:SCE': payerBefore, 'steempro.com:SCE': treasuryBefore },
      };

      const ok = validateMutations(
        'nft',
        'create',
        [
          { entity: 'balance', key: 'alice:SCE', value: payerAfter },
          { entity: 'balance', key: 'steempro.com:SCE', value: treasuryAfter },
        ],
        snapshot,
      );
      expect(ok).toHaveLength(2);

      let caught: unknown;
      try {
        validateMutations(
          'nft',
          'create',
          [
            { entity: 'balance', key: 'alice:SCE', value: payerAfter },
            { entity: 'balance', key: 'steempro.com:SCE', value: { ...treasuryAfter, quantity: '10' } },
          ],
          snapshot,
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MutationGuardError);
      expect((caught as MutationGuardError).code).toBe('GUARD_CONSERVATION');
    });

    it('keeps param.admin/param.treasury immutable for setParam', () => {
      let caught: unknown;
      try {
        validateMutations(
          'engine',
          'setParam',
          [{ entity: 'param', key: PARAM_KEY, value: { ...ADMIN_PARAM, admin: 'bob' } }],
          snapshotWithParam(),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MutationGuardError);
      expect((caught as MutationGuardError).code).toBe('GUARD_IMMUTABLE_FIELD');
    });

    it('setParam may only write the param row', () => {
      let caught: unknown;
      try {
        validateMutations(
          'engine',
          'setParam',
          [
            { entity: 'param', key: PARAM_KEY, value: ADMIN_PARAM },
            { entity: 'balance', key: 'alice:SCE', value: balance('alice', '999') },
          ],
          snapshotWithParam(),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MutationGuardError);
      expect((caught as MutationGuardError).code).toBe('GUARD_ENTITY_DENIED');
    });
  });
});
