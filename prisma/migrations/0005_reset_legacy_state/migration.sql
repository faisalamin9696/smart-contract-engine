-- Pre-release state reset: wipe ALL engine state and re-seed the genesis `param` row.
--
-- WHY: everything in these tables predates the SCE rebrand — test collections
-- (e.g. ARCHERS), rows created under the legacy op id `steem_nft_v1`, the old-id
-- genesis (SCE named "SteemCraft Engine") and every order/balance/log derived
-- from them. Pre-release is a closed stage (docs/TOKENS-DESIGN.md), so the
-- state DB is wiped instead of carrying legacy test data into the release.
--
-- This is a ONE-SHOT migration: `prisma migrate deploy` (image entrypoint) applies
-- it exactly once, on the next deploy. Nothing on chain changes — legacy-id ops are
-- not parsed by this engine and stay permanently unparsed history.
--
-- WHAT HAPPENS NEXT (runbook — docs/TOKENS-DESIGN.md "Genesis runbook"):
--   1. The engine boots against the empty tables, finds no cursor (BlockRecord
--      empty) and cold-starts at the CURRENT head — no historical resync.
--      Leave START_BLOCK_HEIGHT unset for this.
--   2. Genesis is re-broadcast:            node scripts/genesis.cjs
--      (tokens.create SCE -> tokens.issue 1,000,000 -> engine.setParam fees)
--      — only AFTER the engine reports cursor == head (/api/v1/status), so the
--      ops land above the cold-start height and are ingested live.
--   3. Fees move from the all-zero bootstrap row (re-seeded below) to the live
--      schedule (20/20/20/0/200 bps). The bootstrap MUST stay all-zero: the
--      `tokens.create` genesis op would fail to pay its own fee otherwise
--      (the SCE catch-22, see migration 0003).
--
-- TRUNCATE, not DROP: the schema stays byte-identical (0001-0004 are never
-- re-run, `_prisma_migrations` untouched), and TRUNCATE is transactional, so the
-- engine — if it happens to query mid-deploy — sees either the old state or the
-- fresh one, never a half-wipe. Every state table is listed in a single statement,
-- which also satisfies the JournalEntry -> BlockRecord foreign key without CASCADE.

-- TRUNCATE: all state tables, one atomic pass
TRUNCATE TABLE
    "JournalEntry",
    "BlockRecord",
    "TransactionLogRecord",
    "MarketOrderRecord",
    "InstanceRecord",
    "CollectionRecord",
    "AccountRecord",
    "SettingRecord",
    "TokenRecord",
    "BalanceRecord",
    "ParamRecord";

-- Seed: the single `param` row — byte-identical to migration 0003's bootstrap
-- (admin/treasury = genesis admin, ALL fees = 0, feeTokens = ["SCE"]).
-- No ON CONFLICT needed: the table was just truncated inside this migration.
INSERT INTO "ParamRecord" ("key", "admin", "treasury", "fees", "feeTokens")
VALUES (
    'param',
    'steempro.com',
    'steempro.com',
    '{"nftCreationFee":"0","addPropertyFee":"0","tokenCreationFee":"0","issueFee":"0","fillOrderFeeBps":"0"}'::jsonb,
    ARRAY['SCE']
);
