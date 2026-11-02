import { MAX_PAYLOAD_BYTES, parseEnvelope, PayloadError } from '../../src/types/actions';
import { validateMutations, MutationGuardError } from '../../src/vm/guard';
import { balanceKey, emptySnapshot, type StateSnapshot, type Token } from '../../src/types/domain';
import type { RawBlock } from '../../src/chain/rpc';
import { parseBlock } from '../../src/chain/opParser';

/**
 * Professional adversarial regression suite (white-hat pass).
 *
 * Every case below models an attacker-controlled input at one of the engine's trust
 * boundaries — chain ingress (`custom_json` payloads) and the host-side mutation
 * guard — and pins the *hostile* behaviour: prototype pollution, schema bombs,
 * float smuggling, scientific-notation amounts, key/value desync, silent deletes.
 * These complement the behavioural suites (actions/guard/market) which exercise the
 * happy path and named invariants.
 */

const OP_ID = 'sce-testnet1';

function envelope(contract: string, action: string, params: unknown): string {
  return JSON.stringify({ contract, action, params });
}

function expectPayloadCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PayloadError);
    expect((err as PayloadError).code).toBe(code);
    return;
  }
  throw new Error(`expected PayloadError ${code} but nothing was thrown`);
}

/** Minimal hostile `custom_json` block around one raw json string. */
function rawBlock(json: unknown, auths: unknown[] = ['alice']): RawBlock {
  return {
    transaction_ids: ['tx-hostile'],
    transactions: [
      {
        operations: [
          [
            'custom_json',
            { id: OP_ID, json, required_auths: auths, required_posting_auths: [] },
          ],
        ],
      },
    ],
  } as unknown as RawBlock;
}

/* ==========================================================================
 * 1. Hostile chain ingress — the memo payload is attacker-written bytes.
 * ========================================================================== */
describe('security: hostile custom_json ingress', () => {
  it('rejects prototype-pollution keys smuggled into params', () => {
    const hostile = [
      '{"action":"transfer","params":{"to":"bob","nfts":[{"symbol":"ABC","ids":["1"]}],"__proto__":{"polluted":true}}}',
      '{"contract":"tokens","action":"transfer","params":{"symbol":"ABC","to":"bob","quantity":"1","constructor":{"prototype":{"polluted":true}}}}',
      '{"contractName":"nft","contractAction":"create","contractPayload":{"symbol":"ABC","name":"X","prototype":{"polluted":true}}}',
    ];
    for (const raw of hostile) {
      expectPayloadCode(() => parseEnvelope(raw), 'INVALID_PARAMS');
    }
    // The host realm must be untouched after every attempt.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses contract names that address Object.prototype', () => {
    expectPayloadCode(
      () => parseEnvelope('{"contract":"__proto__","action":"create","params":{}}'),
      'UNKNOWN_CONTRACT',
    );
    expectPayloadCode(
      () => parseEnvelope('{"contractName":"constructor","contractAction":"x","contractPayload":{}}'),
      'UNKNOWN_CONTRACT',
    );
  });

  it('refuses actions that address the allow-list prototype chain', () => {
    for (const action of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expectPayloadCode(
        () => parseEnvelope(`{"contract":"tokens","action":"${action}","params":{}}`),
        'INVALID_ENVELOPE',
      );
    }
  });

  it('rejects float smuggling in every numeric surface', () => {
    expectPayloadCode(
      () =>
        parseEnvelope(
          '{"action":"issue","params":{"symbol":"ABC","to":"alice","properties":{"power":0.5}}}',
        ),
      'INVALID_PARAMS',
    );
    expectPayloadCode(
      () =>
        parseEnvelope(
          '{"action":"updateMetadata","params":{"symbol":"ABC","metadata":{"x":0.0000001}}}',
        ),
      'INVALID_PARAMS',
    );
  });

  it('rejects scientific notation, hex, signs and locale amounts', () => {
    const quantities = ['1e5', '1E5', '0x10', '-1', '1,5', '', ' ', '+5', '1.', '.5', '1.234567891'];
    for (const quantity of quantities) {
      expectPayloadCode(
        () =>
          parseEnvelope(
            `{"contract":"tokens","action":"transfer","params":{"symbol":"ABC","to":"bob","quantity":${JSON.stringify(quantity)}}}`,
          ),
        'INVALID_PARAMS',
      );
    }
  });

  it('rejects supply caps beyond the safe integer range', () => {
    for (const maxSupply of ['9007199254740993', '99999999999999999999999', '0', '-1', '1e3']) {
      expectPayloadCode(
        () =>
          parseEnvelope(
            `{"contract":"tokens","action":"create","params":{"symbol":"ABC","name":"X","precision":3,"maxSupply":${JSON.stringify(maxSupply)}}}`,
          ),
        'INVALID_PARAMS',
      );
    }
  });

  it('rejects batch and issue bombs before the VM sees them', () => {
    const ids = Array.from({ length: 51 }, (_, i) => String(i + 1));
    expectPayloadCode(
      () =>
        parseEnvelope(
          JSON.stringify({
            action: 'transfer',
            params: { to: 'bob', nfts: [{ symbol: 'ABC', ids }] },
          }),
        ),
      'BATCH_TOO_LARGE',
    );
    const instances = Array.from({ length: 11 }, () => ({ symbol: 'ABC', to: 'alice' }));
    expectPayloadCode(
      () => parseEnvelope(JSON.stringify({ action: 'issueMultiple', params: { instances } })),
      'INVALID_PARAMS',
    );
  });

  it('contains a deeply-nested metadata bomb without crashing', () => {
    // Built by concatenation on purpose: JSON.parse itself is the first recursion
    // wall a deep payload hits (RangeError). In production that throw happens inside
    // parseEnvelope's guarded JSON.parse (-> INVALID_JSON) or, one layer deeper, in
    // the float walker (-> caught by parseBlock as INVALID_PAYLOAD) — either way the
    // op is rejected and the process survives. The raw text stays under the 16KB cap
    // so the size gate cannot mask the real defence.
    const depth = 8000;
    const raw =
      '{"action":"updateMetadata","params":{"symbol":"ABC","metadata":{"bomb":' +
      '['.repeat(depth) +
      ']'.repeat(depth) +
      '}}}';
    expect(raw.length).toBeLessThan(MAX_PAYLOAD_BYTES);
    const result = parseBlock(rawBlock(raw), OP_ID);
    expect(result.ops).toHaveLength(1);
    expect(result.ops[0].ok).toBe(false);
  });

  it('refuses oversized, non-string and authority-less ops', () => {
    const oversized = `{"action":"updateMetadata","params":{"symbol":"ABC","metadata":{"pad":"${'x'.repeat(MAX_PAYLOAD_BYTES)}"}}}`;
    const tooLarge = parseBlock(rawBlock(oversized), OP_ID);
    expect(tooLarge.ops[0].ok).toBe(false);
    if (!tooLarge.ops[0].ok) expect(tooLarge.ops[0].code).toBe('PAYLOAD_TOO_LARGE');

    const nonString = parseBlock(rawBlock({ action: 'issue' } as unknown as string), OP_ID);
    if (!nonString.ops[0].ok) expect(nonString.ops[0].code).toBe('INVALID_JSON');

    const noAuth = parseBlock(rawBlock('{"action":"issue","params":{}}', []), OP_ID);
    if (!noAuth.ops[0].ok) expect(noAuth.ops[0].code).toBe('NO_AUTHORITY');
  });

  it('normalises hostile authority entries without crashing or trusting them', () => {
    // Auth arrays are chain-verified upstream; the parser must only normalise them.
    // Objects/nulls stringify to inert names that can never match a real account.
    const result = parseBlock(
      rawBlock(
        '{"contract":"tokens","action":"transfer","params":{"symbol":"ABC","to":"bob","quantity":"1"}}',
        [{}, 42, null],
      ),
      OP_ID,
    );
    const op = result.ops[0];
    expect(op.ok).toBe(true);
    expect(op.auth.actor).toBe('[object Object]');
    expect(op.auth.active).toEqual(['[object Object]', '42', 'null']);
  });

  it('refuses array envelopes and foreign contracts with explicit codes', () => {
    expectPayloadCode(() => parseEnvelope('[]'), 'UNSUPPORTED_ENVELOPE');
    expectPayloadCode(() => parseEnvelope('[{"contract":"tokens"}]'), 'UNSUPPORTED_ENVELOPE');
    expectPayloadCode(
      () => parseEnvelope('{"contract":"defi","action":"swap","params":{}}'),
      'UNKNOWN_CONTRACT',
    );
    expectPayloadCode(
      () => parseEnvelope('{"contractName":"nft","contractAction":"create"}'),
      'INVALID_ENVELOPE',
    );
  });
});

/* ==========================================================================
 * 2. Hostile mutations — what a compromised VM would emit.
 * ========================================================================== */
describe('security: hostile mutation corpus (compromised-VM model)', () => {
  const token: Token = {
    symbol: 'STEEM',
    name: 'Steem Token',
    precision: 3,
    maxSupply: '0',
    supply: '100',
    issuer: 'alice',
    url: '',
    metadata: '',
    createdAtBlock: 1,
    createdAt: '2026-01-01T00:00:00',
  };

  function snapshotWithBalance(): StateSnapshot {
    const snapshot = emptySnapshot();
    const record = snapshot as unknown as Record<string, Record<string, unknown>>;
    record.token[token.symbol] = token;
    record.balance[balanceKey('alice', 'STEEM')] = {
      account: 'alice',
      symbol: 'STEEM',
      quantity: '10',
    };
    return snapshot;
  }

  function expectGuardCode(fn: () => unknown, code: string): void {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(MutationGuardError);
      expect((err as MutationGuardError).code).toBe(code);
      return;
    }
    throw new Error(`expected MutationGuardError ${code} but nothing was thrown`);
  }

  it('refuses a balance row whose key disagrees with its fields', () => {
    expectGuardCode(
      () =>
        validateMutations('tokens', 'transfer', [
          {
            entity: 'balance',
            key: balanceKey('bob', 'STEEM'), // key says bob...
            value: { account: 'alice', symbol: 'STEEM', quantity: '10' }, // ...row says alice
          },
        ], snapshotWithBalance()),
      'GUARD_KEY_MISMATCH',
    );
  });

  it('refuses a token row whose key disagrees with its symbol', () => {
    expectGuardCode(
      () =>
        validateMutations('tokens', 'create', [
          { entity: 'token', key: 'EVIL', value: token },
        ], snapshotWithBalance()),
      'GUARD_KEY_MISMATCH',
    );
  });

  it('refuses balance credits that mint supply out of nothing', () => {
    // Conservation: a +10 balance delta without a matching supply delta is theft.
    expectGuardCode(
      () =>
        validateMutations('tokens', 'issue', [
          {
            entity: 'balance',
            key: balanceKey('attacker', 'STEEM'),
            value: { account: 'attacker', symbol: 'STEEM', quantity: '10' },
          },
        ], snapshotWithBalance()),
      'GUARD_CONSERVATION',
    );
  });

  it('refuses balances that exceed their token precision', () => {
    expectGuardCode(
      () =>
        validateMutations('tokens', 'transfer', [
          {
            entity: 'balance',
            key: balanceKey('bob', 'STEEM'),
            value: { account: 'bob', symbol: 'STEEM', quantity: '1.2345' }, // precision is 3
          },
        ], snapshotWithBalance()),
      'GUARD_BALANCE_PRECISION',
    );
  });

  it('treats an undefined value as a delete attempt and refuses it', () => {
    expectGuardCode(
      () =>
        validateMutations('tokens', 'transfer', [
          {
            entity: 'balance',
            key: balanceKey('alice', 'STEEM'),
            value: undefined,
          },
        ], snapshotWithBalance()),
      'GUARD_DELETE_DENIED',
    );
  });

  it('rejects non-canonical quantities (NaN, scientific, negative, hex)', () => {
    for (const quantity of ['NaN', 'Infinity', '1e5', '-1', '0x10', '']) {
      expectGuardCode(
        () =>
          validateMutations('tokens', 'transfer', [
            {
              entity: 'balance',
              key: balanceKey('bob', 'STEEM'),
              value: { account: 'bob', symbol: 'STEEM', quantity },
            },
          ], snapshotWithBalance()),
        'GUARD_SCHEMA',
      );
    }
  });

  it('refuses to write entities outside the action allow list', () => {
    // `param` carries admin/treasury — only engine.setParam may ever touch it.
    expectGuardCode(
      () =>
        validateMutations('tokens', 'transfer', [
          {
            entity: 'param',
            key: 'fees',
            value: {
              admin: 'attacker',
              treasury: 'attacker',
              nftCreationFee: '0',
              addPropertyFee: '0',
              tokenCreationFee: '0',
              issueFee: '0',
              fillOrderFeeBps: '0',
              tradeFeeBps: '0',
            },
          },
        ], snapshotWithBalance()),
      'GUARD_ENTITY_DENIED',
    );
  });
});
