# Tokens Contract — Design Brief (Phase 1)

Status: **Phase 1 in progress** — build order steps 1–5 done (step 1: migration 0003 +
store layer, 2026-10-07; step 2: contract-scoped dispatch, tokens handlers, guard
conservation, 2026-10-08; step 3: fee engine — `engine.setParam`, `chargeFee()`
wired into nft create/addProperty(4th+)/issue(+issueMultiple)/tokens create/issue,
2026-10-08; step 4: atomic `fillOrder` settlement with `priceSymbol`, 2026-10-09;
step 5: token/balance/params reads over REST + GraphQL, WS `token:<SYMBOL>`
channel and `BALANCE_CHANGED` events, 2026-10-09)
Wiki source: https://github.com/hive-engine/steemsmartcontracts-wiki/blob/master/Tokens-Contract.md

## Goal

Add a wiki-aligned fungible `tokens` contract to this engine — same op id
(`sce-mainnet1`), same VM, same state transaction as the `nft` contract —
introduce the **SCE** platform token, charge fees from an in-state param table,
and make marketplace settlement atomic (balances actually move).

## Scope (v1)

| Wiki action | In v1 | Auth |
| --- | --- | --- |
| `create` (name, symbol, precision 0–8, maxSupply, url) | ✅ | active |
| `issue` (issuer only) | ✅ | active |
| `transfer` | ✅ | active |
| `burn` | ✅ (extension — not on wiki page; supply must decrease) | active |
| `updateUrl` / `updateMetadata` | ✅ | posting (wiki: active not required) |
| `transferOwnership` | ✅ | active |
| `updatePrecision` (increase only) | ✅ | active |
| `transferToContract` | ❌ deferred — no contract accounts yet |
| staking / delegation / pendingUnstakes | ❌ deferred — same cooldown/undo deferral as NFT contract |

Symbol `^[A-Z]{3,10}$`; amounts decimal strings, BigNumber only, no floats;
maxSupply cap `9,007,199,254,740,991` (wiki/JS max safe integer).

## State

- **`token`** table: symbol, name, precision, maxSupply, supply, issuer, url,
  metadata (stringified ≤ 1000 chars), createdAtBlock, createdAt
- **`balance`** table: keyed `<account>:<SYMBOL>`, decimal-string quantity
- **`param`** row (fee schedule lives in state, never in env — determinism):

```jsonc
{
  "admin": "steempro.com",    // only signer allowed to setParam (user's account, confirmed 2026-10-07)
  "treasury": "steempro.com", // fee destination (user's account, confirmed 2026-10-07)
  "fees": {
    "nftCreationFee": "0",   // target 20 SCE   ("listing a collection")
    "addPropertyFee": "0",   // target 20 SCE, first 3 properties free (wiki rule)
    "tokenCreationFee": "0", // target 20 SCE (confirmed 2026-10-07)
    "issueFee": "0",         // target 0 — wiki formula (base + base×#properties) is dust
    "fillOrderFeeBps": "0"   // target 200 (2%) → treasury
  },
  "feeTokens": ["SCE"]
}
```

### Fee bootstrap (avoids the catch-22)

SCE cannot pay fees before SCE exists. Migration `0003` seeds the `param` row
with **all fees = 0**. Genesis admin then: `tokens.create` SCE →
`tokens.issue` initial supply → `setParam` raises fees to target values.
`setParam` = engine action, admin-only, signed on-chain. *(Implemented step 3:
`setParam` lives in its own third contract namespace — `contractName: 'engine'`,
currently the only action — and `chargeFee()` in `contractSource.ts` debits the
authorised payer → `param.treasury` on nft `create`/`addProperty`(4th+)/
`issue`(+`issueMultiple`)/tokens `create`/`issue`; fee moves net to zero, so
guard conservation holds. `fillOrderFeeBps` is wired with step 4 settlement.
`MemoryStore` seeds the same genesis row as the migration so `STORAGE=memory`
runs behave like a migrated database.)*

### Genesis runbook (broadcast as `steempro.com`, active key)

Three ops, in order — the first two are free (fees still 0), the third raises
the schedule. Numbers confirmed 2026-10-08: **precision 3, unlimited supply,
initial issue 1,000,000 SCE** to the treasury.

```jsonc
// 1. create (free — tokenCreationFee still "0"; maxSupply OMITTED = unlimited)
{"contractName":"tokens","contractAction":"create","contractPayload":{"symbol":"SCE","name":"Smart Contract Engine","precision":3,"url":"https://steempro.com"}}
// 2. issue initial supply to the treasury (free — payer is the treasury itself)
{"contractName":"tokens","contractAction":"issue","contractPayload":{"symbol":"SCE","to":"steempro.com","quantity":"1000000"}}
// 3. raise the schedule to its target values
{"contractName":"engine","contractAction":"setParam","contractPayload":{"fees":{"nftCreationFee":"20","addPropertyFee":"20","tokenCreationFee":"20","issueFee":"0","fillOrderFeeBps":"200"}}}
```

Helper: `node scripts/genesis.cjs` broadcasts the three ops **in order** and verifies
each through the engine's transaction log before sending the next (aborts if the engine
is still running pre-step-3 code or rejects an op — step 3 never runs unless SCE exists).
`--dry-run` prints the payloads without signing; the active WIF is read from
`STEEM_ACTIVE_WIF` at runtime and never stored.

**Canonical genesis — executed on mainnet 2026-10-09** under `sce-mainnet1`
(via `scripts/genesis.cjs`, right after the migration `0005_reset_legacy_state`
state reset; all APPLIED):

| Step | tx id | height |
| --- | --- | --- |
| `tokens.create` SCE | `f69d6da2b158b66de46d4e65e5b263db5e604ce2` | 110282608 |
| `tokens.issue` 1,000,000 | `319f7eef5f279f3c43a839586b16a4465cc6d918` | 110282611 |
| `engine.setParam` raise fees | `d40f7c838ebae16f55456123e935fa575e83cefc` | 110282614 |

Verified in production afterwards: SCE "Smart Contract Engine" (precision 3,
supply 1,000,000, issuer `steempro.com`, `createdAtBlock` 110282608), schedule
20/20/20/0/200 bps with `feeTokens ["SCE"]`, treasury balance 1,000,000,
collections empty (legacy test rows gone), cursor == head.

The fee schedule is therefore **live in production** (20 SCE create fees); further SCE
distribution happens from the treasury (`tokens.issue` stays free while `issueFee = 0`).

> **Rebrand note / reset history.** The first execution (2026-10-08, heights
> 110263779–110263783, txs `523f0d77…`/`ce6bb332…`/`8917513d…`) went out under the
> legacy id `steem_nft_v1`. The engine is now branded **SCE — Smart Contract
> Engine** with id **`sce-mainnet1`**, and legacy ids are *not* parsed — so
> pre-release the state DB is wiped by migration **`0005_reset_legacy_state`**
> (applies automatically on deploy via the entrypoint's `prisma migrate deploy`:
> truncates every state table, re-seeds the all-zero `param` bootstrap) and the
> runbook above is re-broadcast under the new id. Order after any such reset:
> wait for `cursor == head` (`GET /api/v1/status`) — an empty DB cold-starts at
> the *current* head, so leave `START_BLOCK_HEIGHT` unset and never broadcast
> genesis before the engine's first boot — then run `node scripts/genesis.cjs`.
> The 2026-10-08 ops then remain permanently unparsed history.

## Key architectural decisions

1. **Contract-scoped dispatch.** Both contracts share action names (`create`,
   `issue`, `transfer`, `burn`, `updateUrl`, `updateMetadata`,
   `transferOwnership`).
   `contractSource.ts` `HANDLERS[action]` becomes `HANDLERS[contract][action]`;
   `types/actions.ts` `contractName !== 'nft'` becomes `∈ {nft, tokens}`
   (others still `UNKNOWN_CONTRACT`). One op id multiplexes both contracts —
   same pattern as real Steem Engine. *(Implemented step 2: action lists,
   zod param schemas and the guard's entity allow list are all keyed per
   contract; snapshot prefetch routing branches on `contract`; the engine
   shorthand envelope accepts an optional `contract` field, defaulting to
   `nft` for back-compatibility.)*
2. **`feeSymbol` becomes real.** Once fees exist, `issue.feeSymbol` must be in
   `param.feeTokens` (wiki's `nftIssuanceFee` map pattern); during the zero-fee
   bootstrap it is accepted and ignored exactly as before, so no payload break
   for clients that already send it (frontend `builder.ts:708`).
   *(Implemented step 3 — validated inside `chargeFee()` only when the fee is
   non-zero.)*
3. **Guard conservation invariant.** `vm/guard.ts` additionally asserts every
   state txn nets to **zero** across balances+treasury (transfer = −x/+x,
   fee = split, issue/burn = ±supply only). Makes ledger bugs structurally
   impossible. Existing per-entity checks stay. *(Implemented step 2:
   `GUARD_CONSERVATION` + token invariants — initial supply 0, precision
   increase-only, supply ≤ maxSupply, key↔row agreement, balance precision.)*
4. **Fee unit = L2 SCE, not SBD.** Wiki charges ENG (platform L2 token) for
   the same reason: atomic in-VM debit, re-org undo covers it, no custody.
   A pegged-SBD bridge is a possible later phase (hot-wallet custody — own
   design review).

## Marketplace settlement

- `placeOrder` gains `priceSymbol` (replaces hardcoded `currency:'STEEM'`,
  default `SCE`) + validation that price matches precision
- `fillOrder` settles atomically in one state txn: debit buyer → credit
  `sellerProceeds` + `royaltyRecipient` + optional `fillOrderFeeBps` treasury
  cut, **and** NFT ownership → buyer (existing logic), all under the 30-block
  undo buffer
- Insufficient balance → `INSUFFICIENT_BALANCE` fail (no partial effects)
- Both royalty and the platform cut derive from `price` (ROUND_DOWN at the
  price token's precision); `sellerProceeds = price − royalty − fee`;
  `royalty + fee > price` fails `SETTLEMENT_ERROR`, and legs sharing a holder
  (seller == royalty recipient, treasury == buyer, ...) are summed into net
  deltas before writing, so the per-op conservation invariant holds exactly.

## Build order

1. Migration `0003_tokens` (**additive** — no reset) + store layer
   (`state/store.ts`, `memoryStore.ts`, `db/prismaStateStore.ts`) — **done 2026-10-07**
2. VM: contract-scoped dispatch + tokens handlers + guard conservation +
   zod schemas in `types/actions.ts` — **done 2026-10-08** (`TOKEN_*` events are
   emitted from step 2; their WS routing lands with step 5)
3. Fee engine: `param` row, `requireFee()`, `setParam`, wire into NFT
   `create`/`addProperty`(4th+)/`issue` — **done 2026-10-08** (implemented as
   `engine.setParam` + `chargeFee()`; also wired `issueMultiple` (per item) and
   tokens `create`/`issue`; `MemoryStore` seeds the genesis param row)
4. Settlement: `priceSymbol` + atomic `fillOrder` — **done 2026-10-09**
   (`placeOrder` validates `priceSymbol` against an existing token row and
   caps the price at its precision; `fillOrder` debits the buyer and credits
   seller + royalty + the `fillOrderFeeBps` treasury cut in one state txn —
   `INSUFFICIENT_BALANCE` fails the whole op; migration
   `0004_order_price_symbol` renames the order column, legacy `STEEM` rows
   fail fill with `TOKEN_NOT_FOUND` but stay cancellable)
5. API/WS: GraphQL/REST `tokens`, `token(symbol)`, `balances(account)`,
   `params`; WS events `TOKEN_*` / `BALANCE_*` — **done 2026-10-09**
   (REST `/tokens`, `/tokens/:symbol`, `/balances` (`account` required),
   `/params`; GraphQL `tokens`/`token`/`balances`/`params` + `Token`,
   `Balance`, `Params`, `FeeSchedule` types; `TOKEN_*`/`BALANCE_*` route to a
   new `token:<SYMBOL>` channel instead of the NFT `collection:`/`market`
   lanes; `BALANCE_CHANGED` is synthesized host-side from the committed
   write-set — one event per holder whose balance row moved, so transfers,
   issues, burns, fee debits and settlement legs all reach `account:` channel
   subscribers without touching guest code)
6. Frontend (`E:\SteemNft`): builder.ts new actions + AUTH rows, wallet
   balance in topbar, fee line + pre-Keychain balance check in fee dialogs,
   GraphQL queries/types — **done 2026-10-09**
   (contract-aware envelope — `{ contract, action, params }` for `tokens`/
   `engine`, bare `{ action, params }` kept for nft so payloads stay
   byte-identical; `TOKEN_AUTH`/`ENGINE_AUTH` rows + `buildTokenCreate`/
   `Issue`/`Transfer`/`Burn`/`buildSetParam` wrappers over
   `buildFromParams(contract, …)`; topbar chip shows the `feeTokens[0]`
   balance from the same cached `balances` query the dialogs gate on; the
   drawer prints `nftCreationFee` / `addPropertyFee` (4th+ property) /
   `issueFee` above the sign button and the buy dialog gates
   `balance >= price` in `priceSymbol` — an *unknown* balance never blocks,
   only a confidently-low one; GraphQL gains `tokens`/`token`/`balances`/
   `params` documents + `Token`/`Balance`/`EngineParams`/`FeeSchedule`
   types, the step-4 `currency` → `priceSymbol` rename is fixed across
   queries/UI/fixtures, `Settlement.fee` + the `fillOrderFeeBps` cut surface
   in both breakdowns, and `computeRoyalty` gained the treasury line;
   `placeOrder` now emits `priceSymbol`; `params`/`balances`/`tokens`/
   `orders(priceSymbol)` probed live against production — all valid)
7. Tests: unit + determinism; integration parity suite needs
   `TEST_DATABASE_URL` (CI job planned)

## Kickoff decisions (confirmed 2026-10-07)

- **Genesis admin/treasury account**: `steempro.com` — seeded once by migration
  `0003` (the `param` row).
- **Fee schedule**: nft create 20 SCE · addProperty(4th+) 20 SCE ·
  token create 20 SCE · issue free · placeOrder free · fillOrder 2 % (200 bps) —
  migration seeds all fees **0** (fee bootstrap), genesis raises them via
  `setParam` after SCE exists.
- **SCE genesis** *(confirmed 2026-10-08 — replaces "still open")*:
  precision **3**, `maxSupply` omitted (unlimited), initial issue **1,000,000**
  SCE to `steempro.com` (treasury), then raise the schedule via `setParam`
  (exact payloads in the Genesis runbook above).
- **Protocol identity / op id** *(confirmed 2026-10-08)*: the engine is branded
  **SCE — Smart Contract Engine**; the frontend keeps **SteemCraft**;
  `custom_json` id **`sce-mainnet1`** (env `SCE_OP_ID`; convention =
  `prefix-env-generation` after upstream `ssc-mainnet1`). Legacy `steem_nft_v1`
  is **not** kept — pre-release is a closed stage, the state DB may be wiped, and
  genesis is re-broadcast under the new id at reset (token name becomes
  "Smart Contract Engine"; the ops executed on 2026-10-08 then stay permanently
  unparsed).

## Repo state at handoff

- Engine: `E:\SteemCraftEngine` → GitHub `faisalamin9696/steem-craft-engine`
  (private), main with build-order steps 1–6 + genesis helper + the pre-release
  reset migration `0005_reset_legacy_state` (truncates all state tables and
  re-seeds the all-zero `param` bootstrap; applied in production 2026-10-09;
  guarded by `tests/unit/resetMigration.test.ts`); gates before push:
  `npx tsc --noEmit`, `npx jest --runInBand`, `npm run build`,
  `npx js-yaml <compose>`, `sh -n docker-entrypoint.sh`
- Frontend: `E:\SteemNft` (not a git repo yet); typecheck + build green after
  step 6 (rebuilt with `NEXT_PUBLIC_CUSTOM_JSON_ID=sce-mainnet1` inlined);
  new + renamed GraphQL documents probed against live schema 2026-10-09;
  live endpoints: API `https://nft-api.steempro.com`,
  WS `wss://nft-ws.steempro.com` (also `nss-ws`), engine healthy
  (cursor == head, postgres, isolated-vm)
- **Done 2026-10-09 (pre-release reset)**: migration `0005_reset_legacy_state`
  deployed via Dokploy (all legacy test state wiped: old-id genesis, ARCHERS,
  orders/logs; engine cold-started at head) and genesis re-broadcast under
  `sce-mainnet1` — verified live (SCE "Smart Contract Engine", schedule
  20/20/20/0/200, treasury 1,000,000, collections empty)
- **Still pending**: first e2e NFT test from the frontend (`create` →
  `/collections`) — now unblocked, everything it needs has shipped
- Housekeeping: stray `limit` file in `E:\SteemNft` root; frontend git init;
  DB password rotation (old repo history); CI with postgres service
