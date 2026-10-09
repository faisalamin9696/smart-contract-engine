#!/usr/bin/env node
'use strict';

/**
 * Genesis broadcast for the fungible tokens contract — docs/TOKENS-DESIGN.md
 * "Genesis runbook". Re-run whenever the state DB is reset: the original
 * 2026-10-08 genesis went out under the legacy id steem_nft_v1, which this
 * engine no longer parses (op id is now sce-mainnet1).
 *
 * Sends the three ops as the genesis admin, IN ORDER, and verifies each one through
 * the engine's transaction log before sending the next. Step 3 (setParam) must not
 * run unless step 1 landed: raising fees while SCE does not exist would make every
 * fee-bearing action fail with TOKEN_NOT_FOUND afterwards.
 *
 * Usage (PowerShell):
 *   $env:STEEM_ACTIVE_WIF = '5K...'    # active key of the admin — never commit it
 *   node scripts/genesis.cjs            # broadcast + verify each step
 *   node scripts/genesis.cjs --dry-run  # print the three payloads and exit
 *
 * Env:
 *   STEEM_ACTIVE_WIF  active WIF of GENESIS_ACCOUNT  (required unless --dry-run)
 *   GENESIS_ACCOUNT   admin / treasury account       (default steempro.com)
 *   STEEM_RPC         Steem RPC endpoint             (default https://api.steemit.com)
 *   ENGINE_API        engine REST base URL           (default https://nft-api.steempro.com)
 */

const { Client, PrivateKey } = require('@steempro/dsteem');

// custom_json operation id — override with SCE_OP_ID to run genesis for an
// isolated network (e.g. SCE_OP_ID=sce-testnet1 broadcasts testnet genesis).
const OP_ID = process.env.SCE_OP_ID || 'sce-mainnet1';
const ACCOUNT = process.env.GENESIS_ACCOUNT || 'steempro.com';
const STEEM_RPC = process.env.STEEM_RPC || 'https://api.steemit.com';
const ENGINE_API = (process.env.ENGINE_API || 'https://nft-api.steempro.com').replace(/\/+$/, '');
const POLL_MS = 3000;
const STEP_TIMEOUT_MS = 120000;

const STEPS = [
  {
    label: '1/3 tokens.create SCE',
    action: 'create',
    payload: {
      contractName: 'tokens',
      contractAction: 'create',
      contractPayload: {
        symbol: 'SCE',
        name: 'Smart Contract Engine',
        precision: 3,
        url: 'https://steempro.com',
        // maxSupply omitted on purpose = unlimited (an explicit "0" is rejected).
      },
    },
  },
  {
    label: '2/3 tokens.issue 1,000,000 SCE to treasury',
    action: 'issue',
    payload: {
      contractName: 'tokens',
      contractAction: 'issue',
      contractPayload: { symbol: 'SCE', to: ACCOUNT, quantity: '1000000' },
    },
  },
  {
    label: '3/3 engine.setParam raise schedule',
    action: 'setParam',
    payload: {
      contractName: 'engine',
      contractAction: 'setParam',
      contractPayload: {
        fees: {
          nftCreationFee: '20',
          addPropertyFee: '20',
          tokenCreationFee: '20',
          issueFee: '0',
          fillOrderFeeBps: '200',
        },
      },
    },
  },
];

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
    log && (log.error?.code === 'UNKNOWN_CONTRACT' || log.error?.code === 'UNKNOWN_ACTION')
      ? '\n  -> the live engine is probably still running pre-step-3 code: redeploy on Dokploy first,'
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

async function main() {
  if (process.argv.includes('--dry-run')) {
    for (const step of STEPS) {
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
    console.error('  node scripts/genesis.cjs --dry-run   # inspect payloads first');
    process.exit(1);
  }

  const key = PrivateKey.fromString(wif.trim());
  console.log(`Pre-flight: checking the WIF is an active key of ${ACCOUNT} ...`);
  await verifyActiveKey(key);
  console.log('Pre-flight OK.\n');

  const client = new Client(STEEM_RPC);
  for (const step of STEPS) {
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

  console.log('Genesis complete: SCE exists with 1,000,000 in the treasury and the fee');
  console.log('schedule is live (nft create / addProperty(4th+) / tokens create = 20 SCE,');
  console.log('issue = 0, fillOrder = 200 bps).');
}

main().catch((error) => {
  console.error(`Fatal: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
