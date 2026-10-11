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

### Multisig upgrade (recommended before mainnet launch)

1. Collect the public parts of the new keys (reuse existing cold keys or
   generate fresh ones):

   ```js
   const { PrivateKey } = require('@steempro/dsteem');
   console.log(PrivateKey.fromString('5K...').createPublic().toString());
   ```

2. Broadcast an `account_update` **signed with the current owner key** that
   replaces the active authority with a threshold of those pubkeys, e.g. 2-of-3:

   ```json
   {
     "account": "steempro.funds",
     "owner": {
       "weight_threshold": 2,
       "account_auths": [],
       "key_auths": [["STM...key1", 1], ["STM...key2", 1], ["STM...key3", 1]]
     },
     "active": { "weight_threshold": 2, "account_auths": [], "key_auths": [["STM...key1", 1], ["STM...key2", 1], ["STM...key3", 1]] },
     "posting": "<copy unchanged from the live account>",
     "memo_key": "<copy unchanged>",
     "json_metadata": ""
   }
   ```

3. Verify a small signed op with the new setup before moving size; only then
   consider the old single key burned. Keep offline copies of **all** private
   keys — losing 2-of-3 loses the backing permanently.

I can prepare the exact broadcast (posting/memo filled from the live account)
on request; the signing stays on your side with the current owner key.

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

## Peg-out (WSTEEM → user STEEM)

1. User engine-transfers WSTEEM to `steempro.funds` (the Portal's withdraw
   drawer does this via Keychain).
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
