# syntax=docker/dockerfile:1
# ---- WSTEEM bridge watcher image ------------------------------------------------
# The key-holding signer half of the bridge (scripts/wsteem.cjs --watch): detects
# L1 deposits -> issues WSTEEM, detects peg-out intents -> burns + releases STEEM.
# Build context = repo root; deploy through docker-compose.watcher.yml (Dokploy).
#
# Deliberately separate from the engine image: the engine holds NO keys and must
# never grow any (docs/BRIDGE.md -> "Server deployment").
FROM node:24-bookworm-slim

# Base matches the engine image (Node 24 floor, glibc). ca-certificates is
# required for the outbound HTTPS calls (engine REST + Steem RPC) — slim ships
# without a trust store, same reasoning as the engine's runtime stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Minimal dependency set: dsteem only — verified sufficient (scripts/wsteem.cjs
# runs standalone against exactly this tree). --ignore-scripts: secp256k1 3.8.1
# then signs via its pure-JS path, producing byte-identical RFC6979 signatures to
# a native build (cross-checked against the install that signed every live
# mainnet broadcast), and no install script can smuggle code into the image.
COPY watcher/package.json watcher/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# The ops script is self-contained (reads env, talks to RPC/REST over HTTPS).
COPY scripts/wsteem.cjs ./scripts/wsteem.cjs

# Non-secret defaults ONLY — STEEM_ACTIVE_WIF (space-separated 2-of-3 WIFs) comes
# from the Dokploy Environment tab: a secret baked into a layer outlives every
# redeploy and ships to anyone who pulls the image.
ENV BRIDGE_ACCOUNT=steempro.funds \
    SCE_OP_ID=sce-mainnet1 \
    ENGINE_API=https://sce-api.steempro.com \
    STEEM_RPC=https://api.steemit.com \
    WATCH_INTERVAL=30 \
    WATCH_LAG_TICKS=20

USER node
# Outbound-only: engine REST + Steem RPC over HTTPS. No EXPOSE — nothing listens.
CMD ["node", "scripts/wsteem.cjs", "--watch"]
