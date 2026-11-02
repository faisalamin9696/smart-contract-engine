#!/usr/bin/env node
'use strict';
/**
 * Live market rehearsal (docs/MARKET-DESIGN.md; wiki `market` contract).
 *
 * Drives the full order lifecycle against a RUNNING engine through the real
 * consensus path (broadcast -> chain -> indexer -> VM -> guard -> projections):
 *
 *   1. sell  10 WSTEEM @ 2 SCE   -> rests on the book (escrow 10 WSTEEM)
 *   2. buy    4 WSTEEM @ 2 SCE   -> crosses the resting sell at the MAKER price
 *                                  (fill: 4 WSTEEM delivered, 8 SCE settled,
 *                                  MARKET_FILLED event, trade row recorded)
 *   3. cancel the sell remainder -> CANCELLED row, 6 WSTEEM escrow refunded
 *
 * then verifies the API surface a trading UI consumes: open-order list, depth
 * ladder, trades tape and balances. The engine has no self-match restriction,
 * so a single bridge key exercises every leg; a trade row with buyer == seller
 * is the honest signature of a self-rehearsal, not a defect.
 *
 * Usage (PowerShell):
 *   $env:SCE_OP_ID='sce-testnet1'; $env:ENGINE_API='https://sce-test.steempro.com'
 *   node scripts/market-rehearsal.cjs --dry-run
 *   $env:STEEM_ACTIVE_WIF='5K...'
 *   node scripts/market-rehearsal.cjs
 *
 * Env: SCE_OP_ID, GENESIS_ACCOUNT (trader), STEEM_RPC, ENGINE_API, STEEM_ACTIVE_WIF
 */
const { Client, PrivateKey } = require('@steempro/dsteem');

const OP_ID = process.env.SCE_OP_ID || 'sce-mainnet1';
const ACCOUNT = process.env.GENESIS_ACCOUNT || 'steempro.com';
const STEEM_RPC = process.env.STEEM_RPC || 'https://api.steemit.com';
const ENGINE_API = (process.env.ENGINE_API || 'https://sce-api.steempro.com').replace(/\/+$/, '');
const POLL_MS = 3000;
const STEP_TIMEOUT_MS = 120000;

const BASE = 'WSTEEM';
const QUOTE = 'SCE';
const SELL_QTY = '10';
const BUY_QTY = '4';
const PRICE = '2';

const marketOp = (action, params) => ({
  contractName: 'market',
  contractAction: action,
  contractPayload: params,
});

const STEPS = [
  {
    label: `1/3 market.sell ${SELL_QTY} ${BASE} @ ${PRICE} ${QUOTE} (rests on the book)`,
    payload: marketOp('sell', { symbol: BASE, quote: QUOTE, quantity: SELL_QTY, price: PRICE }),
  },
  {
    label: `2/3 market.buy ${BUY_QTY} ${BASE} @ ${PRICE} ${QUOTE} (crosses the resting sell)`,
    payload: marketOp('buy', { symbol: BASE, quote: QUOTE, quantity: BUY_QTY, price: PRICE }),
  },
  {
    label: '3/3 market.cancel the partially filled sell (refunds the remainder)',
    // placeholder id — replaced at runtime with the real id of step 1
    payload: marketOp('cancel', { orderId: '__SELL_ORDER_ID__' }),
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function engineJson(path) {
  const response = await fetch(`${ENGINE_API}${path}`);
  if (!response.ok) throw new Error(`GET ${path} -> HTTP ${response.status}`);
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

/** Recovers the resting sell order id through the public REST surface (the same
 *  endpoint the trading UI uses to render open orders). */
async function findOpenSellId() {
  const body = await engineJson(
    `/api/v1/market/orders?symbol=${BASE}&quote=${QUOTE}&status=OPEN&side=SELL&account=${ACCOUNT}`,
  );
  const rows = Array.isArray(body.data) ? body.data : [];
  return rows.length > 0 ? rows[rows.length - 1].id : null;
}

async function verifyActiveKey(key) {
  const client = new Client(STEEM_RPC);
  const pubkey = key.createPublic().toString();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const [account] = await client.database.getAccounts([ACCOUNT]);
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

/* ----------------------------------------------------------------- checking */

function expect(label, actual, wanted) {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}`);
  return ok;
}

async function verifyProjections() {
  console.log('--- API projections (what the trading UI consumes)');
  const orders = (await engineJson(`/api/v1/market/orders?symbol=${BASE}&quote=${QUOTE}`)).data;
  const sell = orders.find((o) => o.side === 'SELL');
  const buy = orders.find((o) => o.side === 'BUY');
  const trades = (await engineJson(`/api/v1/market/trades?symbol=${BASE}&quote=${QUOTE}`)).data;
  const book = (await engineJson(`/api/v1/market/book?symbol=${BASE}&quote=${QUOTE}`)).data;
  const balances = (await engineJson(`/api/v1/balances?account=${ACCOUNT}`)).data;

  let ok = true;
  ok = expect('sell order CANCELLED, escrow released', sell && { status: sell.status, quantity: sell.quantity, escrow: sell.escrow, filled: sell.filled }, { status: 'CANCELLED', quantity: '0', escrow: '0', filled: BUY_QTY }) && ok;
  ok = expect('buy order FILLED at maker price', buy && { status: buy.status, quantity: buy.quantity, price: buy.price }, { status: 'FILLED', quantity: '0', price: PRICE }) && ok;
  ok = expect('one trade recorded (self-rehearsal: buyer == seller)', trades.length, 1) && ok;
  ok = expect('depth ladder empty after cancel', { bids: book.bids.length, asks: book.asks.length }, { bids: 0, asks: 0 }) && ok;
  const wsteem = balances.find((b) => b.symbol === BASE);
  const sce = balances.find((b) => b.symbol === QUOTE);
  ok = expect(`${BASE} balance conserved (round trip)`, wsteem && wsteem.quantity, '100000') && ok;
  ok = expect(`${QUOTE} unchanged (tradeFeeBps is 0, self-trade nets)`, sce && sce.quantity, '1000000') && ok;
  return ok;
}

/* --------------------------------------------------------------------- main */

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const steps = JSON.parse(JSON.stringify(STEPS));

  if (dryRun) {
    for (const step of steps) {
      console.log(`--- ${step.label}`);
      console.log(JSON.stringify(step.payload, null, 2));
    }
    console.log(`(custom_json id = ${OP_ID}, broadcast as ${ACCOUNT}; step 3's order id is filled in at runtime)`);
    return;
  }

  const wif = process.env.STEEM_ACTIVE_WIF;
  if (!wif) {
    console.error('STEEM_ACTIVE_WIF is not set. In PowerShell:');
    console.error("  $env:STEEM_ACTIVE_WIF = '5K...'   # active key of " + ACCOUNT);
    console.error('  node scripts/market-rehearsal.cjs --dry-run');
    process.exit(1);
  }

  const key = PrivateKey.fromString(wif.trim());
  console.log(`Pre-flight: checking the WIF is an active key of ${ACCOUNT} ...`);
  await verifyActiveKey(key);
  console.log('Pre-flight OK.\n');

  const client = new Client(STEEM_RPC);
  let sellOrderId = null;

  for (const step of steps) {
    if (step.payload.contractPayload.orderId === '__SELL_ORDER_ID__') {
      if (!sellOrderId) throw new Error('step 1 produced no order id — aborting before cancel');
      step.payload.contractPayload.orderId = sellOrderId;
    }

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
    console.log(`  APPLIED at height ${log.height}`);

    if (step === steps[0]) {
      sellOrderId = await findOpenSellId();
      if (!sellOrderId) {
        console.error('  could not find the resting sell on the book via REST. Aborting.');
        process.exit(1);
      }
      console.log(`  resting sell order id (via /market/orders): ${sellOrderId}`);
    }
    console.log('');
  }

  const ok = await verifyProjections();
  if (!ok) {
    console.error('\nRehearsal broadcast OK but projection checks FAILED — investigate before frontend work.');
    process.exit(1);
  }
  console.log('\nMarket rehearsal complete: placement, maker-price fill, escrow release, cancel refund,');
  console.log('trade tape and depth ladder all verified through the live consensus path.');
}

main().catch((error) => {
  console.error(`Fatal: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
