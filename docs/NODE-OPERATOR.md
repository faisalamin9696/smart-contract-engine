# Running your own node

Anyone can run an SCE engine against Steem and independently arrive at the **same
state** — the engine is a deterministic function of the chain, and the API lets you
prove your result matches everyone else's. This guide takes you from zero to a
verified node.

Related: [SECURITY.md](SECURITY.md) (threat model), [TESTNET.md](TESTNET.md)
(run an isolated testnet), [DEPLOYMENT.md](DEPLOYMENT.md) (server details),
[README](../README.md) (architecture).

## What you get

* a full copy of SCE state (NFT collections/instances, fungible tokens, balances,
  marketplace orders, fee params) in **your** PostgreSQL;
* REST + GraphQL + WebSocket endpoints you control;
* cryptographic (SHA-256) proof your state matches the network — no trust required.

You never need anyone's permission or API key: the only inputs are public Steem RPC
endpoints and a database.

## 1. Prerequisites

* Node.js ≥ 24 and npm (or Docker — all compose variants are provided). The
  `engines` field enforces ≥24 (isolated-vm 7's floor), so npm refuses older runtimes
* PostgreSQL 16 (or use `docker-compose.local-db.yml`, which bundles one — it
  publishes PostgreSQL on loopback only, see DEPLOYMENT.md)
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

> The repository is public — clone freely. Nothing else about running a node requires
> approval: RPC endpoints are public, and state agreement is proven by the checksum,
> not by an authority.

Docker users: see the compose variants in the README (the image entrypoint runs
`prisma migrate deploy` for you, so no deploy tool can skip migrations).

## 3. Configuration that matters for node operators

| Variable | Default | Notes |
| --- | --- | --- |
| `STEEM_RPC_ENDPOINTS` | three public endpoints | comma-separated. **Use ≥ 2, ideally 3, independent endpoints** — that is what powers quorum verification. Best: your own full node (`http://<your-node>:8090`) plus two public ones. |
| `DATABASE_URL` | — | your PostgreSQL. `STORAGE=postgres` refuses to start without it (no silent in-memory mode). Append `?connection_limit=N` to size the Prisma pool (default ≈ CPU cores×2+1) under heavy API traffic. |
| `SCE_OP_ID` | `sce-mainnet1` | mainnet operation id. Different id ⇒ an isolated network of your own (testnet-style — see [TESTNET.md](TESTNET.md)). |
| `START_BLOCK_HEIGHT` | *(unset ⇒ current head)* | where a fresh DB starts indexing — see §4. |
| `QUORUM_VERIFY_DEPTH` | `50` | head-window size for cross-endpoint block verification (0 = off). |
| `RATE_LIMIT_RPM` | `600` | per-IP HTTP budget (`/health` exempt; 0 = off). |
| `TRUST_PROXY_HOPS` | `1` | proxy hops in front of the API (see SECURITY.md). |
| `WS_MAX_CLIENTS` | `500` | simultaneous WebSocket cap. |
| `UNDO_BUFFER_DEPTH` | `30` | micro-fork rollback capacity. |
| `SANDBOX_PROVIDER` | `auto` | pin `isolated-vm` in production to guarantee the hardened isolate. |

Full list: README → Configuration; every knob is also in `.env.example`.

### Minimal verification-node profile (a witness node)

A node that exists only to independently verify the ledger needs no keys and can
run lean:

* engine + PostgreSQL only — skip `docker-compose.watcher.yml` entirely: the
  watcher holds bridge WIFs and a verification node never needs them;
* keep `REST_ENABLED=true` — it also serves `/health` and `/api/v1/status`,
  which the compose healthcheck and §6 depend on; set `GRAPHQL_ENABLED=false`
  if you do not use GraphQL;
* the WebSocket server always listens on `WS_PORT` and cannot be disabled by
  configuration — firewall the port if you serve no subscribers;
* run without a reverse proxy: `TRUST_PROXY_HOPS=0` (see [SECURITY.md](SECURITY.md));
* point `STEEM_RPC_ENDPOINTS` at your own Steem node plus a public fallback and
  you depend on nothing of ours except the chain itself.

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
internal container — the `docker ps` below finds its name):

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

# 2) op id (namespace: sce-mainnet1 / sce-testnet1) + ingest stats
#    (blocksApplied, reorgs, sandbox provider in use)
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

1. Pick a reference node. The canonical one is the public mainnet API,
   `https://sce-api.steempro.com`; once a second independent operator exists,
   cross-check against them too (two independent references beat one).
2. If heights differ, wait for both cursors to reach the same height (re-run).
3. Compare `checksum`. On mismatch, compare `entities` to see which table diverged,
   then diff that table via the REST/GraphQL reads.

The same digest is asserted across `MemoryStore` and `PrismaStateStore` in CI, so a
Postgres-backed node and a memory-backed reference agree by contract.

Near the head, blocks are additionally **quorum-verified** across your endpoints
(see SECURITY.md → "RPC trust"), so a single lying RPC cannot silently diverge your
view while you watch.

The endpoint is budgeted at **12 requests per minute per IP** (repeat polls at
the same height are answered from an in-process cache), so a verification cron
should poll at most a few times a minute from one address — HTTP `429` means you
hit the shared budget, not that verification failed. Digests are computed inside
a single consistent snapshot (cursor + rows from one committed view), so they
stay meaningful while the reference node is actively indexing; the equal-height
rule above remains the only thing that makes two digests comparable.

## 7. Monitoring & capacity

No agent needed — the engine answers its own health over HTTP. **Alert on these**
(a 60-second cron against the endpoints below is enough):

| Signal | Where | Alert when |
| --- | --- | --- |
| cursor lag | `GET /health` | `headHeight - cursorHeight > 100` for several minutes (stuck ingestion) |
| engine health | `GET /health` | HTTP `503` / `"status":"degraded"` — halted indexer or unreachable database (fields: `indexer.running`, `indexer.storeError`) |
| ingest progress | `GET /api/v1/status` | `blocksApplied` flat while the cursor lags |
| quorum disagreements | logs (`QUORUM_DISAGREE`) | any sustained occurrence — a lying or failing endpoint |
| sandbox degradation | `GET /health` → `sandbox` | anything but `isolated-vm` in production |
| RPC endpoint health | logs (cooldown notices) | every endpoint in cooldown |
| disk | host | > 80 % used (Postgres data + WAL grow with history) |
| rate limiting | logs / edge metrics | rising 429s — legitimate clients being cut |
| process | host | RSS growth without bound, restart loops |

```bash
# health + cursor-lag probe: exits 1 when the API is down, when /health reports
# degraded (503 — engine halted or store unreachable; -sf fails on non-2xx), or
# when the cursor lags > 100 blocks. Fields nest under `indexer`.
h=$(curl -sf localhost:4000/health) || exit 1
node -e 'const i=JSON.parse(process.argv[1]).indexer;process.exit(i.headHeight-i.cursorHeight>100?1:0)' "$h"
```

**Capacity baseline** (head-following node, honest numbers):

| Resource | Small node | Notes |
| --- | --- | --- |
| CPU | 1–2 vCPU | isolated-vm execution + JSON parsing; catch-up replay is CPU/RPC bound |
| RAM | 1–2 GB | Node process ~200–400 MB + Postgres shared buffers ~512 MB |
| Disk | ~1–2 GB / year | one small row per block (journal is pruned, block/op history is kept) + WAL; snapshots (§5) compress well |
| Network | ~1 request / 3 s at head | burst during catch-up; responses are gzip-compressed |
| DB pool | ≈ CPU cores × 2 + 1 | raise deliberately via `?connection_limit=` when API traffic grows |

Reads scale horizontally: the API is read-only, so read replicas behind a
replicated database can absorb traffic. The write path (ingestion) is
**single-writer by design** — never run two engines against one database.

## 8. Upgrades

```bash
git pull
docker compose up -d --build     # entrypoint: prisma migrate deploy, then start
curl localhost:4000/health       # confirm cursor resumes at head
curl localhost:4000/health | jq .version   # confirm the new build (release = bump
                                           # package.json version; SCE_BUILD_SHA
                                           # stamps the exact commit if set)
```

Migrations are additive and run automatically; no manual DDL. If a migration is a
reset-style operation (like `0005_reset_legacy_state`), it will be announced in the
release notes — read them before deploying.

## 9. Serving others / contributing

**Reverse proxy** — TLS, edge rate limits (they complement the built-in limiter)
and WebSocket pass-through. Caddy example:

```caddyfile
# API (REST + GraphQL + health)
your-api.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4000
}

# WebSocket — flush immediately so server-sent frames are never buffered
your-ws.example.com {
	reverse_proxy 127.0.0.1:4001 {
		flush_interval -1
	}
}
```

**Security checklist** (rationale in [SECURITY.md](SECURITY.md)):

* `TRUST_PROXY_HOPS` matches your proxy count **exactly** (never “trust all” — it
  lets clients spoof their IP past the limiter);
* `SANDBOX_PROVIDER=isolated-vm` pinned in production;
* ≥ 2 independent `STEEM_RPC_ENDPOINTS` — quorum verification needs disagreement
  to be detectable;
* Postgres reachable only from the engine’s network, strong password, rotated if
  it ever touched git history;
* TLS everywhere; your official hostname documented so clients can pin it;
* `npm audit --omit=dev` reviewed before releases (known advisories are explained
  in SECURITY.md → “Known dependency advisories”).

Applications pick your endpoint by URL — there is no registration with a central
operator; agreement is enforced by the state checksum, not by an authority.

**Contributing code:** see [CONTRIBUTING.md](../CONTRIBUTING.md) — open an issue
first for large changes, then a PR; CI runs every gate on ubuntu + Postgres 16.
License: MIT (see `LICENSE`).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `cursorHeight` stuck | `/health` — RPC failover logs, endpoint cooldowns; `LOG_LEVEL=debug` |
| `QUORUM_DISAGREE` in logs | two of your endpoints report different blocks — that is the safety working; fix/remove the outlier endpoint |
| 429 responses | you or your clients exceeded `RATE_LIMIT_RPM` — raise it or put a proxy budget in front |
| `sandbox: node-vm` in `/health` | isolated-vm failed to load (toolchain); install build deps or pin providers explicitly |
| checksum mismatch | compare `entities` digests first; confirm both nodes are at the same `height` |
| disk filling up | block/op history grows monotonically — watch the trend, keep WAL on the same disk sizing as data, use §5 snapshots for distribution |
| `sorry, too many clients already` | Postgres connection slots exhausted — lower `connection_limit` in `DATABASE_URL` or raise `max_connections` |
| upstream HTTP 429 from RPC endpoints | you are polling faster than public endpoints allow — endpoints cool down and rotate automatically; add your own node or raise `BLOCK_POLL_INTERVAL_MS` |
| `Unique constraint failed on (height, seq)` in logs | two engine instances write one database (§7: single-writer) — stop the extra one; a single occurrence right after a rolling deploy is the known two-writer race, the loser backs off and converges |
| `/health` returns 503 / `degraded` | `indexer.running=false` (halted, e.g. deep fork) or `indexer.storeError=true` (DB unreachable) — check logs; the compose healthcheck acts on this status code |
