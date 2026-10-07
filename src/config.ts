import dotenv from 'dotenv';

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

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) throw new Error(`${name} must contain at least one endpoint`);
  return items;
}

// Verified reachable (failover order): the engine rotates + backs off on failure anyway.
const DEFAULT_ENDPOINTS = [
  'https://api.steemit.com',
  'https://api.steemyy.com',
  'https://api.moecki.online',
];

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

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

  return Object.freeze({
    rpcEndpoints: list('STEEM_RPC_ENDPOINTS', DEFAULT_ENDPOINTS),
    blockPollIntervalMs: pollMs,
    undoBufferDepth: int('UNDO_BUFFER_DEPTH', 30, 1),
    opId: env.NFT_OP_ID ?? 'steem_nft_v1',
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
  });
}
