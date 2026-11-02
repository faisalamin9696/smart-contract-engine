# Testnet (`sce-testnet1`)

A second, fully isolated engine you can break without touching mainnet — served
at `sce-test.steempro.com` (API) for developers and CI.

Related: [NODE-OPERATOR.md](NODE-OPERATOR.md) (running a node),
[SECURITY.md](SECURITY.md), [TOKENS-DESIGN.md](TOKENS-DESIGN.md) (genesis
runbook), [README](../README.md).

## How isolation works (and why it is this cheap)

The engine consumes **one `custom_json` id per instance** (`SCE_OP_ID`). Two
instances pointed at different ids on the same Steem chain see disjoint sets of
operations and hold completely separate state:

```
                 Steem mainnet (public chain)
        ┌──────────────────────────────────────────────┐
        │  custom_json id = sce-mainnet1   (mainnet)   │
        │  custom_json id = sce-testnet1   (testnet)   │
        │  every other id                 (ignored)    │
        └──────────────┬───────────────────┬───────────┘
                       │                   │
              ┌────────▼────────┐  ┌───────▼─────────┐
              │ mainnet engine  │  │ testnet engine  │
              │ own Postgres    │  │ own Postgres    │
              │ sce-api.…       │  │ sce-test.…      │
              └─────────────────┘  └─────────────────┘
```

* A `sce-testnet1` broadcast is **invisible to the mainnet engine** (different
  id), and vice versa — isolation is enforced by the same parser that filters
  everything else (`src/chain/opParser.ts`).
* No second blockchain, no witness set, no extra chain infrastructure: the test
  network is just another consumer of the public chain. Steem's own historic
  testnet is dead; this needs nothing from anyone.
* The frontend already reads its id from `NEXT_PUBLIC_CUSTOM_JSON_ID` — pointing
  a build at the testnet is configuration, not code.

The trade-off is explicit: testnet operations are real Steem transactions (they
cost RC like any `custom_json`, and they are publicly readable). They carry no
SCE value — the testnet ledger is a different world.

## Topology

| | Mainnet | Testnet |
| --- | --- | --- |
| `SCE_OP_ID` | `sce-mainnet1` | `sce-testnet1` |
| API | `https://sce-api.steempro.com` | `https://sce-test.steempro.com` |
| WebSocket | `wss://sce-ws.steempro.com` | `wss://sce-test-ws.steempro.com` |
| Frontend | production build | build with test env (below) |
| Database | dedicated Postgres | **separate** dedicated Postgres |
| Genesis | `scripts/genesis.cjs` (done 2026-10-09) | done — SCE + fee schedule verified on-chain; WSTEEM live (100k bridge inventory) and the full market rehearsal (place → fill → cancel) passed 2026-10-11 via `scripts/market-rehearsal.cjs` |

## 1. Deploy the testnet engine (Dokploy)

A second compose service from the **same repository** as mainnet, with its own
Postgres service and domains.
Environment differences from mainnet:

```dotenv
SCE_OP_ID=sce-testnet1
STORAGE=postgres
DATABASE_URL=postgresql://<user>:<pass>@<testnet-db-host>:5432/<testnet-db>

# Host ports MUST differ from mainnet — both stacks publish ports on the same
# server (the compose maps ${PORT}:${PORT} and ${WS_PORT}:${WS_PORT}); reuse of
# 4000/4001 fails with "port is already allocated".
PORT=4010
WS_PORT=4011

# Domains tab → service `engine`:
#   https://sce-test.steempro.com      → container port 4010  (REST + GraphQL)
#   wss://sce-test-ws.steempro.com     → container port 4011  (WebSocket)
```

Leave `START_BLOCK_HEIGHT` **unset**: the engine syncs to the current head in
seconds with empty state. Everything else (rate limits, quorum, sandbox) should
match production — the testnet is a rehearsal of the real thing.

## 2. Genesis (one-time, seeded by `steempro.com`)

Order matters — a fresh engine starts **at head**, so the engine must already be
running (or you must point it below the genesis height):

```powershell
# 1) inspect what will be broadcast (no transaction sent)
$env:SCE_OP_ID='sce-testnet1'; $env:ENGINE_API='https://sce-test.steempro.com'
node scripts/genesis.cjs --dry-run

# 2) broadcast for real (active key of GENESIS_ACCOUNT, default steempro.com)
$env:STEEM_ACTIVE_WIF='…'
node scripts/genesis.cjs
```

The script broadcasts the canonical genesis under id `sce-testnet1`: treasury
supply (1,000,000 test SCE) + the fee/param schedule. The running testnet engine
applies them within a few seconds (`GET /api/v1/status` → `opsApplied` rises).

If the engine starts *after* genesis, set `START_BLOCK_HEIGHT` to any height at
or below the genesis height (the broadcast transaction's block height) and
restart — the scan is cheap because non-matching ids are ignored.

The testnet genesis also serves **every local `sce-testnet1` node**: a developer
replaying from below that height inherits the same fee schedule and treasury.

## 3. Test frontend

A second frontend deployment (any domain, e.g. `sce-test-ui.steempro.com`) with:

```dotenv
NEXT_PUBLIC_NFT_API=https://sce-test.steempro.com
NEXT_PUBLIC_NFT_WS=wss://sce-test-ws.steempro.com
NEXT_PUBLIC_CUSTOM_JSON_ID=sce-testnet1
NEXT_PUBLIC_DEMO_DATA=0
```

Keychain signs against **real accounts** — the only difference is the id in the
transaction, which routes the write to the testnet ledger. Nothing about the
mainnet UI or engine changes.

For local UI work the same three variables go in `.env.local` of the frontend
repo (see `.env.local.example`).

## 4. Verify

```bash
curl https://sce-test.steempro.com/health           # cursor ≈ head, sandbox=isolated-vm, indexer.opId=sce-testnet1
curl https://sce-test.steempro.com/api/v1/status    # data.opId=sce-testnet1; stats.opsApplied ≥ 1 after genesis
```

Confirm the engine is actually on the test namespace: `GET /health`,
`GET /api/v1/status` and the GraphQL `status` query all expose the namespace as
**`opId`** — a testnet instance must report `sce-testnet1` (mainnet reports
`sce-mainnet1`). That one field is the proof; an empty `tokens` list alone is
ambiguous. The value is also logged once at startup (Dokploy → service → Logs:
`indexer started opId=sce-testnet1`).

Then create a collection through the test frontend with any Steem account and
watch `opsApplied` and `/collections` update. Confirm **isolation**: the same
transaction does not appear on `sce-api.steempro.com`.

## 5. Resetting the testnet

The testnet is a sandbox — resetting loses nothing of value:

1. Delete/recreate the testnet Postgres (or `DROP SCHEMA public` + re-apply
   migrations), redeploy the engine (it syncs to head),
2. re-run `genesis.cjs` with `SCE_OP_ID=sce-testnet1`.

## FAQ

**Why not run an actual separate Steem testnet?** It needs a witness set, chain
ops support and RC faucets — Steem's own testnet is dormant. Namespace isolation
gives the same developer experience with zero chain operations, and it exercises
the *real* consensus path (blocks, re-orgs, quorum) that a synthetic chain would
mock away.

**Can testnet traffic ever affect mainnet?** No — the mainnet engine ignores the
`sce-testnet1` id at the parser, before anything else happens. The only shared
resource is the public Steem chain itself (the RC cost of the broadcast).

**Do I need special accounts?** No — any Steem account with RC (any account does)
can broadcast testnet ops.
