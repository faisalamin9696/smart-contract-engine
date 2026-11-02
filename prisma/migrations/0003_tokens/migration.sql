-- Tokens contract, phase 1: fungible `tokens` state.
--
-- ADDITIVE ONLY — no reset: existing NFT state (collections, instances, orders,
-- journal, logs, cursor) is untouched and the engine keeps replaying from its
-- current head after this migration.
--
--  * TokenRecord    — the `token` table (wiki `tokens` create/issue/transfer/burn)
--  * BalanceRecord  — the `balance` table, keyed "<account>:<SYMBOL>"
--  * ParamRecord    — the single `param` row: genesis admin/treasury + fee schedule
--
-- Fee bootstrap (avoids the SCE catch-22): the `param` row is seeded with ALL fees
-- = 0, because SCE cannot pay fees before SCE exists. The genesis admin then runs
-- `tokens.create` SCE -> `tokens.issue` initial supply -> `setParam` to raise the
-- schedule to its target values (nft create 20 SCE, addProperty 4th+ 20 SCE,
-- fillOrder 200 bps). `setParam` is an engine action, admin-only, signed on-chain.

-- CreateTable
CREATE TABLE "TokenRecord" (
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "precision" INTEGER NOT NULL,
    "maxSupply" TEXT NOT NULL,
    "supply" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,
    "createdAtBlock" INTEGER NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "TokenRecord_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "BalanceRecord" (
    "key" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,

    CONSTRAINT "BalanceRecord_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ParamRecord" (
    "key" TEXT NOT NULL,
    "admin" TEXT NOT NULL,
    "treasury" TEXT NOT NULL,
    "fees" JSONB NOT NULL,
    "feeTokens" TEXT[],

    CONSTRAINT "ParamRecord_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "TokenRecord_issuer_idx" ON "TokenRecord"("issuer");

-- CreateIndex
CREATE INDEX "BalanceRecord_account_idx" ON "BalanceRecord"("account");

-- CreateIndex
CREATE INDEX "BalanceRecord_symbol_idx" ON "BalanceRecord"("symbol");

-- Seed: the single `param` row (genesis admin/treasury = the user's Steem account).
-- ON CONFLICT keeps the seed idempotent if the migration is ever re-applied by hand.
INSERT INTO "ParamRecord" ("key", "admin", "treasury", "fees", "feeTokens")
VALUES (
    'param',
    'steempro.com',
    'steempro.com',
    '{"nftCreationFee":"0","addPropertyFee":"0","tokenCreationFee":"0","issueFee":"0","fillOrderFeeBps":"0"}'::jsonb,
    ARRAY['SCE']
)
ON CONFLICT ("key") DO NOTHING;
