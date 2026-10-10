# Market & Wrapped Assets (`WSTEEM` / `WSBD`) — design

**Status: design-only, deferred** until the first frontend e2e milestone lands
(same gate `TOKENS-DESIGN.md` used). Naming decision recorded 2026-10-10.

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
| `cancel` | `{ orderId }` | posting (refund only returns to owner) |

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

- REST: `GET /api/v1/market/orders?symbol&quote&side&limit&offset`,
  `GET /api/v1/market/trades`; `/orders` remains NFT-specific.
- GraphQL: `marketOrders(...)`, `marketTrades(...)`.
- WebSocket: **no change** — the `market` channel already routes every
  `ORDER_*` event (`indexer/events.ts`).

## Frontend (SteemNft)

- **Markets page**: order-book depth, recent tape, buy/sell/cancel forms
  (Keychain `custom_json`), live via the existing `market` channel.
- **Balances**: WSTEEM/WSBD rows next to SCE; deposit/withdraw drawer with
  bridge instructions (manual in v1).
- **Pre-sign summary**: quantity, price, `tradeFeeBps` cost — shown before the
  Keychain prompt, same pattern as the fee drawer for `nft.create`.

## Phasing

- **Phase 0 (gate)**: first Keychain e2e NFT create on mainnet — nothing here
  starts before it.
- **Phase 1**: WSTEEM issued by the bridge; engine release with the `market`
  contract; full rehearsal on the testnet (`sce-testnet1`); frontend markets
  page; manual bridge with published reserve checks.
- **Phase 2**: WSBD + second pair; scripted bridge + proof-of-reserves page;
  evaluate `transferToContract`-based escrow for trust-minimized withdrawals.

## Open decisions (build-time)

- Launch `tradeFeeBps` default (suggest 10–25 bps; the NFT cut is 200).
- Min order size and the per-account open-order cap (suggest 100).
- Buy-escrow rounding: ceil (suggested) to avoid dust shortfalls.
- Cancel authority: posting (suggested) vs active — confirm at implementation.
