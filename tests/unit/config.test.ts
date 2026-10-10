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
