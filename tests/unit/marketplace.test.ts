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

  it('fills an order, transfers the instance and settles royalty to the creator', async () => {
    const selfFill = await engine.execFail('fillOrder', { orderId: 'ORD-00000002' }, active('seller'));
    expect(selfFill.log.error?.code).toBe('NOT_AUTHORIZED');

    const outcome = await engine.execOk('fillOrder', { orderId: 'ORD-00000002' }, active('buyer'), {
      height: 105,
    });
    const filledEvent = outcome.events.find((e) => e.type === 'ORDER_FILLED');
    expect(filledEvent).toMatchObject({ price: '12.345', royalty: '0.925', sellerProceeds: '11.420' });

    const order = await engine.order('ORD-00000002');
    expect(order).toMatchObject({
      status: 'FILLED',
      fillBy: 'buyer',
      filledAtBlock: 105,
      settlement: {
        price: '12.345',
        royalty: '0.925',
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

    const doubleFill = await engine.execFail('fillOrder', { orderId: 'ORD-00000002' }, active('mallory'));
    expect(doubleFill.log.error?.code).toBe('ORDER_NOT_OPEN');
  });

  it('keeps supply untouched by trades (ownership only moves)', async () => {
    const collection = await engine.collection('DRAGON');
    expect(collection).toMatchObject({ supply: '2', burned: '0', circulatingSupply: '2' });
  });
});
