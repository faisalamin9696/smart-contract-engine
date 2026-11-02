# WSTEEM bridge — operations runbook

Custody operations for the STEEM ↔ WSTEEM peg ([MARKET-DESIGN.md](MARKET-DESIGN.md)
"Wrapped assets"; tooling: `scripts/wsteem.cjs`). WSBD reuses this exact
playbook in phase 2.

## Accounts and keys

| Role | Account | Notes |
| --- | --- | --- |
| **Bridge** (WSTEEM issuer, holds the L1 backing) | `steempro.funds` | Cold key: signs only deposit issues, peg-out burns and L1 releases. Segregated from admin so its L1 balance **is** the backing — the invariant is one glance, no commingling. |
| **Engine admin** (params, fees, SCE treasury) | `steempro.com` | Unchanged; never touches bridge funds. |

The bridge account currently runs single-signature; for real custody volume,
upgrade its active authority to a **threshold (multisig) setup** — Steem
supports 2-of-N active authorities natively.

### Multisig upgrade (script-driven; recommended before the backing gets size)

`scripts/bridge-multisig.cjs` flips `steempro.funds` from 1-of-1 into a
**2-of-3 threshold on BOTH the owner and active authorities** — one stolen
key then moves nothing, one lost key doesn't brick the account. Doing it now,
while the balance is 0.000, carries zero transition risk.

1. **Preview** (broadcasts nothing, prints no private material):

   ```powershell
   node scripts/bridge-multisig.cjs
   ```

2. **Apply** — needs the **current OWNER key** of the bridge (different from
   the active key used for daily ops). The target is named **explicitly on the
   command line** (`--apply` deliberately ignores `BRIDGE_ACCOUNT` env so a
   stale env var can never retarget an authority flip). The script pre-flights
   the key against the live owner authority, generates 3 fresh keys (**each
   WIF is printed exactly once — save them immediately in three separate
   secure places**), broadcasts the `account_update`, and re-reads the account
   to verify both authorities landed:

   ```powershell
   $env:STEEM_OWNER_WIF='5K...'      # OWNER key of steempro.funds
   node scripts/bridge-multisig.cjs --apply --account steempro.funds
   ```

3. **Smoke-test the live threshold** — a real threshold-signed op proves the
   setup end to end: a balance-neutral 0.001 STEEM self-transfer when the
   account holds funds, or (at 0.000 balance) a funds-free `custom_json`
   probe — the exact op shape every bridge op uses:

   ```powershell
   $env:BRIDGE_SIGN_KEYS='wif1 wif2'
   node scripts/bridge-multisig.cjs --test
   ```

4. Afterwards, every bridge op needs two active keys — `wsteem.cjs` accepts
   them space-separated and its pre-flight verifies the combined weight meets
   the threshold before anything is signed:

   ```powershell
   $env:STEEM_ACTIVE_WIF='wif1 wif2'
   node scripts/wsteem.cjs --reconcile
   ```

The old single owner/active keys lose **all** authority the moment the update
applies — retire them. Keep offline copies of all three private keys: losing
2-of-3 permanently bricks access to the backing. The update takes effect
immediately (owner-signed operations from that point on).

**Disclosure** (carry wherever the market UI lives, including the Portal):
WSTEEM is a custodial wrapper — every WSTEEM is backed 1:1 by STEEM held on
L1 by `steempro.funds`, verifiable by anyone (engine supply vs the account's
on-chain balance), but redemption depends on steempro.com's operation of the
bridge.

## The invariant

```
circulating WSTEEM supply (engine)  ==  STEEM balance of steempro.funds (L1)
```

Check it any time — no key needed:

```powershell
node scripts/wsteem.cjs --reconcile                    # mainnet
$env:SCE_OP_ID='sce-testnet1'; $env:ENGINE_API='https://sce-test.steempro.com'
node scripts/wsteem.cjs --reconcile                    # testnet (inventory model — mismatch expected)
```

`--reconcile` exits non-zero on shortfall/overback beyond the mainnet instance.
Run it after **every** deposit and peg-out, and on a daily cadence.

### Backing evidence (`--audit`)

The deep-dive companion: it reconstructs the entire WSTEEM ledger from both
chains — every engine issue/burn/transfer (from `/api/v1/logs`) against every
L1 transfer in/out of the bridge account (from the chain history) — and
cross-checks them. Read-only, no key, safe to run anytime:

```powershell
node scripts/wsteem.cjs --audit
```

On mainnet it **enforces** (exit ≠ 0, stops operations):

* `supply == issues - burns` — engine-internal math must close;
* `supply == L1 STEEM balance` — the custody invariant, now with the evidence
  listed item by item (deposits with sender/tx/memo, releases with recipient/tx).

and **warns** on the two flows non-bridge paths can legitimately perturb
(bridge balance vs its reconstructed transfer flow; L1 balance vs
transfer inflow−outflow, since rewards/vesting move liquid STEEM). Run it
weekly, after any incident, and before/after every launch step. The engine-side
fetch fails loudly rather than ever reporting an incomplete ledger as empty.

## Deposit (user STEEM → WSTEEM)

1. User sends STEEM on L1 to `steempro.funds` (ideally with a memo naming
   their account).
2. Operator confirms the L1 delta on-chain (Steemd / any explorer).
3. Operator issues the wrapper **to the user's account**:

```powershell
$env:STEEM_ACTIVE_WIF='5K...'   # bridge key
node scripts/wsteem.cjs --issue <qty> --to <user> --no-create
node scripts/wsteem.cjs --reconcile
```

Never issue before the L1 funds are visible; the script's per-step engine
confirmation makes a half-run safe (nothing is idempotency-destructive: a
re-run after a crash re-checks state first — verify balances before retrying).

### Automating the bridge (`--pending` / `--watch`)

The engine cannot see L1, so detection runs off-chain in the ops script —
never inside a contract. Two modes share the detectors:

```powershell
node scripts/wsteem.cjs --pending   # read-only: unissued deposits + queued peg-outs + exact commands
node scripts/wsteem.cjs --watch     # daemon: both directions, automatic
```

**Deposit side.** The detector reads **state first** (L1 balance − supply =
unbacked excess, immune to history-plugin lag), then attributes excess to
post-genesis transfers-in FIFO-paired against applied issues. Attribution
reads two sources: the history walk (`get_account_history`) **and a block-log
tail** (`get_block` over the most recent blocks, `WATCH_BLOCK_TAIL`, default
2000 ≈ 100 min) — the block log is served from the same real-time state as
the balance scan, so a deposit is attributable within a block even when the
history plugin trails by minutes; the tail only runs while unbacked excess
exists and stops as soon as it overlaps the history walk or covers the whole
excess. A deposit is auto-issuable only if its memo is *exactly* an existing
L1 account name (the naming convention in step 1 becomes mandatory for
hands-free credit). Anything else — empty/odd memo, unknown account — is
flagged for manual handling, never guessed.

**Peg-out side.** Bridge on-engine balance (state) with FIFO-paired burns
consumed = queued peg-outs. Each one is released through the shared
burn-then-release core to the **signed op's sender** — never the memo: a memo
is user-chosen text and must not be able to redirect real L1 funds. Manual
`--withdraw` uses the same machinery and stays available; the cover checks
make a double-release attempt abort before broadcast.

`--watch` needs `STEEM_ACTIVE_WIF` (the bridge's 2-of-3) in its environment,
acts at most **once per tick**, remembers consumed deposit indices and engine
heights for the session (a re-scan can never act twice), and **stops with
exit 1** on: shortfall (supply > backing), pending sums exceeding the excess
(double-issue risk), state/logs disagreement (held inventory with no inbound
pair, more burns than inbound), releases exceeding the bridge's L1 balance,
or backing that stays unattributed for `WATCH_LAG_TICKS` ticks (default 20 ×
`WATCH_INTERVAL`s ≈ 10 min — the usual cause is non-deposit credits, see the
rewards note below; history lag alone no longer reaches this limit thanks to
the block-log tail). `WATCH_INTERVAL` (seconds, default 30) tunes the poll.

> **Rewards note:** `steempro.funds` accrues curation/author rewards as liquid
> STEEM — that raises L1 balance without any deposit, so `--audit` check `b`
> fails and the watcher stops (by design). Sweep stray credits out
> (`transfer` to the admin account) to restore exact equality.

### Running on a server (Dokploy)

For 24/7 credit, deploy the watcher as its own service (`docker-compose.watcher.yml`
+ `watcher/Dockerfile`, both in this repo):

1. Dokploy → + Service → Compose → this repo → Compose Path:
   `docker-compose.watcher.yml`.
2. Environment tab: `STEEM_ACTIVE_WIF` = **two** bridge WIFs, space-separated
   (satisfies the account's 2-of-3 active threshold). Everything else has
   working defaults in the file (account, op id, endpoints, intervals).
3. Deploy — no Domains tab entry: the service is outbound-only (engine REST +
   Steem RPC) and exposes no port.

Rules that come with it:

* **Exactly one watcher, anywhere.** The PID lock only excludes a second
  process *on the same host* — a local `--watch` and the server watcher would
  both see the same deposit and could double-issue before the other's tick.
  Deploying the server service means disabling the local scheduled task, and
  vice versa.
* **Threat model:** this Compose project's Environment tab now holds threshold
  key material — treat it accordingly. The third WIF is never uploaded and the
  engine service stays keyless; never merge the two services.
* **STOP means stop.** Anomaly exits are deliberate, and both restart switches
  keep the container dead (`restart: "no"` + Swarm `restart_policy: none` —
  Dokploy deploys compose as a Swarm stack that would otherwise restart
  forever). A stopped service in Dokploy **is** the alert: read its logs, work
  the failure playbook, then restart — and check the service after any host
  reboot, because `none` means it will not resurrect itself.
* **Stateless restarts:** consumed sets are rebuilt from state + logs on every
  start, so a restart can never re-issue a credited deposit or re-release a
  burned peg-out. Logs are stdout (Dokploy's log viewer), one heartbeat line
  per tick.
* `--reconcile` / `--audit` stay keyless and read-only — run them from any
  cron (server included) as the always-on tripwire.

1. User engine-transfers WSTEEM to `steempro.funds` (the Portal's withdraw
   drawer does this via Keychain; CLI fallback for holders without the Portal):

   ```powershell
   $env:BRIDGE_ACCOUNT='<holder>'          # e.g. steempro.com
   $env:STEEM_ACTIVE_WIF='<holder active>' # single key — holder signs their own transfer
   node scripts/wsteem.cjs --transfer <qty> --to steempro.funds
   ```
2. Operator runs:

```powershell
$env:STEEM_ACTIVE_WIF='5K...'
node scripts/wsteem.cjs --withdraw <qty> --to <user>
node scripts/wsteem.cjs --reconcile
```

Order of operations (built into the script, do not re-order manually):

1. **engine burn first** — the wrapper is destroyed and the backing freed;
2. **L1 release second** — STEEM sent to the user.

Burn-then-release means a crash between the legs can never leave the user
without funds (worst case: wrapper burned, STEEM not yet sent — operator
re-sends; the reverse order could pay twice). The script aborts before any
broadcast if the bridge's on-engine WSTEEM balance doesn't cover the amount
(i.e. the user's transfer isn't visible yet).

## Rehearsal (testnet, before any launch or script change)

`--rehearse` exercises the exact peg-out machinery end to end: a dust burn
through the real consensus path, the L1 release broadcast, then automatic
conservation checks re-read from both chains (supply, bridge on-engine
balance, bridge L1 balance) with ok/FAIL lines and non-zero exit on mismatch:

```powershell
$env:SCE_OP_ID='sce-testnet1'; $env:ENGINE_API='https://sce-test.steempro.com'
$env:BRIDGE_ACCOUNT='steempro.com'   # testnet bridge (historical issuer)
$env:STEEM_ACTIVE_WIF='5K...'        # active key of steempro.com
node scripts/wsteem.cjs --rehearse 0.010
```

Safety properties:

* the script **refuses to run against `sce-mainnet1`** (the burn would destroy
  real inventory) — the guard fires before any key handling;
* the default release target is the bridge itself: a cost-free, balance-neutral
  self-transfer on L1, so a full rehearsal moves no real value (pass
  `--to <account-you-own>` to rehearse a real release direction);
* each run permanently removes the dust quantity from testnet inventory —
  immaterial at 0.010, but keep it small.

Rerun after every change to the withdraw path, and once before any mainnet
launch decision.

## Testnet vs mainnet topology

| | Testnet (`sce-testnet1`) | Mainnet (`sce-mainnet1`) |
| --- | --- | --- |
| Bridge account | `steempro.com` (historical — WSTEEM was created there on 2026-10-11 before the segregation decision) | **`steempro.funds`** |
| Model | inventory: 100k WSTEEM issued up front, no L1 backing | deposit-driven: issue only against received L1 STEEM |
| Reconcile | prints the inventory-model NOTE | enforces the invariant (exit ≠ 0 on mismatch) |
| Audit | engine checks enforced, invariant as NOTE | engine checks **and** invariant enforced, with per-item evidence |
| Rehearse | allowed (dust burn + self-release) | **refused by the script** |

The operational *flows* are identical on both — issuer identity affects no
engine behavior, script, or UI.

## Failure playbook

* **Script aborted mid-run**: nothing is retried blindly. Read the engine tx
  log (`/api/v1/logs`), reconcile state (balances both sides), then re-run the
  remaining leg with the appropriate flag.
* **Reconcile shows shortfall on mainnet**: freeze deposits (do not issue),
  run `--audit` — it lists every issuance and every L1 movement with tx ids so
  the gap can be located exactly.
* **Bridge key exposure**: rotate the active key on L1 (owner authority), then
  re-issue `--reconcile` and `--audit` as the sanity gate before resuming.
