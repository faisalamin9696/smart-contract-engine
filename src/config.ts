import dotenv from 'dotenv';

import type { RpcScheduleWindow, RpcStrategy } from './chain/rpc';

dotenv.config();

/**
 * Central, immutable runtime configuration.
 *
 * Every value that can influence consensus-relevant behaviour is parsed here once so
 * that downstream modules never touch `process.env` directly (which keeps execution
 * deterministic and the code testable).
 */
export interface Config {
  readonly rpcEndpoints: string[];
  /**
   * Endpoint selection policy (STEEM_RPC_STRATEGY): `rotate` (default) divides
   * steady-state load round-robin across healthy endpoints; `sticky` pins to the
   * last endpoint that answered. Automatic failover (cooldown + backoff + walk the
   * remaining candidates) applies in both modes.
   */
  readonly rpcStrategy: RpcStrategy;
  /**
   * Time windows (STEEM_RPC_SCHEDULE) pinning all load to one endpoint — e.g. give
   * one node the busy hours. Empty = no pinning. A pinned endpoint that is failing
   * falls back to the regular policy until its cooldown expires.
   */
  readonly rpcSchedule: readonly RpcScheduleWindow[];
  readonly blockPollIntervalMs: number;
  readonly undoBufferDepth: number;
  readonly opId: string;
  readonly startBlockHeight: number | null;
  readonly databaseUrl: string | null;
  /**
   * Which state store to use.
   *  - `auto`     → postgres when DATABASE_URL is set, otherwise memory (dev/demo only)
   *  - `postgres` → require DATABASE_URL and a reachable server; refuse to start otherwise
   *  - `memory`   → explicit in-process store (tests/demo; state is lost on restart)
   */
  readonly storage: StorageMode;
  readonly port: number;
  readonly wsPort: number;
  readonly graphqlPath: string;
  readonly restEnabled: boolean;
  readonly graphqlEnabled: boolean;
  readonly sandboxProvider: 'auto' | 'isolated-vm' | 'node-vm';
  readonly sandboxTimeoutMs: number;
  readonly sandboxMemoryLimitMb: number;
  readonly failOnDeepFork: boolean;
  readonly logLevel: LogLevel;
  /**
   * Cross-endpoint block verification window: blocks within this many heights of the
   * known head are fetched from a second RPC endpoint and compared byte-for-byte
   * (fingerprint) before being applied. 0 disables quorum verification; when only one
   * endpoint is configured it is skipped (nothing to compare against).
   */
  readonly quorumVerifyDepth: number;
  /** Per-IP HTTP request budget (requests/minute, token bucket). 0 disables the limiter. */
  readonly rateLimitRpm: number;
  /**
   * How many reverse-proxy hops sit in front of the HTTP server. Express uses this to
   * recover the real client IP from X-Forwarded-For; `1` (default) is correct behind a
   * single proxy (Traefik/Dokploy) and irrelevant when the engine is directly exposed
   * (no header → socket address). Unlike `trust proxy: true` this cannot be spoofed by
   * a client prepending its own X-Forwarded-For values.
   */
  readonly trustProxyHops: number;
  /** Hard cap on simultaneous WebSocket connections. */
  readonly wsMaxClients: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type StorageMode = 'auto' | 'postgres' | 'memory';

const STORAGE_MODES: StorageMode[] = ['auto', 'postgres', 'memory'];

function int(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function list(env: NodeJS.ProcessEnv, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) throw new Error(`${name} must contain at least one endpoint`);
  return items;
}

// Verified reachable 2026-11-28 (appbase JSON-RPC `call`, heads within one block of
// each other). Load is divided round-robin across this list (STEEM_RPC_STRATEGY),
// failing endpoints drop out with cooldown/backoff automatically, and
// STEEM_RPC_SCHEDULE can pin a UTC time window to one of them.
const DEFAULT_ENDPOINTS = [
  'https://api.steemit.com',
  'https://api.justyy.com',
  'https://api.moecki.online',
  'https://steemd.steemworld.org',
];

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** `STEEM_RPC_STRATEGY` — endpoint selection policy (default: rotate). */
function rpcStrategy(raw: string | undefined): RpcStrategy {
  if (raw === undefined || raw.trim() === '') return 'rotate';
  const value = raw.trim();
  if (value === 'rotate' || value === 'sticky') return value;
  throw new Error(`Invalid STEEM_RPC_STRATEGY: ${raw} (expected rotate | sticky)`);
}

/**
 * `STEEM_RPC_SCHEDULE` → time windows pinning all load to one endpoint.
 *
 * Format: `HH:MM-HH:MM=<url>[,HH:MM-HH:MM=<url>…]`, minutes are UTC, the end is
 * exclusive, and `00:00` AS THE END means midnight (so `22:00-00:00` runs to
 * midnight and `00:00-00:00` covers the whole day); an end earlier than the start
 * wraps past midnight (`23:00-01:00`). With overlapping windows the FIRST match
 * wins. Every URL must appear in the endpoint list — a pin to an endpoint that is
 * not configured can never be honoured, so that is a startup error rather than a
 * silently ignored window.
 */
function rpcSchedule(endpoints: string[], raw: string | undefined): RpcScheduleWindow[] {
  if (raw === undefined || raw.trim() === '') return [];
  const windows: RpcScheduleWindow[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})=(\S+)$/.exec(entry);
    if (!m) {
      throw new Error(
        `Invalid STEEM_RPC_SCHEDULE entry: ${entry} (expected HH:MM-HH:MM=<url>, e.g. 00:00-06:00=https://api.steemit.com)`,
      );
    }
    const [startH, startM, endH, endM] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    const url = m[5];
    if (startM > 59 || endM > 59 || startH > 23 || endH > 24 || (endH === 24 && endM > 0)) {
      throw new Error(`Invalid STEEM_RPC_SCHEDULE time in: ${entry} (hours 00-23, minutes 00-59; 24:00 only as end)`);
    }
    const startMin = startH * 60 + startM;
    // `-00:00` means "until midnight" (a 1440-minute end), not an empty window at 0.
    const endRaw = endH * 60 + endM;
    const endMin = endRaw === 0 ? 1440 : endRaw;
    if (startMin === endMin) {
      throw new Error(`Invalid STEEM_RPC_SCHEDULE window: ${entry} (start equals end — empty window)`);
    }
    if (!endpoints.includes(url)) {
      throw new Error(
        `STEEM_RPC_SCHEDULE pins ${url} which is not in STEEM_RPC_ENDPOINTS (configured: ${endpoints.join(', ')})`,
      );
    }
    windows.push({ startMin, endMin, url });
  }
  return windows;
}

/**
 * Strips one matching pair of surrounding quotes and surrounding whitespace.
 * `DATABASE_URL='postgresql://…'` is a very common Environment-tab paste; the quotes
 * must never become part of the value. Returns null when nothing of value remains.
 */
function unquote(raw: string): string | null {
  let value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value === '' ? null : value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.SANDBOX_PROVIDER ?? 'auto') as Config['sandboxProvider'];
  if (!['auto', 'isolated-vm', 'node-vm'].includes(provider)) {
    throw new Error(`Invalid SANDBOX_PROVIDER: ${provider}`);
  }
  const level = (env.LOG_LEVEL ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(level)) throw new Error(`Invalid LOG_LEVEL: ${level}`);

  const storage = (env.STORAGE ?? 'auto') as StorageMode;
  if (!STORAGE_MODES.includes(storage)) {
    throw new Error(`Invalid STORAGE: ${storage} (expected ${STORAGE_MODES.join(' | ')})`);
  }

  // Present-but-empty values are Environment-tab mistakes: a blank or whitespace-only
  // value slips past Compose's `${VAR:?}` check (which only rejects unset/empty strings
  // in some positions) and would otherwise silently fall back to in-memory state.
  const databaseUrl = env.DATABASE_URL === undefined ? null : unquote(env.DATABASE_URL);
  if (env.DATABASE_URL !== undefined && databaseUrl === null) {
    throw new Error(
      env.DATABASE_URL.trim() === ''
        ? 'DATABASE_URL is set but contains only whitespace — fix the value (it must be the full postgresql://… URL)'
        : 'DATABASE_URL contains no value once quotes are removed — paste the full postgresql://… URL',
    );
  }

  const pollMs = int('BLOCK_POLL_INTERVAL_MS', 3000, 1);
  if (pollMs < 1000) {
    // Steem produces one block every 3s; hammering public RPC endpoints is abusive.
    throw new Error('BLOCK_POLL_INTERVAL_MS must be >= 1000');
  }

  const rpcEndpoints = list(env, 'STEEM_RPC_ENDPOINTS', DEFAULT_ENDPOINTS);

  return Object.freeze({
    rpcEndpoints,
    rpcStrategy: rpcStrategy(env.STEEM_RPC_STRATEGY),
    rpcSchedule: Object.freeze(rpcSchedule(rpcEndpoints, env.STEEM_RPC_SCHEDULE)),
    blockPollIntervalMs: pollMs,
    undoBufferDepth: int('UNDO_BUFFER_DEPTH', 30, 1),
    opId: env.SCE_OP_ID ?? 'sce-mainnet1',
    startBlockHeight: env.START_BLOCK_HEIGHT ? int('START_BLOCK_HEIGHT', 0, 1) : null,
    databaseUrl,
    storage,
    port: int('PORT', 4000, 1),
    wsPort: int('WS_PORT', 4001, 1),
    graphqlPath: env.GRAPHQL_PATH ?? '/graphql',
    restEnabled: bool('REST_ENABLED', true),
    graphqlEnabled: bool('GRAPHQL_ENABLED', true),
    sandboxProvider: provider,
    sandboxTimeoutMs: int('SANDBOX_TIMEOUT_MS', 1000, 1),
    sandboxMemoryLimitMb: int('SANDBOX_MEMORY_LIMIT_MB', 128, 16),
    failOnDeepFork: bool('FAIL_ON_DEEP_FORK', true),
    logLevel: level,
    quorumVerifyDepth: int('QUORUM_VERIFY_DEPTH', 50, 0),
    rateLimitRpm: int('RATE_LIMIT_RPM', 600, 0),
    trustProxyHops: int('TRUST_PROXY_HOPS', 1, 0),
    wsMaxClients: int('WS_MAX_CLIENTS', 500, 1),
  });
}
