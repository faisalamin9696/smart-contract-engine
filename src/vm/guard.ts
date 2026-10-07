import { ACTION_ENTITY_ALLOWLIST, type ActionName } from '../types/actions';
import {
  parseEntityValue,
  type Collection,
  type EntityKind,
  type Instance,
  type JsonValue,
  type MarketOrder,
  type Mutation,
  type PropertyDefinition,
  type StateSnapshot,
} from '../types/domain';
import { deepEqual } from '../utils/canonical';

export class MutationGuardError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MutationGuardError';
  }
}

/**
 * Fields the contract may never change once an entity exists.
 *
 * Deliberately *not* listed for collections: `name`, `issuer`, `url`, `orgName`,
 * `productName`, `metadata`, `authorizedIssuing*` and `properties` are all editable by
 * their wiki actions (`updateName`, `transferOwnership`, `updateMetadata`,
 * `add/removeAuthorizedIssuing*`, `addProperty`/`setPropertyPermissions`/...); they are
 * guarded instead by the semantic invariants below.
 */
const IMMUTABLE_FIELDS: Record<EntityKind, readonly string[]> = {
  collection: [
    'symbol',
    'maxSupply',
    'royaltyBps',
    'royaltyRecipient',
    'createdAtBlock',
    'createdAt',
  ],
  instance: ['id', 'symbol', 'seq', 'createdAtBlock', 'createdAt'],
  account: ['name', 'createdAtBlock', 'createdAt'],
  order: [
    'id',
    'symbol',
    'instanceId',
    'seller',
    'price',
    'currency',
    'royaltyBps',
    'royaltyRecipient',
    'createdAtBlock',
  ],
  meta: [],
};

const MAX_MUTATIONS_PER_OP = 500;
const MAX_SAFE_INT = 9007199254740991;
const MAX_PROP_STRING = 100;

function assertImmutableFields(entity: EntityKind, before: JsonValue, after: JsonValue): void {
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  for (const field of IMMUTABLE_FIELDS[entity]) {
    if (!deepEqual(b[field], a[field])) {
      throw new MutationGuardError(
        'GUARD_IMMUTABLE_FIELD',
        `${entity} field '${field}' may not be modified (before=${JSON.stringify(b[field])}, after=${JSON.stringify(a[field])})`,
      );
    }
  }
}

/**
 * Wiki invariants for the `nfts` table:
 *  - `supply` counts tokens ever issued and may never decrease (it is also the id
 *    sequence, so a regression would recycle ids);
 *  - `burned` may never decrease;
 *  - `circulatingSupply` is always `supply - burned`;
 *  - `groupBy` may be set exactly once;
 *  - property definitions may be renamed only while no token has been issued.
 */
function assertCollectionInvariants(before: JsonValue, after: JsonValue): void {
  const b = before as unknown as Collection;
  const a = after as unknown as Collection;

  if (BigInt(a.supply) < BigInt(b.supply)) {
    throw new MutationGuardError(
      'GUARD_SUPPLY_REGRESSION',
      `supply (tokens ever issued) may not decrease: ${b.supply} -> ${a.supply}`,
    );
  }
  if (BigInt(a.burned) < BigInt(b.burned)) {
    throw new MutationGuardError(
      'GUARD_BURN_REGRESSION',
      `burned may not decrease: ${b.burned} -> ${a.burned}`,
    );
  }
  const expected = BigInt(a.supply) - BigInt(a.burned);
  if (BigInt(a.circulatingSupply) !== expected) {
    throw new MutationGuardError(
      'GUARD_SUPPLY_INVARIANT',
      `circulatingSupply must equal supply - burned (expected ${expected}, got ${a.circulatingSupply})`,
    );
  }

  if (b.groupBy.length > 0 && !deepEqual(a.groupBy, b.groupBy)) {
    throw new MutationGuardError(
      'GUARD_GROUP_BY_IMMUTABLE',
      `grouping may only be set once (before=${JSON.stringify(b.groupBy)}, after=${JSON.stringify(a.groupBy)})`,
    );
  }

  // Definitions may be renamed/retyped only before the first issuance (wiki
  // `updatePropertyDefinition`); afterwards the key set may only grow.
  if (b.supply !== '0') {
    for (const key of Object.keys(b.properties)) {
      if (!Object.prototype.hasOwnProperty.call(a.properties, key)) {
        throw new MutationGuardError(
          'GUARD_PROPERTY_SCHEMA_FROZEN',
          `property definition '${key}' may not be removed once supply is ${b.supply}`,
        );
      }
    }
  }
}

function assertPropertyValueType(def: PropertyDefinition, value: unknown, name: string): void {
  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new MutationGuardError('GUARD_PROPERTY_TYPE', `property '${name}' must be boolean`);
    }
    return;
  }
  if (def.type === 'string') {
    if (typeof value !== 'string' || value.length > MAX_PROP_STRING) {
      throw new MutationGuardError(
        'GUARD_PROPERTY_TYPE',
        `property '${name}' must be a string of at most ${MAX_PROP_STRING} characters`,
      );
    }
    return;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    Math.abs(value) > MAX_SAFE_INT
  ) {
    throw new MutationGuardError(
      'GUARD_PROPERTY_TYPE',
      `property '${name}' must be an integer (floats are forbidden for determinism)`,
    );
  }
}

/**
 * Instance-level invariants: every property must exist in the collection's declared
 * schema and carry the declared type, read-only properties freeze after their first set,
 * and a transfer must record the previous holder.
 *
 * Needs the collection that the snapshot always prefetches alongside its instances
 * (instance -> collection edge); if it is absent the structural checks are skipped —
 * schema validation still applies.
 */
function assertInstanceInvariants(
  before: JsonValue | undefined,
  after: Instance,
  snapshot: StateSnapshot,
): void {
  const collection = snapshot.collection[after.symbol] as Collection | null | undefined;
  if (collection === null || collection === undefined) return;

  for (const [name, value] of Object.entries(after.properties)) {
    const def = collection.properties[name];
    if (def === undefined) {
      throw new MutationGuardError(
        'GUARD_UNKNOWN_PROPERTY',
        `instance ${after.symbol}:${after.id} carries property '${name}' which is not declared on ${after.symbol}`,
      );
    }
    assertPropertyValueType(def, value, name);
    if (def.isReadOnly) {
      const bProps =
        before === undefined || before === null ? null : (before as Instance).properties;
      if (bProps !== null && Object.prototype.hasOwnProperty.call(bProps, name)) {
        if (!deepEqual(bProps[name], value)) {
          throw new MutationGuardError(
            'GUARD_READ_ONLY_PROPERTY',
            `property '${name}' is read-only once set and may not change again`,
          );
        }
      }
    }
  }

  if (before !== undefined && before !== null) {
    const b = before as unknown as Instance;
    if (b.owner !== after.owner && after.previousAccount !== b.owner) {
      throw new MutationGuardError(
        'GUARD_PREVIOUS_OWNER',
        `changing the owner of ${after.symbol}:${after.id} must record the previous holder ` +
          `(expected previousAccount=${b.owner}, got ${String(after.previousAccount)})`,
      );
    }
  }
}

/**
 * Host-side validation of everything the sandbox produced.
 *
 * Defense in depth: even a buggy or malicious isolate cannot persist state that
 *  (a) belongs to an entity the action is not allowed to touch,
 *  (b) fails the canonical entity schema,
 *  (c) mutates an immutable field of an entity it read,
 *  (d) breaks the wiki supply/burn/groupBy/read-only invariants, or
 *  (e) deletes something (only instances may be destroyed).
 *
 * Read/write integrity itself (create-without-read, lost updates) is enforced by
 * {@link StateTxn.apply}, which still has the underlying store to compare against.
 */
export function validateMutations(
  action: ActionName,
  rawMutations: unknown,
  snapshot: StateSnapshot,
): Mutation[] {
  if (!Array.isArray(rawMutations)) {
    throw new MutationGuardError('GUARD_BAD_SHAPE', 'mutations must be an array');
  }
  if (rawMutations.length > MAX_MUTATIONS_PER_OP) {
    throw new MutationGuardError(
      'GUARD_TOO_MANY_MUTATIONS',
      `op produced ${rawMutations.length} mutations (max ${MAX_MUTATIONS_PER_OP})`,
    );
  }
  const allowed = new Set<string>(ACTION_ENTITY_ALLOWLIST[action]);
  const validated: Mutation[] = [];

  for (const raw of rawMutations) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new MutationGuardError('GUARD_BAD_SHAPE', 'mutation must be an object');
    }
    const { entity, key, value } = raw as { entity?: unknown; key?: unknown; value?: unknown };
    if (typeof entity !== 'string' || typeof key !== 'string') {
      throw new MutationGuardError('GUARD_BAD_SHAPE', 'mutation requires string entity and key');
    }
    if (key.length === 0 || key.length > 64) {
      throw new MutationGuardError('GUARD_BAD_KEY', `key length out of range for ${entity}:${key}`);
    }
    if (!allowed.has(entity)) {
      throw new MutationGuardError(
        'GUARD_ENTITY_DENIED',
        `action '${action}' may not mutate '${entity}' (allowed: ${[...allowed].join(', ')})`,
      );
    }

    const before = (snapshot as unknown as Record<string, Record<string, JsonValue | undefined>>)[
      entity
    ]?.[key];

    if (value === null || value === undefined) {
      if (before === undefined) {
        throw new MutationGuardError('GUARD_DELETE_UNREAD', `refusing to delete unread key ${entity}:${key}`);
      }
      if (before === null) {
        throw new MutationGuardError('GUARD_DELETE_ABSENT', `refusing to delete absent key ${entity}:${key}`);
      }
      if (entity !== 'instance') {
        throw new MutationGuardError('GUARD_DELETE_DENIED', `entity '${entity}' is not destructible`);
      }
      validated.push({ entity, key, value: null } as Mutation);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseEntityValue(entity as EntityKind, value);
    } catch (err) {
      throw new MutationGuardError(
        'GUARD_SCHEMA',
        `${entity}:${key} failed schema validation: ${(err as Error).message}`,
      );
    }

    if (before !== undefined && before !== null) {
      assertImmutableFields(entity as EntityKind, before, parsed as JsonValue);
      if (entity === 'collection') assertCollectionInvariants(before, parsed as JsonValue);
      if (entity === 'instance') assertInstanceInvariants(before, parsed as Instance, snapshot);
      if (entity === 'order') {
        const b = before as unknown as MarketOrder;
        const a = parsed as MarketOrder;
        if (b.status !== 'OPEN' && a.status !== b.status) {
          throw new MutationGuardError('GUARD_ORDER_FINAL', `order ${b.id} is already ${b.status}`);
        }
      }
    } else if (entity === 'instance') {
      // Brand-new token (mint): validate its properties against the schema too.
      assertInstanceInvariants(undefined, parsed as Instance, snapshot);
    }

    validated.push({ entity, key, value: parsed } as Mutation);
  }

  return validated;
}
