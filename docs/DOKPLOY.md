# Deploying on Dokploy

[Dokploy](https://dokploy.com) deploys this engine as a **Compose** service. The repo ships
a ready-made file for it: [`docker-compose.dokploy.yml`](../docker-compose.dokploy.yml),
which

* applies `prisma migrate deploy` in the engine's entrypoint before serving (set
  `RUN_MIGRATIONS=false` to disable),
* starts the engine (REST :4000, GraphQL, WebSocket :4001),
* attaches both to Dokploy's shared **`dokploy-network`** — that is what makes the
  database hostname (e.g. `steemcraft-db-4jwfp1`) resolve *and* lets Traefik reach the
  engine through the Domains tab.

## 0. Prerequisites

| | |
| --- | --- |
| Database | a Dokploy **Postgres** service (or any DB on `dokploy-network`), plus its connection string |
| Code | pushed to GitHub / GitLab / Bitbucket and connected in Dokploy (*Settings → Git*) |
| Domains | DNS `A` records pointing at your Dokploy server; *Settings → Server* has a Let's Encrypt email configured |
| Ports | 80/443 open for Traefik (and 4000/4001 only if you keep the direct `ports` mapping) |

## 1. Create the Compose service

1. **Project → + Service → Compose**, type **Docker Compose**
2. Provider: **GitHub/GitLab/Bitbucket** → select the repo, branch (e.g. `main`)
3. **Compose Path**: `docker-compose.dokploy.yml`
4. Save

## 2. Environment

Open the service's **Environment** tab and add at least:

```dotenv
DATABASE_URL=postgresql://steempro:***@steemcraft-db-4jwfp1:5432/steemcraft
```

> Keep `DATABASE_URL` in this Environment tab — no default is baked into the compose
> file or image (secrets stay out of git). `STORAGE=postgres` *is* baked in, so a missing
> or unreachable database fails the deploy/startup **visibly** instead of silently running
> on in-memory state.

Optional overrides (all have defaults):

```dotenv
STEEM_RPC_ENDPOINTS=https://api.steemit.com,https://api.steemyy.com,https://api.moecki.online
UNDO_BUFFER_DEPTH=30
START_BLOCK_HEIGHT=0
LOG_LEVEL=info
PORT=4000
WS_PORT=4001
```

Compose reads these for `${...}` interpolation *and* injects them into the containers.

## 3. Domains

**Domains tab → + Domain**, service `engine`:

| Domain | Container port | Serves |
| --- | --- | --- |
| `nft-api.example.com` | `4000` | `GET /health`, `/api/v1/*`, `POST /graphql` |
| `nft-ws.example.com` | `4001` | WebSocket (`wss://`) |

Traefik proxies WebSocket transparently, so no extra configuration is needed. Create the
two DNS `A` records before deploying (certificates take ~10 s after the first request).

> Prefer raw TCP instead? Keep the `ports:` mapping in the compose file and connect to
> `ws://<server-ip>:4001` directly (open 4001 in your firewall). Everything else can still
> go through a domain.

## 4. Deploy

Click **Deploy**. Expected sequence in the logs:

```
engine   → applying database migrations … 0001_init, 0002_wiki_nft_alignment (or "No pending migrations")
engine   → DATABASE_URL … connected to PostgreSQL
engine   → contract sandbox ready  provider=isolated-vm
engine   → http server listening / websocket server listening / indexer started
```

> Migrations run **inside the engine container**. Dokploy deploys compose files as a
> Docker Swarm stack, which ignores `depends_on` — a separate one-shot `migrate`
> service would never run (that is how the database once stayed empty while the
> engine reported `connected to PostgreSQL`).

Verify:

```bash
curl -s https://nft-api.example.com/health
# {"status":"ok","storage":"postgres","indexer":{"running":true,...}}

curl -s https://nft-api.example.com/graphql -H 'content-type: application/json' \
     -d '{"query":"{ status { running cursorHeight sandbox storage stats { blocksApplied } } }"}'
```

WebSocket: connect to `wss://nft-ws.example.com` and send
`{"type":"subscribe","channels":["account:alice","market"]}`.

## 5. Day-2

| Task | How |
| --- | --- |
| Ship an update | `git push` → **Deploy** in Dokploy (migration reruns, idempotent) |
| Inspect logs | service → **Logs** |
| Force re-run migrations | redeploy, or `docker exec <engine-container> npx prisma migrate deploy` on the server |
| Rotate a variable | **Environment** tab → Save → **Redeploy** |
| Check ingestion cursor | `GET /health` or `/api/v1/status` (`cursorHeight` vs `headHeight`) |

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/health` reports `"storage":"memory"` | `DATABASE_URL` never reached the container: the Environment tab was empty or not saved. Redeploy with it set — with the shipped `STORAGE=postgres` the deploy now fails fast instead of silently using RAM |
| `password authentication failed for user …` | wrong credentials in `DATABASE_URL` |
| `getaddrinfo ENOTFOUND steemcraft-db-…` | the DB is not on `dokploy-network` — recreate it as a Dokploy Postgres service, or check its network with `docker inspect <db> --format '{{json .NetworkSettings.Networks}}'` |
| `Environment variable not found: DATABASE_URL` from the migration step | the variable is missing in the Environment tab (the compose file fails fast on purpose) |
| `/api/v1/*` returns 500 with `relation "public."…" does not exist` | the schema was never applied (the engine skips queries it cannot make). Check the logs for `applying database migrations`; otherwise run `docker exec <engine-container> npx prisma migrate deploy` and redeploy |
| deploy fails with `port is already allocated` | 4000/4001 taken — change `PORT`/`WS_PORT`, or delete the `ports:` block and use Domains only |
| `engine` container unhealthy | `Logs`: RPC timeouts → endpoints rotate/back-off automatically; DB down → check the Postgres service |
| `ingestion halted: re-org deeper than the undo buffer` | raise `UNDO_BUFFER_DEPTH` (default 30) and redeploy — state is never corrupted, it halts instead |
| 404 from a domain | domain points at the wrong service/port — must be service `engine`, port `4000`/`4001` |
| WebSocket connects but no events | subscribe first: `{"type":"subscribe","channels":["*"]}` |

## 7. Optional: Postgres parity suite

From any machine that can reach the database:

```bash
TEST_DATABASE_URL="$DATABASE_URL" npx jest --runInBand tests/integration/postgresStore.test.ts
```

It applies migrations (idempotent), writes `TST*`/`height ≥ 9_000_001` fixtures and cleans
them up afterwards — best run against a scratch database (`steemcraft_test`).
