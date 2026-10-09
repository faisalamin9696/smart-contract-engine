import { WebSocketServer, WebSocket, type RawData } from 'ws';

import { channelsFor, type EngineEventBus, type EventChannel } from '../indexer/events';
import type { EngineEvent } from '../types/domain';
import type { Logger } from '../logger';

export interface WsHubOptions {
  port: number;
  host?: string;
  /** Reject oversized frames (defence against memory exhaustion). */
  maxPayloadBytes?: number;
  /** Dead-peer detection interval. */
  heartbeatMs?: number;
  /** Upper bound on channels a single socket may subscribe to. */
  maxSubscriptions?: number;
  /** Hard cap on simultaneous connected clients (0/undefined = unlimited). */
  maxClients?: number;
}

const ACCOUNT_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const SYMBOL_RE = /^[A-Z][A-Z0-9]{2,11}$/;

/**
 * Validates a channel name.
 *
 * Accepted: `*`, `market`, `chain`, `account:<name>`, `collection:<symbol>`,
 * `token:<symbol>`.
 * Anything else is rejected up front so a client cannot flood the bus with garbage
 * listeners.
 */
export function isValidChannel(channel: unknown): channel is EventChannel {
  if (channel === '*' || channel === 'market' || channel === 'chain') return true;
  if (typeof channel !== 'string') return false;
  if (channel.startsWith('account:')) return ACCOUNT_RE.test(channel.slice(8));
  if (channel.startsWith('collection:')) return SYMBOL_RE.test(channel.slice(11));
  if (channel.startsWith('token:')) return SYMBOL_RE.test(channel.slice(6));
  return false;
}

type ClientMessage =
  | { type: 'subscribe'; channels: string[] }
  | { type: 'unsubscribe'; channels: string[] }
  | { type: 'ping' };

/**
 * Real-time notification server.
 *
 * Contract (JSON frames, one object per message):
 *   -> {"type":"subscribe","channels":["account:alice","market"]}
 *   <- {"type":"welcome","server":{...},"channels":["account:alice","market"]}
 *   <- {"type":"subscribed","channels":["account:alice","market"]}
 *   <- {"type":"event","channels":["account:alice"],"event":{...}}
 *   -> {"type":"ping"}  <-  {"type":"pong","timestamp":"..."}
 *
 * Delivery is at-most-once and purely a view of events the indexer has *already*
 * committed: a socket never observes an event for a block that later rolled back.
 */
export class WebSocketHub {
  private readonly wss: WebSocketServer;
  private readonly subscriptions = new Map<WebSocket, Set<EventChannel>>();
  private readonly maxPayload: number;
  private readonly heartbeatMs: number;
  private readonly maxSubs: number;
  private readonly maxClients: number;
  private readonly unsubscribeBus: () => void;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly log: Logger;
  /** Resolves once the socket is accepting connections; rejects if the port is taken. */
  readonly ready: Promise<void>;

  constructor(
    private readonly bus: EngineEventBus,
    private readonly opts: WsHubOptions,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'ws' });
    this.maxPayload = opts.maxPayloadBytes ?? 64 * 1024;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.maxSubs = opts.maxSubscriptions ?? 100;
    this.maxClients = opts.maxClients ?? 0;
    this.wss = new WebSocketServer({
      port: opts.port,
      host: opts.host,
      maxPayload: this.maxPayload,
      perMessageDeflate: false,
    });

    this.ready = new Promise<void>((resolve, reject) => {
      if (this.wss.address()) {
        resolve();
        return;
      }
      this.wss.once('listening', () => resolve());
      this.wss.once('error', (error) => reject(error));
    });

    this.wss.on('connection', (socket, request) =>
      this.onConnection(socket, request.socket.remoteAddress ?? 'unknown'),
    );
    this.wss.on('error', (error) => this.log.error('ws server error', { error: error.message }));

    // One bus listener for the whole hub; fan-out to sockets happens in memory.
    this.unsubscribeBus = this.bus.onEvent((event) => this.fanout(event));
  }

  get port(): number | null {
    const address = this.wss.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  get clientCount(): number {
    return this.subscriptions.size;
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.unsubscribeBus();
    for (const socket of this.subscriptions.keys()) {
      socket.removeAllListeners();
      try {
        socket.close(1001, 'server shutting down');
      } catch {
        /* already gone */
      }
    }
    this.subscriptions.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /* --------------------------------------------------------------- internals */

  private onConnection(socket: WebSocket, remote: string): void {
    if (this.maxClients > 0 && this.subscriptions.size >= this.maxClients) {
      // Shed load before registering: beyond the cap we refuse rather than degrade
      // service for everyone already connected.
      this.log.warn('ws connection refused (client cap reached)', { remote, cap: this.maxClients });
      try {
        socket.close(1013, 'server at connection capacity');
      } catch {
        socket.terminate();
      }
      return;
    }
    this.subscriptions.set(socket, new Set());
    this.log.debug('ws client connected', { remote });

    this.send(socket, {
      type: 'welcome',
      timestamp: new Date().toISOString(),
      channels: ['*', 'account:<name>', 'collection:<SYMBOL>', 'token:<SYMBOL>', 'market', 'chain'],
      protocol: { subscribe: 'subscribe', unsubscribe: 'unsubscribe', ping: 'ping' },
    });

    socket.on('message', (raw) => this.onMessage(socket, raw));
    socket.on('pong', () => {
      (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
    socket.on('close', () => {
      this.subscriptions.delete(socket);
      this.log.debug('ws client disconnected', { remote });
    });
    socket.on('error', (error) => {
      this.log.warn('ws client error', { remote, error: error.message });
      this.subscriptions.delete(socket);
      socket.terminate();
    });

    (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
    this.ensureHeartbeat();
  }

  private onMessage(socket: WebSocket, raw: RawData): void {
    let parsed: ClientMessage;
    try {
      const text = raw.toString();
      if (text.length > this.maxPayload) throw new Error('payload too large');
      parsed = JSON.parse(text) as ClientMessage;
    } catch (error) {
      this.send(socket, { type: 'error', message: `invalid message: ${(error as Error).message}` });
      return;
    }

    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      this.send(socket, { type: 'error', message: 'message must be an object with a "type"' });
      return;
    }

    switch (parsed.type) {
      case 'ping':
        this.send(socket, { type: 'pong', timestamp: new Date().toISOString() });
        return;

      case 'subscribe':
      case 'unsubscribe': {
        const channels = parsed.channels;
        if (!Array.isArray(channels) || channels.length === 0) {
          this.send(socket, { type: 'error', message: 'channels must be a non-empty array' });
          return;
        }
        const invalid = channels.filter((c) => !isValidChannel(c));
        if (invalid.length > 0) {
          this.send(socket, { type: 'error', message: `invalid channels: ${invalid.join(', ')}` });
          return;
        }
        const subs = this.subscriptions.get(socket);
        if (!subs) return;

        if (parsed.type === 'subscribe') {
          if (subs.size + channels.length > this.maxSubs) {
            this.send(socket, { type: 'error', message: `subscription limit is ${this.maxSubs}` });
            return;
          }
          for (const channel of channels) subs.add(channel as EventChannel);
        } else {
          for (const channel of channels) subs.delete(channel as EventChannel);
        }
        this.send(socket, { type: 'subscribed', channels: [...subs] });
        return;
      }

      default: {
        // Union exhausted above — captured for a useful error message only.
        const type = (parsed as { type?: unknown }).type;
        this.send(socket, { type: 'error', message: `unknown message type: ${String(type)}` });
      }
    }
  }

  private fanout(event: EngineEvent): void {
    const eventChannels = channelsFor(event);
    const payload = JSON.stringify({ type: 'event', channels: eventChannels, event });
    for (const [socket, subs] of this.subscriptions) {
      if (subs.size === 0) continue;
      const matched =
        subs.has('*') || eventChannels.some((channel) => subs.has(channel));
      if (!matched) continue;
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  private send(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this.log.warn('ws send failed', { error: (error as Error).message });
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [socket] of this.subscriptions) {
        const probe = socket as WebSocket & { isAlive?: boolean };
        if (probe.isAlive === false) {
          this.subscriptions.delete(socket);
          socket.terminate();
          continue;
        }
        probe.isAlive = false;
        try {
          socket.ping();
        } catch {
          this.subscriptions.delete(socket);
          socket.terminate();
        }
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }
}
