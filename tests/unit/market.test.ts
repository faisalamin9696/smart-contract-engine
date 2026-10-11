import { TestEngine } from '../helpers/engine';
import { active } from '../helpers/chain';
import { MutationGuardError, validateMutations } from '../../src/vm/guard';
import {
  emptySnapshot,
  type Balance,
  type BookOrder,
  type Mutation,
  type StateSnapshot,
  type Token,
} from '../../src/types/domain';

/**
 * Fungible market contract (docs/MARKET-DESIGN.md): buy/sell/cancel with escrow on
 * the order row and deterministic price-time matching. All arithmetic assertions go
 * through the real VM + guard pipeline, so a conservation violation anywhere fails
 * the op (and this suite) loudly.
 */
describe('market contract (fungible order book)', () => {
  let engine: TestEngine;
  let height = 0;
  const next = () => ({ height: ++height });

  const setupTokens = async (): Promise<void> => {
    // Base token AAA (alice is the primary holder), quote token BBB (bob is the
    // primary holder); both accounts get some of each so fills can credit either.
    await engine.execOk(
      'create',
      { symbol: 'AAA', name: 'Alpha', precision: 2 },
      active('issuer'),
      next(),
      'tokens',
    );
    await engine.execOk(
      'create',
      { symbol: 'BBB', name: 'Beta', precision: 2 },
      active('issuer'),
      next(),
      'tokens',
    );
    await engine.execOk(
      'issue',
      { symbol: 'AAA', to: 'alice', quantity: '1000' },
      active('issuer'),
      next(),
      'tokens',
    );
    await engine.execOk(
      'issue',
      { symbol: 'BBB', to: 'bob', quantity: '1000' },
      active('issuer'),
      next(),
      'tokens',
    );
    await engine.execOk(
      'issue',
      { symbol: 'AAA', to: 'bob', quantity: '1000' },
      active('issuer'),
      next(),
      'tokens',
    );
    // The treasury needs a balance row to receive trade fees.
    await engine.execOk(
      'issue',
      { symbol: 'BBB', to: 'steempro.com', quantity: '100' },
      active('issuer'),
      next(),
      'tokens',
    );
  };

  beforeEach(async () => {
    engine = await TestEngine.create();
    height = 100;
    await setupTokens();
  });

  afterEach(async () => {
    await engine.dispose();
  });

  /* ------------------------------------------------------------- placement */

  it('escrows the full quote cost on a buy order (ceil) and debits the buyer', async () => {
    const outcome = await engine.execOk(
      'buy',
      { symbol: 'AAA', quote: 'BBB', quantity: '10', price: '2' },
      active('bob'),
      next(),
      'market',
    );

    const order = await engine.bookOrder('MKT-00000001');
    expect(order).toMatchObject({
      id: 'MKT-00000001',
      account: 'bob',
      side: 'BUY',
      symbol: 'AAA',
      quote: 'BBB',
      quantity: '10',
      filled: '0',
      price: '2',
      escrow: '20',
      status: 'OPEN',
    });
    expect((await engine.balance('bob', 'BBB'))?.quantity).toBe('980');
    expect((await engine.store.get('meta', 'market_order_seq'))).toBe('1');
    expect(outcome.events.some((e) => e.type === 'MARKET_PLACED' && e.symbol === 'AAA')).toBe(true);
  });

  it('escrows the base quantity on a sell order and debits the seller', async () => {
    await engine.execOk(
      'sell',
      { symbol: 'AAA', quote: 'BBB', quantity: '7.5', price: '3.10' },
      active('alice'),
      next(),
      'market',
    );

    const order = await engine.bookOrder('MKT-00000001');
    expect(order).toMatchObject({ side: 'SELL', quantity: '7.5', escrow: '7.5', price: '3.10' });
    expect((await engine.balance('alice', 'AAA'))?.quantity).toBe('992.5');
  });

  it('rejects orders the ledger cannot back (bad pair, precision, balance)', async () => {
    const insufficient = await engine.execFail(
      'buy',
      { symbol: 'AAA', quote: 'BBB', quantity: '1000', price: '2' },
      active('bob'),
      next(),
      'market',
    );
    expect(insufficient.log.error?.code).toBe('INSUFFICIENT_BALANCE');

    const sameToken = await engine.execFail(
      'buy',
      { symbol: 'AAA', quote: 'AAA', quantity: '1', price: '1' },
      active('bob'),
      next(),
      'market',
    );
    expect(sameToken.log.error?.code).toBe('SAME_TOKEN');

    const unknownQuote = await engine.execFail(
      'buy',
      { symbol: 'AAA', quote: 'ZZZ', quantity: '1', price: '1' },
      active('bob'),
      next(),
      'market',
    );
    expect(unknownQuote.log.error?.code).toBe('TOKEN_NOT_FOUND');

    const pricePrecision = await engine.execFail(
      'sell',
      { symbol: 'AAA', quote: 'BBB', quantity: '1', price: '1.001' },
      active('alice'),
      next(),
      'market',
    );
    expect(pricePrecision.log.error?.code).toBe('PRECISION_EXCEEDED');

    const quantityPrecision = await engine.execFail(
      'sell',
      { symbol: 'AAA', quote: 'BBB', quantity: '1.0001', price: '1' },
      active('alice'),
      next(),
      'market',
    );
    expect(quantityPrecision.log.error?.code).toBe('PRECISION_EXCEEDED');

    // Failed ops leave no residue: no order, no counter tick, no balance change.
    expect(await engine.bookOrder('MKT-00000001')).toBeNull();
    expect(await engine.store.get('meta', 'market_order_seq')).toBeNull();
    expect((await engine.balance('alice', 'AAA'))?.quantity).toBe('1000');
  });

  /* ------------------------------------------------------------- matching */

  it('fills a crossing buy against a resting sell at the MAKER price (with refund of the improvement)', async () => {
    await engine.execOk(
      'sell',
      { symbol: 'AAA', quote: 'BBB', quantity: '10', price: '2' },
      active('alice'),
      next(),
      'market',
    );
    // Bob is willing to pay 3, but the resting sell only asks 2: he pays 2 and the
    // unused escrow (10 x (3 - 2)) returns to him in the same op.
    const outcome = await engine.execOk(
      'buy',
      { symbol: 'AAA', quote: 'BBB', quantity: '10', price: '3' },
      active('bob'),
      next(),
      'market',
    );

    expect((await engine.bookOrder('MKT-00000001'))?.status).toBe('FILLED');
    const taker = await engine.bookOrder('MKT-00000002');
    expect(taker).toMatchObject({ status: 'FILLED', quantity: '0', escrow: '0', filled: '10' });

    expect((await engine.balance('bob', 'AAA'))?.quantity).toBe('1010');
    expect((await engine.balance('bob', 'BBB'))?.quantity).toBe('980'); // 1000 - 30 escrow + 10 refund
    expect((await engine.balance('alice', 'BBB'))?.quantity).toBe('20');
    expect((await engine.balance('alice', 'AAA'))?.quantity).toBe('990');

    const fill = outcome.events.find((e) => e.type === 'MARKET_FILLED');
    expect(fill).toMatchObject({ symbol: 'AAA', price: '2' });
    expect(fill?.data).toMatchObject({ quantity: '10', cost: '20', fee: '0', quote: 'BBB' });
  });

  it('partially fills and rests the remainder on the book', async () => {
    await engine.execOk(
      'sell',
      { symbol: 'AAA', quote: 'BBB', quantity: '10', price: '2' },
      active('alice'),
      next(),
      'market',
    );
    await engine.execOk(
      'buy',
      { symbol: 'AAA', quote: 'BBB', quantity: '4', price: '2' },
      active('bob'),
      next(),
      'market',
    );

    const maker = await engine.bookOrder('MKT-00000001');
    expect(maker).toMatchObject({ status: 'OPEN', quantity: '6', filled: '4', escrow: '6' });
    expect((await engine.bookOrder('MKT-00000002'))?.status).toBe('FILLED');
    expect((await engine.balance('bob', 'AAA'))?.quantity).toBe('1004');
    expect((await engine.balance('alice', 'BBB'))?.quantity).toBe('8');
  });

  it('matches in price-time priority across several resting orders', async () => {
    // Placed in id order 1, 2, 3 with prices 2 / 1.5 / 2.5 — matching must consume
    // the best price first (1.5), then the older of the equal prices (id 1 @ 2).
    await engine.execOk('sell', { symbol: 'AAA', quote: 'BBB', quantity: '5', price: '2' }, active('alice'), next(), 'market');
    await engine.execOk('sell', { symbol: 'AAA', quote: 'BBB', quantity: '5', price: '1.5' }, active('alice'), next(), 'market');
    await engine.execOk('sell', { symbol: 'AAA', quote: 'BBB', quantity: '5', price: '2.5' }, active('alice'), next(), 'market');

    await engine.execOk(
      'buy',
      { symbol: 'AAA', quote: 'BBB', quantity: '12', price: '3' },
      active('bob'),
      next(),
      'market',
    );

    expect(await engine.bookOrder('MKT-00000001')).toMatchObject({ status: 'FILLED', filled: '5' }); // 2 x 5
    expect(await engine.bookOrder('MKT-00000002')).toMatchObject({ status: 'FILLED', filled: '5' }); // 1.5 x 5
    expect(await engine.bookOrder('MKT-00000003')).toMatchObject({ status: 'OPEN', quantity: '3', filled: '2' }); // 2.5 x 2
    expect(await engine.bookOrder('MKT-00000004')).toMatchObject({ status: 'FILLED', filled: '12' });

    // 5x1.5 + 5x2 + 2x2.5 = 22.5 paid; escrow was ceil(12 x 3) = 36 -> 13.5 refunded.
    expect((await engine.balance('bob', 'BBB'))?.quantity).toBe('977.5');
    expect((await engine.balance('bob', 'AAA'))?.quantity).toBe('1012');
  });

  it('never crosses orders from a different quote of the same base', async () => {
    await engine.execOk(
      'create',
      { symbol: 'CCC', name: 'Gamma', precision: 2 },
      active('issuer'),
      next(),
      'tokens',
    );
    await engine.execOk(
      'issue',
      { symbol: 'CCC', to: 'bob', quantity: '1000' },
      active('issuer'),
      next(),
      'tokens',
    );

    // Resting sell of AAA priced in BBB...
    await engine.execOk(
      'sell',
      { symbol: 'AAA', quote: 'BBB', quantity: '5', price: '2' },
      active('alice'),
      next(),
      'market',
    );
    // ...and a crossing-priced buy of the same base denominated in CCC: a different
    // quote means a different market — it must not touch the AAA/BBB book.
    const outcome = await engine.execOk(
      'buy',
      { symbol: 'AAA', quote: 'CCC', quantity: '5', price: '2' },
      active('bob'),
      next(),
      'market',
    );

    expect(await engine.bookOrder('MKT-00000001')).toMatchObject({ status: 'OPEN', filled: '0' });
    expect(await engine.bookOrder('MKT-00000002')).toMatchObject({
      status: 'OPEN',
      side: 'BUY',
      quote: 'CCC',
      filled: '0',
    });
    expect(outcome.events.some((e) => e.type === 'MARKET_FILLED')).toBe(false);
    // Each side escrowed its own currency and nothing settled: 5 AAA from alice,
    // 10 CCC from bob, bob's BBB untouched.
    expect((await engine.balance('alice', 'AAA'))?.quantity).toBe('995');
    expect((await engine.balance('bob', 'CCC'))?.quantity).toBe('990');
    expect((await engine.balance('bob', 'BBB'))?.quantity).toBe('1000');
  });

  it('stops matching at the 25-fills-per-op cap and rests the remainder', async () => {
    // 26 crossing resting sells; the taker wants far more than the book can fill.
    for (let i = 0; i < 26; i += 1) {
      await engine.execOk(
        'sell',
        { symbol: 'AAA', quote: 'BBB', quantity: '1', price: '2' },
        active('alice'),
        next(),
        'market',
      );
    }

    const outcome = await engine.execOk(
      'buy',
      { symbol: 'AAA', quote: 'BBB', quantity: '100', price: '2' },
      active('bob'),
      next(),
      'market',
    );

    // Exactly MAX_FILLS_PER_OP fills happen; the 26th maker is never reached.
    expect(outcome.events.filter((e) => e.type === 'MARKET_FILLED')).toHaveLength(25);
    for (let i = 1; i <= 25; i += 1) {
      expect(await engine.bookOrder(`MKT-${String(i).padStart(8, '0')}`)).toMatchObject({
        status: 'FILLED',
        filled: '1',
        escrow: '0',
      });
    }
    expect(await engine.bookOrder('MKT-00000026')).toMatchObject({ status: 'OPEN', quantity: '1', filled: '0' });

    // The taker rests with the remainder: 100 - 25 = 75, escrow 200 - 50 = 150.
    expect(await engine.bookOrder('MKT-00000027')).toMatchObject({
      status: 'OPEN',
      quantity: '75',
      filled: '25',
      escrow: '150',
    });

    // Exact escrow accounting under the cap: bob paid 200 into escrow up front and
    // received 25 AAA; alice released 25 AAA (1 stays escrowed on maker 26) and
    // earned 25 x 2 BBB.
    expect((await engine.balance('bob', 'AAA'))?.quantity).toBe('1025');
    expect((await engine.balance('bob', 'BBB'))?.quantity).toBe('800');
    expect((await engine.balance('alice', 'AAA'))?.quantity).toBe('974');
    expect((await engine.balance('alice', 'BBB'))?.quantity).toBe('50');
  });

  /* --------------------------------------------------------------- cancel */

  it('cancels an open order and refunds the escrow (owner only, once)', async () => {
    await engine.execOk(
      'sell',
      { symbol: 'AAA', quote: 'BBB', quantity: '10', price: '2' },
      active('alice'),
      next(),
      'market',
    );

    const byStranger = await engine.execFail('cancel', { orderId: 'MKT-00000001' }, active('bob'), next(), 'market');
    expect(byStranger.log.error?.code).toBe('NOT_AUTHORIZED');

    const outcome = await engine.execOk('cancel', { orderId: 'MKT-00000001' }, active('alice'), next(), 'market');
    expect(await engine.bookOrder('MKT-00000001')).toMatchObject({
      status: 'CANCELLED',
      quantity: '0',
      escrow: '0',
    });
    expect((await engine.balance('alice', 'AAA'))?.quantity).toBe('1000'); // escrow returned
    expect(outcome.events.some((e) => e.type === 'MARKET_CANCELLED')).toBe(true);

    const again = await engine.execFail('cancel', { orderId: 'MKT-00000001' }, active('alice'), next(), 'market');
    expect(again.log.error?.code).toBe('ORDER_NOT_OPEN');

    const missing = await engine.execFail('cancel', { orderId: 'MKT-99999999' }, active('alice'), next(), 'market');
    expect(missing.log.error?.code).toBe('ORDER_NOT_FOUND');
  });

  it('cancelling a partially filled buy refunds only the unspent escrow', async () => {
    await engine.execOk('sell', { symbol: 'AAA', quote: 'BBB', quantity: '4', price: '2' }, active('alice'), next(), 'market');
    await engine.execOk('buy', { symbol: 'AAA', quote: 'BBB', quantity: '10', price: '2' }, active('bob'), next(), 'market');

    await engine.execOk('cancel', { orderId: 'MKT-00000002' }, active('bob'), next(), 'market');
    expect(await engine.bookOrder('MKT-00000002')).toMatchObject({ status: 'CANCELLED', quantity: '0', escrow: '0', filled: '4' });
    // Paid 8 for the 4 filled + 12 escrow refunded = net -8 BBB, +4 AAA.
    expect((await engine.balance('bob', 'BBB'))?.quantity).toBe('992');
    expect((await engine.balance('bob', 'AAA'))?.quantity).toBe('1004');
  });

  /* ---------------------------------------------------------------- fees */

  it('routes the tradeFeeBps cut to the treasury out of the quote proceeds', async () => {
    await engine.execOk(
      'setParam',
      { fees: { tradeFeeBps: '200' } },
      active('steempro.com'),
      next(),
      'engine',
    );
    await engine.execOk('sell', { symbol: 'AAA', quote: 'BBB', quantity: '10', price: '2' }, active('alice'), next(), 'market');
    const outcome = await engine.execOk(
      'buy',
      { symbol: 'AAA', quote: 'BBB', quantity: '10', price: '2' },
      active('bob'),
      next(),
      'market',
    );

    // cost 20, fee = 20 x 200 / 10000 = 0.4 -> seller proceeds 19.6, treasury 0.4.
    expect((await engine.balance('alice', 'BBB'))?.quantity).toBe('19.6');
    expect((await engine.balance('steempro.com', 'BBB'))?.quantity).toBe('100.4');
    expect((await engine.balance('bob', 'BBB'))?.quantity).toBe('980');

    const fill = outcome.events.find((e) => e.type === 'MARKET_FILLED');
    expect(fill?.data).toMatchObject({ cost: '20', fee: '0.4' });
  });

  it('rejects an out-of-range tradeFeeBps at setParam (host schema and VM)', async () => {
    const outcome = await engine.execFail(
      'setParam',
      { fees: { tradeFeeBps: '10001' } },
      active('steempro.com'),
      next(),
      'engine',
    );
    expect(outcome.log.error?.code).toBe('BAD_FEE');
  });

  /* ---------------------------------------------------------------- caps */

  it('caps resting orders per account (open-order limit)', async () => {
    await engine.execOk('issue', { symbol: 'BBB', to: 'bob', quantity: '100' }, active('issuer'), next(), 'tokens');
    for (let i = 0; i < 100; i++) {
      await engine.execOk(
        'buy',
        { symbol: 'AAA', quote: 'BBB', quantity: '1', price: '1' },
        active('bob'),
        next(),
        'market',
      );
    }
    const overflow = await engine.execFail(
      'buy',
      { symbol: 'AAA', quote: 'BBB', quantity: '1', price: '1' },
      active('bob'),
      next(),
      'market',
    );
    expect(overflow.log.error?.code).toBe('TOO_MANY_OPEN_ORDERS');

    // Freeing one slot lets the next order through; a different account is unaffected.
    await engine.execOk('cancel', { orderId: 'MKT-00000001' }, active('bob'), next(), 'market');
    await engine.execOk(
      'buy',
      { symbol: 'AAA', quote: 'BBB', quantity: '1', price: '1' },
      active('bob'),
      next(),
      'market',
    );
    await engine.execOk(
      'sell',
      { symbol: 'AAA', quote: 'BBB', quantity: '1', price: '9' },
      active('alice'),
      next(),
      'market',
    );
  });

  /* ------------------------------------------------------- guard internals */

  describe('guard (host side)', () => {
    const token = (symbol: string, precision: number): Token => ({
      symbol,
      name: symbol,
      precision,
      maxSupply: '0',
      supply: '1000',
      issuer: 'issuer',
      url: '',
      metadata: '',
      createdAtBlock: 1,
      createdAt: '2026-01-01T00:00:00',
    });

    const openOrder = (over: Partial<BookOrder> = {}): BookOrder => ({
      id: 'MKT-00000001',
      account: 'bob',
      side: 'BUY',
      symbol: 'AAA',
      quote: 'BBB',
      quantity: '10',
      filled: '0',
      price: '2',
      escrow: '20',
      status: 'OPEN',
      createdAtBlock: 1,
      updatedAtBlock: 1,
      filledAtBlock: null,
      ...over,
    });

    const snapshotWith = (mutate: (s: StateSnapshot) => void): StateSnapshot => {
      const snapshot = emptySnapshot();
      snapshot.token.AAA = token('AAA', 2);
      snapshot.token.BBB = token('BBB', 2);
      snapshot.balance['bob:BBB'] = { account: 'bob', symbol: 'BBB', quantity: '1000' };
      snapshot.balance['alice:AAA'] = { account: 'alice', symbol: 'AAA', quantity: '1000' };
      snapshot.balance['steempro.com:BBB'] = {
        account: 'steempro.com',
        symbol: 'BBB',
        quantity: '0',
      };
      mutate(snapshot);
      return snapshot;
    };

    it('accepts an escrow placement that nets to zero (balance -> escrow)', () => {
      const snapshot = snapshotWith((s) => {
        s.marketOrder['MKT-00000001'] = null;
      });
      const mutations: Mutation[] = [
        {
          entity: 'balance',
          key: 'bob:BBB',
          value: { account: 'bob', symbol: 'BBB', quantity: '980' },
        },
        { entity: 'marketOrder', key: 'MKT-00000001', value: openOrder() },
      ];
      expect(validateMutations('market', 'buy', mutations, snapshot)).toHaveLength(2);
    });

    it('rejects a balance debit that no escrow explains (conservation)', () => {
      const snapshot = snapshotWith((s) => {
        s.marketOrder['MKT-00000001'] = null;
      });
      const mutations: Mutation[] = [
        {
          entity: 'balance',
          key: 'bob:BBB',
          value: { account: 'bob', symbol: 'BBB', quantity: '980' },
        },
      ];
      expect(() => validateMutations('market', 'buy', mutations, snapshot)).toThrow(MutationGuardError);
      try {
        validateMutations('market', 'buy', mutations, snapshot);
      } catch (err) {
        expect((err as MutationGuardError).code).toBe('GUARD_CONSERVATION');
      }
    });

    it('freezes identity fields (price, side, pair, owner) once placed', () => {
      const snapshot = snapshotWith((s) => {
        s.marketOrder['MKT-00000001'] = openOrder();
      });
      const mutations: Mutation[] = [
        { entity: 'marketOrder', key: 'MKT-00000001', value: openOrder({ price: '3' }) },
      ];
      try {
        validateMutations('market', 'buy', mutations, snapshot);
        throw new Error('expected GUARD_IMMUTABLE_FIELD');
      } catch (err) {
        expect(err).toBeInstanceOf(MutationGuardError);
        expect((err as MutationGuardError).code).toBe('GUARD_IMMUTABLE_FIELD');
      }
    });

    it('requires new orders to start OPEN and terminal orders to release everything', () => {
      const snapshot = snapshotWith((s) => {
        s.marketOrder['MKT-00000001'] = null;
        s.marketOrder['MKT-00000002'] = openOrder();
      });
      const filled: Mutation = {
        entity: 'marketOrder',
        key: 'MKT-00000001',
        value: openOrder({ status: 'FILLED' }),
      };
      try {
        validateMutations('market', 'buy', [filled], snapshot);
        throw new Error('expected GUARD_BOOK_ORDER_INITIAL_STATUS');
      } catch (err) {
        expect((err as MutationGuardError).code).toBe('GUARD_BOOK_ORDER_INITIAL_STATUS');
      }

      const residue: Mutation = {
        entity: 'marketOrder',
        key: 'MKT-00000002',
        value: openOrder({ status: 'CANCELLED', quantity: '0' /* escrow still 20 */ }),
      };
      try {
        validateMutations('market', 'cancel', [residue], snapshot);
        throw new Error('expected GUARD_BOOK_ORDER_RESIDUE');
      } catch (err) {
        expect((err as MutationGuardError).code).toBe('GUARD_BOOK_ORDER_RESIDUE');
      }
    });

    it('freezes terminal rows entirely', () => {
      const cancelled: BookOrder = openOrder({ status: 'CANCELLED', quantity: '0', escrow: '0' });
      const snapshot = snapshotWith((s) => {
        s.marketOrder['MKT-00000001'] = cancelled;
        s.balance['alice:BBB'] = { account: 'alice', symbol: 'BBB', quantity: '20' };
      });
      const mutations: Mutation[] = [
        {
          entity: 'balance',
          key: 'alice:BBB',
          value: { account: 'alice', symbol: 'BBB', quantity: '40' },
        },
        { entity: 'marketOrder', key: 'MKT-00000001', value: openOrder({ status: 'CANCELLED', quantity: '0', escrow: '20' }) },
      ];
      try {
        validateMutations('market', 'cancel', mutations, snapshot);
        throw new Error('expected GUARD_BOOK_ORDER_FINAL');
      } catch (err) {
        expect((err as MutationGuardError).code).toBe('GUARD_BOOK_ORDER_FINAL');
      }
    });
  });
});
