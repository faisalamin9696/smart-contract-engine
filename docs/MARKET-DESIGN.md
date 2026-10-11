# Market & Wrapped Assets (`WSTEEM` / `WSBD`) — design

**Status: contract implemented (2026-10-11)** — the `market` contract, migration
`0006`, checksum partitions, REST/GraphQL/WS surfaces and the VM/guard changes
all ship in this release. Wrapped-asset issuance (`WSTEEM`), the testnet
rehearsal and the frontend markets page are the remaining phase-1 steps (see
Phasing). Naming decision recorded 2026-10-10; implementation decisions
recorded in "Implementation notes" below.

Related: [TOKENS-DESIGN.md](TOKENS-DESIGN.md) (fee engine, NFT marketplace
precedent), [README](../README.md) (architecture), [TESTNET.md](TESTNET.md)
(rehearsal), [NODE-OPERATOR.md](NODE-OPERATOR.md).

## Why

SCE has real utility demand (20 SCE creation fees, the SCE-denominated NFT
marketplace) but **no price discovery**: the `tokens` contract has no trading
primitive, so today's price is whatever the treasury negotiates OTC. This doc
specifies the wiki-compatible fungible order book and the wrapped quote assets
it trades against.

## Non-goals

- No L2 consensus and no engine-held custody — the engine is a deterministic
  L2 reader (see README); the market is a contract, not a broker.
- No arbitrary user-deployed contracts — the fixed first-party set grows by one.
- No leveraged peg products (`sellClose`/`buyClose`) in v1.
- No staking of market shares.

## Wrapped assets: `WSTEEM` (phase 1), `WSBD` (phase 2)

Decision: the quote wrappers are called **WSTEEM** and **WSBD** — both valid
under `RE_SYMBOL = /^[A-Z]{3,10}$/`, so **no symbol-regex change** (dot-names
like `SWAP.STEEM` would have needed one; rejected for now).

- **Issued through the existing `tokens` contract** — `tokens.create`
  `{ symbol: 'WSTEEM', precision: 3 }` from the bridge account; no engine
  change at all. Precision 3 matches the L1 coins.
- **Custody**: real STEEM/SBD sit in the (public) bridge account on L1. The
  invariant `wrapper circulating supply == backing balance` is checkable by
  anyone against the API and the L1 account — transparent, but custodial
  (steempro.com). Disclose this wherever the market UI lives.
- **Bridge account (decision, 2026-10-11)**: `steempro.funds` — segregated from
  the admin account `steempro.com` so its L1 balance *is* the backing (no
  commingling) and the cold bridge key never shares custody with the admin
  crown-jewel key. Operations, rehearsal drill, backing audit, multisig
  upgrade and the failure playbook: **[BRIDGE.md](BRIDGE.md)**
  (`scripts/wsteem.cjs`). The peg-out machinery (burn-then-release) is proven
  on the live testnet consensus path (2026-10-11).
- **Deposit**: user sends coins on L1 → bridge verifies → `tokens.issue`.
- **Withdraw**: user `tokens.transfer`s the wrapper to the bridge → coins
  return on L1 (burn via existing action). Operational SLA, not
  protocol-enforced, in v1.
- **SBD note**: L1 pays ~0.5%/yr SBD interest to the holder — i.e. the
  custodian collects it on the backing. Feature or disclosure, decided at
  launch; WSBD is phase 2 anyway.

## Market contract (new first-party `market` contract)

Wiki-compatible action set (steemsmartcontracts `market`):

| Action | Payload | Authority |
| --- | --- | --- |
| `buy` | `{ symbol, quote, quantity, price }` | **active** (moves funds) |
| `sell` | `{ symbol, quote, quantity, price }` | **active** (moves funds) |
| `cancel` | `{ orderId }` | **active** (refund is a fund movement — see notes) |

`quantity` is in `symbol`; `price` is `quote` per unit (decimal string, capped
at the quote's precision — same rule as NFT order prices). The quote is an
explicit parameter, so any existing token can be quoted; operations start with
**SCE:WSTEEM** only.

Mechanics:

- **Escrow at placement** — a buy escrows `quantity × price` (rounded **up**
  to quote precision) of `quote`; a sell escrows `quantity` of `symbol`;
  `cancel` refunds the un-filled remainder. Resting orders are always fully
  backed, so overselling is impossible.
- **Matching** — placing an order matches immediately against the best-priced
  opposing resting orders (price-time priority, in-block op order); the
  remainder rests on the book. Fully deterministic: no clocks, no floats.
- **Settlement** — atomic in-VM balance moves. Precedent already ships: the
  NFT `fillOrder` settles buyer → seller + royalty + treasury in
  `priceSymbol` via `settleDeltas`. The partition guard gains one lane entry
  (`market` may touch `balance` rows), mirroring the NFT market lane.
- **Fees** — new schedule key **`tradeFeeBps`** (≤ 10000) added to
  `param.fees` through the existing `engine.setParam`; charged in `quote` per
  fill and credited to `param.treasury` (same `chargeFee` semantics). The
  `FEE_KEYS` list grows by one — a consensus-coordinated, additive release
  exactly like the `MAX_PROP_STRING` change.
- **Guard rails** — open orders per account capped (suggest 100); min order
  size ≥ one unit; per-account caps are DoS guards, not economics.

## Storage & release

- **Migration `0006` (additive)**: `market_orders` (+ fills derivable from the
  tx log / events). Existing `orders` stays the NFT marketplace table.
- **state-checksum** partitions extended to the new tables.
- The release is **additive-only**: new contract, new fee key, new tables,
  new partition entries. Existing state and replay are untouched; every node
  adopts the same compiled source in lockstep (the engine's normal upgrade
  contract — see README consensus section).

## API & realtime

- REST: `GET /api/v1/market/orders?symbol&quote&side&status&account&limit&offset`,
  `GET /api/v1/market/orders/:id`, `GET /api/v1/market/book?symbol&quote`
  (aggregated depth), `GET /api/v1/market/trades?symbol&quote` (flattened from
  `MARKET_FILLED` events — no separate trade table to re-org); `/orders`
  remains NFT-specific.
- GraphQL: `bookOrders(...)`, `bookOrder(id)`, `book(symbol, quote)`,
  `trades(...)`; `FeeSchedule.tradeFeeBps` (absence serialized as `"0"`).
- WebSocket: `MARKET_PLACED` / `MARKET_FILLED` / `MARKET_CANCELLED` route to
  the existing `market` channel plus `token:<BASE>` (they name the fungible
  base token — `indexer/events.ts`). `BALANCE_CHANGED` synthesis already
  covers every settlement leg per holder.

## Frontend (SteemNft)

- **Markets page**: order-book depth, recent tape, buy/sell/cancel forms
  (Keychain `custom_json`), live via the existing `market` channel.
- **Balances**: WSTEEM/WSBD rows next to SCE; deposit/withdraw drawer with
  bridge instructions (manual in v1).
- **Pre-sign summary**: quantity, price, `tradeFeeBps` cost — shown before the
  Keychain prompt, same pattern as the fee drawer for `nft.create`.

## Phasing

- **Phase 0 (gate)**: first Keychain e2e NFT create on mainnet — **closed**
  (verified 2026-10-10 on testnet; mainnet isolation confirmed).
- **Phase 1**: WSTEEM issued by the bridge; engine release with the `market`
  contract (**shipped in code — awaiting rollout**); full rehearsal on the
  testnet (`sce-testnet1`); frontend markets page; manual bridge with published
  reserve checks.
- **Phase 2**: WSBD + second pair; scripted bridge + proof-of-reserves page;
  evaluate `transferToContract`-based escrow for trust-minimized withdrawals.

## Open decisions — resolved at implementation (2026-10-11)

| Decision | Outcome |
| --- | --- |
| Launch `tradeFeeBps` default | **0** at genesis (like every fee); the admin raises it via `setParam` once the market is live — target 10–25 bps decided at the testnet rehearsal. |
| Per-account open-order cap | **100**, enforced in-VM; the count is fetched host-side (`countBookOrders`) and handed to the sandbox as a synthetic read-only snapshot key (`open:<account>`). |
| Min order size | One unit of the base token (`quantity > 0`, precision-capped) — no absolute floor beyond that in v1. |
| Buy-escrow rounding | **Ceil** to quote precision (per-fill costs floor, so the escrow can never be outrun; rounding dust returns to the buyer when the order completes). |
| Cancel authority | **active** — the refund is a fund movement, and buy/sell already sign with active; same UX and a stronger default than the wiki's posting. |

## Implementation notes (2026-10-11)

- **Escrow lives on the order row** (`BookOrder.escrow` — quote units for BUY,
  base units for SELL), not on a pooled custody account: a pooled engine account
  name is registerable on Steem and its balance drainable via an L1-signed
  `tokens.transfer`. The guard's conservation invariant counts book-order
  escrow as a balance-equivalent of `side === 'BUY' ? quote : symbol`, so
  placement (balance → escrow), fills (escrow → counterparties + treasury) and
  cancels (escrow → balance) are all pinned to net zero per op.
- **Matching runs in-VM over a prefetched book.** The pair's open orders are
  loaded into the snapshot at prefetch time (store-ordered by id; an
  unprefetched crossing order would raise `SNAPSHOT_MISS` mid-match). The
  matcher re-sorts explicitly — BUY side best-price-then-id ascending, SELL
  side mirrored — and executes at the **resting** order's price (maker
  priority); a better-priced taker's unused escrow is refunded on completion.
- **Fill throughput is bounded** (`MAX_FILLS_PER_OP = 25`): the matcher stops
  and the remainder rests, keeping every op well under the guard's 500-mutation
  ceiling.
- **Guard hardening:** the market is the first flow that writes the same key
  several times in one op (the taker's row is rewritten per fill), so
  `validateMutations` and the conservation sum now diff each write against the
  *previous write in the same op* rather than the original snapshot value.
  Book orders additionally get immutable identity fields (id, account, side,
  pair, price, creation block), frozen terminal rows, monotonic `filled`, and
  the terminal-residue rule (a FILLED/CANCELLED order ends with zero quantity
  and zero escrow).
- **Ids** come from the `market_order_seq` meta counter (`MKT-00000001`, same
  pattern as the NFT `ORD-` counter); the counter and the `bookOrders` entity
  are folded into the state checksum.
- **`tradeFeeBps` is an optional fee key** at the schema level — param rows
  written before this release (and their undo before-images) carry no such key
  and read as "0" everywhere. Migration `0006` still backfills the live row to
  `"0"` so a migrated Postgres stays byte-identical to `genesisParam()`.
  `setParam` validates it like `fillOrderFeeBps` (≤ 10000); `FEE_KEYS` grew by
  one.
- **Storage:** migration `0006` is additive — `BookOrderRecord` (+ indexes on
  status, pair, account) plus the param backfill; the existing `orders` table
  stays the NFT marketplace table.
