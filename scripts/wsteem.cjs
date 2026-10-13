#!/usr/bin/env node
'use strict';
/**
 * WSTEEM bridge operations (docs/MARKET-DESIGN.md -> "Wrapped assets";
 * ops runbook in docs/BRIDGE.md).
 *
 * The bridge account is steempro.funds — deliberately segregated from the
 * engine admin account steempro.com so that:
 *   * the L1 balance of steempro.funds IS the custody backing, publicly
 *     checkable as `circulating WSTEEM supply == STEEM held on L1`, and
 *   * the bridge key (cold, signs rarely) never shares custody with the
 *     admin crown-jewel key (params, fees, SCE issuance).
 *
 * Modes:
 *   (default)            tokens.create WSTEEM (+ optional --issue deposit)
 *   --withdraw <qty>     release a peg-out: engine burn FIRST, then L1 STEEM
 *                        transfer (burn-then-release: a crash between the legs
 *                        can never leave the user without their funds)
 *   --transfer <qty>     peg-out step 1 (CLI fallback for the Portal drawer):
 *                        holder sends WSTEEM to the bridge on the engine —
 *                        requires --to, signs with ACCOUNT's own active key
 *                        (set BRIDGE_ACCOUNT to the holding account)
 *   --rehearse [qty]     testnet-only end-to-end peg-out rehearsal: burn from
 *                        bridge inventory through real consensus + L1 release
 *                        broadcast + automatic conservation checks
 *   --reconcile          quick custody invariant (engine supply vs L1 balance)
 *   --audit              full backing evidence: every engine issue/burn/transfer
 *                        cross-checked against every L1 transfer in/out of the
 *                        bridge account (read-only, no key needed)
 *   --pending            pending bridge movements: unissued deposits + queued
 *                        peg-outs, with exact commands (read-only, no key)
 *   --watch              the full bridge daemon: auto-issues memo-attributed
 *                        deposits AND auto-releases peg-outs to the signed
 *                        sender (needs STEEM_ACTIVE_WIF; one action per tick;
 *                        stops with exit 1 on any inconsistency — shortfall,
 *                        unbackable attribution, state/logs disagreement,
 *                        backing with no deposit). WATCH_INTERVAL (s, default
 *                        30), WATCH_LAG_TICKS (default 20), WATCH_BLOCK_TAIL
 *                        (default 2000 recent blocks) tune the loop.
 *
 * Usage (PowerShell):
 *   $env:SCE_OP_ID='sce-testnet1'; $env:ENGINE_API='https://sce-test.steempro.com'
 *   node scripts/wsteem.cjs --dry-run
 *   $env:STEEM_ACTIVE_WIF='5K...'                          # active key of bridge
 *   node scripts/wsteem.cjs --issue 100000                 # create + issue inventory
 *   node scripts/wsteem.cjs --issue 5 --to alice --no-create   # deposit: verify L1 first!
 *   node scripts/wsteem.cjs --withdraw 5 --to alice        # peg-out: burn + L1 release
 *   node scripts/wsteem.cjs --transfer 5 --to steempro.funds  # peg-out step 1 (holder's key)
 *   node scripts/wsteem.cjs --rehearse 0.010               # testnet peg-out drill (WIF)
 *   node scripts/wsteem.cjs --reconcile                    # invariant check (no key)
 *   node scripts/wsteem.cjs --audit                        # backing evidence (no key)
 *   node scripts/wsteem.cjs --pending                      # pending movements (no key)
 *   node scripts/wsteem.cjs --watch                        # bridge daemon (auto both ways)
 *
 * Env:
 *   SCE_OP_ID        target instance (default sce-mainnet1)
 *   BRIDGE_ACCOUNT   bridge account (default steempro.funds)
 *   STEEM_RPC        signing/broadcast endpoint (default https://api.steemit.com)
 *   ENGINE_API       engine REST base (default https://sce-api.steempro.com)
 *   STEEM_ACTIVE_WIF active key(s) of the bridge account — one WIF, or several
 *                    space-separated once the 2-of-3 multisig is live
 *                    (scripts/bridge-multisig.cjs); not needed for
 *                    --reconcile / --audit / --dry-run
 */
const { Client, PrivateKey } = require('@steempro/dsteem');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OP_ID = process.env.SCE_OP_ID || 'sce-mainnet1';
const ACCOUNT = process.env.BRIDGE_ACCOUNT || process.env.GENESIS_ACCOUNT || 'steempro.funds';
const STEEM_RPC = process.env.STEEM_RPC || 'https://api.steemit.com';
const ENGINE_API = (process.env.ENGINE_API || 'https://sce-api.steempro.com').replace(/\/+$/, '');
const POLL_MS = 3000;
const STEP_TIMEOUT_MS = 120000;

const SYMBOL = 'WSTEEM';

// Option-A genesis: the L1 index of the sweep-out that zeroed steempro.funds
// (2026-10-11T17:17:42) — the account's earlier life was NOT bridge activity,
// so deposit detection only considers transfers-in after this index.
const BRIDGE_GENESIS_L1_INDEX = 12939;

// decimal quantity param of a fungible engine op (market/NFT ops lack it)
const qtyOf = (o) => (o.params && typeof o.params.quantity === 'string' ? o.params.quantity : null);

/* --------------------------------------------------------------- arguments */

/**
 * Single-instance guard for --watch: two concurrent watchers could race the
 * same deposit before either's log view refreshes (the consumed sets are
 * per-process). The lock file holds the owner PID; a dead PID is a stale
 * lock from a crash and is reclaimed on the next start.
 */
function acquireWatchLock() {
  const lock = path.join(os.tmpdir(), `sce-watch-${OP_ID}-${ACCOUNT}.lock`);
  if (fs.existsSync(lock)) {
    let pid = NaN;
    try {
      pid = Number(fs.readFileSync(lock, 'utf8').trim());
    } catch {
      /* unreadable lock — treat as stale */
    }
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw new Error(
        `another --watch is already running (pid ${pid}, lock ${lock}) — refusing to start a second instance`,
      );
    }
  }
  fs.writeFileSync(lock, String(process.pid));
  const release = () => {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => {
    release();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    release();
    process.exit(143);
  });
}

function parseQty(value, flag) {
  if (value === undefined || !/^\d+(\.\d{1,3})?$/.test(value) || Number(value) <= 0) {
    throw new Error(`${flag} expects a positive amount with at most 3 decimals (WSTEEM precision)`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    mode: 'seed',
    dryRun: false,
    noCreate: false,
    issue: null,
    withdraw: null,
    transfer: null,
    rehearse: '0.010',
    to: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-create') args.noCreate = true;
    else if (arg === '--reconcile') args.mode = 'reconcile';
    else if (arg === '--audit') args.mode = 'audit';
    else if (arg === '--pending') args.mode = 'pending';
    else if (arg === '--watch') args.mode = 'watch';
    else if (arg === '--rehearse') {
      args.mode = 'rehearse';
      // optional inline quantity: `--rehearse 0.050` (default 0.010)
      const inline = argv[i + 1];
      if (inline !== undefined && /^\d+(\.\d{1,3})?$/.test(inline)) {
        args.rehearse = parseQty(inline, '--rehearse');
        i += 1;
      }
    } else if (arg === '--issue') {
      args.mode = 'seed';
      args.issue = parseQty(argv[++i], '--issue');
    } else if (arg === '--withdraw') {
      args.mode = 'withdraw';
      args.withdraw = parseQty(argv[++i], '--withdraw');
    } else if (arg === '--transfer') {
      args.mode = 'transfer';
      args.transfer = parseQty(argv[++i], '--transfer');
    } else if (arg === '--to') {
      args.to = argv[++i];
      if (args.to === undefined || !/^[a-z][a-z0-9.-]{2,15}$/.test(args.to)) {
        throw new Error('--to expects a valid Steem account name');
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.mode === 'transfer' && args.to === null) {
    throw new Error('--transfer requires --to <receiving account>');
  }
  if (args.to === null) args.to = ACCOUNT;
  return args;
}

const wiki = (action, params) => ({ contractName: 'tokens', contractAction: action, contractPayload: params });

function buildSeedSteps(args) {
  const steps = [];
  if (!args.noCreate) {
    steps.push({
      label: `1 tokens.create ${SYMBOL}`,
      payload: wiki('create', {
        symbol: SYMBOL,
        name: 'Wrapped STEEM',
        precision: 3,
        url: 'https://steempro.com',
        // maxSupply omitted on purpose = unlimited; deposits issue on demand.
      }),
    });
  }
  if (args.issue !== null) {
    steps.push({
      label: `${steps.length + 1} tokens.issue ${args.issue} ${SYMBOL} to ${args.to}`,
      payload: wiki('issue', { symbol: SYMBOL, to: args.to, quantity: args.issue }),
    });
  }
  if (steps.length === 0) {
    throw new Error('nothing to do: pass --issue <qty>, --withdraw <qty>, --transfer <qty> --to <acct>, --rehearse [qty], --reconcile or --audit');
  }
  return steps;
}

/* ---------------------------------------------------------------- mechanics */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function engineJson(path) {
  const response = await fetch(`${ENGINE_API}${path}`);
  if (!response.ok) return { __status: response.status, __body: await response.json().catch(() => null) };
  return response.json();
}

async function fetchRecentLogs() {
  const body = await engineJson('/api/v1/logs?limit=20');
  return Array.isArray(body.data) ? body.data : [];
}

async function waitForOutcome(txId) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let logs = [];
    try {
      logs = await fetchRecentLogs();
    } catch {
      // engine restarting or unreachable — keep polling until the deadline
    }
    const hit = logs.find((entry) => entry.txId === txId);
    if (hit) return hit;
    await sleep(POLL_MS);
  }
  return null;
}

async function engineBalance(account, symbol) {
  const body = await engineJson(`/api/v1/balances?account=${account}&symbol=${symbol}`);
  const row = Array.isArray(body.data) ? body.data[0] : null;
  return row ? row.quantity : null;
}

async function engineToken(symbol) {
  const body = await engineJson(`/api/v1/tokens/${symbol}`);
  return body.__status === 404 ? null : body.data;
}

async function l1Account(name) {
  const client = new Client(STEEM_RPC);
  const [account] = await client.database.getAccounts([name]);
  return account ?? null;
}

function l1SteemToNumber(balance) {
  return balance ? parseFloat(String(balance).split(' ')[0]) : 0;
}

/** All APPLIED engine ops for a symbol, paginated — the audit's engine-side evidence. */
async function fetchEngineOps(symbol, maxPages = 100) {
  const ops = [];
  for (let page = 0; page < maxPages; page += 1) {
    // REST page cap is 100 (src/api/rest.ts MAX_LIMIT) — page size must match it
    const body = await engineJson(`/api/v1/logs?symbol=${symbol}&status=APPLIED&limit=100&offset=${page * 100}`);
    if (body.__status) {
      // never let a filtered fetch silently degrade to "no history"
      throw new Error(`engine logs fetch failed (HTTP ${body.__status}) — refusing to audit an incomplete ledger`);
    }
    const rows = Array.isArray(body.data) ? body.data : [];
    ops.push(...rows);
    if (rows.length < 100) return { ops, truncated: false };
  }
  return { ops, truncated: true };
}

/** Transfer ops touching an L1 account — the audit's L1-side evidence. */
async function l1TransferHistory(account, maxPages) {
  const pages = maxPages ?? Number(process.env.AUDIT_L1_PAGES || 200);
  const client = new Client(STEEM_RPC);
  const rows = [];
  const seen = new Set();
  let start = -1; // -1 = newest window (warm-up)
  let minSeen = Infinity;
  let prevMin = Infinity;
  let truncated = false;
  for (let page = 0; page < pages; page += 1) {
    let batch;
    try {
      // legacy Steem caps get_account_history at 100 per call; mask 4 = transfers only
      batch = await client.database.getAccountHistory(account, start, 100, 4);
    } catch {
      batch = await client.database.getAccountHistory(account, start, 100);
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const entry of batch) {
      const index = Array.isArray(entry) ? entry[0] : -1;
      // window bounds track EVERY entry — the mask is ignored server-side, so
      // most entries are votes; hop math must use true window indices
      if (index >= 0) minSeen = Math.min(minSeen, index);
      const record = Array.isArray(entry) ? entry[1] : null;
      // nodes report the op type either numerically (legacy) or by name; the
      // server-side mask is not honoured everywhere, so filter here regardless
      if (!record || !Array.isArray(record.op)) continue;
      if (record.op[0] !== 2 && record.op[0] !== 'transfer') continue;
      // probed behavior of api.steemit.com: windows are ASCENDING and can
      // overlap at the seam — dedup transfers by history index (every op
      // occupies exactly one index)
      if (index >= 0) {
        if (seen.has(index)) continue;
        seen.add(index);
      }
      const transfer = record.op[1] || {};
      rows.push({
        index,
        txId: record.trx_id ?? record.tx_id ?? '',
        timestamp: record.timestamp ?? '',
        from: transfer.from,
        to: transfer.to,
        amount: transfer.amount ?? '',
        memo: transfer.memo ?? '',
      });
    }
    if (!Number.isFinite(minSeen)) break; // nothing parseable at all
    if (minSeen === 0) return { rows, truncated: false }; // reached the account's first index
    if (page > 0 && minSeen >= prevMin) {
      return { rows, truncated: false }; // no progress — stop rather than loop
    }
    // probed: an explicit start returns the ASCENDING window [start-100 ..
    // start] (101 entries), and the node rejects start < limit — so request
    // minSeen-1 for the contiguous next-older block, except at the very tail
    // where start=100 yields [0..100] and reaches the account's first op
    start = Math.max(minSeen - 1, 100);
    prevMin = minSeen;
    if (page === pages - 1) truncated = true;
  }
  return { rows, truncated };
}

/** Minimal raw Steem JSON-RPC (get_block et al. are verified against this shape live). */
async function rawRpc(method, params) {
  const res = await fetch(STEEM_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`STEEM RPC ${method} HTTP ${res.status} from ${STEEM_RPC}`);
  const body = await res.json();
  if (body.error) throw new Error(`STEEM RPC ${method}: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * Block-log tail for deposit attribution. The history plugin indexes behind
 * chain state, so a fresh deposit can be INVISIBLE to get_account_history for
 * minutes (the "(history lag)" watcher message) while the balance scan
 * already sees the excess. get_block reads the same real-time database as the
 * balance scan, and transfers are plain transactions in it — no plugin, no
 * lag. Only called while unbacked excess exists; idle ticks scan nothing.
 *
 * Walks newest -> oldest from head, stopping at the first of:
 *   (a) a block holding a transfer already known from the history walk
 *       (the sources overlap — everything older is history's job);
 *   (b) accumulated tail deposits covering the whole excess;
 *   (c) WATCH_BLOCK_TAIL blocks (default 2000 ≈ 100 min). Deeper staleness
 *       falls back to the lag/stop machinery — never to guessing.
 * Rows mirror the history-row shape (index null) plus block/opInTx for a
 * stable identity. The window is far smaller than the distance to the
 * post-genesis anchor on any live network, so tail rows are recent by
 * construction.
 */
async function l1BlockTailTransfers(account, excess, historyRows) {
  const maxDepth = Number(process.env.WATCH_BLOCK_TAIL) || 2000;
  const knownTx = new Set(historyRows.map((r) => r.txId).filter(Boolean));
  const props = await rawRpc('condenser_api.get_dynamic_global_properties', []);
  const head = Number(props.head_block_number);
  const rows = [];
  let sum = 0;
  let scanned = 0;
  for (let height = head; height > head - maxDepth; height -= 1, scanned += 1) {
    const block = await rawRpc('condenser_api.get_block', [height]);
    if (!block) {
      throw new Error(`block ${height} unavailable from ${STEEM_RPC} — refusing to attribute on an incomplete chain`);
    }
    const hits = [];
    for (const tx of block.transactions || []) {
      const ops = tx.operations || [];
      for (let i = 0; i < ops.length; i += 1) {
        const op = ops[i];
        if (!Array.isArray(op) || op[0] !== 'transfer' || !op[1] || op[1].to !== account) continue;
        hits.push({
          index: null,
          block: height,
          opInTx: i,
          txId: tx.transaction_id || '',
          timestamp: block.timestamp || '',
          from: op[1].from,
          to: op[1].to,
          amount: op[1].amount ?? '',
          memo: op[1].memo ?? '',
        });
      }
    }
    if (hits.length) {
      rows.unshift(...hits); // scanned head-down; keep ascending arrival order
      sum += sumQtys(hits.map((h) => String(h.amount).split(' ')[0]));
    }
    if (hits.some((h) => knownTx.has(h.txId))) break; // (a) overlap reached
    if (sum >= excess) break; // (b) excess fully covered
  }
  return { rows, scanned };
}

/** Precision-safe sum of3-decimal quantity strings (integer thousandths). */
function sumQtys(items) {
  return items.reduce((acc, value) => acc + Math.round(Number(value) * 1000), 0) / 1000;
}

function fmtList(rows, render, cap = 8) {
  for (const row of rows.slice(0, cap)) console.log(`    ${render(row)}`);
  if (rows.length > cap) console.log(`    ... +${rows.length - cap} more`);
}

/**
 * Pre-flight: every provided WIF must be listed in the bridge's active
 * authority, and their combined weight must meet the threshold — so the
 * 2-of-3 multisig (scripts/bridge-multisig.cjs) is enforced before anything
 * is signed, not discovered at broadcast time.
 */
async function verifyActiveKey(keys) {
  const client = new Client(STEEM_RPC);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const account = await l1Account(ACCOUNT);
      if (!account) throw new Error(`account ${ACCOUNT} not found on chain`);
      let weight = 0;
      for (const key of keys) {
        const pubkey = key.createPublic().toString();
        const entry = account.active.key_auths.find(([listed]) => listed === pubkey);
        if (!entry) {
          throw new Error(
            `the provided WIF ${pubkey} is not an active key of ${ACCOUNT} (not listed in active key_auths)`,
          );
        }
        weight += entry[1];
      }
      if (weight < account.active.weight_threshold) {
        throw new Error(
          `provided key weight ${weight} is below ${ACCOUNT}'s active threshold ${account.active.weight_threshold} — add more active WIFs to STEEM_ACTIVE_WIF (space-separated)`,
        );
      }
      console.log(`  ${keys.length} key(s) verified, signing weight ${weight} >= threshold ${account.active.weight_threshold}`);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(2000);
    }
  }
}

async function runEngineStep(client, keys, step) {
  console.log(`${step.label} ...`);
  const op = [
    'custom_json',
    {
      id: OP_ID,
      required_auths: [ACCOUNT],
      required_posting_auths: [],
      json: JSON.stringify(step.payload),
    },
  ];
  const confirmation = await client.broadcast.sendOperations([op], keys.length === 1 ? keys[0] : keys);
  console.log(`  broadcast tx ${confirmation.id}`);

  const log = await waitForOutcome(confirmation.id);
  if (!log) {
    console.error(`  timed out after ${STEP_TIMEOUT_MS / 1000}s: the op never appeared in the engine log. Aborting.`);
    process.exit(1);
  }
  if (log.status !== 'APPLIED') {
    const error = log.error ? `${log.error.code}: ${log.error.message}` : 'unknown error';
    console.error(`  engine rejected ${log.action} -> ${error}`);
    console.error('  Aborting (later steps were NOT sent).');
    process.exit(1);
  }
  console.log(`  APPLIED at height ${log.height}\n`);
  return confirmation.id;
}

/* -------------------------------------------------------------------- modes */

async function seedMode(args, keys) {
  const steps = buildSeedSteps(args);
  if (args.dryRun) {
    for (const step of steps) {
      console.log(`--- ${step.label}`);
      console.log(JSON.stringify(step.payload, null, 2));
    }
    console.log(`(custom_json id = ${OP_ID}, broadcast as ${ACCOUNT})`);
    return;
  }

  const client = new Client(STEEM_RPC);
  for (const step of steps) await runEngineStep(client, keys, step);

  console.log(`${SYMBOL} step complete.`);
  if (OP_ID === 'sce-mainnet1') {
    console.log('Custody reminder (mainnet): run --reconcile after every deposit/withdraw —');
    console.log(`circulating ${SYMBOL} supply must equal the STEEM backing held on L1 by ${ACCOUNT}.`);
  }
}

/**
 * Peg-out step 1 (CLI fallback for the Portal drawer): the holder sends
 * WSTEEM to the bridge on the engine, so the bridge's burn can then destroy
 * it. The acting account is ACCOUNT — run with BRIDGE_ACCOUNT set to the
 * HOLDING account (e.g. steempro.com) and that account's single active key.
 */
async function transferMode(args, keys) {
  if (args.to === ACCOUNT) {
    throw new Error(
      `--transfer target equals the acting account (${ACCOUNT}) — set BRIDGE_ACCOUNT to the holding account`,
    );
  }
  const held = parseFloat((await engineBalance(ACCOUNT, SYMBOL)) ?? '0');
  if (held < Number(args.transfer)) {
    throw new Error(
      `${ACCOUNT} holds ${held.toFixed(3)} ${SYMBOL} on the engine — needs ${args.transfer}. Nothing sent.`,
    );
  }
  const step = {
    label: `tokens.transfer ${args.transfer} ${SYMBOL} ${ACCOUNT} -> ${args.to}`,
    payload: wiki('transfer', { symbol: SYMBOL, to: args.to, quantity: args.transfer }),
  };
  if (args.dryRun) {
    console.log(`--- ${step.label}`);
    console.log(JSON.stringify(step.payload, null, 2));
    console.log(`(custom_json id = ${OP_ID}, broadcast as ${ACCOUNT})`);
    return;
  }

  const client = new Client(STEEM_RPC);
  await runEngineStep(client, keys, step);
  console.log(`${SYMBOL} transfer complete.`);
  console.log('Next (peg-out): run --withdraw with the BRIDGE keys, then --reconcile.');
}

/**
 * Burn-then-release core, shared by --withdraw and --watch: engine burn FIRST
 * (destroys the wrapper, frees the backing), then the L1 STEEM release. A
 * failure between the legs leaves the user whole (wrapper gone, STEEM
 * re-sendable by the operator); the opposite order could pay twice.
 */
async function executePegOut(client, keys, qty, to) {
  const l1Amount = `${Number(qty).toFixed(3)} STEEM`;
  await runEngineStep(client, keys, {
    label: `1 tokens.burn ${qty} ${SYMBOL} (engine)`,
    payload: wiki('burn', { symbol: SYMBOL, quantity: qty }),
  });
  console.log(`2 L1 transfer ${l1Amount} ${ACCOUNT} -> ${to} ...`);
  const transfer = await client.broadcast.transfer(
    { from: ACCOUNT, to, amount: l1Amount, memo: `${SYMBOL} bridge withdraw (${OP_ID})` },
    keys.length === 1 ? keys[0] : keys,
  );
  console.log(`  l1 tx ${transfer.id}`);
  return transfer.id;
}

/**
 * Manual peg-out: explicit --qty/--to. The watcher (scanPendingPegOuts +
 * executePegOut) handles the automatic path with the same machinery.
 */
async function withdrawMode(args, keys) {
  const qty = args.withdraw;
  const to = args.to === ACCOUNT ? null : args.to;
  if (!to) throw new Error('--withdraw requires --to <user account>');
  const l1Amount = `${Number(qty).toFixed(3)} STEEM`;

  console.log(`Peg-out ${qty} ${SYMBOL} -> ${to} (${OP_ID}, bridge ${ACCOUNT})`);

  const held = await engineBalance(ACCOUNT, SYMBOL);
  if (held === null || Number(held) < Number(qty)) {
    console.error(
      `Bridge engine-side ${SYMBOL} balance is ${held ?? 'missing'} — the user's transfer to ${ACCOUNT} is not visible yet. Aborting.`,
    );
    process.exit(1);
  }
  console.log(`Inbound transfer visible: bridge holds ${held} ${SYMBOL} on-engine.\n`);

  if (args.dryRun) {
    console.log('--- 1 tokens.burn (engine, bridge auth)');
    console.log(JSON.stringify(wiki('burn', { symbol: SYMBOL, quantity: qty }), null, 2));
    console.log(`--- 2 L1 transfer ${l1Amount} ${ACCOUNT} -> ${to} (memo: ${SYMBOL} bridge withdraw)`);
    console.log('(dry run — nothing broadcast)');
    return;
  }

  const client = new Client(STEEM_RPC);
  await executePegOut(client, keys, qty, to);
  const after = await l1Account(ACCOUNT);
  console.log(`  bridge L1 balance now ${after ? after.balance : 'unknown'}`);
  console.log(`\nPeg-out complete: wrapper burned, ${l1Amount} released to ${to}.`);
}

/** Custody invariant: circulating engine supply == STEEM backing on L1. */
async function reconcileMode() {
  const token = await engineToken(SYMBOL);
  if (!token) {
    console.log(`${SYMBOL} does not exist on ${ENGINE_API} (${OP_ID}) yet — nothing to reconcile.`);
    return;
  }
  const account = await l1Account(ACCOUNT);
  const l1 = account ? l1SteemToNumber(account.balance) : 0;
  const supply = parseFloat(token.supply);
  const pending = await engineBalance(ACCOUNT, SYMBOL);
  const delta = l1 - supply;

  console.log(`--- custody reconciliation (${OP_ID} vs ${STEEM_RPC})`);
  console.log(`  engine circulating ${SYMBOL} supply : ${supply.toFixed(3)}`);
  console.log(`  L1 ${ACCOUNT} STEEM balance      : ${l1.toFixed(3)}`);
  console.log(`  bridge on-engine ${SYMBOL} (pending withdrawals): ${pending ?? '0 (none)'}`);
  console.log(`  delta (L1 - supply)                   : ${delta.toFixed(3)}`);

  const testnet = OP_ID === 'sce-testnet1';
  if (testnet) {
    console.log(
      '\n  NOTE: testnet runs the inventory model (no L1 backing by design) — a mismatch here is expected.',
    );
    return;
  }
  if (delta === 0) {
    console.log('\n  INVARIANT OK: backing equals circulating supply.');
  } else if (delta < 0) {
    console.log(`\n  SHORTFALL: ${Math.abs(delta).toFixed(3)} STEEM missing vs supply — investigate before any issue.`);
    process.exit(1);
  } else {
    console.log(`\n  OVERBACKED: ${delta.toFixed(3)} STEEM unaccounted for on the engine side.`);
    process.exit(1);
  }
}

/**
 * Backing evidence: reconstruct the WSTEEM ledger from both chains and
 * cross-check it. Read-only — never broadcasts, never needs a key.
 *
 * Hard checks (enforced with exit != 0 on mainnet):
 *   a. supply == total issues - total burns        (engine-internal math)
 *   b. supply == L1 STEEM balance of the bridge    (the custody invariant)
 * Informational warnings (non-bridge paths can legitimately move these):
 *   c. bridge on-engine balance == its reconstructed flow
 *   d. L1 balance == inflows - outflows
 */
async function auditMode() {
  const testnet = OP_ID === 'sce-testnet1';
  console.log(`--- WSTEEM backing audit (${OP_ID} engine vs ${STEEM_RPC} L1, bridge ${ACCOUNT})\n`);

  const token = await engineToken(SYMBOL);
  if (!token) {
    console.log(`${SYMBOL} does not exist on ${ENGINE_API} yet — nothing to audit.`);
    return;
  }

  const { ops, truncated: opsTruncated } = await fetchEngineOps(SYMBOL);
  // The symbol filter also catches market ops (sell/buy/cancel escrow moves) and
  // could in theory catch an NFT collection of the same name (separate partition)
  // — so every fungible flow is recognized by its decimal `quantity` param.
  const issues = ops.filter((o) => o.action === 'issue' && qtyOf(o) !== null);
  const burns = ops.filter((o) => o.action === 'burn' && qtyOf(o) !== null);
  const transfers = ops.filter((o) => o.action === 'transfer' && qtyOf(o) !== null);
  const issuesToBridge = issues.filter((o) => o.params.to === ACCOUNT);
  const burnsByBridge = burns.filter((o) => o.actor === ACCOUNT);
  const toBridge = transfers.filter((o) => o.params.to === ACCOUNT);
  const fromBridge = transfers.filter((o) => o.actor === ACCOUNT);

  const issued = sumQtys(issues.map(qtyOf));
  const burned = sumQtys(burns.map(qtyOf));
  const supply = parseFloat(token.supply);
  const bridgeHeld = parseFloat((await engineBalance(ACCOUNT, SYMBOL)) ?? '0');

  console.log('  engine side (from /api/v1/logs, symbol-filtered, APPLIED only):');
  console.log(`    issues              : ${issues.length} ops, +${issued.toFixed(3)} ${SYMBOL}`);
  console.log(`    burns               : ${burns.length} ops, -${burned.toFixed(3)} ${SYMBOL}`);
  console.log(
    `    transfers           : ${transfers.length} ops (${toBridge.length} to bridge, ${fromBridge.length} from bridge)`,
  );
  console.log(`    circulating supply  : ${supply.toFixed(3)} ${SYMBOL}`);
  console.log(`    bridge on-engine    : ${bridgeHeld.toFixed(3)} ${SYMBOL} (inbound, not yet burned)`);
  if (opsTruncated) console.log('    WARNING: op history hit the page cap — raise the cap for a complete audit.');

  const { rows: l1Rows, truncated: l1Truncated } = await l1TransferHistory(ACCOUNT);
  const ins = l1Rows.filter((r) => r.to === ACCOUNT);
  const outs = l1Rows.filter((r) => r.from === ACCOUNT);
  const steemOf = (amount) => parseFloat(String(amount).split(' ')[0]) || 0;
  const inTotal = ins.reduce((a, r) => a + steemOf(r.amount), 0);
  const outTotal = outs.reduce((a, r) => a + steemOf(r.amount), 0);
  const account = await l1Account(ACCOUNT);
  const l1Balance = account ? l1SteemToNumber(account.balance) : 0;

  console.log(`\n  L1 side (transfer history of ${ACCOUNT}):`);
  console.log(`    transfers in        : ${ins.length}, +${inTotal.toFixed(3)} STEEM`);
  console.log(`    transfers out       : ${outs.length}, -${outTotal.toFixed(3)} STEEM`);
  console.log(`    current balance     : ${l1Balance.toFixed(3)} STEEM`);
  if (l1Truncated) {
    const pages = process.env.AUDIT_L1_PAGES || 200;
    console.log(`    NOTE: history capped at ${pages} pages (101 entries each) — raise AUDIT_L1_PAGES for full depth.`);
  }

  console.log('\n  recent deposits (L1 in):');
  if (ins.length === 0) console.log('    (none)');
  fmtList(
    // walk collects newest window first — sort by history index desc so the
    // newest deposit always leads the "recent" list
    ins.slice().sort((x, y) => y.index - x.index),
    (r) => `+ ${r.amount} from ${r.from}  ${r.timestamp}  ${r.txId}${r.memo ? `  memo="${r.memo}"` : ''}`,
  );
  console.log('\n  recent releases (L1 out):');
  if (outs.length === 0) console.log('    (none)');
  fmtList(
    outs.slice().sort((x, y) => y.index - x.index),
    (r) => `- ${r.amount} to ${r.to}  ${r.timestamp}  ${r.txId}`,
  );

  console.log('\n  checks:');
  let failed = false;

  const a = Math.round(supply * 1000) === Math.round((issued - burned) * 1000);
  console.log(
    `  ${a ? 'ok  ' : 'FAIL'} a. supply == issues - burns (${supply.toFixed(3)} vs ${(issued - burned).toFixed(3)})`,
  );
  if (!a) failed = true;

  const reconstructed =
    sumQtys(issuesToBridge.map(qtyOf)) +
    sumQtys(toBridge.map(qtyOf)) -
    sumQtys(fromBridge.map(qtyOf)) -
    sumQtys(burnsByBridge.map(qtyOf));
  const c = Math.round(bridgeHeld * 1000) === Math.round(reconstructed * 1000);
  console.log(
    `  ${c ? 'ok  ' : 'WARN'} c. bridge balance == its reconstructed flow (${bridgeHeld.toFixed(3)} vs ${reconstructed.toFixed(3)})` +
      (c ? '' : ' — market/fee paths can move balances; inspect the transfers above'),
  );

  const d = Math.abs(l1Balance - (inTotal - outTotal)) < 0.0005;
  console.log(
    `  ${d ? 'ok  ' : 'WARN'} d. L1 balance == inflows - outflows (${l1Balance.toFixed(3)} vs ${(inTotal - outTotal).toFixed(3)})` +
      (d ? '' : ' — non-transfer L1 ops (rewards, etc.) can move liquid STEEM'),
  );

  if (testnet) {
    console.log(
      `  NOTE b. custody invariant not enforced on testnet (inventory model; delta ${(l1Balance - supply).toFixed(3)} is expected)`,
    );
  } else {
    const b = Math.round(l1Balance * 1000) === Math.round(supply * 1000);
    console.log(`  ${b ? 'ok  ' : 'FAIL'} b. supply == L1 backing (${supply.toFixed(3)} vs ${l1Balance.toFixed(3)})`);
    if (!b) {
      failed = true;
      // direction matters: shortfall = underbacked (dangerous); overback =
      // funds on L1 not yet wrapped (fresh deposit awaiting --issue, or a
      // peg-out mid-flight — burn-then-release drops supply before L1 moves)
      console.log(
        supply > l1Balance
          ? '         SHORTFALL — do NOT release; investigate before any withdraw or issue.'
          : '         OVERBACKED — L1 funds are not wrapped yet; verify the pending deposit and run --issue.' +
            ' (Deposit row missing? The history plugin can lag the state — retry in a minute.)',
      );
    }
  }

  if (failed) {
    console.log('\n  AUDIT FAILED — do not issue or release until resolved.');
    process.exit(1);
  }
  console.log('\n  Audit clean.');
}

/* ------------------------------------------------- deposit detection core */

/**
 * Stable identity for a deposit across scans: the history index when the
 * history walk saw it, else tx+op for block-tail rows — both are stable for
 * the lifetime of the op, so the consumed/flagged sets can never collide.
 */
function depKey(dep) {
  return dep.index === null || dep.index === undefined ? `tx:${dep.txId}:${dep.opInTx ?? 0}` : String(dep.index);
}

/**
 * Shared detection for --pending / --watch: how much L1 backing is not yet
 * wrapped, and which post-genesis deposits account for it.
 *
 * Guards baked in (each one learned from a live run):
 *   * state-first: balance + supply come from chain state, so history-plugin
 *     lag delays ATTRIBUTION, never DETECTION;
 *   * attribution: post-genesis transfers-in FIFO-paired against engine
 *     issues (issue k consumed deposit k in arrival order); the history walk
 *     is supplemented by a block-log tail so history-plugin lag (minutes on
 *     api.steemit.com) never delays a deposit the state scan already sees;
 *   * memo = recipient (trimmed — real memos carry stray spaces); anything
 *     else is flagged unattributed, never guessed;
 *   * recipient must exist on L1 — an engine balance keyed to a non-existent
 *     account could never be signed away;
 *   * sum(pending) > excess => inconsistency => STOP (never double-issue);
 *   * excess < 0 => shortfall => STOP.
 */
async function scanPendingDeposits() {
  const round3 = (n) => Math.round(n * 1000) / 1000;
  const token = await engineToken(SYMBOL);
  if (!token) throw new Error(`${SYMBOL} does not exist on ${ENGINE_API} — nothing to watch.`);
  if (token.issuer !== ACCOUNT) {
    throw new Error(
      `acting account ${ACCOUNT} is not the issuer of ${SYMBOL} (issuer is ${token.issuer}) — check BRIDGE_ACCOUNT`,
    );
  }
  const supply = round3(parseFloat(token.supply));
  const acct = await l1Account(ACCOUNT);
  const balance = acct ? round3(l1SteemToNumber(acct.balance)) : 0;
  const excess = round3(balance - supply);
  const base = { balance, supply, excess };
  const noAttribution = { history: 0, tailScanned: 0, tailAdded: 0 };
  if (excess < 0) return { ...base, pending: [], pendingSum: 0, anomalies: [], shortfall: true, attribution: noAttribution };
  if (excess === 0) return { ...base, pending: [], pendingSum: 0, anomalies: [], shortfall: false, attribution: noAttribution };

  const anomalies = [];
  const { rows } = await l1TransferHistory(ACCOUNT);
  // attribution source 2 — the block-log tail (covers history-plugin lag;
  // see l1BlockTailTransfers). Tail rows are newer than every history row
  // (the history walk is contiguous from its newest entry), so they append.
  const tail = await l1BlockTailTransfers(ACCOUNT, excess, rows);
  const knownTx = new Set(rows.map((r) => r.txId).filter(Boolean));
  const extra = tail.rows.filter((r) => !knownTx.has(r.txId));
  const merged = extra.length ? [...rows, ...extra] : rows;
  const attribution = { history: rows.length, tailScanned: tail.scanned, tailAdded: extra.length };
  const isTailRow = (r) => r.index === null || r.index === undefined;
  const deposits = merged
    .filter((r) => {
      if (r.to !== ACCOUNT) return false;
      if (isTailRow(r)) return true; // recent by construction (depth-capped)
      return OP_ID !== 'sce-mainnet1' || r.index > BRIDGE_GENESIS_L1_INDEX;
    })
    .sort((a, b) => {
      if (isTailRow(a) !== isTailRow(b)) return isTailRow(a) ? 1 : -1; // history first
      if (!isTailRow(a)) return a.index - b.index;
      return a.block - b.block || a.opInTx - b.opInTx || String(a.txId).localeCompare(String(b.txId));
    });
  const { ops } = await fetchEngineOps(SYMBOL);
  const issues = ops
    .filter((o) => o.action === 'issue' && qtyOf(o) !== null)
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0));

  if (issues.length > deposits.length) {
    anomalies.push(
      `${issues.length} applied issues but only ${deposits.length} post-genesis deposits — ` +
        'issuance without visible backing; investigate manually',
    );
  }

  const pending = deposits.slice(issues.length).map((dep) => {
    const qty = String(dep.amount).split(' ')[0];
    const memoName = (dep.memo || '').trim();
    return { ...dep, qty, memoName, recipient: null, reason: null };
  });

  // memo must name an existing L1 account (batched lookup)
  const names = [...new Set(pending.map((d) => d.memoName).filter((n) => /^[a-z][a-z0-9.-]{2,15}$/.test(n) && n !== ACCOUNT))];
  if (names.length) {
    const client = new Client(STEEM_RPC);
    const found = await client.database.getAccounts(names);
    const have = new Set(found.map((a) => a.name));
    for (const dep of pending) {
      if (!/^[a-z][a-z0-9.-]{2,15}$/.test(dep.memoName)) {
        dep.reason = `memo "${dep.memo}" does not name an engine account`;
      } else if (dep.memoName === ACCOUNT) {
        dep.reason = 'memo names the bridge itself';
      } else if (!have.has(dep.memoName)) {
        dep.reason = `memo names ${dep.memoName}, which does not exist on L1`;
      } else {
        dep.recipient = dep.memoName;
      }
    }
  } else {
    for (const dep of pending) dep.reason = `memo "${dep.memo}" does not name an engine account`;
  }

  const pendingSum = round3(pending.reduce((a, d) => a + Number(d.qty), 0));
  if (pendingSum > excess) {
    anomalies.push(
      `post-genesis deposits pending ${pendingSum.toFixed(3)} exceed unbacked excess ${excess.toFixed(3)} — ` +
        'refusing to attribute; investigate manually',
    );
  }
  return { ...base, pending, pendingSum, anomalies, shortfall: false, attribution };
}

/**
 * Peg-out detection (shared by --pending and --watch): bridge on-engine
 * balance (state) with FIFO-paired burns consumed = unconsumed inbound
 * transfers, each one a user's wrapper waiting to become STEEM.
 *
 * The release target is the signed op's ACTOR — never the memo: a memo is
 * user-chosen text and must not be able to redirect real L1 funds. The actor
 * proved L1 identity by signing the custom_json, so no lookup is needed.
 */
async function scanPendingPegOuts() {
  const round3 = (n) => Math.round(n * 1000) / 1000;
  const held = round3(parseFloat((await engineBalance(ACCOUNT, SYMBOL)) ?? '0'));
  const base = { held };
  if (held <= 0) return { ...base, pegOuts: [], unconsumedSum: 0, anomalies: [] };

  const anomalies = [];
  const { ops } = await fetchEngineOps(SYMBOL);
  const inbound = ops
    .filter((o) => o.action === 'transfer' && qtyOf(o) !== null && o.params.to === ACCOUNT)
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
  const burns = ops
    .filter((o) => o.action === 'burn' && qtyOf(o) !== null && o.actor === ACCOUNT)
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0));

  if (burns.length > inbound.length) {
    anomalies.push(
      `${burns.length} bridge burns but only ${inbound.length} inbound transfers — ` +
        'inventory spent without visible inbound; investigate manually',
    );
  }
  const pegOuts = inbound.slice(burns.length).map((o) => ({ qty: qtyOf(o), sender: o.actor, height: o.height }));
  const unconsumedSum = round3(pegOuts.reduce((a, p) => a + Number(p.qty), 0));

  if (held > 0 && pegOuts.length === 0) {
    anomalies.push(
      `bridge holds ${held.toFixed(3)} ${SYMBOL} but every inbound transfer appears burned — ` +
        'state and logs disagree; investigate manually',
    );
  }
  if (unconsumedSum > held) {
    anomalies.push(
      `unconsumed inbound ${unconsumedSum.toFixed(3)} exceeds bridge engine balance ${held.toFixed(3)} — ` +
        'refusing to release; investigate manually',
    );
  }
  const acct = await l1Account(ACCOUNT);
  const l1 = acct ? round3(l1SteemToNumber(acct.balance)) : 0;
  if (unconsumedSum > l1) {
    anomalies.push(
      `pending peg-outs ${unconsumedSum.toFixed(3)} exceed bridge L1 balance ${l1.toFixed(3)} — ` +
        'release would fail on-chain; investigate manually',
    );
  }
  return { ...base, pegOuts, unconsumedSum, anomalies, unexplained: round3(Math.max(held - unconsumedSum, 0)) };
}

/** Read-only report: what would be auto-issued, with exact commands. */
async function pendingMode() {
  console.log(`--- pending bridge movements (${OP_ID}, bridge ${ACCOUNT})\n`);
  const report = await scanPendingDeposits();
  console.log(`  L1 balance : ${report.balance.toFixed(3)} STEEM`);
  console.log(`  supply     : ${report.supply.toFixed(3)} ${SYMBOL}`);
  console.log(`  excess     : ${report.excess.toFixed(3)} (backing not yet wrapped)`);
  if (report.attribution && (report.attribution.tailScanned || report.attribution.tailAdded)) {
    console.log(
      `  attribution: history walk + block tail (${report.attribution.tailScanned} block(s) scanned, ` +
        `${report.attribution.tailAdded} fresh transfer(s))`,
    );
  }
  console.log('');

  if (report.shortfall) {
    console.log('  SHORTFALL: circulating supply exceeds L1 backing — do NOT issue anything; run --audit.');
    process.exit(1);
  }
  if (report.anomalies.length) {
    for (const a of report.anomalies) console.log(`  ANOMALY: ${a}`);
    process.exit(1);
  }
  if (!report.pending.length) {
    console.log('  No unissued deposits — everything is wrapped.');
  } else {
    console.log(`  ${report.pending.length} deposit(s) totalling ${report.pendingSum.toFixed(3)} ${SYMBOL}:\n`);
    report.pending.forEach((dep, i) => {
      console.log(`  ${i + 1}. +${dep.amount} from ${dep.from}  ${dep.timestamp}  tx ${dep.txId}  memo="${dep.memo}"`);
      if (dep.recipient) {
        console.log(`     -> node scripts/wsteem.cjs --issue ${dep.qty} --to ${dep.recipient} --no-create`);
      } else {
        console.log(`     !! not auto-issuable: ${dep.reason} — verify manually, then --issue ${dep.qty} --to <account> --no-create`);
      }
    });
  }

  const peg = await scanPendingPegOuts();
  if (peg.anomalies.length) {
    for (const a of peg.anomalies) console.log(`\n  ANOMALY: ${a}`);
    process.exit(1);
  }
  if (peg.pegOuts.length) {
    console.log(`\n  ${peg.pegOuts.length} pending peg-out(s), bridge holds ${peg.held.toFixed(3)} ${SYMBOL} on-engine:\n`);
    peg.pegOuts.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.qty} ${SYMBOL} from ${p.sender} (engine h${p.height})`);
      console.log(`     -> node scripts/wsteem.cjs --withdraw ${p.qty} --to ${p.sender}`);
    });
    if (peg.unexplained > 0) {
      console.log(`\n  note: ${peg.unexplained.toFixed(3)} ${SYMBOL} of bridge inventory has no inbound pair — it will not auto-release.`);
    }
  } else {
    console.log('\n  No pending peg-outs (bridge on-engine balance is 0).');
  }
  console.log('\n  Funds first: confirm each movement in your records before issuing/releasing.');
}

/**
 * Bridge watcher: both directions, one action per tick.
 *   deposit side — state-first excess detection, memo attribution, guarded issue;
 *   peg-out side — unconsumed inbound transfers released to the signed op's
 *                  sender via the shared burn-then-release core.
 * Any doubt — shortfall, inconsistent attribution, state/logs disagreement,
 * backing with no deposit — stops the loop with exit 1 instead of guessing.
 * In-session consumed sets (deposit indices, engine heights) make double
 * actions impossible even if a future scan misbehaves.
 */
async function watchMode(args, keys) {
  const intervalMs = (Number(process.env.WATCH_INTERVAL) || 30) * 1000;
  const lagLimit = Number(process.env.WATCH_LAG_TICKS) || 20;
  const client = new Client(STEEM_RPC);
  const issuedIndices = new Set();
  const consumedPegHeights = new Set();
  const flagged = new Set();
  let lagTicks = 0;
  console.log(
    `Watch: auto-issuing deposits and auto-releasing peg-outs for ${ACCOUNT} every ${intervalMs / 1000}s — Ctrl+C stops.\n`,
  );

  for (;;) {
    const stamp = new Date().toISOString().slice(11, 19);

    /* ---------------- deposit side (state-first) ---------------- */
    let report;
    try {
      report = await scanPendingDeposits();
    } catch (error) {
      console.error(`[${stamp}] deposit scan failed: ${error.message} — retrying next tick`);
      await sleep(intervalMs);
      continue;
    }
    if (report.shortfall) {
      console.error(`[${stamp}] SHORTFALL: supply ${report.supply.toFixed(3)} > L1 ${report.balance.toFixed(3)} — STOPPING.`);
      console.error('Run --audit and investigate before any further op.');
      process.exit(1);
    }
    if (report.anomalies.length) {
      for (const a of report.anomalies) console.error(`[${stamp}] ANOMALY: ${a}`);
      console.error('STOPPING — no issuance performed. Investigate manually (see docs/BRIDGE.md).');
      process.exit(1);
    }

    if (report.excess > 0 && !report.pending.length) {
      lagTicks += 1;
      console.log(
        `[${stamp}] excess ${report.excess.toFixed(3)} but no post-genesis deposit visible yet ` +
          `(history lag) ${lagTicks}/${lagLimit}`,
      );
      if (lagTicks >= lagLimit) {
        console.error(
          `STOPPING: backing without an attributable deposit for ${lagTicks} ticks — ` +
            'likely non-deposit credits (rewards) or a missed transfer. Sweep stray credits out, run --audit.',
        );
        process.exit(1);
      }
    } else {
      lagTicks = 0;
    }

    for (const dep of report.pending) {
      if (dep.recipient) continue;
      if (flagged.has(depKey(dep))) continue;
      flagged.add(depKey(dep));
      console.log(
        `[${stamp}] unattributed deposit +${dep.amount} tx ${dep.txId}: ${dep.reason} — ` +
          'will NOT auto-issue it; handle manually.',
      );
    }

    const next = report.pending.find((d) => d.recipient && !issuedIndices.has(depKey(d)));
    if (next) {
      // funds-first re-verified inside scanPendingDeposits on this very tick
      console.log(
        `[${stamp}] deposit +${next.amount} (tx ${next.txId}) -> issuing ${next.qty} ${SYMBOL} to ${next.recipient}`,
      );
      await runEngineStep(client, keys, {
        label: `tokens.issue ${next.qty} ${SYMBOL} to ${next.recipient}`,
        payload: wiki('issue', { symbol: SYMBOL, to: next.recipient, quantity: next.qty }),
      });
      issuedIndices.add(depKey(next));
      continue; // one action per tick — re-scan before the next
    }

    /* ---------------- peg-out side ---------------- */
    let peg;
    try {
      peg = await scanPendingPegOuts();
    } catch (error) {
      console.error(`[${stamp}] peg-out scan failed: ${error.message} — retrying next tick`);
      await sleep(intervalMs);
      continue;
    }
    if (peg.anomalies.length) {
      for (const a of peg.anomalies) console.error(`[${stamp}] ANOMALY: ${a}`);
      console.error('STOPPING — no release performed. Investigate manually (see docs/BRIDGE.md).');
      process.exit(1);
    }

    const pegNext = peg.pegOuts.find((p) => !consumedPegHeights.has(p.height));
    if (pegNext) {
      console.log(
        `[${stamp}] peg-out ${pegNext.qty} ${SYMBOL} from ${pegNext.sender} (engine h${pegNext.height}) -> burn + release`,
      );
      await executePegOut(client, keys, pegNext.qty, pegNext.sender);
      consumedPegHeights.add(pegNext.height);
      continue; // one action per tick
    }

    /* ---------------- idle ---------------- */
    console.log(
      `[${stamp}] idle: excess ${report.excess.toFixed(3)}, bridge holds ${peg.held.toFixed(3)} ${SYMBOL} on-engine`,
    );
    await sleep(intervalMs);
  }
}

/**
 * Testnet-only peg-out rehearsal: burn a dust quantity from bridge inventory
 * through the real consensus path, broadcast the matching L1 release, then
 * auto-verify every projection from independent reads (REST + L1), exactly
 * like scripts/market-rehearsal.cjs. Default release target is the bridge
 * itself — a cost-free, balance-neutral self-transfer.
 */
async function rehearseMode(args, keys) {
  const qty = args.rehearse;
  const to = args.to; // defaults to the bridge itself
  const selfRelease = to === ACCOUNT;
  const l1Amount = `${Number(qty).toFixed(3)} STEEM`;

  console.log(
    `Bridge peg-out rehearsal ${qty} ${SYMBOL} (${OP_ID}, bridge ${ACCOUNT}, release -> ${to}${selfRelease ? ', cost-free self-release' : ''})`,
  );

  const tokenBefore = await engineToken(SYMBOL);
  const heldBefore = await engineBalance(ACCOUNT, SYMBOL);
  const l1Before = await l1Account(ACCOUNT);
  if (!tokenBefore || heldBefore === null) {
    console.error('Bridge state not readable (token/balance missing) — aborting.');
    process.exit(1);
  }
  const supply0 = parseFloat(tokenBefore.supply);
  const held0 = parseFloat(heldBefore);
  const l10 = l1SteemToNumber(l1Before ? l1Before.balance : null);
  console.log(
    `Pre-state: supply ${supply0.toFixed(3)}, bridge on-engine ${held0.toFixed(3)}, bridge L1 ${l10.toFixed(3)}\n`,
  );

  if (args.dryRun) {
    console.log('--- 1 tokens.burn (engine, bridge auth)');
    console.log(JSON.stringify(wiki('burn', { symbol: SYMBOL, quantity: qty }), null, 2));
    console.log(`--- 2 L1 transfer ${l1Amount} ${ACCOUNT} -> ${to} (memo: ${SYMBOL} bridge withdraw (${OP_ID}))`);
    console.log('(dry run — nothing broadcast)');
    return;
  }

  const client = new Client(STEEM_RPC);
  await runEngineStep(client, keys, {
    label: `1 tokens.burn ${qty} ${SYMBOL} (engine)`,
    payload: wiki('burn', { symbol: SYMBOL, quantity: qty }),
  });

  console.log(`2 L1 transfer ${l1Amount} ${ACCOUNT} -> ${to} ...`);
  const transfer = await client.broadcast.transfer(
    { from: ACCOUNT, to, amount: l1Amount, memo: `${SYMBOL} bridge withdraw (${OP_ID})` },
    keys.length === 1 ? keys[0] : keys,
  );
  console.log(`  l1 tx ${transfer.id}`);

  // ---- auto-verify: re-read both chains, never trust the broadcast receipts alone
  console.log('\n--- projections (independent re-read)');
  const n = Number(qty);
  let failed = false;
  const check = (ok, label, actual) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual}`);
    if (!ok) failed = true;
  };

  const supply1 = parseFloat((await engineToken(SYMBOL))?.supply ?? 'NaN');
  check(
    Math.abs(supply1 - (supply0 - n)) < 0.0005,
    `supply decreased by exactly ${qty}`,
    `${supply1.toFixed(3)} (${(supply1 - supply0).toFixed(3)})`,
  );

  const held1 = parseFloat((await engineBalance(ACCOUNT, SYMBOL)) ?? 'NaN');
  check(
    Math.abs(held1 - (held0 - n)) < 0.0005,
    `bridge on-engine balance decreased by exactly ${qty}`,
    `${held1.toFixed(3)} (${(held1 - held0).toFixed(3)})`,
  );

  const l1After = await l1Account(ACCOUNT);
  const l11 = l1SteemToNumber(l1After ? l1After.balance : null);
  if (selfRelease) {
    check(
      Math.abs(l11 - l10) < 0.0005,
      'bridge L1 balance unchanged (self-release is balance-neutral)',
      l11.toFixed(3),
    );
  } else {
    check(
      Math.abs(l11 - (l10 - n)) < 0.0005,
      `bridge L1 decreased by exactly ${l1Amount}`,
      `${l11.toFixed(3)} (${(l11 - l10).toFixed(3)})`,
    );
  }

  if (failed) {
    console.error('\nRehearsal FAILED projections — inspect /api/v1/logs and the L1 tx before trusting the flow.');
    process.exit(1);
  }
  console.log('\nRehearsal complete: burn consensus leg + L1 release + conservation all verified.');
}

/* --------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // single instance BEFORE anything else: two watchers racing the same
  // deposit is the one bug the in-session consumed sets cannot cover
  if (args.mode === 'watch') acquireWatchLock();

  // read-only modes never touch a key
  if (args.mode === 'audit') return auditMode();
  if (args.mode === 'pending') return pendingMode();

  const needsKey = !args.dryRun && args.mode !== 'reconcile';

  if (args.mode === 'reconcile' && args.dryRun) {
    console.log(`(would compare engine ${SYMBOL} supply on ${ENGINE_API} with the STEEM balance of ${ACCOUNT} on ${STEEM_RPC})`);
    return;
  }
  if (args.mode === 'reconcile') return reconcileMode();

  // fail fast, before any key handling: a rehearsal must never touch mainnet
  if (args.mode === 'rehearse' && OP_ID === 'sce-mainnet1') {
    console.error('Refusing to rehearse on mainnet: the burn leg would destroy real inventory.');
    console.error("Set SCE_OP_ID='sce-testnet1' (plus ENGINE_API) for rehearsals.");
    process.exit(1);
  }

  let keys = null;
  if (needsKey) {
    const raw = (process.env.STEEM_ACTIVE_WIF || '').trim();
    if (!raw) {
      console.error('STEEM_ACTIVE_WIF is not set. In PowerShell:');
      console.error("  $env:STEEM_ACTIVE_WIF = '5K...'   # active key(s) of " + ACCOUNT);
      console.error(`  node scripts/wsteem.cjs --dry-run`);
      process.exit(1);
    }
    // one WIF, or several space/comma-separated once the multisig is live
    keys = raw.split(/[\s,]+/).filter(Boolean).map((wif) => PrivateKey.fromString(wif));
    console.log(`Pre-flight: checking ${keys.length} WIF(s) against the active authority of ${ACCOUNT} ...`);
    await verifyActiveKey(keys);
    console.log('Pre-flight OK.\n');
  }

  if (args.mode === 'withdraw') return withdrawMode(args, keys);
  if (args.mode === 'transfer') return transferMode(args, keys);
  if (args.mode === 'watch') return watchMode(args, keys);
  if (args.mode === 'rehearse') return rehearseMode(args, keys);
  return seedMode(args, keys);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}

// exported read-only for validating the detectors outside the CLI
module.exports = { scanPendingDeposits, l1BlockTailTransfers, depKey, sumQtys };
