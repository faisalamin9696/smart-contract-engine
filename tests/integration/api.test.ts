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
  opId: 'steem_nft_v1',
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
const listTx = customJsonTx(
  { action: 'placeOrder', params: { symbol: 'RAID', id: '1', price: '12.345' } },
  active('carol'),
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
  let base: string;
  let wsUrl: string;

  beforeAll(async () => {
    rpc = new MockRpc();
    rpc.mine({ transactions: [createTx] });
    rpc.mine({ transactions: [mintBobTx] });
    rpc.mine({ transactions: [transferTx] });
    rpc.mine({ transactions: [listTx] });

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
        opId: 'steem_nft_v1',
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

    await indexer.catchUp();
  });

  afterAll(async () => {
    await star?.close();
    await carol?.close();
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
      indexer: { running: false, cursorHeight: 4 },
    });

    const status = await fetch(`${base}/api/v1/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      data: { cursorHeight: 4, storage: 'memory', headHeight: 4 },
    });
  });

  it('answers REST reads over indexed projections', async () => {
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
    expect(logs.data).toHaveLength(1);
    expect(logs.data[0]).toMatchObject({ action: 'create', status: 'APPLIED' });

    const block = await getJson(`${base}/api/v1/blocks/2`);
    expect(block.data).toMatchObject({ height: 2, txCount: 1 });
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
      status: { storage: 'memory', cursorHeight: 4 },
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
});
