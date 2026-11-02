import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'path';

/**
 * Migration 0005 (docs/TOKENS-DESIGN.md — pre-release state reset): a one-shot wipe
 * of ALL engine state plus a re-seed of the genesis `param` row. The image entrypoint
 * applies it via `prisma migrate deploy`, so production executes exactly this SQL on
 * the next deploy. These guards pin that behaviour:
 *
 *  - every state table that EXISTS when 0005 runs (i.e. created by 0001-0005) is
 *    truncated — a missed table would keep legacy test rows alive, which is the exact
 *    problem this reset exists to remove. Tables created by LATER migrations (0006+,
 *    e.g. BookOrderRecord) cannot appear: they do not exist at 0005's execution point,
 *    and 0005 is checksum-frozen once applied (P3009 forbids editing it),
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

/** Every migration's SQL in apply order (zero-padded names sort correctly). */
const MIGRATION_SQL_BY_DIR = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{4}_/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));

/** Tables each migration's SQL creates. */
function createdTables(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
}

/** Tables that exist at 0005's execution point: everything 0001-0005 created. */
const TABLES_AT_RESET = MIGRATION_SQL_BY_DIR.slice(0, 5).flatMap(createdTables);
/** Tables created after the reset — legitimately absent from 0005's wipe. */
const POST_RESET_TABLES = MIGRATION_SQL_BY_DIR.slice(5).flatMap(createdTables);

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
  it('truncates every state table that existed at reset time — nothing legacy survives', () => {
    const truncated = truncatedTables(RESET_SQL);
    expect(truncated.length).toBeGreaterThan(0);
    expect(new Set(truncated).size).toBe(truncated.length); // no duplicate entries
    // Completeness: every table created by 0001-0005 (everything that exists when 0005
    // executes) is in the wipe — schema.prisma remains the source of truth for the
    // models created after it, checked below.
    expect(truncated).toEqual(expect.arrayContaining(TABLES_AT_RESET));
    // Cross-check both directions: every model is either wiped by 0005 or created
    // after it, and every truncated table is a real model (no drift either way).
    for (const model of MODEL_TABLES) {
      expect(TABLES_AT_RESET.includes(model) || POST_RESET_TABLES.includes(model)).toBe(true);
    }
    for (const table of truncated) {
      expect(MODEL_TABLES).toContain(table);
    }
  });

  it('only removes data — no DROP TABLE / DROP SCHEMA, _prisma_migrations survives', () => {
    expect(RESET_SQL).not.toMatch(/drop\s+(table|schema)/i);
    expect(truncatedTables(RESET_SQL)).not.toContain('_prisma_migrations');
  });

  it('re-seeds the param row byte-identical to migration 0003 (all-zero fee bootstrap)', () => {
    expect(paramSeedValues(RESET_SQL)).toBe(paramSeedValues(GENESIS_SQL));
  });
});
