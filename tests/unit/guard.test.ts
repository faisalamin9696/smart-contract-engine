import { validateMutations, MutationGuardError } from '../../src/vm/guard';
import {
  emptySnapshot,
  type Collection,
  type Instance,
  type MarketOrder,
  type StateSnapshot,
} from '../../src/types/domain';

const COLLECTION: Collection = {
  symbol: 'HERO',
  name: 'Heroes',
  issuer: 'alice',
  url: '',
  orgName: '',
  productName: '',
  metadata: {},
  maxSupply: '100',
  supply: '5',
  burned: '0',
  circulatingSupply: '5',
  authorizedIssuingAccounts: ['alice'],
  authorizedIssuingContracts: [],
  properties: {
    xp: {
      type: 'number',
      isReadOnly: false,
      authorizedEditingAccounts: ['alice'],
      authorizedEditingContracts: [],
    },
    serial: {
      type: 'string',
      isReadOnly: true,
      authorizedEditingAccounts: ['alice'],
      authorizedEditingContracts: [],
    },
  },
  groupBy: [],
  royaltyBps: '500',
  royaltyRecipient: 'alice',
  createdAtBlock: 1,
  createdAt: '2026-01-01T00:00:00',
};

const INSTANCE: Instance = {
  id: '1',
  symbol: 'HERO',
  seq: 1,
  owner: 'alice',
  properties: { xp: 10 },
  listedOrderId: null,
  previousAccount: null,
  createdAtBlock: 1,
  createdAt: '2026-01-01T00:00:00',
};

const ORDER: MarketOrder = {
  id: 'ORD-00000001',
  symbol: 'HERO',
  instanceId: 'HERO:1',
  seller: 'alice',
  price: '1.000',
  currency: 'STEEM',
  status: 'OPEN',
  royaltyBps: '500',
  royaltyRecipient: 'alice',
  createdAtBlock: 2,
  updatedAtBlock: 2,
  filledAtBlock: null,
  fillBy: null,
  settlement: null,
};

function snapshot(): StateSnapshot {
  return {
    ...emptySnapshot(),
    collection: { HERO: COLLECTION },
    instance: { 'HERO:1': INSTANCE },
    order: { 'ORD-00000001': ORDER },
  };
}

function expectGuardError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MutationGuardError);
    expect((err as MutationGuardError).code).toBe(code);
    return;
  }
  throw new Error(`expected guard error ${code}`);
}

describe('mutation guard', () => {
  it('accepts legitimate mutations', () => {
    const out = validateMutations(
      'transfer',
      [{ entity: 'instance', key: 'HERO:1', value: { ...INSTANCE, owner: 'bob', previousAccount: 'alice' } }],
      snapshot(),
    );
    expect(out).toHaveLength(1);
    expect((out[0] as { value: Instance }).value.owner).toBe('bob');
  });

  it('rejects entities outside the action allow list', () => {
    expectGuardError(
      () =>
        validateMutations(
          'transfer',
          [{ entity: 'collection', key: 'HERO', value: { ...COLLECTION, supply: '99' } }],
          snapshot(),
        ),
      'GUARD_ENTITY_DENIED',
    );
  });

  it('rejects modifications of immutable fields', () => {
    expectGuardError(
      () =>
        validateMutations(
          'setProperties',
          [{ entity: 'instance', key: 'HERO:1', value: { ...INSTANCE, seq: 99 } }],
          snapshot(),
        ),
      'GUARD_IMMUTABLE_FIELD',
    );
    expectGuardError(
      () =>
        validateMutations(
          'issue',
          [{ entity: 'collection', key: 'HERO', value: { ...COLLECTION, maxSupply: '99' } }],
          snapshot(),
        ),
      'GUARD_IMMUTABLE_FIELD',
    );
    expectGuardError(
      () =>
        validateMutations(
          'issue',
          [{ entity: 'collection', key: 'HERO', value: { ...COLLECTION, symbol: 'HEROES' } }],
          snapshot(),
        ),
      'GUARD_IMMUTABLE_FIELD',
    );
  });

  it('allows the wiki-editable collection fields (name/issuer/metadata/issuers)', () => {
    const out = validateMutations(
      'updateName',
      [{ entity: 'collection', key: 'HERO', value: { ...COLLECTION, name: 'New Name' } }],
      snapshot(),
    );
    expect(out).toHaveLength(1);
    const ownership = validateMutations(
      'transferOwnership',
      [{ entity: 'collection', key: 'HERO', value: { ...COLLECTION, issuer: 'bob' } }],
      snapshot(),
    );
    expect(ownership).toHaveLength(1);
  });

  it('rejects schema violations in after-images', () => {
    expectGuardError(
      () =>
        validateMutations(
          'transfer',
          [{ entity: 'instance', key: 'HERO:1', value: { ...INSTANCE, owner: 'NotAnAccount' } }],
          snapshot(),
        ),
      'GUARD_SCHEMA',
    );
    expectGuardError(
      () =>
        validateMutations(
          'setProperties',
          [{ entity: 'instance', key: 'HERO:1', value: { ...INSTANCE, properties: { xp: 1.5 } } }],
          snapshot(),
        ),
      'GUARD_SCHEMA',
    );
  });

  it('validates instance properties against the declared schema', () => {
    // undeclared property
    expectGuardError(
      () =>
        validateMutations(
          'setProperties',
          [{ entity: 'instance', key: 'HERO:1', value: { ...INSTANCE, properties: { mystery: 1 } } }],
          snapshot(),
        ),
      'GUARD_UNKNOWN_PROPERTY',
    );
    // wrong declared type (serial is a string)
    expectGuardError(
      () =>
        validateMutations(
          'setProperties',
          [{ entity: 'instance', key: 'HERO:1', value: { ...INSTANCE, properties: { serial: 42 } } }],
          snapshot(),
        ),
      'GUARD_PROPERTY_TYPE',
    );
    // number property must hold an integer
    expectGuardError(
      () =>
        validateMutations(
          'setProperties',
          [{ entity: 'instance', key: 'HERO:1', value: { ...INSTANCE, properties: { xp: 'lots' } } }],
          snapshot(),
        ),
      'GUARD_PROPERTY_TYPE',
    );
    // read-only property may be set once, never changed again
    const withSerial: Instance = { ...INSTANCE, properties: { xp: 10, serial: 'A-1' } };
    expectGuardError(
      () =>
        validateMutations(
          'setProperties',
          [{ entity: 'instance', key: 'HERO:1', value: { ...withSerial, properties: { xp: 10, serial: 'A-2' } } }],
          { ...snapshot(), instance: { 'HERO:1': withSerial } },
        ),
      'GUARD_READ_ONLY_PROPERTY',
    );
    // the same value twice is a harmless no-op
    expect(
      validateMutations(
        'setProperties',
        [{ entity: 'instance', key: 'HERO:1', value: withSerial }],
        { ...snapshot(), instance: { 'HERO:1': withSerial } },
      ),
    ).toHaveLength(1);
  });

  it('requires a transfer to record the previous holder', () => {
    expectGuardError(
      () =>
        validateMutations(
          'transfer',
          [{ entity: 'instance', key: 'HERO:1', value: { ...INSTANCE, owner: 'bob', previousAccount: null } }],
          snapshot(),
        ),
      'GUARD_PREVIOUS_OWNER',
    );
  });

  it('only allows destroying instances', () => {
    expectGuardError(
      () => validateMutations('cancelOrder', [{ entity: 'order', key: 'ORD-00000001', value: null }], snapshot()),
      'GUARD_DELETE_DENIED',
    );
    expectGuardError(
      () => validateMutations('burn', [{ entity: 'instance', key: 'OTHER:1', value: null }], snapshot()),
      'GUARD_DELETE_UNREAD',
    );
    expectGuardError(
      () =>
        validateMutations(
          'burn',
          [{ entity: 'instance', key: 'HERO:2', value: null }],
          { ...snapshot(), instance: { ...snapshot().instance, 'HERO:2': null } },
        ),
      'GUARD_DELETE_ABSENT',
    );
    // a real burn of a read instance is accepted
    expect(validateMutations('burn', [{ entity: 'instance', key: 'HERO:1', value: null }], snapshot())).toHaveLength(
      1,
    );
  });

  it('keeps supply, burned and circulatingSupply consistent (wiki invariants)', () => {
    // supply = tokens ever issued: it may never decrease (ids would be recycled)
    expectGuardError(
      () =>
        validateMutations(
          'issue',
          [{ entity: 'collection', key: 'HERO', value: { ...COLLECTION, supply: '4' } }],
          snapshot(),
        ),
      'GUARD_SUPPLY_REGRESSION',
    );
    // burned may never decrease
    const alreadyBurnt: Collection = { ...COLLECTION, burned: '2', circulatingSupply: '3' };
    expectGuardError(
      () =>
        validateMutations(
          'burn',
          [{ entity: 'collection', key: 'HERO', value: { ...alreadyBurnt, burned: '1', circulatingSupply: '4' } }],
          { ...snapshot(), collection: { HERO: alreadyBurnt } },
        ),
      'GUARD_BURN_REGRESSION',
    );
    // circulatingSupply must equal supply - burned
    expectGuardError(
      () =>
        validateMutations(
          'burn',
          [
            {
              entity: 'collection',
              key: 'HERO',
              value: { ...COLLECTION, burned: '1', circulatingSupply: '5' },
            },
          ],
          snapshot(),
        ),
      'GUARD_SUPPLY_INVARIANT',
    );
    // a proper burn keeps every counter in step
    const burnt = validateMutations(
      'burn',
      [{ entity: 'collection', key: 'HERO', value: { ...COLLECTION, burned: '1', circulatingSupply: '4' } }],
      snapshot(),
    );
    expect(burnt).toHaveLength(1);
    // issuance increments all three
    const issued = validateMutations(
      'issue',
      [
        {
          entity: 'collection',
          key: 'HERO',
          value: { ...COLLECTION, supply: '6', circulatingSupply: '6' },
        },
      ],
      snapshot(),
    );
    expect(issued).toHaveLength(1);
  });

  it('freezes grouping once set and the property schema once issued', () => {
    const grouped: Collection = { ...COLLECTION, groupBy: ['xp'] };
    expectGuardError(
      () =>
        validateMutations(
          'setGroupBy',
          [{ entity: 'collection', key: 'HERO', value: { ...grouped, groupBy: ['serial'] } }],
          { ...snapshot(), collection: { HERO: grouped } },
        ),
      'GUARD_GROUP_BY_IMMUTABLE',
    );
    expect(
      validateMutations(
        'setGroupBy',
        [{ entity: 'collection', key: 'HERO', value: { ...COLLECTION, groupBy: ['xp'] } }],
        snapshot(),
      ),
    ).toHaveLength(1);

    // definitions may be renamed only while no token has been issued
    const withoutXp = { ...COLLECTION.properties };
    delete withoutXp.xp;
    expectGuardError(
      () =>
        validateMutations(
          'updatePropertyDefinition',
          [{ entity: 'collection', key: 'HERO', value: { ...COLLECTION, properties: withoutXp } }],
          snapshot(),
        ),
      'GUARD_PROPERTY_SCHEMA_FROZEN',
    );
    const virgin: Collection = { ...COLLECTION, supply: '0', circulatingSupply: '0' };
    expect(
      validateMutations(
        'updatePropertyDefinition',
        [{ entity: 'collection', key: 'HERO', value: { ...virgin, properties: withoutXp } }],
        { ...snapshot(), collection: { HERO: virgin } },
      ),
    ).toHaveLength(1);
  });

  it('refuses to mutate orders that already left the OPEN state', () => {
    const filled: MarketOrder = { ...ORDER, status: 'FILLED', fillBy: 'bob', filledAtBlock: 3 };
    expectGuardError(
      () =>
        validateMutations(
          'fillOrder',
          [{ entity: 'order', key: 'ORD-00000001', value: { ...filled, status: 'OPEN', fillBy: null } }],
          { ...snapshot(), order: { 'ORD-00000001': filled } },
        ),
      'GUARD_ORDER_FINAL',
    );
    expectGuardError(
      () =>
        validateMutations(
          'cancelOrder',
          [{ entity: 'order', key: 'ORD-00000001', value: { ...filled, status: 'CANCELLED' } }],
          { ...snapshot(), order: { 'ORD-00000001': filled } },
        ),
      'GUARD_ORDER_FINAL',
    );
  });

  it('caps the number of mutations per operation', () => {
    const many = Array.from({ length: 501 }, () => ({
      entity: 'instance',
      key: 'HERO:1',
      value: INSTANCE,
    }));
    expectGuardError(() => validateMutations('setProperties', many, snapshot()), 'GUARD_TOO_MANY_MUTATIONS');
  });
});
