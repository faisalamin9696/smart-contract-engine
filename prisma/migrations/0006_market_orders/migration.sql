-- Fungible market contract (docs/MARKET-DESIGN.md): the order book table.
--
-- ADDITIVE ONLY — no reset: existing NFT state (collections, instances, orders,
-- tokens, balances, journal, logs, cursor) is untouched and the engine keeps
-- replaying from its current head after this migration.
--
--  * BookOrderRecord — the `marketOrder` entity: one row per fungible order
--    (buy/sell/cancel), with escrow held ON the row (`escrow` is quote units for a
--    BUY and base units for a SELL). Keys are `MKT-00000001`-style ids allocated
--    from the `market_order_seq` meta counter (folded into the state checksum).
--
-- The `param` row: the new `tradeFeeBps` fee key is optional at the schema level
-- (absence = "0" — pre-market rows and their undo before-images stay valid), but the
-- live row is backfilled here so a migrated database remains byte-identical to
-- `genesisParam()` (the shape MemoryStore mirrors). It starts at "0" like every
-- other fee and is raised by `engine.setParam`.
UPDATE "ParamRecord"
SET "fees" = "fees" || '{"tradeFeeBps":"0"}'::jsonb
WHERE NOT ("fees" ? 'tradeFeeBps');

-- CreateTable
CREATE TABLE "BookOrderRecord" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "filled" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "escrow" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAtBlock" INTEGER NOT NULL,
    "updatedAtBlock" INTEGER NOT NULL,
    "filledAtBlock" INTEGER,

    CONSTRAINT "BookOrderRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookOrderRecord_status_idx" ON "BookOrderRecord"("status");

-- CreateIndex (the trading pair: every book query filters on these two)
CREATE INDEX "BookOrderRecord_symbol_quote_idx" ON "BookOrderRecord"("symbol", "quote");

-- CreateIndex (per-account open-order cap + account order history)
CREATE INDEX "BookOrderRecord_account_idx" ON "BookOrderRecord"("account");
