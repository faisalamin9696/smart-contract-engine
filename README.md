# SCE — Smart Contract Engine

A production-oriented Node.js/TypeScript service that indexes Steem `custom_json`
operations (`id = sce-mainnet1`), executes them inside a sandboxed deterministic VM, keeps
an off-chain state database, and exposes that state through REST, GraphQL and WebSocket.

*The protocol is branded **SCE**; the **SteemCraft** dApps (NFT frontend) build on top of it.*

```
 Steem RPC (failover)          engine process                      clients
┌──────────────────┐   ┌───────────────────────────────────┐   ┌──────────────┐
│ api.steemit.com  │──▶│ BlockStreamer ─▶ Indexer          │──▶│ REST  /api/v1│
│ api.steemyy.com  │   │   │ fork detect / undo-redo       │   │ GQL   /graphql│
│ api.moecki.online│   │   ▼                               │   │ WS    :4001  │
└──────────────────┘   │ opParser ─▶ executor ─▶ sandbox VM│   └──────────────┘
                       │   │  (isolated-vm / node-vm)      │
                       │   ▼                               │
                       │ guard ─▶ StateTxn ─▶ EngineStore   │
                       │        (journal, atomic per block) │
                       └───────────────────────────────────┘
                                     │
                       ┌─────────────▼─────────────┐
                       │ PostgreSQL (Prisma)       │  or MemoryStore (dev/tests)
                       │ blocks · journal · state ·│
                       │ logs                      │
                       └───────────────────────────┘
```

## What it does

| Concern | Implementation |
| --- | --- |
| Block ingestion | sequential ~3s polling against a rotating endpoint list with timeouts, cooldowns and exponential back-off (`src/chain/rpc.ts`, `src/chain/blockStreamer.ts`) |
| Operation filtering | only `custom_json` ops with `id = sce-mainnet1`; malformed/oversized payloads are logged as `IGNORED` without failing the block (`src/chain/opParser.ts`) |
| Re-org handling | previous-hash linkage check + tip re-check while idle, rolling 30-block undo/redo buffer, automatic rollback & re-apply, hard stop beyond buffer depth (`src/chain/reorg.ts`) |
| Execution | one compiled contract source carrying all contracts (`nft`, `tokens` and the `engine` admin namespace, dispatched per envelope), run in an `isolated-vm` V8 isolate (falls back to Node `vm` with the identical source); hard timeout, memory limit, blocked globals (`src/vm/`) |
| Determinism | `bignumber.js` only — integers/decimal strings, **no floating point anywhere**, frozen BigNumber config on both host and guest, canonical JSON (`src/utils/bn.ts`, `src/utils/canonical.ts`) |
| State integrity | sandbox returns *declarative mutations*; the host re-validates schema, entity allowlist (per contract), immutable fields, read-set integrity (unread-write / stale-read guards), supply/burn/groupBy invariants, fungible token invariants + the ledger **conservation invariant** (balance deltas must equal the supply delta per op), typed property rules and order finality (`src/vm/guard.ts`) |
| Atomicity | one DB transaction per block: state + journal + logs + cursor commit together; advisory lock (`pg_advisory_xact_lock`) serialises block processing across replicas |
| APIs | REST + GraphQL (Apollo Server 5) + WebSocket channels |
| Tests | 141 tests across 15 suites (deterministic execution, wiki action semantics for all contracts, the fee engine, marketplace settlement, guards, journal, parser) + integration suites for micro-fork rollbacks, the API surface, and an opt-in Postgres parity suite |

## Quick start

### 1. Local (in-memory store, no database)

```bash
npm install
npx prisma generate
npm test          # jest --runInBand
npm run typecheck
npm run dev       # tsx watch src/index.ts
```

Without `DATABASE_URL` the engine logs a warning and runs on `MemoryStore` — all state is
lost on restart. That mode is for demos and tests only.

### 2. With PostgreSQL

```bash
cp .env.example .env          # edit DATABASE_URL
docker compose up -d postgres
npx prisma migrate deploy     # applies prisma/migrations (0001_init, 0002_wiki_nft_alignment, 0003_tokens, 0004_order_price_symbol)
npm start                     # node dist/src/index.js  (or: npm run build && npm start)
```

### 3. Full stack in Docker

```bash
# database already exists (default bridge / host DNS)
docker compose up -d --build

# database lives on another Docker network
DB_NETWORK=<network> docker compose -f docker-compose.yml -f docker-compose.dbnet.yml up -d --build

# no database yet — bundled PostgreSQL instead
docker compose -f docker-compose.yml -f docker-compose.local-db.yml up -d --build
```

The image's entrypoint applies `npx prisma migrate deploy` before the engine starts
(retrying for ~2.5 minutes while the database boots), so no deploy tool can skip
migrations. Full server instructions (network discovery, verification, upgrades,
troubleshooting) are in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

### 4. Deploying on Dokploy

```bash
# Compose Path in the Dokploy service:
docker-compose.dokploy.yml
```

It attaches everything to Dokploy's shared `dokploy-network` (so the database hostname
resolves and Traefik can reach the engine). Step-by-step: **[docs/DOKPLOY.md](docs/DOKPLOY.md)**.

## API

### Health

```bash
curl localhost:4000/health
{"status":"ok","uptimeSeconds":12,"storage":"postgres",
 "indexer":{"running":true,"headHeight":123_456_789,"cursorHeight":123_456_789,"sandbox":"isolated-vm"}}
```

### REST (`GET /api/v1/...`)

| Route | Purpose |
| --- | --- |
| `/status` | cursor, head, sandbox provider, ingest statistics |
| `/collections?limit&offset` | all collections |
| `/collections/:symbol` · `/collections/:symbol/instances` | collection detail / inventory |
| `/instances?owner&symbol&limit&offset` · `/instances/:id` · `/instances/:symbol/:id` | filtered inventory |
| `/accounts/:name` · `/accounts/:name/instances` | account profile + inventory |
| `/orders?status&symbol&seller&limit&offset` · `/orders/:id` | marketplace book |
| `/tokens?issuer&limit&offset` · `/tokens/:symbol` | fungible tokens (wiki `tokens` contract) |
| `/balances?account&symbol&limit&offset` | token balances for one account (`account` required) |
| `/params` | admin, treasury and the in-state fee schedule |
| `/logs?actor&instanceId&symbol&height&status&limit&offset` | execution history |
| `/blocks/latest` · `/blocks/:height` | indexed block cursor |

```bash
curl 'localhost:4000/api/v1/instances?owner=alice&limit=10'
curl 'localhost:4000/api/v1/instances/DRAGON:573'   # or: /instances/DRAGON/573
curl 'localhost:4000/api/v1/orders?status=OPEN'
curl 'localhost:4000/api/v1/logs?status=FAILED'
```

Errors are JSON: `{"error":{"code":"NOT_FOUND","message":"instance not found"}}`
(`400 BAD_REQUEST` for invalid query parameters, `404` for missing resources).

### GraphQL (`POST /graphql`)

```graphql
{
  collections(limit: 10) {
    symbol
    supply
    circulatingSupply
    properties          # declared data-property schema
    royaltyBps
    instances(owner: "alice") { id owner listedOrderId previousAccount }
  }
  instance(id: "DRAGON:573") { id owner }
  tokens(issuer: "alice") { symbol precision supply maxSupply issuer }
  token(symbol: "SCE") { name metadata }
  balances(account: "bob") { symbol quantity }
  params { admin treasury fees { tokenCreationFee fillOrderFeeBps } feeTokens }
  orders(status: OPEN) {
    id instanceId price seller
    instance { id owner }
    settlement { royalty fee sellerProceeds buyer }
  }
  logs(actor: "alice", limit: 5) { action status error }
  status { running cursorHeight sandbox storage stats { blocksApplied reorgs } }
}
```

Custom `JSON` scalar refuses floating-point literals (the engine never produces them).

### WebSocket (`ws://localhost:4001`)

```jsonc
// subscribe
{"type":"subscribe","channels":["account:alice","collection:RAID","market"]}
// → {"type":"subscribed","channels":["account:alice","collection:RAID","market"]}

// notification (delivered only after the block committed)
{"type":"event","channels":["account:alice"],
 "event":{"type":"NFT_RECEIVED","block":1234,"account":"alice",
          "instanceId":"RAID:7","timestamp":"2026-01-01T00:00:00"}}

{"type":"ping"}   // → {"type":"pong","timestamp":"..."}
```

Channels: `*` (everything), `account:<name>`, `collection:<SYMBOL>`, `token:<SYMBOL>`,
`market`, `chain`. `TOKEN_*` and `BALANCE_CHANGED` events go to `token:<SYMBOL>` +
`account:<name>` (never to the NFT `collection:`/`market` lanes); `BALANCE_CHANGED`
fires once per holder whose balance row moved — transfers, issues, burns, fee debits
and settlement legs.
Invalid channel names, oversized frames and more than 100 subscriptions per socket are
rejected with `{"type":"error","message":...}`.

Event types: `BLOCK_APPLIED`, `COLLECTION_CREATED`, `NFT_MINTED`, `NFT_RECEIVED`,
`NFT_TRANSFERRED`, `PROPERTIES_UPDATED`, `NFT_BURNED`, `ORDER_PLACED`, `ORDER_FILLED`,
`ORDER_CANCELLED`, `TOKEN_CREATED`, `TOKEN_ISSUED`, `TOKEN_TRANSFERRED`,
`TOKEN_BURNED`, `TOKEN_UPDATED`, `BALANCE_CHANGED`, `PARAM_UPDATED`, `ITEM_FAILED`,
`TX_FAILED`, `REORG_DETECTED`, `REORG_APPLIED`, `ENGINE_HALTED`.

## Writing to the engine

Three namespaces share this engine's op id (the same multiplexing pattern as the real
Steem Engine): the standard **`nft`** contract
([NFT-Contracts wiki](https://github.com/hive-engine/steemsmartcontracts-wiki/blob/master/NFT-Contracts.md)),
the fungible **`tokens`** contract
([Tokens-Contract wiki](https://github.com/hive-engine/steemsmartcontracts-wiki/blob/master/Tokens-Contract.md),
v1 scope of [docs/TOKENS-DESIGN.md](docs/TOKENS-DESIGN.md)), and the **`engine`**
admin namespace (fee-schedule meta-actions, currently `setParam`).
Every action is a Steem `custom_json` operation with `id = sce-mainnet1`, accepted in
either envelope shape:

```jsonc
// engine shorthand (contract optional — defaults to "nft")
{"action": "issue", "params": {"symbol": "DRAGON", "to": "bob"}}

// standard steemsmartcontracts envelope (contractName "nft", "tokens" or "engine")
{"contractName": "nft", "contractAction": "issue",
 "contractPayload": {"symbol": "DRAGON", "to": "bob"}}

// the same shape addresses the fungible contract
{"contractName": "tokens", "contractAction": "transfer",
 "contractPayload": {"symbol": "SCE", "to": "bob", "quantity": "5"}}
```

Amounts are decimal strings, supplies and prices are strings; **no floats anywhere**.

### `nft` contract actions

| Action | Params | Authority |
| --- | --- | --- |
| `create` | `symbol, name?, url?, orgName?, productName?, maxSupply?, authorizedIssuingAccounts?, authorizedIssuingContracts?, properties?, groupBy?, royaltyBps? (≤10000), royaltyRecipient?, metadata?` | active of the creator (becomes `issuer`) |
| `addProperty` | `symbol, name, type (number\|string\|boolean), isReadOnly?, authorizedEditingAccounts?, authorizedEditingContracts?` | active of the `issuer` |
| `setPropertyPermissions` | `symbol, name, accounts?, contracts?, isReadOnly?` | active of the `issuer` |
| `updatePropertyDefinition` | `symbol, name, newName?, type?` — only while `supply = 0` | active of the `issuer` |
| `setGroupBy` | `symbol, properties` (≤50, set exactly once) | active of the `issuer` |
| `updateUrl` / `updateMetadata` / `updateName` / `updateOrgName` / `updateProductName` | `symbol` + the new field | owner (active **or** posting) |
| `addAuthorizedIssuingAccounts` / `removeAuthorizedIssuingAccounts` · `…Contracts` | `symbol, accounts:/contracts:` (≤10 per call) | active of the `issuer` |
| `transferOwnership` | `symbol, to` | active of the `issuer` |
| `issue` | `symbol, to, properties?` (`lockTokens`/`lockNfts` rejected, `fromType`/`toType` accepted-and-ignored; `feeSymbol` must be in `param.feeTokens` once an issue fee is set) | active of the `issuer` or an `authorizedIssuingAccounts` / `authorizedIssuingContracts` entry |
| `issueMultiple` | `instances: [{symbol, to, properties?}]` (≤10) — **partial success**: each bad entry emits its own `ITEM_FAILED` event | same as `issue` |
| `transfer` | `to, nfts: [{symbol, ids: [...]}]` (≤50 ids, ≤10 symbols) | **active** of each current owner (posting is not enough) |
| `setProperties` | `symbol, nfts: [{id, properties}]` (≤50) | per-property `authorizedEditingAccounts` (posting is enough) |
| `burn` | `nfts: [{symbol, ids: [...]}]` (≤50) | active of each current owner |
| `placeOrder` | `symbol, id, price, priceSymbol? = SCE` (price decimals ≤ the price token's precision; the token row must exist) — *engine extension* | active of the owner |
| `fillOrder` | `orderId` — settles atomically in one state txn: buyer → seller + royalty + `fillOrderFeeBps` treasury cut, NFT → buyer — *engine extension* | active of the buyer (not the seller) |
| `cancelOrder` | `orderId` — *engine extension* | active of the seller |

### `tokens` contract actions (fungible)

| Action | Params | Authority |
| --- | --- | --- |
| `create` | `symbol, name, precision (0–8, required), maxSupply?, url?` — charges `tokenCreationFee` (20 SCE after genesis) | active of the creator (becomes `issuer`) |
| `issue` | `symbol, to, quantity, feeSymbol?` — issuer only; honours `maxSupply` and precision; `issueFee` is 0 by default | active of the `issuer` |
| `transfer` | `symbol, to, quantity` | active of the holder (posting is not enough) |
| `burn` | `symbol, quantity` — *engine extension*, decreases `supply` | active of the holder |
| `updateUrl` / `updateMetadata` | `symbol` + the new field (`metadata` is a JSON object, stringified ≤ 1000 chars in state) | owner (active **or** posting) |
| `transferOwnership` | `symbol, to` | active of the `issuer` |
| `updatePrecision` | `symbol, precision` — increase only | active of the `issuer` |

Shared action names resolve per `contractName`; every op is additionally checked by the
host guard, which enforces the **ledger conservation invariant**: within one op the sum
of all balance deltas per symbol must equal that token's `supply` delta (transfers and
fees net to zero; only `issue`/`burn` change supply).

### `engine` contract (fee administration)

| Action | Params | Authority |
| --- | --- | --- |
| `setParam` | `{fees?: {nftCreationFee?, addPropertyFee?, tokenCreationFee?, issueFee?, fillOrderFeeBps? (≤10000)}, feeTokens?: [SYMBOL,…] (≤10)}` — partial patch; at least one of the two keys required | active of `param.admin` (`steempro.com`) |

Fee schedule lives in the single `param` row of state (deterministic, re-org safe) and
starts at **0 for everything** — migration `0003` seeds the zero-fee bootstrap because
SCE cannot pay fees before it exists. After genesis (`tokens.create` SCE →
`tokens.issue` → `setParam`) the targets are: nft `create` / `addProperty`(4th+) /
tokens `create` = 20 SCE each, `issue` = 0, `fillOrder` = 200 bps — charged by the VM
via `chargeFee()` to `param.treasury`, and the first three property definitions stay
free (wiki rule). Sending the treasury your own fee is a no-op rebate.

Rules worth knowing:

* **token ids are wiki-style numeric strings scoped to the symbol** — a token is
  referenced as `<SYMBOL>:<id>` (e.g. `DRAGON:573`); `id = supply + 1` at issue time,
  where `supply` counts tokens **ever** issued, so burned ids are never recycled;
* `supply` never decreases and `burned` never decreases; `circulatingSupply` is always
  `supply - burned` (all three enforced by the host guard, not just the VM);
* data properties are typed (`number` **integers only**, `string`, `boolean`) and declared
  once via `addProperty`; each property carries its own editing list and an optional
  `isReadOnly` flag (settable exactly once);
* `issue` to `null` and `transfer` to `"null"` are refused — destroying a token is
  explicitly `burn`;
* `placeOrder` locks the instance (`listedOrderId`): transfer and re-list are rejected
  while an order is open;
* royalties are snapshotted onto the order at placement time, rounded **down**, the
  remainder goes to the seller;
* legacy names (`createCollection`, `mint`, `batchMint`, `updateProperties`) and the
  delegation/staking actions are rejected with an explicit `ACTION_UNSUPPORTED` hint, and
  foreign `contractName`s with `UNKNOWN_CONTRACT`;
* fungible `tokens` rules: quantities are decimal strings capped by the token's
  `precision` (increase-only via `updatePrecision`), the first active signer is the
  sender of `transfer`/`burn`, self-transfers and `null` recipients are refused, and a
  new token always starts at `supply = "0"`;
* actions that fail validation are recorded in the transaction log with a
  machine-readable error code and never abort the block.

Not implemented (per the wiki's optional sections and
[docs/TOKENS-DESIGN.md](docs/TOKENS-DESIGN.md) deferrals): delegation / staking,
`transferToContract`, and locked tokens. The marketplace actions above are an engine
extension — upstream they live in a separate `market` contract.

## Determinism contract

1. All arithmetic is `bignumber.js` with a frozen config (`DECIMAL_PLACES 20`,
   `ROUND_DOWN`, `EXPONENTIAL_AT [-100, 100]`) — identical on host and guest.
2. Non-finite/float values are rejected at three layers (payload zod schema, guard,
   BigNumber config).
3. No host APIs in the sandbox: `Math.random`, `Date`, timers, `fetch`, `require`,
   `process`, `eval` are stubbed/blocked.
4. All timestamps come from the block header — never from the host clock. The host clock
   is stored separately (`blocks.appliedAt`) and excluded from state fingerprints.
5. The same chain replayed from genesis produces a byte-identical state
   (`tests/unit/determinism.test.ts`), including after a micro-fork rollback
   (`tests/integration/reorg.test.ts`).

## Re-org handling

1. Divergence is detected **before** applying anything: `block.previous !== last.blockId`,
   or a tip-id mismatch while idle.
2. The handler walks back through the rolling undo buffer (default 30 blocks) looking for
   the last common ancestor, applying each block's before-images in reverse.
3. Blocks are then re-applied from the redo buffer when the original branch comes back —
   reusing the cached parsed operations, so a flip-back is cheap and deterministic.
4. Forks deeper than the buffer publish `ENGINE_HALTED` and stop ingestion instead of
   corrupting state (configurable with `FAIL_ON_DEEP_FORK=false`).

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `STEEM_RPC_ENDPOINTS` | `https://api.steemit.com,https://api.steemyy.com,https://api.moecki.online` | comma-separated failover list |
| `BLOCK_POLL_INTERVAL_MS` | `3000` | ≥1000 (Steem block time) |
| `UNDO_BUFFER_DEPTH` | `30` | rolling undo/redo size |
| `SCE_OP_ID` | `sce-mainnet1` | `custom_json` id to consume |
| `START_BLOCK_HEIGHT` | *(DB cursor)* | first height when the DB is empty |
| `DATABASE_URL` | — | unset ⇒ `MemoryStore` (state lost on restart) |
| `STORAGE` | `auto` | `auto` \| `postgres` \| `memory`. `postgres` (used by the compose files) **refuses to start** unless `DATABASE_URL` is set and reachable — no silent in-memory fallback |
| `PORT` / `GRAPHQL_PATH` | `4000` / `/graphql` | HTTP |
| `WS_PORT` | `4001` | WebSocket |
| `REST_ENABLED` / `GRAPHQL_ENABLED` | `true` | toggle individual surfaces |
| `SANDBOX_PROVIDER` | `auto` | `isolated-vm`, `node-vm` fallback |
| `SANDBOX_TIMEOUT_MS` / `SANDBOX_MEMORY_LIMIT_MB` | `1000` / `128` | per-execution limits |
| `FAIL_ON_DEEP_FORK` | `true` | halt vs. warn on forks beyond the buffer |
| `LOG_LEVEL` | `info` | `debug \| info \| warn \| error` |

## Testing

```bash
npm test                      # unit + integration (single worker, deterministic)
npm run test:unit
npm run test:integration
npm run typecheck
```

Optional Postgres parity suite (throwaway database — it applies migrations and writes
fixture rows):

```powershell
$env:TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/steemcraft_test'
npx jest --runInBand tests/integration/postgresStore.test.ts
```

## Project layout

```
src/
  api/        graphql.ts · rest.ts · ws.ts · server.ts      HTTP + WS surfaces
  chain/      rpc.ts · blockStreamer.ts · opParser.ts · reorg.ts
  db/         prisma.ts · prismaStateStore.ts               PostgreSQL EngineStore
  indexer/    indexer.ts · events.ts                        ingestion orchestration, event bus
  state/      store.ts · memoryStore.ts · stateTxn.ts · snapshot.ts
  types/      domain.ts · actions.ts                        entities, zod action schemas
  vm/         contractSource.ts · sandbox.ts · guard.ts · executor.ts
  utils/      bn.ts · canonical.ts · mutex.ts
  config.ts · index.ts · logger.ts
prisma/       schema.prisma · migrations/
tests/        unit/ · integration/ · helpers/
```

## Known limitations

* Settlement moves engine-internal token balances (any `tokens` symbol, default `SCE`)
  atomically; no native/off-engine currency is escrowed — bridging a pegged STEEM-side
  token is a later phase.
* Public Steem RPC endpoints fail intermittently (node-side errors such as
  `Invalid cast from object_type to Array`, or slow `get_dynamic_global_properties`);
  the failover client rotates past them with exponential cooldown and logs
  `rpc endpoint recovered` on success. If ingestion looks stalled, check `GET /health`
  (`cursorHeight` vs `headHeight`) before assuming an engine fault.
* The API is read-only and unauthenticated; rate limiting and auth are expected at the
  ingress layer.
* One engine instance should own the ingestion cursor per database (the advisory lock
  makes a second instance safe but idle).

## License

MIT
