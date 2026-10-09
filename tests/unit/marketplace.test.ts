import { TestEngine } from '../helpers/engine';
import { active } from '../helpers/chain';
import { splitRoyalty } from '../../src/utils/bn';

describe('marketplace order book', () => {
  let engine: TestEngine;

  beforeAll(async () => {
    engine = await TestEngine.create();
    await engine.execOk(
      'create',
      {
        symbol: 'DRAGON',
        name: 'Dragons',
        maxSupply: '50',
        royaltyBps: '750',
      },
      active('creator'),
      { height: 100 },
    );
    await engine.execOk('addProperty', { symbol: 'DRAGON', name: 'age', type: 'number' }, active('creator'), {
      height: 100 },
    );
    await engine.execOk(
      'issue',
      { symbol: 'DRAGON', to: 'seller', properties: { age: 5 } },
      active('creator'),
      { height: 101 },
    );
    // second instance used for negative-path listing tests (never listed)
    await engine.execOk('issue', { symbol: 'DRAGON', to: 'seller' }, active('creator'), { height: 101 });
    // step 4 settlement: orders settle in an engine token — the buyer pays SCE
    await engine.execOk(
      'create',
      { symbol: 'SCE', name: 'Smart Contract Engine', precision: 3 },
      active('creator'),
      { height: 99 },
      'tokens',
    );
    await engine.execOk(
      'issue',
      { symbol: 'SCE', to: 'buyer', quantity: '100' },
      active('creator'),
      { height: 99 },
      'tokens',
    );
  });

  afterAll(async () => {
    await engine.dispose();
  });

  it('splits royalty deterministically with round-down and exact reconciliation', () => {
    expect(splitRoyalty('12.345', '750')).toEqual({
      price: '12.345',
      royalty: '0.925',
      sellerProceeds: '11.420',
    });
    expect(splitRoyalty('1.000', '333')).toEqual({
      price: '1',
      royalty: '0.033',
      sellerProceeds: '0.967',
    });
    expect(splitRoyalty('0.001', '10000')).toEqual({
      price: '0.001',
      royalty: '0.001',
      sellerProceeds: '0.000',
    });
    expect(splitRoyalty('100', '0')).toEqual({
      price: '100',
      royalty: '0.000',
      sellerProceeds: '100.000',
    });
  });

  it('places an order, links it to the instance and snapshots royalties', async () => {
    const outcome = await engine.execOk(
      'placeOrder',
      { symbol: 'DRAGON', id: '1', price: '12.345' },
      active('seller'),
      { height: 102 },
    );
    expect(outcome.events.some((e) => e.type === 'ORDER_PLACED')).toBe(true);

    const order = await engine.order('ORD-00000001');
    expect(order).toMatchObject({
      seller: 'seller',
      // wiki-style reference: numeric id scoped to the symbol
      instanceId: 'DRAGON:1',
      price: '12.345',
      // priceSymbol defaults to the genesis fee token
      priceSymbol: 'SCE',
      status: 'OPEN',
      royaltyBps: '750',
      royaltyRecipient: 'creator',
      settlement: null,
    });
    expect(await engine.instance('DRAGON:1')).toMatchObject({ listedOrderId: 'ORD-00000001' });

    const meta = await engine.store.get('meta', 'order_seq');
    expect(meta).toBe('1');
  });

  it('blocks transfers and double listings while an instance is listed', async () => {
    const transfer = await engine.execFail(
      'transfer',
      { to: 'buyer', nfts: [{ symbol: 'DRAGON', ids: ['1'] }] },
      active('seller'),
    );
    expect(transfer.log.error?.code).toBe('INSTANCE_LISTED');

    const relist = await engine.execFail(
      'placeOrder',
      { symbol: 'DRAGON', id: '1', price: '1.000' },
      active('seller'),
    );
    expect(relist.log.error?.code).toBe('ALREADY_LISTED');
  });

  it('rejects invalid prices and non-owner listings', async () => {
    const badPrice = await engine.execFail(
      'placeOrder',
      { symbol: 'DRAGON', id: '2', price: '0' },
      active('seller'),
    );
    expect(badPrice.log.error?.code).toBe('BAD_PRICE');

    const notOwner = await engine.execFail(
      'placeOrder',
      { symbol: 'DRAGON', id: '2', price: '1.000' },
      active('intruder'),
    );
    expect(notOwner.log.error?.code).toBe('NOT_AUTHORIZED');
  });

  it('only the seller (with active authority) can cancel', async () => {
    const byOther = await engine.execFail('cancelOrder', { orderId: 'ORD-00000001' }, active('buyer'));
    expect(byOther.log.error?.code).toBe('NOT_AUTHORIZED');

    await engine.execOk('cancelOrder', { orderId: 'ORD-00000001' }, active('seller'), { height: 103 });
    expect(await engine.order('ORD-00000001')).toMatchObject({ status: 'CANCELLED' });
    expect(await engine.instance('DRAGON:1')).toMatchObject({ listedOrderId: null });

    // listing is free again and order ids keep increasing
    await engine.execOk(
      'placeOrder',
      { symbol: 'DRAGON', id: '1', price: '12.345' },
      active('seller'),
      { height: 104 },
    );
    expect(await engine.order('ORD-00000002')).toMatchObject({ status: 'OPEN' });
  });

  it('fills an order, transfers the instance and settles balances atomically', async () => {
    const selfFill = await engine.execFail('fillOrder', { orderId: 'ORD-00000002' }, active('seller'));
    expect(selfFill.log.error?.code).toBe('NOT_AUTHORIZED');

    const outcome = await engine.execOk('fillOrder', { orderId: 'ORD-00000002' }, active('buyer'), {
      height: 105,
    });
    const filledEvent = outcome.events.find((e) => e.type === 'ORDER_FILLED');
    expect(filledEvent).toMatchObject({
      price: '12.345',
      priceSymbol: 'SCE',
      royalty: '0.925',
      fee: '0.000',
      sellerProceeds: '11.420',
    });

    const order = await engine.order('ORD-00000002');
    expect(order).toMatchObject({
      status: 'FILLED',
      fillBy: 'buyer',
      filledAtBlock: 105,
      settlement: {
        price: '12.345',
        royalty: '0.925',
        fee: '0.000',
        sellerProceeds: '11.420',
        royaltyRecipient: 'creator',
        buyer: 'buyer',
        seller: 'seller',
      },
    });

    expect(await engine.instance('DRAGON:1')).toMatchObject({
      owner: 'buyer',
      previousAccount: 'seller',
      listedOrderId: null,
      properties: { age: 5 },
    });

    // step 4: the price actually moved (fee schedule still at its genesis zeros)
    expect(await engine.balance('buyer', 'SCE')).toMatchObject({ quantity: '87.655' });
    expect(await engine.balance('seller', 'SCE')).toMatchObject({ quantity: '11.42' });
    expect(await engine.balance('creator', 'SCE')).toMatchObject({ quantity: '0.925' });
    expect(await engine.balance('steempro.com', 'SCE')).toBeNull();

    const doubleFill = await engine.execFail('fillOrder', { orderId: 'ORD-00000002' }, active('mallory'));
    expect(doubleFill.log.error?.code).toBe('ORDER_NOT_OPEN');
  });

  it('routes the fillOrderFeeBps cut to the treasury out of the sale price', async () => {
    await engine.execOk(
      'setParam',
      { fees: { fillOrderFeeBps: '200' } },
      active('steempro.com'),
      { height: 106 },
      'engine',
    );
    await engine.execOk(
      'placeOrder',
      { symbol: 'DRAGON', id: '2', price: '12.345' },
      active('seller'),
      { height: 107 },
    );
    const outcome = await engine.execOk('fillOrder', { orderId: 'ORD-00000003' }, active('buyer'), {
      height: 108,
    });

    // 12.345 * 2% = 0.2469 -> precision 3, rounded down
    const order = await engine.order('ORD-00000003');
    expect(order?.settlement).toMatchObject({
      price: '12.345',
      royalty: '0.925',
      fee: '0.246',
      sellerProceeds: '11.174',
    });
    expect(outcome.events.find((e) => e.type === 'ORDER_FILLED')).toMatchObject({ fee: '0.246' });

    expect(await engine.balance('buyer', 'SCE')).toMatchObject({ quantity: '75.31' });
    expect(await engine.balance('seller', 'SCE')).toMatchObject({ quantity: '22.594' });
    expect(await engine.balance('creator', 'SCE')).toMatchObject({ quantity: '1.85' });
    expect(await engine.balance('steempro.com', 'SCE')).toMatchObject({ quantity: '0.246' });
  });

  it('fails the whole fill when the buyer cannot afford it (no partial effects)', async () => {
    await engine.execOk(
      'placeOrder',
      { symbol: 'DRAGON', id: '1', price: '50.000' },
      active('buyer'),
      { height: 109 },
    );
    const orderId = 'ORD-00000004';
    const fill = await engine.execFail('fillOrder', { orderId }, active('stranger'), { height: 110 });
    expect(fill.log.error?.code).toBe('INSUFFICIENT_BALANCE');

    // nothing moved: order still open, NFT still with the seller, treasury untouched
    expect(await engine.order(orderId)).toMatchObject({ status: 'OPEN', settlement: null });
    expect(await engine.instance('DRAGON:1')).toMatchObject({
      owner: 'buyer',
      listedOrderId: orderId,
    });
    expect(await engine.balance('stranger', 'SCE')).toBeNull();
    expect(await engine.balance('steempro.com', 'SCE')).toMatchObject({ quantity: '0.246' });
  });

  it('prices orders in an explicit token and enforces its precision', async () => {
    await engine.execOk(
      'create',
      { symbol: 'GOLD', name: 'Gold Bars', precision: 2 },
      active('creator'),
      { height: 111 },
      'tokens',
    );

    const unknownToken = await engine.execFail(
      'placeOrder',
      { symbol: 'DRAGON', id: '2', price: '1.00', priceSymbol: 'NOPE' },
      active('buyer'),
      { height: 112 },
    );
    expect(unknownToken.log.error?.code).toBe('TOKEN_NOT_FOUND');

    const tooPrecise = await engine.execFail(
      'placeOrder',
      { symbol: 'DRAGON', id: '2', price: '5.555', priceSymbol: 'GOLD' },
      active('buyer'),
      { height: 112 },
    );
    expect(tooPrecise.log.error?.code).toBe('BAD_PRICE');

    await engine.execOk(
      'placeOrder',
      { symbol: 'DRAGON', id: '2', price: '5.55', priceSymbol: 'GOLD' },
      active('buyer'),
      { height: 113 },
    );
    expect(await engine.order('ORD-00000005')).toMatchObject({
      status: 'OPEN',
      price: '5.55',
      priceSymbol: 'GOLD',
    });
  });

  it('keeps supply untouched by trades (ownership only moves)', async () => {
    const collection = await engine.collection('DRAGON');
    expect(collection).toMatchObject({ supply: '2', burned: '0', circulatingSupply: '2' });
  });
});
