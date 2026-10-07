# syntax=docker/dockerfile:1
# ---- build stage: compiles the engine and the Prisma client -------------------
FROM node:22-bookworm-slim AS build

# isolated-vm is a native addon — toolchain is only needed while building.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

RUN npx prisma generate
RUN npm run build

# ---- runtime stage ------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# OpenSSL must exist in the runtime, not just the build stage: Prisma detects its
# platform by running `openssl version`. Without the CLI it mis-detects
# "debian-openssl-1.1.x" and refuses to load the 3.0.x engine built at generate time
# ("Prisma Client could not locate the Query Engine for runtime debian-openssl-1.1.x").
# ca-certificates is equally required for the HTTPS calls to the Steem RPC endpoints.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Last-resort production default (override via compose `environment:` or the Dokploy
# Environment tab): WITHOUT this the engine could silently boot into in-memory state.
# The URL itself is intentionally NOT baked here — it belongs in the Environment tab.
ENV STORAGE=postgres
WORKDIR /app

# The Prisma CLI stays in the image so migrations can be applied by a one-off task
# (`npx prisma migrate deploy`) or — as configured below — by the entrypoint.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh
# .gitattributes pins the script to LF, but a CRLF checkout would silently break the
# interpreter — normalise again at build time so the image is correct either way.
RUN sed -i 's/\r$//' docker-entrypoint.sh

USER node
EXPOSE 4000 4001
# Migrations run in the entrypoint (then the engine), so every deploy path applies
# the schema before the first query — Swarm/Dokploy ignores compose `depends_on`.
ENTRYPOINT ["sh", "./docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
