# Running your own node

Anyone can run an SCE engine against Steem and independently arrive at the **same
state** — the engine is a deterministic function of the chain, and the API lets you
prove your result matches everyone else's. This guide takes you from zero to a
verified node.

Related: [SECURITY.md](SECURITY.md) (threat model), [DEPLOYMENT.md](DEPLOYMENT.md)
(server details), [DOKPLOY.md](DOKPLOY.md) (PaaS deploy), [README](../README.md)
(architecture).

## What you get

* a full copy of SCE state (NFT collections/instances, fungible tokens, balances,
  marketplace orders, fee params) in **your** PostgreSQL;
* REST + GraphQL + WebSocket endpoints you control;
* cryptographic (SHA-256) proof your state matches the network — no trust required.

You never need anyone's permission or API key: the only inputs are public Steem RPC
endpoints and a database.

## 1. Prerequisites

* Node.js ≥ 20 and npm (or Docker — all compose variants are provided)
* PostgreSQL 16 (or use `docker-compose.local-db.yml`, which bundles one)
* Outbound HTTPS to your Steem RPC endpoints; inbound only if you want to serve the API

## 2. Install

```bash
git clone https://github.com/faisalamin9696/smart-contract-engine.git
cd smart-contract-engine
npm ci
cp .env.example .env       # then edit — at minimum DATABASE_URL and STEEM_RPC_ENDPOINTS
npx prisma generate
npx prisma migrate deploy  # applies prisma/migrations
npm run build
npm start                  # node dist/src/index.js
```

> The repository is currently **private** — ask the maintainer for read access to the
> clone URL above. Nothing else about running a node requires approval: RPC endpoints
> are public, and state agreement is proven by the checksum, not by an authority.

Docker users: see the compose variants in the README (the image entrypoint runs
`prisma migrate deploy` for you, so no deploy tool can skip migrations).

## 3. Configuration that matters for node operators

| Variable | Default | Notes |
| --- | --- | --- |
| `STEEM_RPC_ENDPOINTS` | three public endpoints | comma-separated. **Use ≥ 2, ideally 3, independent endpoints** — that is what powers quorum verification. Best: your own full node (`http://<your-node>:8090`) plus two public ones. |
| `DATABASE_URL` | — | your PostgreSQL. `STORAGE=postgres` refuses to start without it (no silent in-memory mode). |
| `SCE_OP_ID` | `sce-mainnet1` | mainnet operation id. Different id ⇒ an isolated network of your own (testnet-style). |
| `START_BLOCK_HEIGHT` | *(unset ⇒ current head)* | where a fresh DB starts indexing — see §4. |
| `QUORUM_VERIFY_DEPTH` | `50` | head-window size for cross-endpoint block verification (0 = off). |
| `RATE_LIMIT_RPM` | `600` | per-IP HTTP budget (`/health` exempt; 0 = off). |
| `TRUST_PROXY_HOPS` | `1` | proxy hops in front of the API (see SECURITY.md). |
| `WS_MAX_CLIENTS` | `500` | simultaneous WebSocket cap. |
| `UNDO_BUFFER_DEPTH` | `30` | micro-fork rollback capacity. |
| `SANDBOX_PROVIDER` | `auto` | pin `isolated-vm` in production to guarantee the hardened isolate. |

Full list: README → Configuration; every knob is also in `.env.example`.

## 4. Sync semantics (read this before your first boot)

* **Fresh node, `START_BLOCK_HEIGHT` unset:** indexing starts at the **current head**.
  Fast to get an API online, but your state starts empty from that moment — history
  before your start is not retroactively visible.
* **To reproduce the canonical mainnet state:** start at or just before the first
  `sce-mainnet1` operation:

  ```bash
  # genesis ops live at heights 110282608/110282611/110282614
  START_BLOCK_HEIGHT=110282600
  ```

  Everything before that contains no operations for this op id (legacy ids are
  ignored), so scanning from there yields byte-identical state. Scanning from `0` works
  too — just slower.
* **Never broadcast genesis/fee ops "because your node is new"** — state comes from
  the chain, not from local re-broadcasts. If your DB already has the ops, re-issuing
  them only creates failed transactions.
* Cursor vs head: watch `GET /health` (`cursorHeight` catching up to `headHeight`).
  During catch-up the engine polls as fast as RPC allows; at head it settles to ~3s.

## 5. Start from a shared snapshot (fast start, optional)

Instead of replaying chain history (§4), you can restore a `pg_dump` of an
already-synced node and continue from its cursor — a quick way to stand up a
second node, and the supported way to distribute the ledger as history grows.

**Publisher** (someone with DB access; on this deployment Postgres runs as an
internal container — see DOKPLOY.md for its name):

```bash
# find the container:  docker ps --format '{{.Names}}' | grep -i postg
docker exec <postgres-container> pg_dump -U <user> -d <db> -Fc > sce-snapshot.dump
sha256sum sce-snapshot.dump      # publish this digest next to the file
```

* one `pg_dump` is a single MVCC snapshot — state and cursor are mutually
  consistent (the cursor height is the height of every row in the file);
* it contains only public, chain-derived data: roles and passwords are **not**
  included (no `--globals`), so the file is safe to share;
* ship the file's sha256 and the cursor height (`GET /api/v1/status` at dump
  time) together with it — and keep one copy off-box; the same command doubles
  as your disaster-recovery backup.

**Receiver:**

```bash
sha256sum sce-snapshot.dump                 # must equal the published digest
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" sce-snapshot.dump
# plain-SQL dump instead: psql "$DATABASE_URL" -f sce-snapshot.sql

# start the engine with START_BLOCK_HEIGHT **unset** — it resumes at the
# dump's cursor automatically; the dump carries _prisma_migrations, so
# `prisma migrate deploy` is a no-op until the next release ships one.
```

**Verification matters more with snapshots.** A restored dump is a *trust
transfer* until you prove it: run §6 against a reference node once both are at
the same height. If you want zero trust from the start, use the replay path in
§4 instead — it just costs more time as history grows.

Not recommended: **live logical replication** of the publisher's Postgres. It
requires exposing the database beyond the internal network, and your engine
writes to the same rows, which breaks the replication stream. Snapshots are the
distribution mechanism this project supports.

## 6. Verify your node (the important part)

```bash
# 1) alive and progressing
curl https://your-host/health

# 2) ingest stats (blocksApplied, reorgs, sandbox provider in use)
curl https://your-host/api/v1/status

# 3) state fingerprint — must match a reference node AT THE SAME HEIGHT
curl https://your-host/api/v1/state-checksum
```

```jsonc
{
  "data": {
    "height": 110284079,              // cursor height — compare only when equal
    "storage": "postgres",
    "entities": { "balances": "…", "collections": "…", "instances": "…",
                  "meta": "…", "orders": "…", "param": "…", "tokens": "…" },
    "checksum": "…"                   // equal on every honest node at this height
  }
}
```

Procedure:

1. Pick a reference node (e.g. the public endpoint, or another operator).
2. If heights differ, wait for both cursors to reach the same height (re-run).
3. Compare `checksum`. On mismatch, compare `entities` to see which table diverged,
   then diff that table via the REST/GraphQL reads.

The same digest is asserted across `MemoryStore` and `PrismaStateStore` in CI, so a
Postgres-backed node and a memory-backed reference agree by contract.

Near the head, blocks are additionally **quorum-verified** across your endpoints
(see SECURITY.md → "RPC trust"), so a single lying RPC cannot silently diverge your
view while you watch.

## 7. Upgrades

```bash
git pull
docker compose up -d --build     # entrypoint: prisma migrate deploy, then start
curl localhost:4000/health       # confirm cursor resumes at head
```

Migrations are additive and run automatically; no manual DDL. If a migration is a
reset-style operation (like `0005_reset_legacy_state`), it will be announced in the
release notes — read them before deploying.

## 8. Serving others / contributing

* Put the engine behind your reverse proxy if you expose it publicly (Traefik/Caddy
  with rate limits at the edge complement the built-in limiter), keep Postgres on an
  internal network only, and pin `SANDBOX_PROVIDER=isolated-vm`.
* Applications pick your endpoint by URL — there is no registration with a central
  operator; agreement is enforced by the state checksum, not by an authority.
* To contribute code: open an issue first for large changes, then a PR. Gates every
  PR must pass (CI runs them on ubuntu + Postgres 16):

  ```bash
  npx tsc --noEmit
  npx jest --runInBand
  npm run build
  npx js-yaml docker-compose.yml   # + the other compose files you touched
  ```

  CI config: `.github/workflows/ci.yml`. License: MIT (see `LICENSE`).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `cursorHeight` stuck | `/health` — RPC failover logs, endpoint cooldowns; `LOG_LEVEL=debug` |
| `QUORUM_DISAGREE` in logs | two of your endpoints report different blocks — that is the safety working; fix/remove the outlier endpoint |
| 429 responses | you or your clients exceeded `RATE_LIMIT_RPM` — raise it or put a proxy budget in front |
| `sandbox: node-vm` in `/health` | isolated-vm failed to load (toolchain); install build deps or pin providers explicitly |
| checksum mismatch | compare `entities` digests first; confirm both nodes are at the same `height` |
