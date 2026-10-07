import { z } from 'zod';
import type { Json } from '../utils/canonical';

/** JSON value alias used across the engine. */
export type JsonValue = Json;
export type JsonMap = Record<string, JsonValue>;

/** Mritable state partitions. Every write to one of these is journaled for undo. */
export type EntityKind = 'collection' | 'instance' | 'account' | 'order' | 'meta';

export interface EntityValueMap {
  collection: Collection;
  instance: Instance;
  account: Account;
  order: MarketOrder;
  meta: string;
}

export type EntityValue<K extends EntityKind = EntityKind> = EntityValueMap[K];

/** A single declarative state change produced by the sandbox VM. */
export type Mutation = {
  [K in EntityKind]: { entity: K; key: string; value: EntityValueMap[K] | null };
}[EntityKind];

/** Inverse record persisted per applied block; `before === null` means "key did not exist". */
export interface JournalEntry {
  seq: number;
  entity: EntityKind;
  key: string;
  before: JsonValue | null;
}

/** Property schema types (wiki: number | string | boolean — JSON must be stringified). */
export type PropertyType = 'number' | 'string' | 'boolean';

/**
 * Schema of one declared data property (wiki `addProperty` / `properties` field).
 * Each property carries its own editing permissions.
 */
export type PropertyDefinition = {
  type: PropertyType;
  /** Set once then frozen (wiki: "can be set exactly one time"). */
  isReadOnly: boolean;
  /** Accounts allowed to edit the property on behalf of the owner (default: the issuer). */
  authorizedEditingAccounts: string[];
  authorizedEditingContracts: string[];
};

/** Collection (a.k.a. NFT series) definition — field names follow the wiki's `nfts` table. */
export type Collection = {
  symbol: string;
  /** Friendly name (letters/numbers/whitespace, <= 50). */
  name: string;
  /** Steem account that owns the NFT (wiki `issuer`). */
  issuer: string;
  /** Project URL (wiki `updateUrl`), <= 255 chars. */
  url: string;
  /** Company/organization (wiki `updateOrgName`), <= 50 chars. */
  orgName: string;
  /** Product/brand (wiki `updateProductName`), <= 50 chars. */
  productName: string;
  /** Free-form token metadata (wiki `updateMetadata`), stringified <= 1000 chars. */
  metadata: JsonMap;
  /** '0' means unlimited (wiki: omit maxSupply => unlimited). */
  maxSupply: string;
  /** Tokens ever issued (wiki `supply`) — monotonic, never decreases. */
  supply: string;
  /** Tokens issued then destroyed; ids are never recycled (id = supply + 1 at issue). */
  burned: string;
  /** supply - burned (wiki `circulatingSupply`) — invariant enforced by the guard. */
  circulatingSupply: string;
  /** Accounts allowed to issue on behalf of the owner (owner included by default, max 10). */
  authorizedIssuingAccounts: string[];
  /** Smart contracts allowed to issue (max 10; this engine has no contract accounts). */
  authorizedIssuingContracts: string[];
  /** Declared data properties (wiki `addProperty`), keyed by property name. */
  properties: Record<string, PropertyDefinition>;
  /** Property names market orders group by (wiki `setGroupBy`) — set once, [] = unset. */
  groupBy: string[];
  /** Royalty in basis points (0..10000) — engine marketplace extension. */
  royaltyBps: string;
  royaltyRecipient: string;
  createdAtBlock: number;
  /** Deterministic timestamp taken from the block header (never host clock). */
  createdAt: string;
}

export type Instance = {
  /**
   * Token id: plain numeric string, unique **per symbol** (wiki: "573" is the 573rd
   * token of that symbol; ids start at 1 and increment by 1 on every issue).
   */
  id: string;
  symbol: string;
  /** Same value as `id`, kept numeric for arithmetic-free rendering. */
  seq: number;
  owner: string;
  properties: JsonMap;
  /** Set while the instance backs an open marketplace order. */
  listedOrderId: string | null;
  /** Previous holder (wiki `previousAccount`) — set after the first transfer/sale. */
  previousAccount: string | null;
  createdAtBlock: number;
  createdAt: string;
}

/**
 * Globally unique instance reference: `<SYMBOL>:<id>`.
 *
 * Ids are only unique within a symbol (as in the wiki), so storage keys, event payloads,
 * order references and log filters all use this composite form.
 */
export function instanceKey(symbol: string, id: string): string {
  return `${symbol}:${id}`;
}

export type Account = {
  name: string;
  createdAtBlock: number;
  createdAt: string;
}

export type OrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED';

export type Settlement = {
  price: string;
  royalty: string;
  sellerProceeds: string;
  royaltyRecipient: string;
  buyer: string;
  seller: string;
}

export type MarketOrder = {
  id: string;
  symbol: string;
  instanceId: string;
  seller: string;
  /** Decimal string in STEEM (3 dp). */
  price: string;
  currency: 'STEEM';
  status: OrderStatus;
  /** Snapshot taken at placement so later collection edits cannot alter open orders. */
  royaltyBps: string;
  royaltyRecipient: string;
  createdAtBlock: number;
  updatedAtBlock: number;
  filledAtBlock: number | null;
  fillBy: string | null;
  settlement: Settlement | null;
}

export interface BlockRecord {
  height: number;
  blockId: string;
  previous: string;
  /** ISO timestamp from the block header. */
  timestamp: string;
  txCount: number;
  opCount: number;
  /** Host clock; explicitly excluded from deterministic state. */
  appliedAt: string;
}

export type TxStatus = 'APPLIED' | 'FAILED' | 'IGNORED';

export interface TransactionLogRecord {
  /** `<height>:<txId>:<opIndex>` — deterministic across replays. */
  id: string;
  height: number;
  blockId: string;
  txId: string;
  opIndex: number;
  action: string;
  actor: string;
  authLevel: 'active' | 'posting' | 'none';
  symbol: string | null;
  instanceId: string | null;
  status: TxStatus;
  params: JsonMap;
  error: { code: string; message: string } | null;
  mutations: JsonValue | null;
  events: JsonValue | null;
  timestamp: string;
}

/** Engine-level events fanned out over WebSocket (not consensus state). */
export type EngineEventType =
  | 'BLOCK_APPLIED'
  | 'COLLECTION_CREATED'
  | 'NFT_MINTED'
  | 'NFT_RECEIVED'
  | 'NFT_TRANSFERRED'
  | 'PROPERTIES_UPDATED'
  | 'NFT_BURNED'
  | 'ORDER_PLACED'
  | 'ORDER_FILLED'
  | 'ORDER_CANCELLED'
  /** One item of a batch action (wiki `issueMultiple`) failed while others succeeded. */
  | 'ITEM_FAILED'
  | 'TX_FAILED'
  | 'REORG_DETECTED'
  | 'REORG_APPLIED'
  | 'ENGINE_HALTED';

export interface EngineEvent {
  type: EngineEventType;
  block: number;
  blockId?: string;
  txId?: string;
  timestamp: string;
  account?: string;
  symbol?: string;
  instanceId?: string;
  orderId?: string;
  price?: string;
  royalty?: string;
  sellerProceeds?: string;
  data?: JsonMap;
}

/** Read-view handed to the sandbox for one action execution. */
export interface StateSnapshot {
  collection: Record<string, Collection | null>;
  instance: Record<string, Instance | null>;
  account: Record<string, Account | null>;
  order: Record<string, MarketOrder | null>;
  meta: Record<string, string | null>;
}

export function emptySnapshot(): StateSnapshot {
  return { collection: {}, instance: {}, account: {}, order: {}, meta: {} };
}

const UINT = /^[0-9]{1,20}$/;
/** Wiki: uppercase letters only, max length 10 (engine keeps a floor of 3). */
const SYMBOL = /^[A-Z]{3,10}$/;
/** Wiki: token ids are numeric strings, unique per symbol. */
const TOKEN_ID = /^[0-9]{1,15}$/;
/** Globally unique instance reference used by storage/events/orders/logs. */
const INSTANCE_KEY = /^[A-Z]{3,10}:[0-9]{1,15}$/;
const ACCOUNT = /^[a-z][a-z0-9.-]{2,15}$/;
const AMOUNT = /^[0-9]{1,15}(\.[0-9]{1,3})?$/;
/** Wiki: letters, numbers and whitespace only, max length 50. */
const NAME = /^[A-Za-z0-9 ]{1,50}$/;

export const patterns = { UINT, SYMBOL, TOKEN_ID, INSTANCE_KEY, ACCOUNT, AMOUNT, NAME };

/** Rejects floating point numbers anywhere inside a JSON structure. */
export function assertNoFloats(value: unknown, path = '$'): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`floating point number at ${path} is forbidden (determinism)`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoFloats(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoFloats(v, `${path}.${k}`);
    }
  }
}

export const jsonMapSchema = z
  .record(z.any())
  .refine((v) => v !== undefined, { message: 'must be an object' })
  .superRefine((v, ctx) => {
    try {
      assertNoFloats(v);
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    }
  }) as unknown as z.ZodType<JsonMap>;

const PROP_NAME = /^[A-Za-z0-9]{1,25}$/;
const MAX_PROPERTY_DEFS = 50;

/** Validates one declared data property schema (wiki `properties` entry). */
export const PropertyDefinitionSchema: z.ZodType<PropertyDefinition> = z
  .object({
    type: z.enum(['number', 'string', 'boolean']),
    isReadOnly: z.boolean(),
    authorizedEditingAccounts: z.array(z.string().regex(ACCOUNT)).max(10),
    authorizedEditingContracts: z.array(z.string().regex(ACCOUNT)).max(10),
  })
  .strict() as unknown as z.ZodType<PropertyDefinition>;

export const CollectionSchema: z.ZodType<Collection> = z
  .object({
    symbol: z.string().regex(SYMBOL),
    name: z.string().regex(NAME),
    issuer: z.string().regex(ACCOUNT),
    url: z.string().max(255),
    orgName: z.string().max(50),
    productName: z.string().max(50),
    metadata: jsonMapSchema,
    maxSupply: z.string().regex(UINT),
    supply: z.string().regex(UINT),
    burned: z.string().regex(UINT),
    circulatingSupply: z.string().regex(UINT),
    authorizedIssuingAccounts: z.array(z.string().regex(ACCOUNT)).max(10),
    authorizedIssuingContracts: z.array(z.string().regex(ACCOUNT)).max(10),
    properties: z
      .record(z.string().regex(PROP_NAME), PropertyDefinitionSchema)
      .superRefine((value, ctx) => {
        if (Object.keys(value).length > MAX_PROPERTY_DEFS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `at most ${MAX_PROPERTY_DEFS} property definitions are allowed`,
          });
        }
      }),
    groupBy: z.array(z.string().regex(PROP_NAME)).max(10),
    royaltyBps: z.string().regex(UINT),
    royaltyRecipient: z.string().regex(ACCOUNT),
    createdAtBlock: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
  })
  .strict() as unknown as z.ZodType<Collection>;

export const InstanceSchema: z.ZodType<Instance> = z
  .object({
    id: z.string().regex(TOKEN_ID),
    symbol: z.string().regex(SYMBOL),
    seq: z.number().int().positive(),
    owner: z.string().regex(ACCOUNT),
    properties: jsonMapSchema,
    listedOrderId: z.string().nullable(),
    previousAccount: z.string().regex(ACCOUNT).nullable(),
    createdAtBlock: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
  })
  .strict() as unknown as z.ZodType<Instance>;

export const AccountSchema: z.ZodType<Account> = z
  .object({
    name: z.string().regex(ACCOUNT),
    createdAtBlock: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
  })
  .strict() as unknown as z.ZodType<Account>;

export const SettlementSchema: z.ZodType<Settlement> = z
  .object({
    price: z.string().regex(AMOUNT),
    royalty: z.string().regex(AMOUNT),
    sellerProceeds: z.string().regex(AMOUNT),
    royaltyRecipient: z.string().regex(ACCOUNT),
    buyer: z.string().regex(ACCOUNT),
    seller: z.string().regex(ACCOUNT),
  })
  .strict() as unknown as z.ZodType<Settlement>;

export const MarketOrderSchema: z.ZodType<MarketOrder> = z
  .object({
    id: z.string().min(3).max(64),
    symbol: z.string().regex(SYMBOL),
    instanceId: z.string().regex(INSTANCE_KEY),
    seller: z.string().regex(ACCOUNT),
    price: z.string().regex(AMOUNT),
    currency: z.literal('STEEM'),
    status: z.enum(['OPEN', 'FILLED', 'CANCELLED']),
    royaltyBps: z.string().regex(UINT),
    royaltyRecipient: z.string().regex(ACCOUNT),
    createdAtBlock: z.number().int().nonnegative(),
    updatedAtBlock: z.number().int().nonnegative(),
    filledAtBlock: z.number().int().nonnegative().nullable(),
    fillBy: z.string().regex(ACCOUNT).nullable(),
    settlement: SettlementSchema.nullable(),
  })
  .strict() as unknown as z.ZodType<MarketOrder>;

const metaSchema = z.string().regex(UINT);

/** Validates a single after-image produced by the sandbox. */
export function parseEntityValue(entity: EntityKind, value: unknown): EntityValue {
  switch (entity) {
    case 'collection':
      return CollectionSchema.parse(value);
    case 'instance':
      return InstanceSchema.parse(value);
    case 'account':
      return AccountSchema.parse(value);
    case 'order':
      return MarketOrderSchema.parse(value);
    case 'meta':
      return metaSchema.parse(value);
    default: {
      const never: never = entity;
      throw new Error(`unknown entity ${String(never)}`);
    }
  }
}
