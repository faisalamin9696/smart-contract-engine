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
 *   --rehearse [qty]     testnet-only end-to-end peg-out rehearsal: burn from
 *                        bridge inventory through real consensus + L1 release
 *                        broadcast + automatic conservation checks
 *   --reconcile          quick custody invariant (engine supply vs L1 balance)
 *   --audit              full backing evidence: every engine issue/burn/transfer
 *                        cross-checked against every L1 transfer in/out of the
 *                        bridge account (read-only, no key needed)
 *
 * Usage (PowerShell):
 *   $env:SCE_OP_ID='sce-testnet1'; $env:ENGINE_API='https://sce-test.steempro.com'
 *   node scripts/wsteem.cjs --dry-run
 *   $env:STEEM_ACTIVE_WIF='5K...'                          # active key of bridge
 *   node scripts/wsteem.cjs --issue 100000                 # create + issue inventory
 *   node scripts/wsteem.cjs --issue 5 --to alice --no-create   # deposit: verify L1 first!
 *   node scripts/wsteem.cjs --withdraw 5 --to alice        # peg-out: burn + L1 release
 *   node scripts/wsteem.cjs --rehearse 0.010               # testnet peg-out drill (WIF)
 *   node scripts/wsteem.cjs --reconcile                    # invariant check (no key)
 *   node scripts/wsteem.cjs --audit                        # backing evidence (no key)
 *
 * Env:
 *   SCE_OP_ID        target instance (default sce-mainnet1)
 *   BRIDGE_ACCOUNT   bridge account (default steempro.funds)
 *   STEEM_RPC        signing/broadcast endpoint (default https://api.steemit.com)
 *   ENGINE_API       engine REST base (default https://sce-api.steempro.com)
 *   STEEM_ACTIVE_WIF active key of the bridge account (not needed for --reconcile / --dry-run)
 */
const { Client, PrivateKey } = require('@steempro/dsteem');

const OP_ID = process.env.SCE_OP_ID || 'sce-mainnet1';
const ACCOUNT = process.env.BRIDGE_ACCOUNT || process.env.GENESIS_ACCOUNT || 'steempro.funds';
const STEEM_RPC = process.env.STEEM_RPC || 'https://api.steemit.com';
const ENGINE_API = (process.env.ENGINE_API || 'https://sce-api.steempro.com').replace(/\/+$/, '');
const POLL_MS = 3000;
const STEP_TIMEOUT_MS = 120000;

const SYMBOL = 'WSTEEM';

/* --------------------------------------------------------------- arguments */

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
    rehearse: '0.010',
    to: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-create') args.noCreate = true;
    else if (arg === '--reconcile') args.mode = 'reconcile';
    else if (arg === '--audit') args.mode = 'audit';
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
    } else if (arg === '--to') {
      args.to = argv[++i];
      if (args.to === undefined || !/^[a-z][a-z0-9.-]{2,15}$/.test(args.to)) {
        throw new Error('--to expects a valid Steem account name');
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
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
    throw new Error('nothing to do: pass --issue <qty>, --withdraw <qty>, --rehearse [qty], --reconcile or --audit');
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
  const pages = maxPages ?? Number(process.env.AUDIT_L1_PAGES || 50);
  const client = new Client(STEEM_RPC);
  const rows = [];
  let start = -1;
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
      const record = Array.isArray(entry) ? entry[1] : null;
      // nodes report the op type either numerically (legacy) or by name; the
      // server-side mask is not honoured everywhere, so filter here regardless
      if (!record || !Array.isArray(record.op)) continue;
      if (record.op[0] !== 2 && record.op[0] !== 'transfer') continue;
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
    const lastEntry = batch[batch.length - 1];
    const lastIndex = Array.isArray(lastEntry) ? lastEntry[0] : -1;
    if (lastIndex <= 0) return { rows, truncated: false };
    start = lastIndex - 1;
    if (page === pages - 1) truncated = true;
  }
  return { rows, truncated };
}

/** Precision-safe sum of3-decimal quantity strings (integer thousandths). */
function sumQtys(items) {
  return items.reduce((acc, value) => acc + Math.round(Number(value) * 1000), 0) / 1000;
}

function fmtList(rows, render, cap = 8) {
  for (const row of rows.slice(0, cap)) console.log(`    ${render(row)}`);
  if (rows.length > cap) console.log(`    ... +${rows.length - cap} more`);
}

async function verifyActiveKey(key) {
  const client = new Client(STEEM_RPC);
  const pubkey = key.createPublic().toString();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const account = await l1Account(ACCOUNT);
      if (!account) throw new Error(`account ${ACCOUNT} not found on chain`);
      const authorised = account.active.key_auths.some(([listed]) => listed === pubkey);
      if (!authorised) {
        throw new Error(
          `the provided WIF is not an active key of ${ACCOUNT} (expected a key whose public part is listed in active key_auths)`,
        );
      }
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(2000);
    }
  }
}

async function runEngineStep(client, key, step) {
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
  const confirmation = await client.broadcast.sendOperations([op], key);
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

async function seedMode(args, key) {
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
  for (const step of steps) await runEngineStep(client, key, step);

  console.log(`${SYMBOL} step complete.`);
  if (OP_ID === 'sce-mainnet1') {
    console.log('Custody reminder (mainnet): run --reconcile after every deposit/withdraw —');
    console.log(`circulating ${SYMBOL} supply must equal the STEEM backing held on L1 by ${ACCOUNT}.`);
  }
}

/**
 * Peg-out: the user has already engine-transferred WSTEEM to the bridge.
 * Order: engine burn FIRST (destroys the wrapper, frees the backing), then the
 * L1 STEEM release. A failure between the legs leaves the user whole (their
 * wrapper is gone and the operator simply re-sends the STEEM); the opposite
 * order could pay twice.
 */
async function withdrawMode(args, key) {
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
  await runEngineStep(client, key, {
    label: `1 tokens.burn ${qty} ${SYMBOL} (engine)`,
    payload: wiki('burn', { symbol: SYMBOL, quantity: qty }),
  });

  console.log(`2 L1 transfer ${l1Amount} ${ACCOUNT} -> ${to} ...`);
  const transfer = await client.broadcast.transfer(
    { from: ACCOUNT, to, amount: l1Amount, memo: `${SYMBOL} bridge withdraw (${OP_ID})` },
    key,
  );
  console.log(`  l1 tx ${transfer.id}`);

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
  const qtyOf = (o) => (o.params && typeof o.params.quantity === 'string' ? o.params.quantity : null);
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
    const pages = process.env.AUDIT_L1_PAGES || 50;
    console.log(`    NOTE: history capped at ${pages} pages (100 ops each) — raise AUDIT_L1_PAGES for full depth.`);
  }

  console.log('\n  recent deposits (L1 in):');
  if (ins.length === 0) console.log('    (none)');
  fmtList(
    ins.slice().reverse(),
    (r) => `+ ${r.amount} from ${r.from}  ${r.timestamp}  ${r.txId}${r.memo ? `  memo="${r.memo}"` : ''}`,
  );
  console.log('\n  recent releases (L1 out):');
  if (outs.length === 0) console.log('    (none)');
  fmtList(outs.slice().reverse(), (r) => `- ${r.amount} to ${r.to}  ${r.timestamp}  ${r.txId}`);

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
    if (!b) failed = true;
  }

  if (failed) {
    console.log('\n  AUDIT FAILED — do not issue or release until resolved.');
    process.exit(1);
  }
  console.log('\n  Audit clean.');
}

/**
 * Testnet-only peg-out rehearsal: burn a dust quantity from bridge inventory
 * through the real consensus path, broadcast the matching L1 release, then
 * auto-verify every projection from independent reads (REST + L1), exactly
 * like scripts/market-rehearsal.cjs. Default release target is the bridge
 * itself — a cost-free, balance-neutral self-transfer.
 */
async function rehearseMode(args, key) {
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
  await runEngineStep(client, key, {
    label: `1 tokens.burn ${qty} ${SYMBOL} (engine)`,
    payload: wiki('burn', { symbol: SYMBOL, quantity: qty }),
  });

  console.log(`2 L1 transfer ${l1Amount} ${ACCOUNT} -> ${to} ...`);
  const transfer = await client.broadcast.transfer(
    { from: ACCOUNT, to, amount: l1Amount, memo: `${SYMBOL} bridge withdraw (${OP_ID})` },
    key,
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

  // read-only modes never touch a key
  if (args.mode === 'audit') return auditMode();

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

  let key = null;
  if (needsKey) {
    const wif = process.env.STEEM_ACTIVE_WIF;
    if (!wif) {
      console.error('STEEM_ACTIVE_WIF is not set. In PowerShell:');
      console.error("  $env:STEEM_ACTIVE_WIF = '5K...'   # active key of " + ACCOUNT);
      console.error(`  node scripts/wsteem.cjs --dry-run`);
      process.exit(1);
    }
    key = PrivateKey.fromString(wif.trim());
    console.log(`Pre-flight: checking the WIF is an active key of ${ACCOUNT} ...`);
    await verifyActiveKey(key);
    console.log('Pre-flight OK.\n');
  }

  if (args.mode === 'withdraw') return withdrawMode(args, key);
  if (args.mode === 'rehearse') return rehearseMode(args, key);
  return seedMode(args, key);
}

main().catch((error) => {
  console.error(`Fatal: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
