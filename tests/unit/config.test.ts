import { loadConfig } from '../../src/config';
import { maskDatabaseUrl } from '../../src/utils/redact';

/**
 * loadConfig is the single gate for runtime configuration, so its failure modes are
 * consensus-adjacent: a silently-empty DATABASE_URL means production runs on RAM.
 */
describe('loadConfig storage selection', () => {
  test('defaults to auto with no database URL', () => {
    const config = loadConfig({});
    expect(config.storage).toBe('auto');
    expect(config.databaseUrl).toBeNull();
  });

  test('rejects a whitespace-only DATABASE_URL instead of silently falling back', () => {
    expect(() => loadConfig({ DATABASE_URL: '   ' })).toThrow(/only whitespace/);
  });

  test('rejects an unknown STORAGE mode', () => {
    expect(() => loadConfig({ STORAGE: 'disk' })).toThrow(/Invalid STORAGE: disk/);
  });

  test('strips surrounding quotes from a pasted URL', () => {
    const config = loadConfig({
      DATABASE_URL: "'postgresql://user:secret@db.internal:5432/sce'",
    });
    expect(config.databaseUrl).toBe('postgresql://user:secret@db.internal:5432/sce');
  });

  test('rejects an explicitly empty DATABASE_URL instead of treating it as unset', () => {
    expect(() => loadConfig({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  test('accepts an explicit postgres mode with a URL', () => {
    const config = loadConfig({
      STORAGE: 'postgres',
      DATABASE_URL: 'postgresql://user:secret@db.internal:5432/sce',
    });
    expect(config.storage).toBe('postgres');
    expect(config.databaseUrl).toBe('postgresql://user:secret@db.internal:5432/sce');
  });

  test('accepts explicit memory mode (tests/demo)', () => {
    expect(loadConfig({ STORAGE: 'memory' }).storage).toBe('memory');
  });
});

describe('loadConfig RPC selection (strategy + schedule)', () => {
  test('defaults to round-robin with no schedule windows', () => {
    const config = loadConfig({});
    expect(config.rpcStrategy).toBe('rotate');
    expect(config.rpcSchedule).toEqual([]);
  });

  test('parses pinned windows (end exclusive; -00:00 means midnight)', () => {
    const config = loadConfig({
      STEEM_RPC_ENDPOINTS: 'https://api.steemit.com,https://api.justyy.com',
      STEEM_RPC_SCHEDULE: '00:00-06:00=https://api.steemit.com,22:00-00:00=https://api.justyy.com',
    });
    expect(config.rpcSchedule).toEqual([
      { startMin: 0, endMin: 360, url: 'https://api.steemit.com' },
      { startMin: 1320, endMin: 1440, url: 'https://api.justyy.com' },
    ]);
  });

  test('accepts an explicit sticky strategy and rejects an unknown one', () => {
    expect(loadConfig({ STEEM_RPC_STRATEGY: 'sticky' }).rpcStrategy).toBe('sticky');
    expect(() => loadConfig({ STEEM_RPC_STRATEGY: 'random' })).toThrow(/STEEM_RPC_STRATEGY/);
  });

  test('rejects a schedule entry with an unparseable time', () => {
    expect(() => loadConfig({ STEEM_RPC_SCHEDULE: '6am-9am=https://api.steemit.com' })).toThrow(
      /STEEM_RPC_SCHEDULE/,
    );
  });

  test('rejects a window whose start equals its end (empty window)', () => {
    expect(() =>
      loadConfig({
        STEEM_RPC_ENDPOINTS: 'https://api.steemit.com',
        STEEM_RPC_SCHEDULE: '06:00-06:00=https://api.steemit.com',
      }),
    ).toThrow(/empty window/);
  });

  test('rejects pinning an endpoint that is not in STEEM_RPC_ENDPOINTS', () => {
    expect(() =>
      loadConfig({
        STEEM_RPC_ENDPOINTS: 'https://api.steemit.com',
        STEEM_RPC_SCHEDULE: '00:00-06:00=https://api.justyy.com',
      }),
    ).toThrow(/not in STEEM_RPC_ENDPOINTS/);
  });
});

describe('maskDatabaseUrl', () => {
  test('masks the password but keeps host and database', () => {
    expect(maskDatabaseUrl('postgresql://user:secret@db.internal:5432/sce')).toBe(
      'postgresql://user:***@db.internal:5432/sce',
    );
  });

  test('never throws on garbage input', () => {
    expect(maskDatabaseUrl('not a url')).toBe('<unparsable DATABASE_URL>');
  });
});
