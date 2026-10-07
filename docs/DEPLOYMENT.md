# Deploying the engine next to its database

The engine is a stateless HTTP/WS process in front of a PostgreSQL database. This guide
covers the typical case where the database already exists on the same host/cluster as an
internal hostname (e.g. `steemcraft-db-4jwfp1:5432`) that only resolves inside that
environment's DNS/network.

## 1. Prerequisites

* Docker Engine + Compose v2 on the target host
* the database reachable from that host, plus a user/database (e.g. `steemcraft`)
* outbound HTTPS to your Steem RPC endpoints

## 2. Copy the project

```bash
git clone <repo> steemcraft && cd steemcraft   # or scp/rsync the folder
```

The image builds its own dependencies — do **not** copy `node_modules`.

## 3. Configure

```bash
cp .env.example .env
```

Minimum required:

```dotenv
DATABASE_URL=postgresql://steempro:***@steemcraft-db-4jwfp1:5432/steemcraft
```

`DATABASE_URL` is the only required variable; everything else has a safe default.

> `.env` holds credentials — it is git-ignored and excluded from the Docker image. Only
> `DATABASE_URL` is injected into containers, via Compose interpolation.

## 4. Decide which Docker network the engine should join

If the DB hostname resolves on the host itself (or is a managed/remote host), skip to
step 5. If it is another Compose project's container name, it only resolves on that
project's network:

```bash
docker network ls
docker inspect <db-container> --format '{{json .NetworkSettings.Networks}}'
```

Take the network name (e.g. `someproject_default`) and pass it with
`docker-compose.dbnet.yml`.

## 5. Start

```bash
# DB reachable on the default bridge / host DNS:
docker compose up -d --build

# DB lives on another Docker network:
DB_NETWORK=<network> docker compose -f docker-compose.yml -f docker-compose.dbnet.yml up -d --build

# No database yet — bring one up together with the engine:
docker compose -f docker-compose.yml -f docker-compose.local-db.yml up -d --build
```

Startup: the engine's entrypoint runs `npx prisma migrate deploy` (applies
`prisma/migrations`, idempotent via Prisma's advisory lock) and only then starts the
process, retrying for ~2.5 minutes while the database boots. There is deliberately **no
separate `migrate` service**: Docker Swarm — what Dokploy deploys compose files as —
ignores `depends_on`, which is exactly how an earlier deploy ended up serving an empty
database. Set `RUN_MIGRATIONS=false` to manage migrations out-of-band instead.

## 6. Verify

```bash
docker compose ps                                   # engine = healthy
curl -s localhost:4000/health | jq
curl -s 'localhost:4000/api/v1/status' | jq
curl -s localhost:4000/graphql -H 'content-type: application/json' \
     -d '{"query":"{ status { running cursorHeight sandbox storage } }"}' | jq
docker compose logs -f engine
```

Expected `health` payload:

```json
{"status":"ok","storage":"postgres",
 "indexer":{"running":true,"headHeight":0,"cursorHeight":0,"sandbox":"isolated-vm"}}
```

`cursorHeight: 0` plus `indexer.running: true` means the engine is waiting for its first
successful RPC poll — check `docker compose logs engine` for endpoint failures.

WebSocket smoke test (from any machine that can reach the host):

```bash
# ws://<host>:4001
# → {"type":"subscribe","channels":["account:alice","market"]}
# → {"type":"subscribed","channels":["account:alice","market"]}
```

## 7. Day-2 operations

| Task | Command |
| --- | --- |
| Redeploy after a pull | `docker compose up -d --build` (entrypoint reruns migrations, idempotent) |
| Run migrations only | `docker compose exec engine npx prisma migrate deploy` |
| Tail logs | `docker compose logs -f engine` |
| Restart | `docker compose restart engine` |
| Stop everything | `docker compose down` (add `-v` only to destroy the local-db volume) |
| Backup the ledger | `docker compose exec postgres pg_dump -U <user> <db> > backup.sql` |

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `getaddrinfo ENOTFOUND steemcraft-db-4jwfp1` in logs | the engine is not on the DB's network → use `docker-compose.dbnet.yml` with the right `DB_NETWORK`, or point `DATABASE_URL` at a resolvable host |
| `password authentication failed` | wrong credentials in `.env` (verify with `psql "$DATABASE_URL" -c 'select 1'`) |
| engine exits immediately with `cannot reach PostgreSQL` | DB down/unreachable, or `DATABASE_URL` missing — see `docker compose logs engine` |
| `ingestion halted: re-org deeper than the undo buffer` | raise `UNDO_BUFFER_DEPTH` (default 30) and restart; state is never corrupted, it stops instead |
| `engine` unhealthy, logs show RPC timeouts | unreachable `STEEM_RPC_ENDPOINTS`; endpoints are rotated with cooldown/back-off automatically |
| `port is already allocated` | another service owns 4000/4001 → set `PORT`/`WS_PORT` in `.env` |
| two engines fighting over the cursor | they are safe: `pg_advisory_xact_lock` serialises block processing, the second one idles |

## 9. Running without Docker

```bash
npm ci
npx prisma generate
npm run build
npx prisma migrate deploy
node dist/src/index.js        # or pm2/systemd for supervision
```

The same `.env` is picked up automatically (dotenv).
