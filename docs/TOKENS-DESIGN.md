# Tokens Contract — Design Brief (Phase 1)

Status: **design agreed, not started** (2026-10-07)
Wiki source: https://github.com/hive-engine/steemsmartcontracts-wiki/blob/master/Tokens-Contract.md

## Goal

Add a wiki-aligned fungible `tokens` contract to this engine — same op id
(`steem_nft_v1`), same VM, same state transaction as the `nft` contract —
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
  "admin": "<genesis Steem account>",        // only signer allowed to setParam
  "treasury": "<fee destination account>",
  "fees": {
    "nftCreationFee": "0",   // target 20 SCE   ("listing a collection")
    "addPropertyFee": "0",   // target 20 SCE, first 3 properties free (wiki rule)
    "tokenCreationFee": "0", // wiki: "a token creation fee might be enforced"
    "issueFee": "0",         // wiki formula: base + base×#properties (dust)
    "fillOrderFeeBps": "0"   // target 200 (2%) → treasury
  },
  "feeTokens": ["SCE"]
}
```

### Fee bootstrap (avoids the catch-22)

SCE cannot pay fees before SCE exists. Migration `0003` seeds the `param` row
with **all fees = 0**. Genesis admin then: `tokens.create` SCE →
`tokens.issue` initial supply → `setParam` raises fees to target values.
`setParam` = engine action, admin-only, signed on-chain.

## Key architectural decisions

1. **Contract-scoped dispatch.** Both contracts share action names (`create`,
   `transfer`, `updateUrl`, `updateMetadata`, `transferOwnership`).
   `contractSource.ts` `HANDLERS[action]` becomes `HANDLERS[contract][action]`;
   `types/actions.ts` `contractName !== 'nft'` becomes `∈ {nft, tokens}`
   (others still `UNKNOWN_CONTRACT`). One op id multiplexes both contracts —
   same pattern as real Steem Engine.
2. **`feeSymbol` becomes real.** Today accepted-and-ignored
   (`types/actions.ts:192`, mirrored in frontend `builder.ts:708`); once fees
   exist, `issue.feeSymbol` must be in `param.feeTokens` (wiki's
   `nftIssuanceFee` map pattern). No payload break — clients already send it.
3. **Guard conservation invariant.** `vm/guard.ts` additionally asserts every
   state txn nets to **zero** across balances+treasury (transfer = −x/+x,
   fee = split, issue/burn = ±supply only). Makes ledger bugs structurally
   impossible. Existing per-entity checks stay.
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

## Build order

1. Migration `0003_tokens` (**additive** — no reset) + store layer
   (`state/store.ts`, `memoryStore.ts`, `db/prismaStateStore.ts`)
2. VM: contract-scoped dispatch + tokens handlers + guard conservation +
   zod schemas in `types/actions.ts`
3. Fee engine: `param` row, `requireFee()`, `setParam`, wire into NFT
   `create`/`addProperty`(4th+)/`issue`
4. Settlement: `priceSymbol` + atomic `fillOrder`
5. API/WS: GraphQL/REST `tokens`, `token(symbol)`, `balances(account)`,
   `params`; WS events `TOKEN_*` / `BALANCE_*`
6. Frontend (`E:\SteemNft`): builder.ts new actions + AUTH rows, wallet
   balance in topbar, fee line + pre-Keychain balance check in fee dialogs,
   GraphQL queries/types
7. Tests: unit + determinism; integration parity suite needs
   `TEST_DATABASE_URL` (CI job planned)

## Open questions (need user input at kickoff)

- **Genesis admin/treasury account** — user's Steem account, seeded once by
  migration
- **Fee schedule confirm**: nft create 20 SCE · addProperty(4th+) 20 SCE ·
  token create ? · issue free/dust · placeOrder free · fillOrder 2 %
- SCE initial supply + distribution

## Repo state at handoff

- Engine: `E:\SteemCraftEngine` → GitHub `faisalamin9696/steem-craft-engine`
  (private), HEAD `4f349ae`; gates before push: `npx tsc --noEmit`,
  `npx jest --runInBand`, `npm run build`, `npx js-yaml <compose>`,
  `sh -n docker-entrypoint.sh`
- Frontend: `E:\SteemNft` (not a git repo yet); typecheck + build green;
  all 11 GraphQL documents verified against live schema; live endpoints:
  API `https://nft-api.steempro.com`, WS `wss://nft-ws.steempro.com`
  (also `nss-ws`), engine healthy (cursor == head, postgres, isolated-vm)
- **Still pending**: first e2e NFT test from the frontend (`create` →
  `/collections`) — run before or alongside this work
- Housekeeping: stray `limit` file in `E:\SteemNft` root; frontend git init;
  DB password rotation (old repo history); CI with postgres service
