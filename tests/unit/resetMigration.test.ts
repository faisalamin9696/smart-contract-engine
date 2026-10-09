import { readFileSync } from 'node:fs';
import * as path from 'path';

/**
 * Migration 0005 (docs/TOKENS-DESIGN.md — pre-release state reset): a one-shot wipe
 * of ALL engine state plus a re-seed of the genesis `param` row. The image entrypoint
 * applies it via `prisma migrate deploy`, so production executes exactly this SQL on
 * the next deploy. These guards pin that behaviour:
 *
 *  - every state table in schema.prisma is truncated — a missed table would keep
 *    legacy test rows alive, which is the exact problem this reset exists to remove,
 *  - only data goes: no DROP TABLE / DROP SCHEMA (schema stays byte-identical, so
 *    migrations 0001-0004 are never re-run and deploy history is preserved),
 *  - `_prisma_migrations` itself is never truncated,
 *  - the re-seeded `param` row is byte-identical to migration 0003's bootstrap
 *    (all fees "0" — the SCE catch-22; admin/treasury steempro.com; feeTokens ["SCE"]).
 */

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const RESET_SQL = readFileSync(
  path.join(MIGRATIONS_DIR, '0005_reset_legacy_state', 'migration.sql'),
  'utf8',
);
const GENESIS_SQL = readFileSync(path.join(MIGRATIONS_DIR, '0003_tokens', 'migration.sql'), 'utf8');
const PRISMA_SCHEMA = readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

/** Tables Prisma maps the models to (this schema has no @@map, so name = model). */
const MODEL_TABLES = [...PRISMA_SCHEMA.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);

/** The table list of the migration's single TRUNCATE statement. */
function truncatedTables(sql: string): string[] {
  const match = /TRUNCATE TABLE([\s\S]*?);/.exec(sql);
  return match ? [...match[1].matchAll(/"(\w+)"/g)].map((m) => m[1]) : [];
}

/** Normalised VALUES tuple of the `param` bootstrap INSERT. */
function paramSeedValues(sql: string): string {
  const match = /INSERT INTO "ParamRecord"[\s\S]*?VALUES\s*\(([\s\S]*?)\)\s*(?:ON CONFLICT[\s\S]*?)?;/.exec(
    sql,
  );
  return (match ? match[1] : '').replace(/\s+/g, ' ').trim();
}

describe('migration 0005_reset_legacy_state (pre-release reset)', () => {
  it('truncates every state table in schema.prisma — nothing legacy survives', () => {
    const truncated = truncatedTables(RESET_SQL);
    expect(truncated.length).toBeGreaterThan(0);
    expect(new Set(truncated).size).toBe(truncated.length); // no duplicate entries
    // Completeness: every model must be in the wipe (schema.prisma is the source of truth).
    expect(truncated).toEqual(expect.arrayContaining(MODEL_TABLES));
  });

  it('only removes data — no DROP TABLE / DROP SCHEMA, _prisma_migrations survives', () => {
    expect(RESET_SQL).not.toMatch(/drop\s+(table|schema)/i);
    expect(truncatedTables(RESET_SQL)).not.toContain('_prisma_migrations');
  });

  it('re-seeds the param row byte-identical to migration 0003 (all-zero fee bootstrap)', () => {
    expect(paramSeedValues(RESET_SQL)).toBe(paramSeedValues(GENESIS_SQL));
  });
});
