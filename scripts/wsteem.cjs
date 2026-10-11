#!/usr/bin/env node
'use strict';
/**
 * WSTEEM bridge script (docs/MARKET-DESIGN.md -> "Wrapped assets", phase 1).
 *
 * Creates the `WSTEEM` wrapper token from the bridge account and (optionally)
 * issues supply — per-deposit on mainnet, bootstrap inventory on testnet. No
 * engine change backs this: WSTEEM is an ordinary `tokens` row whose custody
 * invariant (circulating supply == backing L1 balance in the bridge account)
 * is externally checkable against the API and the chain.
 *
 * Follows the genesis.cjs operational pattern: wiki envelope, active-key
 * pre-flight, per-step engine confirmation, abort on rejection.
 *
 * Usage (PowerShell):
 *   $env:SCE_OP_ID='sce-testnet1'; $env:ENGINE_API='https://sce-test.steempro.com'
 *   node scripts/wsteem.cjs --dry-run                      # inspect payloads
 *   $env:STEEM_ACTIVE_WIF='5K...'                          # active key of bridge
 *   node scripts/wsteem.cjs --issue 100000                 # create + issue to bridge
 *   node scripts/wsteem.cjs --issue 500 --to alice --no-create   # deposit-style top-up
 *
 * Env:
 *   SCE_OP_ID        target instance (default sce-mainnet1)
 *   GENESIS_ACCOUNT  bridge account (default steempro.com)
 *   STEEM_RPC        signing/broadcast endpoint (default https://api.steemit.com)
 *   ENGINE_API       engine REST base for verification (default https://sce-api.steempro.com)
 *   STEEM_ACTIVE_WIF active key of the bridge account (required unless --dry-run)
 */
const { Client, PrivateKey } = require('@steempro/dsteem');

const OP_ID = process.env.SCE_OP_ID || 'sce-mainnet1';
const ACCOUNT = process.env.GENESIS_ACCOUNT || 'steempro.com';
const STEEM_RPC = process.env.STEEM_RPC || 'https://api.steemit.com';
const ENGINE_API = (process.env.ENGINE_API || 'https://sce-api.steempro.com').replace(/\/+$/, '');
const POLL_MS = 3000;
const STEP_TIMEOUT_MS = 120000;

/* --------------------------------------------------------------- arguments */

function parseArgs(argv) {
  const args = { dryRun: false, noCreate: false, issue: null, to: ACCOUNT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-create') args.noCreate = true;
    else if (arg === '--issue') {
      args.issue = argv[++i];
      if (args.issue === undefined || !/^\d+(\.\d{1,3})?$/.test(args.issue) || Number(args.issue) <= 0) {
        throw new Error('--issue expects a positive amount with at most 3 decimals (WSTEEM precision)');
      }
    } else if (arg === '--to') {
      args.to = argv[++i];
      if (args.to === undefined || !/^[a-z][a-z0-9.-]{2,15}$/.test(args.to)) {
        throw new Error('--to expects a valid Steem account name');
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function buildSteps(args) {
  const steps = [];
  if (!args.noCreate) {
    steps.push({
      label: '1 tokens.create WSTEEM',
      payload: {
        contractName: 'tokens',
        contractAction: 'create',
        contractPayload: {
          symbol: 'WSTEEM',
          name: 'Wrapped STEEM',
          precision: 3,
          url: 'https://steempro.com',
          // maxSupply omitted on purpose = unlimited; deposits issue on demand.
        },
      },
    });
  }
  if (args.issue !== null) {
    steps.push({
      label: `${steps.length + 1} tokens.issue ${args.issue} WSTEEM to ${args.to}`,
      payload: {
        contractName: 'tokens',
        contractAction: 'issue',
        contractPayload: { symbol: 'WSTEEM', to: args.to, quantity: args.issue },
      },
    });
  }
  if (steps.length === 0) throw new Error('nothing to do: pass --issue <qty> (and optionally --no-create)');
  return steps;
}

/* ---------------------------------------------------------------- mechanics */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Newest-first engine logs (REST /api/v1/logs). */
async function fetchRecentLogs() {
  const response = await fetch(`${ENGINE_API}/api/v1/logs?limit=20`);
  if (!response.ok) throw new Error(`engine logs HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.data) ? body.data : [];
}

/** Polls the engine until the tx shows up in the transaction log. */
async function waitForOutcome(txId) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let logs = [];
    try {
      logs = await fetchRecentLogs();
    } catch {
      // Engine restarting or unreachable — keep polling until the deadline.
    }
    const hit = logs.find((entry) => entry.txId === txId);
    if (hit) return hit;
    await sleep(POLL_MS);
  }
  return null;
}

function describeRejection(log) {
  const error = log && log.error ? `${log.error.code}: ${log.error.message}` : 'unknown error';
  const hint =
    log && log.error?.code === 'INVALID_PARAMS' && String(log.error.message).includes('exists')
      ? '\n  -> WSTEEM already exists on this instance; re-run with --no-create for issue-only runs.'
      : '';
  return `engine rejected ${log ? log.action : 'the op'} -> ${error}${hint}`;
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

/* --------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const steps = buildSteps(args);

  if (args.dryRun) {
    for (const step of steps) {
      console.log(`--- ${step.label}`);
      console.log(JSON.stringify(step.payload, null, 2));
    }
    console.log(`(custom_json id = ${OP_ID}, broadcast as ${ACCOUNT})`);
    return;
  }

  const wif = process.env.STEEM_ACTIVE_WIF;
  if (!wif) {
    console.error('STEEM_ACTIVE_WIF is not set. In PowerShell:');
    console.error("  $env:STEEM_ACTIVE_WIF = '5K...'   # active key of " + ACCOUNT);
    console.error('  node scripts/wsteem.cjs --dry-run   # inspect payloads first');
    process.exit(1);
  }

  const key = PrivateKey.fromString(wif.trim());
  console.log(`Pre-flight: checking the WIF is an active key of ${ACCOUNT} ...`);
  await verifyActiveKey(key);
  console.log('Pre-flight OK.\n');

  const client = new Client(STEEM_RPC);
  for (const step of steps) {
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
      console.error(`  timed out after ${STEP_TIMEOUT_MS / 1000}s: the op never appeared in the engine log.`);
      console.error('  Check engine deployment/status before broadcasting anything else. Aborting.');
      process.exit(1);
    }
    if (log.status !== 'APPLIED') {
      console.error(`  ${describeRejection(log)}`);
      console.error('  Aborting (later steps were NOT sent).');
      process.exit(1);
    }
    console.log(`  APPLIED at height ${log.height}\n`);
  }

  console.log('WSTEEM step complete.');
  if (OP_ID === 'sce-mainnet1') {
    console.log('Custody reminder (mainnet): circulating WSTEEM supply must equal the STEEM');
    console.log('backing balance held on L1 by the bridge account — the invariant is public.');
  }
}

main().catch((error) => {
  console.error(`Fatal: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
