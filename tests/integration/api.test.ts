import { WebSocket } from 'ws';

import { startApi, type ApiServer } from '../../src/api/server';
import type { Config } from '../../src/config';
import { EngineEventBus } from '../../src/indexer/events';
import { Indexer } from '../../src/indexer/indexer';
import { nullLogger } from '../../src/logger';
import { MemoryStore } from '../../src/state/memoryStore';
import { createSandbox, type Sandbox } from '../../src/vm/sandbox';
import { MockRpc, active, customJsonTx } from '../helpers/chain';

jest.setTimeout(60_000);

const CONFIG: Config = {
  rpcEndpoints: ['http://localhost:1'],
  blockPollIntervalMs: 1000,
  undoBufferDepth: 30,
  opId: 'sce-mainnet1',
  startBlockHeight: 1,
  databaseUrl: null,
  storage: 'memory',
  port: 0, // ephemeral
  wsPort: 0, // ephemeral
  graphqlPath: '/graphql',
  restEnabled: true,
  graphqlEnabled: true,
  sandboxProvider: 'auto',
  sandboxTimeoutMs: 1000,
  sandboxMemoryLimitMb: 128,
  failOnDeepFork: true,
  logLevel: 'info',
  quorumVerifyDepth: 0, // single mock endpoint — nothing to cross-check
  rateLimitRpm: 0, // no limiter in api tests (keeps request-heavy suites deterministic)
  trustProxyHops: 1,
  wsMaxClients: 100,
};

/* ------------------------------------------------------------ fixture chain */

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
const transferTx = customJsonTx(
  { action: 'transfer', params: { to: 'carol', nfts: [{ symbol: 'RAID', ids: ['1'] }] } },
  active('bob'),
);
// step 4: placeOrder settles in a token, so the price token must exist first
const sceTx = customJsonTx(
  {
    contract: 'tokens',
    action: 'create',
    params: { symbol: 'SCE', name: 'Smart Contract Engine', precision: 3 },
  },
  active('alice'),
);
// step 5: give a holder a real balance so the balance reads and WS routing have data
const issueTx = customJsonTx(
  {
    contract: 'tokens',
    action: 'issue',
    params: { symbol: 'SCE', to: 'bob', quantity: '1000' },
  },
  active('alice'),
);
const listTx = customJsonTx(
  { action: 'placeOrder', params: { symbol: 'RAID', id: '1', price: '12.345' } },
  active('carol'),
);
// market contract (fungible book): a base token, a resting sell and a crossing buy
const gldCreateTx = customJsonTx(
  { contract: 'tokens', action: 'create', params: { symbol: 'GLD', name: 'Gold', precision: 2 } },
  active('alice'),
);
const gldIssueTx = customJsonTx(
  { contract: 'tokens', action: 'issue', params: { symbol: 'GLD', to: 'alice', quantity: '100' } },
  active('alice'),
);
const marketSellTx = customJsonTx(
  { contract: 'market', action: 'sell', params: { symbol: 'GLD', quote: 'SCE', quantity: '10', price: '2' } },
  active('alice'),
);
const marketBuyTx = customJsonTx(
  { contract: 'market', action: 'buy', params: { symbol: 'GLD', quote: 'SCE', quantity: '4', price: '2' } },
  active('bob'),
);
// the frontend cancel button: cancels alice's sell remainder (10 rested, 4 filled)
const marketCancelTx = customJsonTx(
  { contract: 'market', action: 'cancel', params: { orderId: 'MKT-00000001' } },
  active('alice'),
);

/* ------------------------------------------------------------ tiny ws client */

interface Frame {
  type: string;
  channels?: string[];
  event?: Record<string, unknown>;
  message?: string;
  timestamp?: string;
}

async function waitFor(predicate: () => boolean, label = 'condition', timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Loose JSON reader: response shapes are asserted with matchers, not static types. */
async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  return response.json();
}

class TestClient {
  readonly frames: Frame[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.frames.push(JSON.parse(data.toString()) as Frame);
    });
  }

  static async connect(url: string, channels: string[] = []): Promise<TestClient> {
    const ws = new WebSocket(url);
    const client = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await waitFor(() => client.frames.some((f) => f.type === 'welcome'), 'welcome frame');
    if (channels.length > 0) {
      ws.send(JSON.stringify({ type: 'subscribe', channels }));
      await waitFor(
        () => client.frames.some((f) => f.type === 'subscribed'),
        'subscribed frame',
      );
    }
    return client;
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  events(type?: string): Record<string, unknown>[] {
    return this.frames
      .filter((f) => f.type === 'event' && (!type || f.event?.type === type))
      .map((f) => f.event as Record<string, unknown>);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
      setTimeout(resolve, 1000).unref?.();
    });
  }
}

/* ------------------------------------------------------------------- suite */

describe('HTTP (REST + GraphQL) and WebSocket API', () => {
  let store: MemoryStore;
  let sandbox: Sandbox;
  let indexer: Indexer;
  let api: ApiServer;
  let rpc: MockRpc;
  let star: TestClient;
  let carol: TestClient;
  let tokenWatcher: TestClient;
  let marketWatcher: TestClient;
  let base: string;
  let wsUrl: string;

  beforeAll(async () => {
    rpc = new MockRpc();
    rpc.mine({ transactions: [createTx] });
    rpc.mine({ transactions: [mintBobTx] });
    rpc.mine({ transactions: [transferTx] });
    rpc.mine({ transactions: [sceTx, issueTx, listTx] });
    rpc.mine({ transactions: [gldCreateTx, gldIssueTx, marketSellTx, marketBuyTx] });

    store = new MemoryStore();
    sandbox = await createSandbox({ provider: 'node-vm', timeoutMs: 1000, memoryLimitMb: 128 });
    const bus = new EngineEventBus();
    indexer = new Indexer(
      store,
      rpc,
      sandbox,
      bus,
      {
        pollIntervalMs: 1000,
        undoBufferDepth: 30,
        opId: 'sce-mainnet1',
        startBlockHeight: 1,
        failOnDeepFork: true,
      },
      nullLogger,
    );

    api = await startApi({
      config: CONFIG,
      store,
      indexer,
      bus,
      storage: 'memory',
      logger: nullLogger,
    });
    base = `http://127.0.0.1:${api.port}`;
    wsUrl = `ws://127.0.0.1:${api.wsPort}`;

    // Subscribe *before* ingestion so the notifications are observed as they commit.
    star = await TestClient.connect(wsUrl, ['*']);
    carol = await TestClient.connect(wsUrl, ['account:carol']);
    tokenWatcher = await TestClient.connect(wsUrl, ['token:SCE']);
    marketWatcher = await TestClient.connect(wsUrl, ['market']);

    await indexer.catchUp();
  });

  afterAll(async () => {
    await star?.close();
    await carol?.close();
    await tokenWatcher?.close();
    await marketWatcher?.close();
    await api?.close();
    await sandbox?.dispose();
    await store?.close();
  });

  it('serves a health probe and engine status', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      storage: 'memory',
      indexer: { running: false, cursorHeight: 5, opId: 'sce-mainnet1' },
    });

    const status = await fetch(`${base}/api/v1/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      data: { cursorHeight: 5, storage: 'memory', headHeight: 5, opId: 'sce-mainnet1' },
    });
  });

  it('answers REST reads over indexed projections', async () => {
    // Public-API surface: any origin may read it, and every response (even
    // errors) carries the baseline security headers.
    const bare = await fetch(`${base}/api/v1/collections`);
    expect(bare.headers.get('access-control-allow-origin')).toBe('*');
    expect(bare.headers.get('x-content-type-options')).toBe('nosniff');
    expect(bare.headers.get('x-frame-options')).toBe('DENY');
    expect(bare.headers.get('x-powered-by')).toBeNull();

    const collections = await getJson(`${base}/api/v1/collections`);
    expect(collections.data).toHaveLength(1);
    expect(collections.data[0]).toMatchObject({
      symbol: 'RAID',
      supply: '1',
      circulatingSupply: '1',
      issuer: 'alice',
    });

    const inventory = await getJson(`${base}/api/v1/collections/RAID/instances`);
    expect(inventory.data).toHaveLength(1);
    expect(inventory.data[0]).toMatchObject({
      id: '1',
      owner: 'carol',
      listedOrderId: 'ORD-00000001',
    });

    // wiki ids are per-symbol: both the composite reference and the two-segment form work
    const composite = await getJson(`${base}/api/v1/instances/RAID:1`);
    expect(composite.data).toMatchObject({ id: '1', owner: 'carol' });
    const byPair = await getJson(`${base}/api/v1/instances/RAID/1`);
    expect(byPair.data).toMatchObject({ id: '1', owner: 'carol' });
    const unknownPair = await fetch(`${base}/api/v1/instances/RAID/99999999`);
    expect(unknownPair.status).toBe(404);

    const byOwner = await getJson(`${base}/api/v1/instances?owner=carol`);
    expect(byOwner.meta.total).toBe(1);

    const account = await getJson(`${base}/api/v1/accounts/carol`);
    expect(account.data).toMatchObject({ name: 'carol', instanceCount: 1 });

    const orders = await getJson(`${base}/api/v1/orders?status=OPEN`);
    expect(orders.data).toHaveLength(1);
    expect(orders.data[0]).toMatchObject({
      id: 'ORD-00000001',
      instanceId: 'RAID:1',
      price: '12.345',
      royaltyBps: '1000',
      status: 'OPEN',
    });

    const logs = await getJson(`${base}/api/v1/logs?actor=alice`);
    // alice created the RAID collection, created both price/base tokens, issued both
    // test supplies and placed the resting market sell — every row an applied op
    expect(logs.data).toHaveLength(6);
    expect(logs.data.every((l: { status: string }) => l.status === 'APPLIED')).toBe(true);
    expect(logs.data.filter((l: { action: string }) => l.action === 'create')).toHaveLength(3);
    expect(logs.data.some((l: { action: string }) => l.action === 'issue')).toBe(true);

    const block = await getJson(`${base}/api/v1/blocks/2`);
    expect(block.data).toMatchObject({ height: 2, txCount: 1 });
  });

  it('reads fungible tokens, balances and params over REST', async () => {
    const tokens = await getJson(`${base}/api/v1/tokens`);
    expect(tokens.data).toHaveLength(2);
    expect(tokens.data.map((t: { symbol: string }) => t.symbol)).toEqual(['GLD', 'SCE']);
    expect(tokens.data[1]).toMatchObject({
      symbol: 'SCE',
      name: 'Smart Contract Engine',
      precision: 3,
      maxSupply: '0', // 0 = unlimited
      supply: '1000',
      issuer: 'alice',
      icon: '', // read-side projection of empty metadata
    });

    const token = await getJson(`${base}/api/v1/tokens/SCE`);
    expect(token.data).toMatchObject({ symbol: 'SCE', metadata: '', icon: '' });

    const unknown = await fetch(`${base}/api/v1/tokens/NOPE`);
    expect(unknown.status).toBe(404);

    const balances = await getJson(`${base}/api/v1/balances?account=bob`);
    expect(balances.data).toHaveLength(2);
    // bob's SCE paid the buy escrow (4 x 2 = 8) and the fill delivered 4 GLD
    expect(balances.data.map((b: { symbol: string }) => b.symbol)).toEqual(['GLD', 'SCE']);
    expect(balances.data[0]).toMatchObject({ account: 'bob', symbol: 'GLD', quantity: '4' });
    expect(balances.data[1]).toMatchObject({ account: 'bob', symbol: 'SCE', quantity: '992' });
    expect(balances.meta.total).toBe(2);

    const filtered = await getJson(`${base}/api/v1/balances?account=bob&symbol=RAID`);
    expect(filtered.data).toHaveLength(0);

    const params = await getJson(`${base}/api/v1/params`);
    expect(params.data).toMatchObject({
      admin: 'steempro.com',
      treasury: 'steempro.com',
      feeTokens: ['SCE'],
      fees: { tokenCreationFee: '0', fillOrderFeeBps: '0' },
    });
  });

  it('rejects bad input and unknown routes with JSON errors', async () => {
    const missing = await fetch(`${base}/api/v1/instances/RAID-99999999`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const badEnum = await fetch(`${base}/api/v1/orders?status=NOPE`);
    expect(badEnum.status).toBe(400);
    expect(await badEnum.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });

    const badLimit = await fetch(`${base}/api/v1/collections?limit=0`);
    expect(badLimit.status).toBe(400);

    // balances is account-scoped by design — no global dump
    const noAccount = await fetch(`${base}/api/v1/balances`);
    expect(noAccount.status).toBe(400);
    expect(await noAccount.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });

    const noRoute = await fetch(`${base}/api/v1/nope`);
    expect(noRoute.status).toBe(404);
  });

  it('answers GraphQL queries over the same state', async () => {
    const query = /* GraphQL */ `
      {
        collections {
          symbol
          supply
          circulatingSupply
          royaltyBps
          instanceCount
          instances {
            id
            owner
            listedOrderId
            previousAccount
          }
        }
        orders(status: OPEN) {
          id
          instanceId
          price
          status
          instance {
            id
          }
        }
        instance(id: "RAID:1") {
          id
          owner
        }
        status {
          opId
          storage
          cursorHeight
          sandbox
        }
      }
    `;
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
    expect(body.errors).toBeUndefined();
    expect(body.data).toMatchObject({
      collections: [
        {
          symbol: 'RAID',
          supply: '1',
          circulatingSupply: '1',
          royaltyBps: '1000',
          instanceCount: 1,
          instances: [{ id: '1', owner: 'carol', listedOrderId: 'ORD-00000001', previousAccount: 'bob' }],
        },
      ],
      orders: [
        { id: 'ORD-00000001', instanceId: 'RAID:1', price: '12.345', status: 'OPEN', instance: { id: '1' } },
      ],
      instance: { id: '1', owner: 'carol' },
      status: { opId: 'sce-mainnet1', storage: 'memory', cursorHeight: 5 },
    });
  });

  it('rejects an alias bomb before any resolver runs', async () => {
    // 51 aliased copies of a 100-row list field — above MAX_QUERY_ALIASES (50).
    const fields = Array.from({ length: 51 }, (_, i) => `q${i}: collections { symbol }`);
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ ${fields.join(' ')} }` }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors?: { message?: string }[] };
    // Apollo stamps validation-phase errors `GRAPHQL_VALIDATION_FAILED`; the
    // tell-tale is our analyzer's message (no resolver ran, no data key).
    expect(body.errors?.[0]?.message).toContain('query rejected:');
    expect((body as { data?: unknown }).data).toBeUndefined();
  });

  it('answers fungible token queries over GraphQL', async () => {
    const query = /* GraphQL */ `
      {
        tokens(issuer: "alice") {
          symbol
          precision
          supply
          maxSupply
          issuer
        }
        token(symbol: "SCE") {
          name
          metadata
          icon
        }
        balances(account: "bob") {
          account
          symbol
          quantity
        }
        params {
          admin
          treasury
          fees {
            tokenCreationFee
            fillOrderFeeBps
          }
          feeTokens
        }
      }
    `;
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
    expect(body.errors).toBeUndefined();
    expect(body.data).toMatchObject({
      tokens: [
        { symbol: 'GLD', precision: 2, supply: '100', maxSupply: '0', issuer: 'alice' },
        { symbol: 'SCE', precision: 3, supply: '1000', maxSupply: '0', issuer: 'alice' },
      ],
      token: { name: 'Smart Contract Engine', metadata: '', icon: '' },
      balances: [
        { account: 'bob', symbol: 'GLD', quantity: '4' },
        { account: 'bob', symbol: 'SCE', quantity: '992' },
      ],
      params: {
        admin: 'steempro.com',
        treasury: 'steempro.com',
        fees: { tokenCreationFee: '0', fillOrderFeeBps: '0' },
        feeTokens: ['SCE'],
      },
    });
  });

  it('serves the fungible market book, depth and trades over REST', async () => {
    const open = await getJson(`${base}/api/v1/market/orders?status=OPEN`);
    expect(open.data).toHaveLength(1);
    expect(open.data[0]).toMatchObject({
      id: 'MKT-00000001',
      account: 'alice',
      side: 'SELL',
      symbol: 'GLD',
      quote: 'SCE',
      quantity: '6', // 10 rested, 4 filled by the crossing buy
      filled: '4',
      price: '2',
      escrow: '6',
      status: 'OPEN',
    });

    const single = await getJson(`${base}/api/v1/market/orders/MKT-00000002`);
    expect(single.data).toMatchObject({ side: 'BUY', status: 'FILLED', quantity: '0', escrow: '0' });

    const missing = await fetch(`${base}/api/v1/market/orders/MKT-99999999`);
    expect(missing.status).toBe(404);

    const depth = await getJson(`${base}/api/v1/market/book?symbol=GLD&quote=SCE`);
    expect(depth.data.asks).toEqual([{ price: '2', quantity: '6', orders: 1 }]);
    expect(depth.data.bids).toEqual([]);

    const trades = await getJson(`${base}/api/v1/market/trades?symbol=GLD`);
    expect(trades.data).toHaveLength(1);
    expect(trades.data[0]).toMatchObject({
      buyOrderId: 'MKT-00000002',
      sellOrderId: 'MKT-00000001',
      buyer: 'bob',
      seller: 'alice',
      base: 'GLD',
      quote: 'SCE',
      quantity: '4',
      price: '2',
      cost: '8',
      fee: '0',
    });

    const badSide = await fetch(`${base}/api/v1/market/orders?side=NOPE`);
    expect(badSide.status).toBe(400);
    const noPair = await fetch(`${base}/api/v1/market/book?symbol=GLD`);
    expect(noPair.status).toBe(400);
  });

  it('answers market queries over GraphQL', async () => {
    const query = /* GraphQL */ `
      {
        bookOrders(status: OPEN) {
          id
          account
          side
          quantity
          escrow
          status
        }
        book(symbol: "GLD", quote: "SCE") {
          bids {
            price
            quantity
            orders
          }
          asks {
            price
            quantity
            orders
          }
        }
        trades(symbol: "GLD") {
          buyOrderId
          sellOrderId
          buyer
          seller
          quantity
          price
          cost
          fee
        }
        params {
          fees {
            tradeFeeBps
          }
        }
      }
    `;
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
    expect(body.errors).toBeUndefined();
    expect(body.data).toMatchObject({
      bookOrders: [
        { id: 'MKT-00000001', account: 'alice', side: 'SELL', quantity: '6', escrow: '6', status: 'OPEN' },
      ],
      book: { bids: [], asks: [{ price: '2', quantity: '6', orders: 1 }] },
      trades: [
        {
          buyOrderId: 'MKT-00000002',
          sellOrderId: 'MKT-00000001',
          buyer: 'bob',
          seller: 'alice',
          quantity: '4',
          price: '2',
          cost: '8',
          fee: '0',
        },
      ],
      params: { fees: { tradeFeeBps: '0' } },
    });
  });

  it('streams committed events to wildcard subscribers', async () => {
    await waitFor(() => star.events('BLOCK_APPLIED').length >= 4, 'block events');
    expect(star.events('NFT_MINTED')).toHaveLength(1);
    expect(star.events('ORDER_PLACED')).toHaveLength(1);
    expect(star.events()[0]).toMatchObject({ type: expect.any(String) });

    // Every frame must carry the block it belongs to — clients need a cursor.
    for (const event of star.events()) {
      expect(typeof event.block).toBe('number');
      expect(typeof event.timestamp).toBe('string');
    }
  });

  it('delivers only the channels a client subscribed to', async () => {
    await waitFor(() => carol.events().length > 0, 'carol events');
    const types = carol.events().map((e) => e.type as string);
    expect(types).toContain('NFT_RECEIVED');
    expect(types).toContain('ORDER_PLACED');
    // Wildcard-only events must not leak to a narrow subscription.
    expect(types).not.toContain('BLOCK_APPLIED');
    expect(types.every((t) => t !== 'BLOCK_APPLIED' && t !== 'REORG_DETECTED')).toBe(true);
  });

  it('routes fungible token events to the token lane and balance changes per holder', async () => {
    await waitFor(() => tokenWatcher.events('BALANCE_CHANGED').length > 0, 'token lane events');
    const types = tokenWatcher.events().map((e) => e.type as string);
    expect(types).toContain('TOKEN_CREATED');
    expect(types).toContain('TOKEN_ISSUED');
    expect(types).toContain('BALANCE_CHANGED');
    // NFT collection and marketplace activity must not leak into the token lane
    expect(types).not.toContain('NFT_MINTED');
    expect(types).not.toContain('ORDER_PLACED');

    const changed = tokenWatcher.events('BALANCE_CHANGED')[0];
    expect(changed).toMatchObject({
      account: 'bob',
      symbol: 'SCE',
      data: { previous: '0', balance: '1000', action: 'issue' },
    });

    // wildcard subscribers observe the same synthesized balance event
    await waitFor(() => star.events('BALANCE_CHANGED').length > 0, 'star balance events');
  });

  it('routes fungible market activity to the market lane', async () => {
    await waitFor(() => marketWatcher.events('MARKET_FILLED').length > 0, 'market fill events');
    const types = marketWatcher.events().map((e) => e.type as string);
    expect(types).toContain('MARKET_PLACED'); // alice's sell rested on the book
    expect(types).toContain('MARKET_FILLED'); // bob's buy crossed it (maker priority)
    // NFT activity shares the market lane by design (channelsFor pushes it for every
    // symbol-bearing collection event and every ORDER_* listing event); the fungible
    // balance/token lanes must not leak in.
    expect(types).toContain('ORDER_PLACED');
    expect(types).not.toContain('BALANCE_CHANGED');

    const fill = marketWatcher.events('MARKET_FILLED')[0];
    expect(fill).toMatchObject({ symbol: 'GLD', price: '2' });
  });

  it('validates subscriptions and answers pings', async () => {
    const client = await TestClient.connect(wsUrl);

    client.send({ type: 'subscribe', channels: ['not-a-channel'] });
    await waitFor(() => client.frames.some((f) => f.type === 'error'), 'invalid channel error');
    expect(client.frames.find((f) => f.type === 'error')?.message).toContain('invalid channels');

    client.send({ type: 'ping' });
    await waitFor(() => client.frames.some((f) => f.type === 'pong'), 'pong frame');

    client.send({ type: 'subscribe', channels: ['market', 'chain'] });
    await waitFor(
      () => client.frames.some((f) => f.type === 'subscribed' && f.channels?.includes('market')),
      'market subscription',
    );

    await client.close();
  });

  it('cancels the resting sell through the chain and updates row, book, balances and the market lane', async () => {
    // The frontend cancel button, end to end: a Keychain-signed cancel op replays
    // through the real path (chain -> indexer -> VM -> guard -> projections) and
    // must surface everywhere a trading UI looks — order row, open-order list,
    // depth ladder, balances and the `market` WS lane. Deliberately last: the
    // tests above assert the resting OPEN sell this cancels.
    rpc.mine({ transactions: [marketCancelTx] });
    await indexer.catchUp();
    await waitFor(() => marketWatcher.events('MARKET_CANCELLED').length > 0, 'market cancel event');

    const cancel = marketWatcher.events('MARKET_CANCELLED')[0];
    expect(cancel).toMatchObject({
      account: 'alice',
      symbol: 'GLD',
      data: { orderId: 'MKT-00000001', side: 'SELL', quote: 'SCE', refunded: '6', filled: '4' },
    });

    const row = await getJson(`${base}/api/v1/market/orders/MKT-00000001`);
    expect(row.data).toMatchObject({ status: 'CANCELLED', quantity: '0', escrow: '0', filled: '4' });

    const open = await getJson(`${base}/api/v1/market/orders?status=OPEN&symbol=GLD`);
    expect(open.data).toHaveLength(0);
    expect(open.meta.total).toBe(0);

    const depth = await getJson(`${base}/api/v1/market/book?symbol=GLD&quote=SCE`);
    expect(depth.data).toEqual({ bids: [], asks: [] });

    // escrow refund: 100 GLD - 10 placed + 6 refunded = 96; the 8 SCE proceeds of
    // the earlier fill stay with alice (tradeFeeBps defaults to 0).
    const gld = await getJson(`${base}/api/v1/balances?account=alice&symbol=GLD`);
    expect(gld.data[0]).toMatchObject({ account: 'alice', symbol: 'GLD', quantity: '96' });
    const sce = await getJson(`${base}/api/v1/balances?account=alice&symbol=SCE`);
    expect(sce.data[0]).toMatchObject({ quantity: '8' });
  });
});
