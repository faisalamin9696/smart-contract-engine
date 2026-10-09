-- Marketplace settlement, phase 1 (docs/TOKENS-DESIGN.md step 4): orders settle in
-- an explicit price token instead of the hardcoded `currency: 'STEEM'` field.
--
-- RENAME ONLY — no rows are touched. Existing orders keep their value: a legacy
-- "STEEM" row simply fails `fillOrder` with TOKEN_NOT_FOUND (it is not a token in
-- the registry) until it is re-listed under a real symbol; `cancelOrder` still works.
--
--   * MarketOrderRecord.currency  ->  MarketOrderRecord.priceSymbol
ALTER TABLE "MarketOrderRecord" RENAME COLUMN "currency" TO "priceSymbol";
