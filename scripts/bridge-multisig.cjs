#!/usr/bin/env node
'use strict';
/**
 * Bridge multisig upgrade (docs/BRIDGE.md -> "Multisig upgrade").
 *
 * Turns the bridge account from 1-of-1 signing into a THRESHOLD (default
 * 2-of-3) authority on BOTH the owner and active authorities — one stolen
 * key then moves nothing, one lost key doesn't brick the account. The old
 * single keys lose all authority the moment the update applies.
 *
 * Modes:
 *   (default)   preview: fetch the live account, build the account_update,
 *               print the plan. Broadcasts nothing, prints no private keys.
 *   --apply     broadcast the account_update signed with the CURRENT OWNER
 *               key (STEEM_OWNER_WIF); generates the fresh keys, prints each
 *               WIF once (save immediately — three separate secure places),
 *               then verifies the new authorities on-chain.
 *   --test      smoke-test the live threshold: sign a real op with BRIDGE_SIGN_KEYS
 *               (two or more of the new active WIFs, space/comma separated) —
 *               a balance-neutral 0.001 STEEM self-transfer when the account
 *               holds funds, a funds-free custom_json probe otherwise.
 *
 * Usage (PowerShell):
 *   node scripts/bridge-multisig.cjs                                   # preview
 *   $env:STEEM_OWNER_WIF='5K...'                                       # CURRENT owner key
 *   node scripts/bridge-multisig.cjs --apply --account steempro.funds  # flip to 2-of-3
 *   $env:BRIDGE_SIGN_KEYS='wif1 wif2'                                  # two new active keys
 *   node scripts/bridge-multisig.cjs --test                            # prove 2-of-3 works
 *   # afterwards bridge ops need both keys:
 *   $env:STEEM_ACTIVE_WIF='wif1 wif2'
 *   node scripts/wsteem.cjs --reconcile
 *
 * Env:
 *   BRIDGE_ACCOUNT    default account for preview/test (default steempro.funds);
 *                     --apply IGNORES the env and demands --account explicitly
 *   STEEM_RPC         endpoint (default https://api.steemit.com)
 *   KEY_COUNT         number of fresh keys (default 3)
 *   THRESHOLD         signatures required (default 2)
 *   STEEM_OWNER_WIF   current OWNER key (only for --apply)
 *   BRIDGE_SIGN_KEYS  new active WIFs to test-sign with (only for --test)
 */
const crypto = require('crypto');
const { Client, PrivateKey } = require('@steempro/dsteem');

const STEEM_RPC = process.env.STEEM_RPC || 'https://api.steemit.com';
const KEY_COUNT = Number(process.env.KEY_COUNT || 3);
const THRESHOLD = Number(process.env.THRESHOLD || 2);
const TEST_AMOUNT = '0.001 STEEM';

/* --------------------------------------------------------------- arguments */

const argv = process.argv.slice(2);

const mode = (() => {
  if (argv.includes('--apply')) return 'apply';
  if (argv.includes('--test')) return 'test';
  const known = new Set(['--preview', '--account']);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--account') {
      i += 1; // skip its value
      continue;
    }
    if (!known.has(argv[i])) throw new Error(`unknown argument: ${argv[i]}`);
  }
  return 'preview';
})();

// --account <name> names the target explicitly on the command line. --apply
// REQUIRES it: an authority flip must never be retargetable by a stale
// $env:BRIDGE_ACCOUNT left over from another drill (a real misfire this
// tool caught once — see docs/BRIDGE.md).
const accountFlag = (() => {
  const i = argv.indexOf('--account');
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value || !/^[a-z][a-z0-9.-]{2,15}$/.test(value)) throw new Error('--account expects a valid account name');
  return value;
})();

const ACCOUNT = (() => {
  if (mode === 'apply') {
    if (!accountFlag) {
      console.error('--apply REQUIRES an explicit target: node scripts/bridge-multisig.cjs --apply --account steempro.funds');
      console.error('(the env default is deliberately ignored for authority flips)');
      process.exit(1);
    }
    const envAccount = process.env.BRIDGE_ACCOUNT;
    if (envAccount && envAccount !== accountFlag) {
      console.error(`Refusing: BRIDGE_ACCOUNT env is '${envAccount}' but --account says '${accountFlag}'.`);
      console.error('A stale env var must not retarget an authority flip — unset it and re-run:');
      console.error(`  Remove-Item Env:BRIDGE_ACCOUNT`);
      process.exit(1);
    }
    return accountFlag;
  }
  return accountFlag || process.env.BRIDGE_ACCOUNT || 'steempro.funds';
})();

/* ---------------------------------------------------------------- mechanics */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function l1Account(name) {
  const client = new Client(STEEM_RPC);
  const [account] = await client.database.getAccounts([name]);
  return account ?? null;
}

/** Fresh random WIF: 32 secure random bytes straight onto the curve. */
function randomWif() {
  return new PrivateKey(crypto.randomBytes(32)).toString();
}

function parseWifs(raw, flag) {
  const wifs = String(raw || '')
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (wifs.length === 0) throw new Error(`${flag} is not set`);
  return wifs.map((wif) => PrivateKey.fromString(wif));
}

/** key_auths must be lexicographically sorted for on-chain authorities. */
function buildAuthority(wifs, threshold) {
  const key_auths = wifs
    .map((wif) => [PrivateKey.fromString(wif).createPublic().toString(), 1])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { weight_threshold: threshold, account_auths: [], key_auths };
}

function describeAuthority(auth) {
  return `threshold ${auth.weight_threshold}, ${auth.key_auths.length} key(s): ${auth.key_auths
    .map(([pub, w]) => `${pub}(${w})`)
    .join(', ')}`;
}

/* -------------------------------------------------------------------- modes */

async function previewMode() {
  const account = await l1Account(ACCOUNT);
  if (!account) throw new Error(`account ${ACCOUNT} not found on chain`);
  if (KEY_COUNT <= THRESHOLD || THRESHOLD < 1) {
    throw new Error(`need KEY_COUNT(${KEY_COUNT}) > THRESHOLD(${THRESHOLD}) >= 1`);
  }

  console.log(`--- multisig preview for ${ACCOUNT} (${STEEM_RPC})`);
  console.log(`  current owner : ${describeAuthority(account.owner)}`);
  console.log(`  current active: ${describeAuthority(account.active)}`);
  console.log(
    `\n  plan: replace BOTH owner and active with a ${THRESHOLD}-of-${KEY_COUNT} threshold of fresh keys.`,
  );
  console.log('  preview mode prints no private keys; run --apply to generate them for real.');
  console.log('\n  steps:');
  console.log('    1. $env:STEEM_OWNER_WIF = <current OWNER key of ' + ACCOUNT + '>');
  console.log('    2. node scripts/bridge-multisig.cjs --apply    # saves 3 WIFs (shown once!)');
  console.log('    3. $env:BRIDGE_SIGN_KEYS = <two of the new WIFs>');
  console.log('    4. node scripts/bridge-multisig.cjs --test      # balance-neutral smoke test');
  console.log('    5. bridge ops now need: $env:STEEM_ACTIVE_WIF = <two new WIFs, space-separated>');
}

async function applyMode() {
  const wif = process.env.STEEM_OWNER_WIF;
  if (!wif) {
    console.error("STEEM_OWNER_WIF is not set — the account_update must be signed with the");
    console.error(`CURRENT OWNER key of ${ACCOUNT} (not the active key used for bridge ops).`);
    process.exit(1);
  }
  const ownerKey = PrivateKey.fromString(wif.trim());
  const ownerPub = ownerKey.createPublic().toString();

  const account = await l1Account(ACCOUNT);
  if (!account) throw new Error(`account ${ACCOUNT} not found on chain`);
  if (!account.owner.key_auths.some(([pub]) => pub === ownerPub)) {
    console.error(`The provided STEEM_OWNER_WIF is NOT an owner key of ${ACCOUNT}.`);
    console.error(`Its public part (${ownerPub}) is not in owner key_auths:`);
    console.error(`  ${describeAuthority(account.owner)}`);
    process.exit(1);
  }
  if (KEY_COUNT <= THRESHOLD || THRESHOLD < 1) {
    throw new Error(`need KEY_COUNT(${KEY_COUNT}) > THRESHOLD(${THRESHOLD}) >= 1`);
  }

  console.log(`Owner pre-flight OK (${ownerPub} is listed in ${ACCOUNT}'s owner authority).\n`);

  // generate the fresh threshold keys — shown exactly once
  const wifs = Array.from({ length: KEY_COUNT }, () => randomWif());
  const authority = buildAuthority(wifs, THRESHOLD);
  console.log('===============================================================');
  console.log(`  FRESH ${KEY_COUNT} KEYS FOR ${ACCOUNT} — SAVE EACH WIF NOW.`);
  console.log('  Store them in SEPARATE secure places (password manager, encrypted');
  console.log('  disk, paper). They are shown once; losing 2 of them after the flip');
  console.log('  PERMANENTLY bricks access to the bridge backing.');
  console.log('===============================================================');
  wifs.forEach((key, i) => console.log(`  key ${i + 1}: ${key}`));
  console.log('===============================================================\n');

  const payload = {
    account: ACCOUNT,
    owner: authority,
    active: authority,
    posting: account.posting,
    memo_key: account.memo_key,
    json_metadata: account.json_metadata,
  };
  console.log('broadcasting account_update (old owner+active keys lose all authority):');
  console.log(JSON.stringify({ ...payload, owner: undefined }, null, 2).replace(/\n}/, '\n}'));

  const client = new Client(STEEM_RPC);
  const confirmation = await client.broadcast.sendOperations([['account_update', payload]], ownerKey);
  console.log(`  broadcast tx ${confirmation.id}`);

  await sleep(4000);
  const after = await l1Account(ACCOUNT);
  if (!after) throw new Error('account unreadable after broadcast — verify manually before anything else');

  const matches = (auth) =>
    auth.weight_threshold === THRESHOLD &&
    auth.key_auths.length === KEY_COUNT &&
    authority.key_auths.every(([pub]) => auth.key_auths.some(([listed]) => listed === pub));

  console.log('\n--- post-apply verification (independent re-read)');
  const okOwner = matches(after.owner);
  const okActive = matches(after.active);
  console.log(`  ${okOwner ? 'ok  ' : 'FAIL'} owner  : ${describeAuthority(after.owner)}`);
  console.log(`  ${okActive ? 'ok  ' : 'FAIL'} active : ${describeAuthority(after.active)}`);
  if (!okOwner || !okActive) {
    console.error('\nThe update did NOT land as designed — inspect the tx before proceeding.');
    process.exit(1);
  }
  console.log('\nMultisig live: 2-of-3 on owner AND active. Next:');
  console.log('  * run --test with two of the new WIFs');
  console.log(`  * the previous single keys (old owner ${account.owner.key_auths.map(([p]) => p).join(', ')})`);
  console.log('    and active keys now have NO authority — retire them');
  console.log('  * bridge ops now require two keys: STEEM_ACTIVE_WIF="wif1 wif2"');
}

async function testMode() {
  const raw = process.env.BRIDGE_SIGN_KEYS;
  const keys = parseWifs(raw, 'BRIDGE_SIGN_KEYS');

  const account = await l1Account(ACCOUNT);
  if (!account) throw new Error(`account ${ACCOUNT} not found on chain`);

  let weight = 0;
  for (const key of keys) {
    const pub = key.createPublic().toString();
    const entry = account.active.key_auths.find(([listed]) => listed === pub);
    if (!entry) {
      console.error(`FAIL: ${pub} is not in ${ACCOUNT}'s active authority.`);
      process.exit(1);
    }
    weight += entry[1];
  }
  if (weight < account.active.weight_threshold) {
    console.error(`FAIL: provided key weight ${weight} < active threshold ${account.active.weight_threshold}.`);
    process.exit(1);
  }
  console.log(`Keys verified: ${keys.length} key(s), weight ${weight} >= threshold ${account.active.weight_threshold}.`);

  const before = await l1Account(ACCOUNT);
  const beforeBal = parseFloat(before.balance);
  const client = new Client(STEEM_RPC);

  // The self-transfer proves threshold signing AND the funds path — but it
  // still debits first, so a 0.000-balance account can't run it. Fall back to
  // a custom_json probe: the exact op shape every bridge op uses (active
  // auth of the account), needing no funds at all.
  if (beforeBal >= 0.001) {
    console.log(`\nBroadcasting a balance-neutral ${TEST_AMOUNT} self-transfer signed with ${keys.length} keys ...`);
    const confirmation = await client.broadcast.transfer(
      { from: ACCOUNT, to: ACCOUNT, amount: TEST_AMOUNT, memo: 'multisig smoke test' },
      keys,
    );
    console.log(`  l1 tx ${confirmation.id}`);

    await sleep(4000);
    const after = await l1Account(ACCOUNT);
    const afterBal = parseFloat(after.balance);
    const unchanged = Math.abs(afterBal - beforeBal) < 0.0005;
    console.log(`  balance ${beforeBal.toFixed(3)} -> ${afterBal.toFixed(3)} ${unchanged ? '(unchanged, as expected)' : ''}`);
    if (!unchanged) {
      console.error('FAIL: balance changed on a self-transfer — inspect the tx.');
      process.exit(1);
    }
  } else {
    console.log(
      `\nAccount balance is ${beforeBal.toFixed(3)} STEEM — using a funds-free custom_json probe instead`,
    );
    console.log('(same op shape as every real bridge op: active auth of the account, signed with the key array)');
    const confirmation = await client.broadcast.sendOperations(
      [
        [
          'custom_json',
          {
            id: 'sce-msig-probe',
            required_auths: [ACCOUNT],
            required_posting_auths: [],
            json: '{}',
          },
        ],
      ],
      keys,
    );
    console.log(`  l1 tx ${confirmation.id} — chain accepted a threshold-signed op`);
  }
  console.log('\nMultisig operational: threshold signing works end to end.');
}

/* --------------------------------------------------------------------- main */

async function main() {
  if (mode === 'preview') return previewMode();
  if (mode === 'apply') return applyMode();
  return testMode();
}

main().catch((error) => {
  console.error(`Fatal: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
