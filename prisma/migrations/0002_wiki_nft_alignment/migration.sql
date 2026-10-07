-- Wiki alignment: standard Steem Engine `nft` contract semantics.
--
--  * CollectionRecord gains the wiki's `nfts` columns (url/orgName/productName,
--    authorizedIssuingAccounts/Contracts, typed `properties` schema, `groupBy`,
--    `circulatingSupply`) and loses the pre-alignment `authorizedIssuers`/`metadataSchema`.
--  * InstanceRecord is re-keyed by the composite "<SYMBOL>:<id>" — wiki token ids are
--    only unique per symbol — and gains `previousAccount`.
--
-- Existing rows cannot be translated (ids, supply semantics and property structures all
-- changed), so the whole state is reset here. The engine restarts from the current head
-- on its next boot; the wiki contract has never served production traffic.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- DropForeignKey
ALTER TABLE "JournalEntry" DROP CONSTRAINT IF EXISTS "JournalEntry_height_fkey";

-- DropTable
DROP TABLE IF EXISTS "JournalEntry";
DROP TABLE IF EXISTS "BlockRecord";
DROP TABLE IF EXISTS "TransactionLogRecord";
DROP TABLE IF EXISTS "MarketOrderRecord";
DROP TABLE IF EXISTS "InstanceRecord";
DROP TABLE IF EXISTS "CollectionRecord";
DROP TABLE IF EXISTS "AccountRecord";
DROP TABLE IF EXISTS "SettingRecord";

-- CreateTable
CREATE TABLE "BlockRecord" (
    "height" INTEGER NOT NULL,
    "blockId" TEXT NOT NULL,
    "previous" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "txCount" INTEGER NOT NULL,
    "opCount" INTEGER NOT NULL,
    "appliedAt" TEXT NOT NULL,

    CONSTRAINT "BlockRecord_pkey" PRIMARY KEY ("height")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "height" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "before" JSONB,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("height","seq")
);

-- CreateTable
CREATE TABLE "CollectionRecord" (
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "orgName" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "maxSupply" TEXT NOT NULL,
    "supply" TEXT NOT NULL,
    "burned" TEXT NOT NULL,
    "circulatingSupply" TEXT NOT NULL,
    "authorizedIssuingAccounts" TEXT[],
    "authorizedIssuingContracts" TEXT[],
    "properties" JSONB NOT NULL,
    "groupBy" TEXT[],
    "royaltyBps" TEXT NOT NULL,
    "royaltyRecipient" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAtBlock" INTEGER NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "CollectionRecord_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "InstanceRecord" (
    "key" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "properties" JSONB NOT NULL,
    "listedOrderId" TEXT,
    "previousAccount" TEXT,
    "createdAtBlock" INTEGER NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "InstanceRecord_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AccountRecord" (
    "name" TEXT NOT NULL,
    "createdAtBlock" INTEGER NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "AccountRecord_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "MarketOrderRecord" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "royaltyBps" TEXT NOT NULL,
    "royaltyRecipient" TEXT NOT NULL,
    "createdAtBlock" INTEGER NOT NULL,
    "updatedAtBlock" INTEGER NOT NULL,
    "filledAtBlock" INTEGER,
    "fillBy" TEXT,
    "settlement" JSONB,

    CONSTRAINT "MarketOrderRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionLogRecord" (
    "id" TEXT NOT NULL,
    "height" INTEGER NOT NULL,
    "blockId" TEXT NOT NULL,
    "txId" TEXT NOT NULL,
    "opIndex" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "authLevel" TEXT NOT NULL,
    "symbol" TEXT,
    "instanceId" TEXT,
    "status" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "error" JSONB,
    "mutations" JSONB,
    "events" JSONB,
    "timestamp" TEXT NOT NULL,

    CONSTRAINT "TransactionLogRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettingRecord" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "SettingRecord_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "BlockRecord_blockId_key" ON "BlockRecord"("blockId");

-- CreateIndex
CREATE INDEX "JournalEntry_height_entity_idx" ON "JournalEntry"("height", "entity");

-- CreateIndex
CREATE INDEX "CollectionRecord_issuer_idx" ON "CollectionRecord"("issuer");

-- CreateIndex
CREATE INDEX "InstanceRecord_owner_idx" ON "InstanceRecord"("owner");

-- CreateIndex
CREATE INDEX "InstanceRecord_symbol_idx" ON "InstanceRecord"("symbol");

-- CreateIndex
CREATE INDEX "InstanceRecord_listedOrderId_idx" ON "InstanceRecord"("listedOrderId");

-- CreateIndex
CREATE INDEX "MarketOrderRecord_status_idx" ON "MarketOrderRecord"("status");

-- CreateIndex
CREATE INDEX "MarketOrderRecord_symbol_idx" ON "MarketOrderRecord"("symbol");

-- CreateIndex
CREATE INDEX "MarketOrderRecord_seller_idx" ON "MarketOrderRecord"("seller");

-- CreateIndex
CREATE INDEX "MarketOrderRecord_instanceId_idx" ON "MarketOrderRecord"("instanceId");

-- CreateIndex
CREATE INDEX "MarketOrderRecord_createdAtBlock_idx" ON "MarketOrderRecord"("createdAtBlock");

-- CreateIndex
CREATE INDEX "TransactionLogRecord_height_idx" ON "TransactionLogRecord"("height");

-- CreateIndex
CREATE INDEX "TransactionLogRecord_actor_idx" ON "TransactionLogRecord"("actor");

-- CreateIndex
CREATE INDEX "TransactionLogRecord_instanceId_idx" ON "TransactionLogRecord"("instanceId");

-- CreateIndex
CREATE INDEX "TransactionLogRecord_symbol_idx" ON "TransactionLogRecord"("symbol");

-- CreateIndex
CREATE INDEX "TransactionLogRecord_status_idx" ON "TransactionLogRecord"("status");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_height_fkey" FOREIGN KEY ("height") REFERENCES "BlockRecord"("height") ON DELETE CASCADE ON UPDATE CASCADE;
