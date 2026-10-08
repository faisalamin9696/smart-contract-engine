import { parseBlock } from '../../src/chain/opParser';
import { active, buildBlock, commentTx, customJsonTx, posting } from '../helpers/chain';

describe('custom_json block parser', () => {
  const payload = {
    action: 'transfer',
    params: { to: 'bob', nfts: [{ symbol: 'HERO', ids: ['1'] }] },
  };

  it('extracts only operations for the engine op id, preserving order', () => {
    const block = buildBlock({
      height: 100,
      previous: 'f'.repeat(40),
      transactions: [
        commentTx(),
        customJsonTx(payload, active('alice')),
        customJsonTx({ action: 'issue', params: { symbol: 'HERO', to: 'bob' } }, posting('gamekey')),
        customJsonTx(
          { action: 'burn', params: { nfts: [{ symbol: 'HERO', ids: ['1'] }] } },
          active('alice'),
          'other_plugin',
        ),
      ],
    });

    const { ops, skipped } = parseBlock(block, 'sce-mainnet1');
    expect(ops).toHaveLength(2);
    expect(skipped).toBe(2);
    expect(ops.map((o) => (o.ok ? o.action : o.code))).toEqual(['transfer', 'issue']);
    expect(ops[0].auth).toMatchObject({ actor: 'alice', level: 'active' });
    expect(ops[1].auth).toMatchObject({ actor: 'gamekey', level: 'posting' });
    expect(ops[0].opIndex).toBe(0);
    expect(ops[1].opIndex).toBe(0);
    expect(ops[0].txId).toBe(block.transaction_ids?.[1]);
  });

  it('accepts the standard steemsmartcontracts envelope (contractName/contractAction/contractPayload)', () => {
    const block = buildBlock({
      height: 7,
      previous: 'f'.repeat(40),
      transactions: [
        customJsonTx(
          {
            contractName: 'nft',
            contractAction: 'issue',
            contractPayload: { symbol: 'HERO', to: 'bob', feeSymbol: 'STEEM' },
          },
          active('alice'),
        ),
      ],
    });
    const { ops } = parseBlock(block, 'sce-mainnet1');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      ok: true,
      action: 'issue',
      params: { symbol: 'HERO', to: 'bob', feeSymbol: 'STEEM' },
    });
  });

  it('rejects malformed payloads without failing the block', () => {
    const notJson = customJsonTx({}, active('alice'));
    (notJson.operations[0][1] as { json: unknown }).json = '{ not json';
    const badParams = customJsonTx({ action: 'issue', params: { symbol: 'lower' } }, active('alice'));
    const badAction = customJsonTx({ action: 'rugPull', params: {} }, active('alice'));
    const floatProps = customJsonTx(
      { action: 'issue', params: { symbol: 'HERO', to: 'bob', properties: { xp: 1.5 } } },
      active('alice'),
    );
    const noAuth = customJsonTx(payload, { active: [], posting: [], actor: '', level: 'none' });

    const block = buildBlock({
      height: 1,
      previous: 'f'.repeat(40),
      transactions: [notJson, badParams, badAction, floatProps, noAuth],
    });

    const { ops } = parseBlock(block, 'sce-mainnet1');
    expect(ops).toHaveLength(5);
    expect(ops.every((o) => !o.ok)).toBe(true);
    expect(ops.map((o) => (o as { code: string }).code)).toEqual([
      'INVALID_JSON',
      'INVALID_PARAMS',
      'INVALID_ENVELOPE',
      'INVALID_PARAMS',
      'NO_AUTHORITY',
    ]);
  });

  it('explains unsupported and foreign contracts explicitly', () => {
    const foreign = customJsonTx(
      { contractName: 'tokensx', contractAction: 'transfer', contractPayload: {} },
      active('alice'),
    );
    const missingField = customJsonTx({ contractName: 'nft', contractAction: 'issue' }, active('alice'));
    const callArray = customJsonTx(
      { contractName: 'nft', contractAction: 'issue', contractPayload: {} },
      active('alice'),
    );
    (callArray.operations[0][1] as { json: unknown }).json = JSON.stringify([
      { contractName: 'nft', contractAction: 'issue', contractPayload: {} },
    ]);
    const delegation = customJsonTx(
      { action: 'delegate', params: { symbol: 'HERO', to: 'bob', qty: '1' } },
      active('alice'),
    );
    const legacy = customJsonTx({ action: 'mint', params: { symbol: 'HERO', to: 'bob' } }, active('alice'));

    const block = buildBlock({
      height: 2,
      previous: 'f'.repeat(40),
      transactions: [foreign, missingField, callArray, delegation, legacy],
    });
    const { ops } = parseBlock(block, 'sce-mainnet1');
    expect(ops.map((o) => (o as { code: string }).code)).toEqual([
      'UNKNOWN_CONTRACT',
      'INVALID_ENVELOPE',
      'UNSUPPORTED_ENVELOPE',
      'ACTION_UNSUPPORTED',
      'ACTION_UNSUPPORTED',
    ]);
    expect((ops[4] as { message: string }).message).toContain('renamed to "issue"');
  });

  it('multiplexes the tokens contract over the same op id (standard + shorthand)', () => {
    const standard = customJsonTx(
      {
        contractName: 'tokens',
        contractAction: 'transfer',
        contractPayload: { symbol: 'SCE', to: 'bob', quantity: '5' },
      },
      active('alice'),
    );
    const shorthand = customJsonTx(
      // feeSymbol stays accepted (it becomes real with the fee engine, step 3).
      { action: 'issue', params: { symbol: 'SCE', to: 'bob', quantity: '5', feeSymbol: 'SCE' }, contract: 'tokens' },
      active('alice'),
    );
    const defaultNft = customJsonTx(
      { action: 'transfer', params: { to: 'bob', nfts: [{ symbol: 'HERO', ids: ['1'] }] } },
      active('alice'),
    );

    const block = buildBlock({
      height: 3,
      previous: 'f'.repeat(40),
      transactions: [standard, shorthand, defaultNft],
    });
    const { ops } = parseBlock(block, 'sce-mainnet1');
    expect(ops.map((o) => (o.ok ? `${o.contract}.${o.action}` : o.code))).toEqual([
      'tokens.transfer',
      'tokens.issue',
      'nft.transfer',
    ]);
  });

  it('resolves shared action names per contract and rejects foreign pairings', () => {
    const tokensCreate = customJsonTx(
      {
        contractName: 'tokens',
        contractAction: 'create',
        contractPayload: { symbol: 'SCE', name: 'Smart Contract Engine', precision: 3 },
      },
      active('steempro.com'),
    );
    // `updatePrecision` exists only on `tokens` — not on `nft`.
    const nftUpdatePrecision = customJsonTx(
      { contractName: 'nft', contractAction: 'updatePrecision', contractPayload: { symbol: 'HERO' } },
      active('alice'),
    );
    // `addProperty` exists only on `nft` — not on `tokens`.
    const tokensAddProperty = customJsonTx(
      { contractName: 'tokens', contractAction: 'addProperty', contractPayload: { symbol: 'SCE' } },
      active('alice'),
    );
    // Shorthand without `contract` defaults to `nft`, so a tokens-shaped payload fails there.
    const ambiguousShorthand = customJsonTx(
      { action: 'create', params: { symbol: 'SCE', name: 'Smart Contract Engine', precision: 3 } },
      active('alice'),
    );
    const badContractField = customJsonTx(
      { action: 'create', params: { symbol: 'SCE', name: 'x', precision: 3 }, contract: 'market' },
      active('alice'),
    );

    const block = buildBlock({
      height: 4,
      previous: 'f'.repeat(40),
      transactions: [tokensCreate, nftUpdatePrecision, tokensAddProperty, ambiguousShorthand, badContractField],
    });
    const { ops } = parseBlock(block, 'sce-mainnet1');
    expect(ops[0]).toMatchObject({
      ok: true,
      contract: 'tokens',
      action: 'create',
      params: { symbol: 'SCE', precision: 3 },
    });
    expect(ops[1]).toMatchObject({ ok: false, code: 'INVALID_ENVELOPE' });
    expect((ops[1] as { message: string }).message).toContain('for contract "nft"');
    expect(ops[2]).toMatchObject({ ok: false, code: 'INVALID_ENVELOPE' });
    expect((ops[2] as { message: string }).message).toContain('for contract "tokens"');
    expect(ops[3]).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(ops[4]).toMatchObject({ ok: false, code: 'UNKNOWN_CONTRACT' });
  });

  it('multiplexes the engine contract (setParam) and validates its payload', () => {
    const valid = customJsonTx(
      { contractName: 'engine', contractAction: 'setParam', contractPayload: { fees: { nftCreationFee: '20' } } },
      active('steempro.com'),
    );
    // admin/treasury are immutable — the strict payload schema rejects them outright.
    const withAdmin = customJsonTx(
      {
        contractName: 'engine',
        contractAction: 'setParam',
        contractPayload: { fees: { nftCreationFee: '20' }, admin: 'bob' },
      },
      active('steempro.com'),
    );
    const emptyPatch = customJsonTx(
      { contractName: 'engine', contractAction: 'setParam', contractPayload: {} },
      active('steempro.com'),
    );
    // `create` does not exist on the engine contract.
    const foreignAction = customJsonTx(
      { contractName: 'engine', contractAction: 'create', contractPayload: { symbol: 'HERO', name: 'x' } },
      active('alice'),
    );

    const block = buildBlock({
      height: 5,
      previous: 'f'.repeat(40),
      transactions: [valid, withAdmin, emptyPatch, foreignAction],
    });
    const { ops } = parseBlock(block, 'sce-mainnet1');
    expect(ops[0]).toMatchObject({
      ok: true,
      contract: 'engine',
      action: 'setParam',
      params: { fees: { nftCreationFee: '20' } },
    });
    expect(ops[1]).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(ops[2]).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(ops[3]).toMatchObject({ ok: false, code: 'INVALID_ENVELOPE' });
  });

  it('flags oversized payloads before parsing them', () => {
    const huge = customJsonTx({ action: 'issue', params: {} }, active('alice'));
    (huge.operations[0][1] as { json: string }).json = JSON.stringify({
      action: 'issue',
      params: { note: 'x'.repeat(20000) },
    });
    const block = buildBlock({ height: 1, previous: 'f'.repeat(40), transactions: [huge] });
    const { ops } = parseBlock(block, 'sce-mainnet1');
    expect(ops[0]).toMatchObject({ ok: false, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('keeps multi-operation transactions ordered by op index', () => {
    const tx = {
      operations: [
        ['vote', { voter: 'a' }],
        [
          'custom_json',
          {
            id: 'sce-mainnet1',
            json: JSON.stringify(payload),
            required_auths: ['alice'],
            required_posting_auths: [],
          },
        ],
        [
          'custom_json',
          {
            id: 'sce-mainnet1',
            json: JSON.stringify({
              action: 'burn',
              params: { nfts: [{ symbol: 'HERO', ids: ['1'] }] },
            }),
            required_auths: [],
            required_posting_auths: ['alice'],
          },
        ],
      ],
    };
    const block = buildBlock({ height: 5, previous: 'f'.repeat(40), transactions: [tx as never] });
    const { ops } = parseBlock(block, 'sce-mainnet1');
    expect(ops.map((o) => o.opIndex)).toEqual([1, 2]);
    expect(ops.map((o) => (o.ok ? o.action : '?'))).toEqual(['transfer', 'burn']);
  });
});
