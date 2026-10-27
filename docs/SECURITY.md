# Security

Threat model, verified layers and known limitations for the SCE engine. The engine is
an **L2-style indexer**: it derives state from Steem's consensus-ordered `custom_json`
operations, executes them deterministically, and serves read-only projections of that
state. Writes never enter through the engine's API — they enter through the Steem
blockchain, signed by key holders.

Related: [NODE-OPERATOR.md](NODE-OPERATOR.md) (running your own node),
[README](../README.md) (architecture).

## Trust boundaries

```
 untrusted                          │ boundary              │ trusted
────────────────────────────────────┼───────────────────────┼──────────────────────────
 Steem RPC responses (can lie)      │ quorum + linkage +    │ committed state
 custom_json params (attacker-made) │ re-org handling       │ (Postgres / memory)
 HTTP/WS clients (can flood)        │ zod strict schemas    │ VM mutations (validated
 Browser CORS origins                │ host guard            │ by guard before write)
                                    │ rate limit + caps     │
                                    │ authority derivation  │
                                    │ from chain auths      │
```

## Verified layers

### 1. Authority is derived from the chain, never from the payload

`src/chain/opParser.ts` builds the actor list exclusively from the operation's
`required_auths` (active) and `required_posting_auths` (posting) — the fields Steem's
consensus validates signatures against. The JSON payload's own account fields are
**never** trusted to identify a signer. Operations carrying no authority are rejected
(`NO_AUTHORITY`). Payload size is capped (`MAX_PAYLOAD_BYTES`).

### 2. Every mutating action is authority-gated inside the contract

`src/vm/contractSource.ts` enforces per-action authority with `hasAuth`/`requireAuth`:

| Action class | Requirement |
| --- | --- |
| `create` (nft/tokens) | active authority; `creator = ctx.auths.active[0]`; fee charged to the **signer** |
| transfers / burns / `placeOrder` | active of the current owner/holder (derived from signed auths) |
| `fillOrder` | active; buyer is the first active signer that is not the seller |
| `cancelOrder` | active of the seller |
| market `buy`/`sell`/`cancel` | active of the signer — `buy`/`sell` move funds into escrow, `cancel` refunds **only** to the order owner (identity fields are immutable, terminal rows frozen) |
| issuer management / property admin / `transferOwnership` / `updatePrecision` | active of the owner (`editCollection`/`editToken` check **before** any mutation or fee) |
| `setProperties` | per-property `authorizedEditingAccounts` (posting sufficient by wiki rule) |
| `updateUrl`/`updateMetadata` (and nft name-family) | owner with active **or** posting |
| `engine.setParam` | active of `param.admin` only; fee keys whitelisted; bps capped |

There is no code path that mutates state without passing one of these checks, and fees
are always debited from a signer or an owner-verified payer.

### 3. The host re-validates everything the VM produces

The sandbox returns *declarative mutations*; the host (`src/vm/guard.ts`,
`src/state/stateTxn.ts`) independently re-checks schemas, entity allowlists per
contract, immutable fields, read-set integrity, supply/burn invariants, order finality,
and the **ledger conservation invariant** (per op, balance deltas per symbol must equal
that symbol's supply delta — with the fungible market, book-order escrow counted as a
balance-equivalent of the side's token, so placement/fills/cancels also net to zero). A compromised or buggy guest cannot write a row the guard
rejects, and a failed op never aborts the block.

### 4. Determinism

No floats, frozen BigNumber config on both sides of the sandbox, no host APIs or clock
in the guest (timestamps come from block headers), blocked globals, `codeGeneration`
disabled, hard time/memory limits. `isolated-vm` is preferred; the `node-vm` fallback
runs the identical first-party contract bytes in a locked-down context, is announced
loudly at boot, and in production the boot **stops** rather than degrade to it (see
below). `SANDBOX_PROVIDER` pins the level explicitly.

#### Sandbox provider contract: no silent downgrade

`isolated-vm` is a **native addon** and a **hard dependency** — production refuses
to boot without it (layer 3 below). While 6.x compiled from source, it lived in
`optionalDependencies` so a contributor machine without a compiler could still
`npm ci` and run the suite on `node-vm`; **7.x ships prebuilt binaries for every
platform we use** (win32/linux/darwin × x64/arm64 × glibc/musl, Node 24 and 26
ABIs), so that era is over and a failed install is fatal again. npm proving the
package *installed* is still not the same as the addon *loading* inside the shipped
image, so three layers turn any gap into a loud failure:

1. **Version floor** — Node `>=24` (`engines`, Docker base, CI) matches
   `isolated-vm@^7.0.1`'s own `engines: >=24` requirement. Current pin: **7.0.1**
   (7.x line, security fix for the Aug-2026 ExternalCopy type-confusion escape; its
   6.x backport was 6.2.0 — the version previously pinned here). The Node↔addon
   matrix per upstream: 7.x ↔ Node ≥ 24; below the floor npm has only source builds
   to fall back on and the install fails loudly instead of silently omitting the
   addon.
2. **Build-time** — `node -e "require('isolated-vm')"` runs in CI right after `npm ci`
   and in *both* Docker stages (build stage: the compile succeeded; runtime stage: the
   addon loads against the runtime ABI). A red assertion beats a reduced isolation
   level discovered in production.
3. **Boot-time** — under `NODE_ENV=production` the engine refuses to start when the
   live provider is not `isolated-vm` (`assertProductionSandbox`, `src/vm/sandbox.ts`),
   the same "no silent fallback" rule that already governs `STORAGE`/`DATABASE_URL`.
   The one deliberate escape hatch is an explicit `SANDBOX_PROVIDER=node-vm`.

The live level is always observable: `GET /api/v1/status` → `sandbox` (also in
GraphQL `status.sandbox`). The threat this guards against is not user code — no
user-supplied JavaScript ever reaches the isolate (fixed first-party contract bytes,
JSON params validated before execution) — but the operational failure mode where a
broken toolchain silently halves the containment around the engine process.

### 5. RPC trust: quorum verification + linkage + re-org

An indexer must not accept a block from a single possibly-lying RPC endpoint:

* **Linkage** — `block.previous` must equal the stored head's `block_id` before
  anything is applied; a divergent block triggers the re-org path (rollback + refetch).
* **Quorum** (`QUORUM_VERIFY_DEPTH`, default 50) — every block within 50 heights of the
  known head is fetched from a second endpoint and compared by a full fingerprint
  (header fields + transaction ids + operation bodies). On a split view a **third**
  endpoint breaks the tie: the majority wins and the dissenter is cooled down; an
  unresolvable split throws `QUORUM_DISAGREE` and the engine **stalls loudly instead
  of applying a possibly fabricated block**. Deep-history sync is exempt (those heights
  are far below the head); with a single endpoint there is nothing to compare against.
* **Malformed payloads** rotate the endpoint out (`BAD_RESPONSE`), transport failures
  rotate with exponential cooldown, and endpoint recovery is logged.

### 6. Network-facing surfaces are read-only and rate limited

* Every REST route is `GET`; GraphQL exposes queries only (no mutations); WS accepts
  `subscribe`/`unsubscribe`/`ping` only. Nothing on the API can mutate the ledger —
  the only write path is a signed operation on the Steem chain.
* **Per-IP token-bucket rate limiting** (`RATE_LIMIT_RPM`, default 600/min,
  `/health` exempt) with spoof-proof client IPs (`TRUST_PROXY_HOPS` — a fixed hop
  count instead of `trust proxy: true`, which a client could defeat by prepending its
  own `X-Forwarded-For`). Spoof-proofing assumes exactly one appending proxy hop;
  with **direct exposure** (no proxy in front) set `TRUST_PROXY_HOPS=0`, otherwise
  the client's own rightmost `X-Forwarded-For` entry becomes the bucket key.
* Query/page limits are capped (100 rows), request bodies are capped (256 kB), WS has
  payload caps, a per-socket subscription cap (100), a global client cap
  (`WS_MAX_CLIENTS`) and heartbeat reaping.
* **GraphQL query-cost ceilings** run as a validation rule *before any resolver*:
  depth ≤ 15, aliased fields ≤ 50, directives ≤ 100, and ≤ 10 000 list rows along
  any single root-to-leaf path (`analyzeQuery` + `maxListRowsOnAnyPath`,
  unit-tested). Alias breadth and nested list fan-out are the vectors that matter —
  each alias or nesting level can carry a 100-row list; a bomb is rejected with
  `400` and zero store access.
* Every response carries baseline security headers (`X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`); HTTP gets
  header/body timeouts (15 s / 60 s) against slowloris-style socket holds; JSON
  is gzip-compressed (`compression`) so saturated links keep serving.
* CORS is open (`cors()` — globally, REST included) — acceptable because the API
  is read-only, cookie-less and meant to be consumed by browsers; there is no
  credentialed request to protect. CORS preflights (`OPTIONS`) bypass the limiter:
  they are static replies, and metering them would only double cross-origin traffic.

### 7. Secrets

* `.env` is untracked (only `.env.example` is committed); the config module is the
  single place that reads environment variables.
* The database is internal-only on the Docker network; no engine route exposes
  credentials. *(Operational item: rotate the Postgres password — it appears in old
  commit history — see "Known limitations".)*

## Cross-node verification (trust, but verify)

The state of any two honest nodes at the same cursor height is byte-identical by
construction; the engine makes that checkable:

* `GET /api/v1/state-checksum` — deterministic per-entity SHA-256 fingerprints of the
  whole ledger (collections, instances, tokens, balances, orders, bookOrders, param,
  `order_seq`, `market_order_seq`).
  Compare against a reference node at the **same height**; `entities` pinpoints which
  table diverged.
* The Postgres parity suite runs the same assertions against `MemoryStore` and
  `PrismaStateStore` in CI, including **checksum equality across back-ends** — the two
  storage implementations are held to an identical digest contract.

## Known limitations (explicit, not oversold)

1. **No witness-signature verification.** Block headers are not checked against
   witness signatures, so an attacker who controls *every* endpoint in your
   `STEEM_RPC_ENDPOINTS` list (or the TLS trust behind them) can feed your node a
   self-consistent but false view of history. Mitigations: independent endpoints,
   quorum near the head, linkage + re-org for sequence breaks, and state-checksum
   comparison against an outside reference. Verifying witness signatures (header
   serialization + secp256k1) is the documented next hardening step.
2. **Deep-history replay trusts its sources** — quorum only covers the head window.
   After syncing from a historical `START_BLOCK_HEIGHT`, compare your
   `state-checksum` with a reference node before serving anyone.
3. **The API is unauthenticated** (by design: it is read-only). Application-level
   abuse beyond the per-IP budget is mitigated at the ingress layer if you expose the
   engine publicly at scale.
4. **Governance is centralized for now**: `param.admin`/`treasury` is `steempro.com`;
   fee changes and future parameter moves are that account's key, exercised through
   on-chain `engine.setParam` (visible in the transaction log like any other op).
5. **Operational:** rotate the database password (old history), keep Postgres off
   public ports, and keep endpoints HTTPS.

## Hostile node operators (running a node is permissionless — by design)

Anyone may run an engine against Steem; nothing in the protocol lets that harm
this node, its clients, or the ledger:

* **A node is a reader, not a member.** There is no registry and no join —
  your production node does not know others exist. Their resource use, bugs or
  malice never touch your process, database or users.
* **A hostile operator cannot mint, move or alter anything.** State transitions
  come only from signed chain operations, every API surface is read-only, and
  their own node recomputes state from the same chain. Their sole capacity is
  lying about *reads* to *their own* clients.
* **Lies are detectable by anyone.** A tampered ledger diverges from an honest
  one; `state-checksum` at equal heights exposes it immediately — agreement is
  proven by hash, not by authority.
* **Impersonation is the real residual risk** — an attacker publishing
  `evil-api.example.com` and calling it official. Mitigation: official endpoints
  are the ones in our documentation, and any client can verify ours by checksum.
* **License note:** MIT lets anyone run, modify and re-brand this code; the lever
  for restricting that is the license, not the network. Code *contributions*
  still require PR review + green CI, and repository access can be controlled.

What actually needs guarding (and is): the `steempro.com` signing keys (the only
path to fee/param changes), the database credential (write capability),
SSH/Dokploy access, and the official domain.

## Known dependency advisories (audited, explained, tracked)

Two independent gates watch this tree: `npm audit` (production-only, CI gates at
`--audit-level=critical`) and **OSV-Scanner** (every lockfile — root and
`watcher/` — see below). The residual advisories are off the engine API path;
one is deliberately accepted on the ops-tooling signing path, and its row
explains the trade:

| Advisory | Severity | Why it is acceptable here |
| --- | --- | --- |
| `GHSA-ggr8-5vv4-36mx` — `deepmerge-ts` via prisma CLI (`@prisma/config`) | high | CLI config-file merging over **our own** trusted config — never reachable from API input; fixed only by a major transitive bump that risks the migration tooling; the runtime query client does not use it |
| `GHSA-848j-6mx2-7j84` (CVE-2025-14505) — `elliptic` / `secp256k1` via `@steempro/dsteem` | medium | **The engine runtime never signs** — transactions are signed client-side via Keychain, consensus authorities arrive pre-verified, runtime transport is first-party fetch (`src/chain/rpc.ts`), and the production engine image no longer ships `@steempro/dsteem` (the devDependency tree is pruned in the build stage). The chain IS used on the ops path (`scripts/` multisig broadcasts and the watcher image, which signs via the pure-JS fallback) — accepted because a leak needs a faulty **and** a correct signature over one identical input (steem tx inputs carry ref-block + expiration), a single leaked active WIF stays below the 2-of-3 threshold, and no upstream fix exists for ≤ 6.6.1 |
| `GHSA-hp3w-g68c-fv3c` — jest coverage chain (`sprintf-js` via `js-yaml@3`) | moderate | test-time tooling only — the DoS shape needs attacker-controlled format strings, and format strings here are developer-written source; no shipped or reachable runtime code path |

Local checks: `npm audit --omit=dev` (production-only view) and
`osv-scanner scan --lockfile package-lock.json` (+ `--lockfile
watcher/package-lock.json` for the watcher's signer tree).

### Supply-chain scanning (CI gate)

Every push runs a pinned **OSV-Scanner v2.6.0** binary against each lockfile —
`package-lock.json` and `watcher/package-lock.json` (the production signer tree
behind `docker-compose.watcher.yml`). The binary is downloaded from the Google
release (SLSA3), its SHA256 is checked against the published `SHA256SUMS`, and
any vulnerability **not** baselined in `./osv-scanner.toml` fails CI before the
test steps run. Each baseline entry carries a written reason and a re-evaluation
trigger — the file documents the rules for adding more.

OSV.dev aggregates the GitHub Advisory Database on top of npm's feed, so it
catches advisories npm has not yet reported (the exact lag the Aug-2026
isolated-vm advisory demonstrated). Complementing it, **Dependabot version
updates** (`.github/dependabot.yml`) propose weekly PRs for npm and GitHub
Actions — every PR must pass the full CI gate — and **Dependabot alerts**
(repo setting, free for private repositories) email the moment a new advisory
lands on any dependency, even when no code has been pushed.

No scanner finds first-party bugs: that side is the 278-test suite (sandbox,
ingress fuzzing, hostile-mutation corpus, WS abuse) in `tests/unit`.

## Reporting

Found something exploitable? **Do not open a public issue first.**

1. Use GitHub private vulnerability reporting (Security → Report a
   vulnerability), or contact the maintainer privately with reproduction detail.
2. Expect acknowledgment, then a fix landing through the normal gate: typecheck,
   full test suite, build, compose validation, green CI.
3. Non-exploitable bugs and hardening ideas are welcome as normal issues.
