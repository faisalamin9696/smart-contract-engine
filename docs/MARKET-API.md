# Market API — frontend contract

The complete surface a trading UI (SCE Portal) consumes for the fungible
order book (`market` contract; design in [MARKET-DESIGN.md](MARKET-DESIGN.md)).
Every request/response shape below was verified live against the testnet engine
(`https://sce-test.steempro.com`, op id `sce-testnet1`) on 2026-10-11.

| | Testnet | Mainnet |
| --- | --- | --- |
| REST/GraphQL | `https://sce-test.steempro.com` | `https://sce-api.steempro.com` |
| WebSocket | `wss://sce-test-ws.steempro.com` | `wss://sce-ws.steempro.com` |
| `custom_json` id | `sce-testnet1` | `sce-mainnet1` |

## 1. Writes — Keychain ops (active authority)

Every state change is a Steem `custom_json` signed by the user's **active**
key (market moves funds, so posting authority is never enough):

```json
{ "contractName": "market", "contractAction": "sell",
  "contractPayload": { "symbol": "WSTEEM", "quote": "SCE", "quantity": "10", "price": "2" } }

{ "contractName": "market", "contractAction": "buy",
  "contractPayload": { "symbol": "WSTEEM", "quote": "SCE", "quantity": "4", "price": "2" } }

{ "contractName": "market", "contractAction": "cancel",
  "contractPayload": { "orderId": "MKT-00000001" } }
```

Rules enforced by the engine (all rejected ops land in the tx log as `FAILED`,
never half-applied):

* `quantity` — decimal string in **base** units, ≤ the base token's `precision`.
* `price` — decimal string, quote units per 1 base unit, ≤ the **quote**
  token's `precision`.
* **Escrow moves at placement**: a buy escrows `quantity × price` rounded
  **up** in quote; a sell escrows its full `quantity` in base. Resting orders
  are always fully backed — no partial-reserve states exist.
* An order matches immediately against best-priced opposing resting orders
  (price-time priority); the remainder rests on the book.
* `cancel` — owner only; refunds the unfilled remainder's escrow.
* Open orders per account are capped (UI should surface the
  `ORDER_LIMIT` failure code if a user hits it).

After broadcast, poll `GET /api/v1/logs?limit=20` for the tx id (or listen on
the `chain`/`market` WS lane) to learn `APPLIED` vs the rejection code.

## 2. Reads — REST

All reads are public, CORS `*`, rate limited per IP. Envelope: `{ data, meta }`;
errors are always `{ "error": { "code", "message" } }` with 400/404.

### Order list — `GET /api/v1/market/orders`

Query: `symbol`, `quote`, `account`, `status` (`OPEN|FILLED|CANCELLED`),
`side` (`BUY|SELL`), `limit` (1–100, hard-rejected outside), `offset`.

```json
{ "data": [ { "id": "MKT-00000001", "account": "steempro.com", "side": "SELL",
              "symbol": "WSTEEM", "quote": "SCE", "quantity": "6", "price": "2",
              "filled": "4", "escrow": "6", "status": "OPEN",
              "createdAtBlock": 110341660, "updatedAtBlock": 110341661 } ],
  "meta": { "limit": 20, "offset": 0, "total": 1 } }
```

### Single order — `GET /api/v1/market/orders/:id` → `{ data: <row> }`
404 `{"error":{"code":"NOT_FOUND","message":"market order not found"}}` if missing.

### Depth ladder — `GET /api/v1/market/book?symbol=WSTEEM&quote=SCE`

Both params required (400 otherwise). Best price first on both sides —
this is the ladder the order-book widget renders:

```json
{ "data": { "bids": [ { "price": "2", "quantity": "4", "orders": 1 } ],
            "asks": [ { "price": "2.5", "quantity": "10", "orders": 2 } ] } }
```

### Trades tape — `GET /api/v1/market/trades?symbol=&quote=&limit=&offset=`

Recent fills (flattened from `MARKET_FILLED` events of applied ops; one op's
fills are never split across pages):

```json
{ "data": [ { "height": 110341661, "timestamp": "2026-10-11T08:30:00",
              "txId": "…", "buyOrderId": "MKT-00000002", "sellOrderId": "MKT-00000001",
              "buyer": "bob", "seller": "alice", "symbol": "WSTEEM", "quote": "SCE",
              "price": "2", "quantity": "4", "cost": "8" } ],
  "meta": { "limit": 20, "offset": 0, "count": 1 } }
```

### Balances — `GET /api/v1/balances?account=<name>[&symbol=SYMBOL]`

The escrowed portion of a user's balance is **not** in `quantity` — it lives
on their open orders (`escrow` field). `quantity + Σ(escrow of OPEN orders)`
is the user's true holding; show both.

## 3. Live updates — WebSocket

Connect to the WS host, then:

```json
{ "type": "subscribe", "channels": ["market"] }
```

The hub greets with `{ "type": "welcome", "channels": [...] }` and answers
`{ "type": "subscribed", "channels": ["market"] }`. Event frames:

```json
{ "type": "event",
  "event": { "type": "MARKET_PLACED",   "account": "alice", "symbol": "WSTEEM", "data": { "orderId": "MKT-00000001", "side": "SELL", "quote": "SCE", "quantity": "10", "price": "2" } } }
{ "type": "event",
  "event": { "type": "MARKET_FILLED",   "account": "…", "symbol": "WSTEEM", "data": { …fill fields incl. both order ids, quantity, price… } } }
{ "type": "event",
  "event": { "type": "MARKET_CANCELLED", "account": "alice", "symbol": "WSTEEM",
             "data": { "orderId": "MKT-00000001", "side": "SELL", "quote": "SCE", "refunded": "6", "filled": "4" } } }
```

Other useful lanes: `["token:<SYMBOL>"]` (token balance/issue events),
`["account:<name>"]` (that account's activity), `["chain"]` (engine-wide),
`["*"]` (everything — avoid in production UIs). Limits: 64 KB frames,
subscription cap per socket, connection cap per hub — all answered with
`{ "type": "error", "message": … }` rather than disconnects.

## 4. Wrapped-asset flows — deposit & withdraw drawer

WSTEEM is a **custodial 1:1 wrapper** (STEEM backing held on L1 by the bridge
account `steempro.funds`; ops runbook: [BRIDGE.md](BRIDGE.md)). The UI never
touches bridge keys — it guides the user and shows balances.

**Deposit (STEEM → WSTEEM), manual in v1:**

1. Drawer instructs: "Send STEEM on Steem to **steempro.funds**, with a memo
   of your account name" (link to a block explorer).
2. The operator verifies the L1 receipt and issues WSTEEM to the user; the
   balance row updates — poll
   `GET /api/v1/balances?account=<user>&symbol=WSTEEM` or watch the
   `token:WSTEEM` / `account:<user>` WS lanes.

**Withdraw (WSTEEM → STEEM), manual in v1:**

1. User signs a `tokens.transfer` via Keychain (same custom_json op id as the
   market ops):

   ```json
   { "contractName": "tokens", "contractAction": "transfer",
     "contractPayload": { "symbol": "WSTEEM", "to": "steempro.funds", "quantity": "5" } }
   ```

2. Show the tx as submitted using the same APPLIED-polling pattern as market
   ops; the operator then burns the received wrapper and releases STEEM on L1
   (burn-then-release, so the user can never lose funds mid-flow).
3. Display a clear "processed manually — expect STEEM within the SLA" notice;
   v1 has no automatic release.

**Disclosure copy** (required wherever deposit/withdraw lives): WSTEEM is a
custodial wrapper operated by steempro.com — every WSTEEM is backed 1:1 by
STEEM held on-chain by `steempro.funds` (anyone can verify: engine supply vs
the account balance), but redemption depends on the bridge operator.

## 5. UI checklist

* Optimistic placement is safe **only after** the Keychain signature
  confirms; then poll the tx (or WS) for `APPLIED` before showing the order
  as resting — rejections (insufficient balance, precision, order limit,
  bad price) arrive as tx-log rows with a `code`.
* The book endpoint is the source of truth for depth; WS events tell you
  *when* to re-fetch (and what changed), not the full ladder.
* Price formatting: display up to the **quote** token's precision; the
  engine rejects anything beyond it.
* Testnet and mainnet never share state — the op id in the signed tx is
  the only routing difference; keep `NEXT_PUBLIC_CUSTOM_JSON_ID` as the
  switch (see [TESTNET.md](TESTNET.md)).

End-to-end proof lives in `tests/integration/api.test.ts` (chain-replay of
place → fill → cancel with REST/WS assertions) and the live smoke script
`scripts/market-rehearsal.cjs`.
