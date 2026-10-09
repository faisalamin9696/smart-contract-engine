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
that symbol's supply delta). A compromised or buggy guest cannot write a row the guard
rejects, and a failed op never aborts the block.

### 4. Determinism

No floats, frozen BigNumber config on both sides of the sandbox, no host APIs or clock
in the guest (timestamps come from block headers), blocked globals, `codeGeneration`
disabled, hard time/memory limits. `isolated-vm` is preferred; the `node-vm` fallback
runs the identical first-party contract bytes in a locked-down context and is now
announced loudly at boot instead of degrading silently (`SANDBOX_PROVIDER` pins it).

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
  own `X-Forwarded-For`).
* Query/page limits are capped (100 rows), request bodies are capped (256 kB), WS has
  payload caps, a per-socket subscription cap (100), a global client cap
  (`WS_MAX_CLIENTS`) and heartbeat reaping.
* CORS is open (`cors()`) — acceptable because the API is read-only, cookie-less and
  meant to be consumed by browsers; there is no credentialed request to protect.

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
  whole ledger (collections, instances, tokens, balances, orders, param, `order_seq`).
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

## Reporting

Open a GitHub issue with reproduction detail, or contact the maintainer privately for
anything exploitable in production. Fixes land through the normal gate: typecheck,
full test suite, build, compose validation, green CI.
