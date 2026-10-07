import { TestEngine } from '../helpers/engine';
import { active, posting } from '../helpers/chain';

/**
 * End-to-end action semantics against the wiki's `nft` contract
 * (https://github.com/hive-engine/steemsmartcontracts-wiki/blob/master/NFT-Contracts.md):
 * every action, its authorization rules, the numeric id derivation, the typed data
 * property schema and the marketplace royalty split.
 */
describe('contract actions', () => {
  let engine: TestEngine;

  beforeAll(async () => {
    engine = await TestEngine.create();
  });

  afterAll(async () => {
    await engine.dispose();
  });

  const createKnightCollection = () =>
    engine.execOk(
      'create',
      {
        symbol: 'KNIGHT',
        name: 'Steem Knights',
        maxSupply: '100',
        authorizedIssuingAccounts: ['gamekey'],
        royaltyBps: '750',
      },
      active('alice'),
      { height: 10 },
    );

  /* ------------------------------------------------------------- creation */

  it('creates a collection with wiki fields, royalties and default issuer list', async () => {
    await createKnightCollection();
    const collection = await engine.collection('KNIGHT');

    expect(collection).not.toBeNull();
    expect(collection).toMatchObject({
      issuer: 'alice',
      name: 'Steem Knights',
      maxSupply: '100',
      supply: '0',
      burned: '0',
      circulatingSupply: '0',
      royaltyBps: '750',
      royaltyRecipient: 'alice',
      url: '',
      orgName: '',
      productName: '',
      metadata: {},
      properties: {},
      groupBy: [],
      createdAtBlock: 10,
      createdAt: '2026-01-01T00:00:00',
    });
    // the requested list is stored verbatim; the owner may always issue (wiki default)
    expect(collection?.authorizedIssuingAccounts).toEqual(['gamekey']);
  });

  it('rejects duplicate collections and non-active authority', async () => {
    const duplicate = await engine.execFail('create', { symbol: 'KNIGHT', name: 'dup' }, active('bob'));
    expect(duplicate.log.error?.code).toBe('COLLECTION_EXISTS');

    const noActive = await engine.execFail('create', { symbol: 'SHIELD', name: 'Shields' }, posting('carol'));
    expect(noActive.log.error?.code).toBe('ACTIVE_AUTH_REQUIRED');
  });

  it('accepts wiki convenience fields on create (url, orgName, productName, maxSupply)', async () => {
    await engine.execOk(
      'create',
      {
        symbol: 'CROWN',
        name: 'Crowns',
        url: 'https://example.com/crown',
        orgName: 'SteemPro',
        productName: 'Crowns S1',
        maxSupply: '10',
      },
      active('alice'),
      { height: 11 },
    );
    expect(await engine.collection('CROWN')).toMatchObject({
      url: 'https://example.com/crown',
      orgName: 'SteemPro',
      productName: 'Crowns S1',
      maxSupply: '10',
      authorizedIssuingAccounts: ['alice'],
    });
  });

  /* ------------------------------------------------------- property schema */

  it('declares typed data properties through addProperty', async () => {
    await engine.execOk(
      'addProperty',
      { symbol: 'KNIGHT', name: 'level', type: 'number' },
      active('alice'),
      { height: 12 },
    );
    await engine.execOk(
      'addProperty',
      { symbol: 'KNIGHT', name: 'xp', type: 'number', authorizedEditingAccounts: ['gamekey'] },
      active('alice'),
      { height: 12 },
    );
    await engine.execOk(
      'addProperty',
      { symbol: 'KNIGHT', name: 'serial', type: 'string', isReadOnly: true },
      active('alice'),
      { height: 12 },
    );

    const collection = await engine.collection('KNIGHT');
    expect(collection?.properties).toEqual({
      level: {
        type: 'number',
        isReadOnly: false,
        // default editing list is the NFT owner (wiki default)
        authorizedEditingAccounts: ['alice'],
        authorizedEditingContracts: [],
      },
      xp: {
        type: 'number',
        isReadOnly: false,
        authorizedEditingAccounts: ['gamekey'],
        authorizedEditingContracts: [],
      },
      serial: {
        type: 'string',
        isReadOnly: true,
        authorizedEditingAccounts: ['alice'],
        authorizedEditingContracts: [],
      },
    });

    const duplicate = await engine.execFail(
      'addProperty',
      { symbol: 'KNIGHT', name: 'xp', type: 'string' },
      active('alice'),
    );
    expect(duplicate.log.error?.code).toBe('PROPERTY_EXISTS');

    const byStranger = await engine.execFail(
      'addProperty',
      { symbol: 'KNIGHT', name: 'mana', type: 'number' },
      active('mallory'),
    );
    expect(byStranger.log.error?.code).toBe('NOT_AUTHORIZED');
  });

  /* -------------------------------------------------------------- issuance */

  it('issues tokens with sequential numeric wiki ids and updates supply counters', async () => {
    await engine.execOk(
      'issue',
      { symbol: 'KNIGHT', to: 'dave', properties: { level: 1 } },
      active('gamekey'),
      { height: 13 },
    );
    await engine.execOk(
      'issueMultiple',
      {
        instances: [
          { symbol: 'KNIGHT', to: 'dave' },
          { symbol: 'KNIGHT', to: 'erin', properties: { level: 3, xp: 10 } },
        ],
      },
      active('gamekey'),
      { height: 14 },
    );

    // wiki ids are plain numbers scoped to the symbol
    expect(await engine.instance('1', 'KNIGHT')).toMatchObject({
      id: '1',
      seq: 1,
      symbol: 'KNIGHT',
      owner: 'dave',
      properties: { level: 1 },
    });
    expect(await engine.instance('2', 'KNIGHT')).toMatchObject({ owner: 'dave', seq: 2 });
    expect(await engine.instance('3', 'KNIGHT')).toMatchObject({ owner: 'erin', seq: 3, properties: { level: 3, xp: 10 } });
    // composite reference works too
    expect(await engine.instance('KNIGHT:3')).toMatchObject({ owner: 'erin' });

    expect(await engine.collection('KNIGHT')).toMatchObject({
      supply: '3',
      burned: '0',
      circulatingSupply: '3',
    });
  });

  it('only the owner or an authorized issuer may issue', async () => {
    const outcome = await engine.execFail('issue', { symbol: 'KNIGHT', to: 'mallory' }, active('mallory'));
    expect(outcome.log.error?.code).toBe('NOT_AUTHORIZED');
    expect(await engine.collection('KNIGHT')).toMatchObject({ supply: '3' });

    // the owner is always an issuer even though the list contains only gamekey
    await engine.execOk('issue', { symbol: 'KNIGHT', to: 'frank' }, active('alice'), { height: 15 });
    expect(await engine.instance('4', 'KNIGHT')).toMatchObject({ owner: 'frank' });
    // ... and issuance requires the active key
    const viaPosting = await engine.execFail('issue', { symbol: 'KNIGHT', to: 'mallory' }, posting('alice'));
    expect(viaPosting.log.error?.code).toBe('NOT_AUTHORIZED');
  });

  it('reports each bad entry of issueMultiple individually (wiki: not all-or-nothing)', async () => {
    const outcome = await engine.execOk(
      'issueMultiple',
      {
        instances: [
          { symbol: 'KNIGHT', to: 'gina' },
          { symbol: 'NOPE', to: 'gina' }, // unknown collection
          { symbol: 'KNIGHT', to: 'gina', properties: { unknownProp: 1 } },
        ],
      },
      active('gamekey'),
      { height: 16 },
    );
    expect(outcome.applied).toBe(true);
    const failed = outcome.events.filter((e) => e.type === 'ITEM_FAILED');
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ data: { index: 1, code: 'COLLECTION_NOT_FOUND' } });
    expect(failed[1]).toMatchObject({ data: { index: 2, code: 'UNKNOWN_PROPERTY' } });
    // only the valid entry issued: id 5
    expect(await engine.instance('5', 'KNIGHT')).toMatchObject({ owner: 'gina' });
    expect(await engine.collection('KNIGHT')).toMatchObject({ supply: '5' });
  });

  it('enforces maxSupply against the tokens ever issued', async () => {
    const tiny = await TestEngine.create();
    await tiny.execOk('create', { symbol: 'TINY', name: 'Tiny', maxSupply: '2' }, active('alice'));
    await tiny.execOk('issue', { symbol: 'TINY', to: 'bob' }, active('alice'));
    await tiny.execOk('issue', { symbol: 'TINY', to: 'bob' }, active('alice'));
    const overflow = await tiny.execFail('issue', { symbol: 'TINY', to: 'bob' }, active('alice'));
    expect(overflow.log.error?.code).toBe('MAX_SUPPLY_REACHED');
    await tiny.dispose();
  });

  /* ------------------------------------------------------------- transfer */

  it('transfers in wiki batches with active authority and records the previous holder', async () => {
    const stolen = await engine.execFail(
      'transfer',
      { to: 'mallory', nfts: [{ symbol: 'KNIGHT', ids: ['1'] }] },
      active('mallory'),
    );
    expect(stolen.log.error?.code).toBe('NOT_AUTHORIZED');

    const toSelf = await engine.execFail(
      'transfer',
      { to: 'dave', nfts: [{ symbol: 'KNIGHT', ids: ['1'] }] },
      active('dave'),
    );
    expect(toSelf.log.error?.code).toBe('SAME_OWNER');

    // wiki: transfer requires the ACTIVE key (posting is not enough)
    const viaPosting = await engine.execFail(
      'transfer',
      { to: 'frank', nfts: [{ symbol: 'KNIGHT', ids: ['1'] }] },
      posting('dave'),
    );
    expect(viaPosting.log.error?.code).toBe('NOT_AUTHORIZED');

    await engine.execOk(
      'transfer',
      { to: 'frank', nfts: [{ symbol: 'KNIGHT', ids: ['1'] }] },
      active('dave'),
      { height: 20 },
    );
    expect(await engine.instance('1', 'KNIGHT')).toMatchObject({
      owner: 'frank',
      previousAccount: 'dave',
    });
  });

  it('refuses transferring to null (the wiki says: use burn) and caps batch size', async () => {
    const toNull = await engine.execFail(
      'transfer',
      { to: 'null', nfts: [{ symbol: 'KNIGHT', ids: ['1'] }] },
      active('frank'),
    );
    expect(toNull.log.error?.code).toBe('USE_BURN');

    const tooBig = await engine.execFail(
      'transfer',
      {
        to: 'frank',
        nfts: [{ symbol: 'KNIGHT', ids: Array.from({ length: 51 }, (_, i) => String(i + 1)) }],
      },
      active('dave'),
    );
    expect(tooBig.log.error?.code).toBe('BATCH_TOO_LARGE');
  });

  /* --------------------------------------------------------- setProperties */

  it('edits declared properties only, honouring per-property permissions', async () => {
    const unauthorized = await engine.execFail(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { xp: 999 } }] },
      active('frank'),
    );
    expect(unauthorized.log.error?.code).toBe('NOT_AUTHORIZED');

    await engine.execOk(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { xp: 250 } }] },
      active('gamekey'),
      { height: 21 },
    );
    // active is not required for property edits (wiki: requires active key: no)
    await engine.execOk(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { xp: 300 } }] },
      posting('gamekey'),
      { height: 22 },
    );
    // `level` defaults to the owner's editing list — gamekey is not on it
    const wrongEditor = await engine.execFail(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { level: 9 } }] },
      active('gamekey'),
    );
    expect(wrongEditor.log.error?.code).toBe('NOT_AUTHORIZED');
    await engine.execOk(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { level: 4 } }] },
      active('alice'),
      { height: 23 },
    );
    expect(await engine.instance('3', 'KNIGHT')).toMatchObject({ properties: { level: 4, xp: 300 } });

    const undeclared = await engine.execFail(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { mystery: 1 } }] },
      active('gamekey'),
    );
    expect(undeclared.log.error?.code).toBe('UNKNOWN_PROPERTY');
  });

  it('rejects floating point property values (determinism rule)', async () => {
    const outcome = await engine.execFail(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { xp: 1.5 } }] },
      active('gamekey'),
    );
    expect(outcome.log.error?.code).toBe('FLOAT_FORBIDDEN');
  });

  it('freezes isReadOnly properties after their first set (wiki: exactly one time)', async () => {
    // not set yet: the first write is allowed, whoever is on the editing list
    await engine.execOk(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { serial: 'A-1' } }] },
      active('alice'),
      { height: 24 },
    );
    const second = await engine.execFail(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { serial: 'A-2' } }] },
      active('alice'),
    );
    expect(second.log.error?.code).toBe('READ_ONLY_PROPERTY');
    expect(await engine.instance('3', 'KNIGHT')).toMatchObject({ properties: { serial: 'A-1' } });
  });

  it('rejects wrong declared types for typed properties', async () => {
    const wrongType = await engine.execFail(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { level: 'high' } }] },
      active('alice'),
    );
    expect(wrongType.log.error?.code).toBe('BAD_PROPERTY_TYPE');

    // a number property also accepts integer strings (wiki example)
    await engine.execOk(
      'setProperties',
      { symbol: 'KNIGHT', nfts: [{ id: '3', properties: { level: '7' } }] },
      active('alice'),
      { height: 25 },
    );
    expect(await engine.instance('3', 'KNIGHT')).toMatchObject({ properties: { level: 7 } });
  });

  /* ------------------------------------------------------------------ burn */

  it('burns only what the holder signs for, and keeps supply as "issued to date"', async () => {
    const byStranger = await engine.execFail(
      'burn',
      { nfts: [{ symbol: 'KNIGHT', ids: ['2'] }] },
      active('mallory'),
    );
    expect(byStranger.log.error?.code).toBe('NOT_AUTHORIZED');

    const outcome = await engine.execOk(
      'burn',
      { nfts: [{ symbol: 'KNIGHT', ids: ['2'] }] },
      active('dave'),
      { height: 30 },
    );
    expect(outcome.events.some((e) => e.type === 'NFT_BURNED')).toBe(true);
    expect(await engine.instance('2', 'KNIGHT')).toBeNull();
    // supply counts tokens ever issued and never decreases; only circulatingSupply drops
    expect(await engine.collection('KNIGHT')).toMatchObject({
      supply: '5',
      burned: '1',
      circulatingSupply: '4',
    });
  });

  it('never re-uses ids of burned instances (id = supply + 1)', async () => {
    await engine.execOk('issue', { symbol: 'KNIGHT', to: 'gina' }, active('gamekey'), { height: 31 });
    // supply was 5 -> the next id is 6, even though ids 2 was burned
    expect(await engine.instance('6', 'KNIGHT')).toMatchObject({ owner: 'gina', seq: 6 });
    expect(await engine.instance('2', 'KNIGHT')).toBeNull();
  });

  /* -------------------------------------------- metadata & issuer management */

  it('updates url/metadata/name only as the NFT owner', async () => {
    const byStranger = await engine.execFail(
      'updateUrl',
      { symbol: 'KNIGHT', url: 'https://evil.example' },
      active('mallory'),
    );
    expect(byStranger.log.error?.code).toBe('NOT_AUTHORIZED');

    // active is not required for metadata (wiki: requires active key: no)
    await engine.execOk(
      'updateUrl',
      { symbol: 'KNIGHT', url: 'https://example.com/knights' },
      posting('alice'),
      { height: 32 },
    );
    await engine.execOk(
      'updateMetadata',
      { symbol: 'KNIGHT', metadata: { description: 'Steem Knights', icon: 'shield.png' } },
      active('alice'),
      { height: 32 },
    );
    await engine.execOk(
      'updateName',
      { symbol: 'KNIGHT', name: 'Steem Knights Redux' },
      active('alice'),
      { height: 32 },
    );
    await engine.execOk('updateOrgName', { symbol: 'KNIGHT', orgName: 'SteemPro' }, active('alice'), {
      height: 32,
    });
    await engine.execOk('updateProductName', { symbol: 'KNIGHT', productName: 'Knights' }, active('alice'), {
      height: 32,
    });

    expect(await engine.collection('KNIGHT')).toMatchObject({
      url: 'https://example.com/knights',
      metadata: { description: 'Steem Knights', icon: 'shield.png' },
      name: 'Steem Knights Redux',
      orgName: 'SteemPro',
      productName: 'Knights',
    });
  });

  it('manages the authorized issuer list with active authority only', async () => {
    const viaPosting = await engine.execFail(
      'addAuthorizedIssuingAccounts',
      { symbol: 'KNIGHT', accounts: ['gamekey2'] },
      posting('alice'),
    );
    expect(viaPosting.log.error?.code).toBe('NOT_AUTHORIZED');

    await engine.execOk(
      'addAuthorizedIssuingAccounts',
      { symbol: 'KNIGHT', accounts: ['gamekey2'] },
      active('alice'),
      { height: 33 },
    );
    expect(await engine.collection('KNIGHT')).toMatchObject({
      authorizedIssuingAccounts: ['gamekey', 'gamekey2'],
    });

    // the new issuer can actually issue
    await engine.execOk('issue', { symbol: 'KNIGHT', to: 'hank' }, active('gamekey2'), { height: 34 });
    expect(await engine.instance('7', 'KNIGHT')).toMatchObject({ owner: 'hank' });

    await engine.execOk(
      'removeAuthorizedIssuingAccounts',
      { symbol: 'KNIGHT', accounts: ['gamekey'] },
      active('alice'),
      { height: 35 },
    );
    expect(await engine.collection('KNIGHT')).toMatchObject({ authorizedIssuingAccounts: ['gamekey2'] });
    const revoked = await engine.execFail('issue', { symbol: 'KNIGHT', to: 'mallory' }, active('gamekey'));
    expect(revoked.log.error?.code).toBe('NOT_AUTHORIZED');
  });

  /* ------------------------------------------------------------ grouping */

  it('sets the market grouping exactly once (wiki setGroupBy)', async () => {
    await engine.execOk(
      'setGroupBy',
      { symbol: 'KNIGHT', properties: ['level', 'xp'] },
      active('alice'),
      { height: 36 },
    );
    expect(await engine.collection('KNIGHT')).toMatchObject({ groupBy: ['level', 'xp'] });

    const again = await engine.execFail(
      'setGroupBy',
      { symbol: 'KNIGHT', properties: ['serial'] },
      active('alice'),
    );
    expect(again.log.error?.code).toBe('GROUP_BY_ALREADY_SET');

    const unknown = await engine.execFail(
      'setGroupBy',
      { symbol: 'CROWN', properties: ['nope'] },
      active('alice'),
    );
    expect(unknown.log.error?.code).toBe('UNKNOWN_PROPERTY');
  });

  it('locks property definitions once a token has been issued (wiki updatePropertyDefinition)', async () => {
    await engine.execOk('addProperty', { symbol: 'CROWN', name: 'tier', type: 'string' }, active('alice'), {
      height: 37,
    });
    // rename while supply is 0: allowed
    await engine.execOk(
      'updatePropertyDefinition',
      { symbol: 'CROWN', name: 'tier', newName: 'grade', type: 'string' },
      active('alice'),
      { height: 38 },
    );
    expect((await engine.collection('CROWN'))?.properties).toHaveProperty('grade');

    await engine.execOk('issue', { symbol: 'CROWN', to: 'erin' }, active('alice'), { height: 39 });
    const locked = await engine.execFail(
      'updatePropertyDefinition',
      { symbol: 'CROWN', name: 'grade', newName: 'rank' },
      active('alice'),
    );
    expect(locked.log.error?.code).toBe('PROPERTY_DEFINITION_LOCKED');

    // permissions remain editable after issuance
    await engine.execOk(
      'setPropertyPermissions',
      { symbol: 'CROWN', name: 'grade', accounts: ['erin'] },
      active('alice'),
      { height: 40 },
    );
    expect((await engine.collection('CROWN'))?.properties.grade).toMatchObject({
      authorizedEditingAccounts: ['erin'],
    });
  });

  /* ---------------------------------------------------- ownership transfer */

  it('transfers collection ownership with active authority (wiki transferOwnership)', async () => {
    const viaPosting = await engine.execFail(
      'transferOwnership',
      { symbol: 'KNIGHT', to: 'frank' },
      posting('alice'),
    );
    expect(viaPosting.log.error?.code).toBe('NOT_AUTHORIZED');

    await engine.execOk('transferOwnership', { symbol: 'KNIGHT', to: 'bob' }, active('alice'), {
      height: 41,
    });
    expect(await engine.collection('KNIGHT')).toMatchObject({ issuer: 'bob' });

    // the previous owner lost control, the new one gained it
    const oldOwner = await engine.execFail('addProperty', { symbol: 'KNIGHT', name: 'luck', type: 'number' }, active('alice'));
    expect(oldOwner.log.error?.code).toBe('NOT_AUTHORIZED');
    await engine.execOk('addProperty', { symbol: 'KNIGHT', name: 'luck', type: 'number' }, active('bob'), {
      height: 42,
    });
    // bob can issue without being on the authorized list
    expect((await engine.collection('KNIGHT'))?.authorizedIssuingAccounts).toEqual(['gamekey2']);
  });
});
