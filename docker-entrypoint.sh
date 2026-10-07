#!/bin/sh
# Apply pending schema migrations, then start the engine.
#
# The migration runs inside the engine's own entrypoint instead of a separate
# one-shot `migrate` service for one concrete reason: Dokploy deploys compose
# files as a Docker Swarm stack, and Swarm *ignores* `depends_on`. The separate
# service therefore never ran there — the engine came up against an empty
# database and reported "connected to PostgreSQL" while every query failed with
# `relation "public.BlockRecord" does not exist`.
#
# Running it here works on every deploy path: Swarm/Dokploy, plain
# `docker compose`, and a bare `docker run`. Prisma serialises concurrent
# replicas with an advisory lock, so several engines may race safely.
#
# Opt out with RUN_MIGRATIONS=false (expecting migrations from CI/an operator),
# and note that without DATABASE_URL there is nothing to migrate.
set -e

if [ "${RUN_MIGRATIONS:-true}" != "true" ]; then
  echo "skipping database migrations (RUN_MIGRATIONS=${RUN_MIGRATIONS})"
  exec "$@"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "skipping database migrations (DATABASE_URL is not set)"
  exec "$@"
fi

echo "applying database migrations..."
attempt=0
until npx prisma migrate deploy; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "database migrations failed after $attempt attempts — refusing to start" >&2
    exit 1
  fi
  echo "database migrations failed (attempt $attempt), retrying in 5s..."
  sleep 5
done

exec "$@"
