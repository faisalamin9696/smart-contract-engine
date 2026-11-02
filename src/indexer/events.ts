import { EventEmitter } from 'node:events';
import type { EngineEvent } from '../types/domain';

export type EventChannel =
  | '*'
  | `account:${string}`
  | `collection:${string}`
  | `token:${string}`
  | 'market'
  | 'chain';

export interface Subscription {
  id: string;
  channel: EventChannel;
}

/** Fan-out bus shared by the indexer (producer) and the WebSocket hub (consumer). */
export class EngineEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many WS clients can subscribe to the same account/collection.
    this.emitter.setMaxListeners(0);
  }

  publish(events: readonly EngineEvent[]): void {
    for (const event of events) {
      this.emitter.emit('event', event);
      for (const channel of channelsFor(event)) {
        this.emitter.emit(channel, event);
      }
    }
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  onChannel(channel: EventChannel, listener: (event: EngineEvent) => void): () => void {
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}

/** Channels a single event should be delivered on. */
export function channelsFor(event: EngineEvent): EventChannel[] {
  const channels: EventChannel[] = ['*'];
  if (event.account) channels.push(`account:${event.account}`);
  const fungible =
    event.type.startsWith('TOKEN_') ||
    event.type.startsWith('BALANCE_') ||
    event.type.startsWith('MARKET_');
  if (event.symbol) {
    if (fungible) {
      // Fungible-token events stay on the token lane — a matching symbol string
      // does not make them NFT collection or marketplace activity. `MARKET_*`
      // events name the traded *base token*, which is fungible.
      channels.push(`token:${event.symbol}`);
    } else {
      channels.push(`collection:${event.symbol}`);
      channels.push('market');
    }
  }
  if (event.type.startsWith('ORDER_') || event.type.startsWith('MARKET_')) channels.push('market');
  if (event.type === 'BLOCK_APPLIED' || event.type.startsWith('REORG')) channels.push('chain');
  return [...new Set(channels)];
}
