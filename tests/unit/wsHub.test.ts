import { WebSocket } from 'ws';

import { EngineEventBus } from '../../src/indexer/events';
import type { Logger } from '../../src/logger';
import { WebSocketHub } from '../../src/api/ws';

/**
 * Adversarial WebSocket hub tests (white-hat pass).
 *
 * The push surface is the only engine endpoint that accepts unauthenticated,
 * attacker-shaped *binary* input at high frequency. These cases pin the hostile
 * paths: malformed frames, prototype-flavoured channel names, subscription floods,
 * oversize payloads and connection floods.
 */

function makeSilentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

const silentLogger = makeSilentLogger();

interface Frame {
  type?: string;
  message?: string;
  channels?: string[];
  server?: unknown;
}

/**
 * Test client that buffers frames from construction time.
 *
 * The `ws` client can emit `message` synchronously in the same tick as `open`
 * (the server's welcome rides on the handshake packet), so listeners attached
 * after `await open` would miss it — a test harness race, not a hub defect.
 */
class TestClient {
  readonly socket: WebSocket;
  readonly closed: Promise<number>;
  private readonly frames: Frame[] = [];
  private readonly waiters: Array<(frame: Frame) => void> = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`);
    this.socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    });
    this.closed = new Promise<number>((resolve) => {
      this.socket.once('close', (code) => resolve(code));
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState === WebSocket.OPEN) return resolve();
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  next(): Promise<Frame> {
    const buffered = this.frames.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<Frame>((resolve, reject) => {
      this.waiters.push(resolve);
      this.socket.once('error', reject);
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function connect(port: number): Promise<TestClient> {
  const client = new TestClient(port);
  await client.open();
  return client;
}

describe('security: websocket hub under hostile frames', () => {
  let hub: WebSocketHub;
  let port: number;

  beforeAll(async () => {
    hub = new WebSocketHub(
      new EngineEventBus(),
      {
        port: 0, // ephemeral
        maxPayloadBytes: 1024,
        maxSubscriptions: 2,
        maxClients: 2,
        heartbeatMs: 60_000,
      },
      silentLogger,
    );
    await hub.ready;
    port = hub.port ?? 0;
    expect(port).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await hub.close();
  });

  it('greets with a welcome frame and answers ping', async () => {
    const client = await connect(port);
    const welcome = await client.next();
    expect(welcome.type).toBe('welcome');
    client.socket.send(JSON.stringify({ type: 'ping' }));
    const pong = await client.next();
    expect(pong.type).toBe('pong');
    client.close();
  });

  it('rejects malformed JSON and non-object frames', async () => {
    const client = await connect(port);
    await client.next(); // welcome
    client.socket.send('{{{not json');
    const first = await client.next();
    expect(first.type).toBe('error');
    expect(first.message).toContain('invalid message');
    client.socket.send('42');
    const second = await client.next();
    expect(second.type).toBe('error');
    expect(second.message).toContain('must be an object');
    client.close();
  });

  it('rejects prototype-flavoured and malformed channel names', async () => {
    const client = await connect(port);
    await client.next(); // welcome
    client.socket.send(
      JSON.stringify({
        type: 'subscribe',
        channels: ['__proto__', 'account:ALICE', 'collection:lower', 'constructor', 'account:a'],
      }),
    );
    const reply = await client.next();
    expect(reply.type).toBe('error');
    expect(reply.message).toContain('invalid channels');
    // The one valid channel in the batch must not have been registered either:
    // hostile batches are rejected wholesale, never partially applied.
    client.socket.send(JSON.stringify({ type: 'subscribe', channels: ['account:alice'] }));
    const ok = await client.next();
    expect(ok.type).toBe('subscribed');
    expect(ok.channels).toEqual(['account:alice']);
    client.close();
  });

  it('caps the number of subscriptions per socket', async () => {
    const client = await connect(port);
    await client.next(); // welcome
    client.socket.send(JSON.stringify({ type: 'subscribe', channels: ['account:alice', 'market'] }));
    await client.next(); // subscribed (2/2)
    client.socket.send(JSON.stringify({ type: 'subscribe', channels: ['chain'] }));
    const reply = await client.next();
    expect(reply.type).toBe('error');
    expect(reply.message).toContain('subscription limit is 2');
    client.close();
  });

  it('rejects unknown message types', async () => {
    const client = await connect(port);
    await client.next(); // welcome
    client.socket.send(JSON.stringify({ type: 'eval', code: 'process.exit()' }));
    const reply = await client.next();
    expect(reply.type).toBe('error');
    expect(reply.message).toContain('unknown message type');
    client.close();
  });

  it('drops connections that exceed the frame payload cap', async () => {
    const client = await connect(port);
    await client.next(); // welcome
    // 2 KiB into a 1 KiB maxPayload server: the ws layer must close (1009) rather
    // than buffer the flood.
    client.socket.send(
      JSON.stringify({ type: 'subscribe', channels: ['account:alice'], pad: 'x'.repeat(2048) }),
    );
    expect(await client.closed).toBe(1009);
  });

  it('refuses new connections beyond the client cap', async () => {
    // Wait for earlier sockets to be unregistered server-side so the cap is exact.
    for (let i = 0; i < 100 && hub.clientCount > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(hub.clientCount).toBe(0);
    const first = await connect(port); // occupy slot 1
    await first.next(); // welcome
    const second = await connect(port); // occupy slot 2
    await second.next(); // welcome
    const third = await connect(port);
    expect(await third.closed).toBe(1013);
    first.close();
    second.close();
  });
});
