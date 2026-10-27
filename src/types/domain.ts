import { z } from 'zod';
import type { Json } from '../utils/canonical';

/** JSON value alias used across the engine. */
export type JsonValue = Json;
export type JsonMap = Record<string, JsonValue>;

/** Mritable state partitions. Every write to one of these is journaled for undo. */
export type EntityKind =
  | 'collection'
  | 'instance'
  | 'account'
  | 'order'
  | 'marketOrder'
  | 'token'
  | 'balance'
  | 'param'
  | 'meta';

export interface EntityValueMap {
  collection: Collection;
  instance: Instance;
  account: Account;
  order: MarketOrder;
  marketOrder: BookOrder;
  token: Token;
  balance: Balance;
  param: Param;
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

/** Storage key of the single fee-schedule row (entity `param`). */
export const PARAM_KEY = 'param';

/** Balance key: `<account>:<SYMBOL>` (one row per holder and token). */
export function balanceKey(account: string, symbol: string): string {
  return `${account}:${symbol}`;
}

export type Account = {
  name: string;
  createdAtBlock: number;
  createdAt: string;
}

/**
 * Fee schedule stored inside the `param` row (in state — never in env — so it is
 * deterministic and re-org safe). All values are decimal/basis-point **strings**.
 * Migration 0003 seeds every fee at "0"; the genesis admin raises them to the target
 * values via `setParam` once SCE exists (fee bootstrap, see docs/TOKENS-DESIGN.md).
 */
export type FeeSchedule = {
  /** `nft` create — target 20 SCE ("listing a collection"). */
  nftCreationFee: string;
  /** `nft` addProperty, 4th and later properties — target 20 SCE (first 3 free). */
  addPropertyFee: string;
  /** `tokens` create — target TBD (wiki: "a token creation fee might be enforced"). */
  tokenCreationFee: string;
  /** `issue` — target 0 (wiki's base + base×#properties formula is dust). */
  issueFee: string;
  /** `fillOrder` treasury cut in basis points — target 200 (2%). */
  fillOrderFeeBps: string;
  /**
   * `market` trade fee in basis points, taken from the quote proceeds of every fill
   * and credited to `param.treasury` (docs/MARKET-DESIGN.md). Optional: param rows
   * written before the market contract existed (and their undo before-images) carry
   * no such key — the VM and every host reader treat absence as "0".
   */
  tradeFeeBps?: string;
}

/** Fungible token definition — the `token` table (wiki `tokens` contract). */
export type Token = {
  symbol: string;
  /** Friendly name (letters/numbers/whitespace, <= 50). */
  name: string;
  /** Decimal places accepted for this token (wiki: 0..8). */
  precision: number;
  /** '0' means unlimited (wiki: omitted maxSupply). Decimal string, cap MAX_SAFE. */
  maxSupply: string;
  /** Current fungible supply — rises on `issue`, falls on `burn`
   *  (design doc: burn must decrease supply), decimal string honouring precision. */
  supply: string;
  /** Steem account that created the token (wiki `issuer`). */
  issuer: string;
  /** Project URL (wiki `updateUrl`), <= 255 chars. */
  url: string;
  /** Free-form metadata (wiki `updateMetadata`), stringified <= 1000 chars. */
  metadata: string;
  createdAtBlock: number;
  /** Deterministic timestamp taken from the block header (never host clock). */
  createdAt: string;
}

/** One holder's quantity of one token — the `balance` table, keyed `<account>:<SYMBOL>`. */
export type Balance = {
  /** Holder account (the `<account>` half of the storage key). */
  account: string;
  /** Token symbol (the `<SYMBOL>` half of the storage key). */
  symbol: string;
  /** Decimal string honouring the token's precision (BigNumber arithmetic only). */
  quantity: string;
}

/** Genesis admin/treasury + fee schedule — the single `param` row. */
export type Param = {
  /** Only signer allowed to run `setParam`. */
  admin: string;
  /** Fee destination account. */
  treasury: string;
  fees: FeeSchedule;
  /** Tokens accepted for fee payment (e.g. ["SCE"]). */
  feeTokens: string[];
}

/**
 * Genesis `param` row — byte-for-byte the shape migration 0003 seeds into Postgres
 * (admin/treasury = `steempro.com`, every fee at "0" for the bootstrap window).
 * `MemoryStore` seeds this on construction so `STORAGE=memory` runs behave like a
 * migrated database; the genesis admin raises the numbers via `engine.setParam`
 * after SCE exists.
 */
export function genesisParam(): Param {
  return {
    admin: 'steempro.com',
    treasury: 'steempro.com',
    fees: {
      nftCreationFee: '0',
      addPropertyFee: '0',
      tokenCreationFee: '0',
      issueFee: '0',
      fillOrderFeeBps: '0',
      tradeFeeBps: '0',
    },
    feeTokens: ['SCE'],
  };
}

export type OrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED';

export type Settlement = {
  price: string;
  royalty: string;
  /** Platform cut (`param.fees.fillOrderFeeBps` of the price) credited to the treasury. */
  fee?: string;
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
  /** Decimal string in `priceSymbol` (precision-capped at placement). */
  price: string;
  priceSymbol: string;
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

export type BookOrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED';

/**
 * One order on the fungible `market` book (docs/MARKET-DESIGN.md) — the `marketOrder`
 * entity, keyed by id (`MKT-00000001`). Not to be confused with {@link MarketOrder},
 * which is an NFT marketplace listing (per-instance, no escrow).
 *
 * Escrow lives *on the row*: `escrow` is the amount still held for this order — quote
 * units for a BUY, base units for a SELL. The guard's conservation invariant counts
 * `escrow` as a balance-equivalent of `side === 'BUY' ? quote : symbol`, so placement
 * (balance -> escrow), fills (escrow -> counterparty balances + treasury) and cancels
 * (escrow -> balance) all net to zero per op.
 */
export type BookOrder = {
  id: string;
  /** Order owner: the only account that may cancel it. */
  account: string;
  side: 'BUY' | 'SELL';
  /** Base token being traded. */
  symbol: string;
  /** Quote token (the settlement currency; escrow denomination for BUY orders). */
  quote: string;
  /** Remaining base quantity (decimal string honouring the base precision). */
  quantity: string;
  /** Cumulative base quantity filled so far. */
  filled: string;
  /** Limit price: quote units per base unit (decimal, <= quote precision). */
  price: string;
  /** Remaining escrow: quote units (BUY) or base units (SELL). */
  escrow: string;
  status: BookOrderStatus;
  createdAtBlock: number;
  updatedAtBlock: number;
  /** Block of the fill that completed the order (null while open / cancelled). */
  filledAtBlock: number | null;
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
  /** `market` contract: a fungible order rested on the book (possibly after fills). */
  | 'MARKET_PLACED'
  /** `market` contract: one fill between a BUY and a SELL order (both ids in data). */
  | 'MARKET_FILLED'
  /** `market` contract: an open book order was cancelled and its escrow refunded. */
  | 'MARKET_CANCELLED'
  /** `tokens` contract: a fungible token was created. */
  | 'TOKEN_CREATED'
  /** `tokens` contract: supply increased and a holder was credited. */
  | 'TOKEN_ISSUED'
  /** `tokens` contract: balances moved between two holders. */
  | 'TOKEN_TRANSFERRED'
  /** `tokens` contract: a holder destroyed tokens; supply decreased. */
  | 'TOKEN_BURNED'
  /** `tokens` contract: url/metadata/issuer/precision updated (`data.field` says which). */
  | 'TOKEN_UPDATED'
  /**
   * A holder's balance row changed (issue/transfer/burn legs, fee debits, marketplace
   * settlement). Synthesized host-side from the committed write-set so every credit and
   * debit reaches account-channel subscribers, even when no `TOKEN_*` event names it.
   */
  | 'BALANCE_CHANGED'
  /** `engine` contract: the admin raised/changed the in-state fee schedule. */
  | 'PARAM_UPDATED'
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
  priceSymbol?: string;
  royalty?: string;
  fee?: string;
  sellerProceeds?: string;
  data?: JsonMap;
}

/** Read-view handed to the sandbox for one action execution. */
export interface StateSnapshot {
  collection: Record<string, Collection | null>;
  instance: Record<string, Instance | null>;
  account: Record<string, Account | null>;
  order: Record<string, MarketOrder | null>;
  marketOrder: Record<string, BookOrder | null>;
  token: Record<string, Token | null>;
  balance: Record<string, Balance | null>;
  param: Record<string, Param | null>;
  meta: Record<string, string | null>;
}

export function emptySnapshot(): StateSnapshot {
  return {
    collection: {},
    instance: {},
    account: {},
    order: {},
    marketOrder: {},
    token: {},
    balance: {},
    param: {},
    meta: {},
  };
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
/** Token quantities: up to 8 fractional digits (wiki precision 0..8). */
const DECIMAL = /^[0-9]{1,15}(\.[0-9]{1,8})?$/;
/** Wiki: letters, numbers and whitespace only, max length 50. */
const NAME = /^[A-Za-z0-9 ]{1,50}$/;

export const patterns = { UINT, SYMBOL, TOKEN_ID, INSTANCE_KEY, ACCOUNT, AMOUNT, DECIMAL, NAME };

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
  .record(z.string(), z.any())
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
    price: z.string().regex(DECIMAL),
    royalty: z.string().regex(DECIMAL),
    fee: z.string().regex(DECIMAL).optional(),
    sellerProceeds: z.string().regex(DECIMAL),
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
    price: z.string().regex(DECIMAL),
    priceSymbol: z.string().regex(SYMBOL),
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

export const BookOrderSchema: z.ZodType<BookOrder> = z
  .object({
    id: z.string().min(3).max(64),
    account: z.string().regex(ACCOUNT),
    side: z.enum(['BUY', 'SELL']),
    symbol: z.string().regex(SYMBOL),
    quote: z.string().regex(SYMBOL),
    quantity: z.string().regex(DECIMAL),
    filled: z.string().regex(DECIMAL),
    price: z.string().regex(DECIMAL),
    escrow: z.string().regex(DECIMAL),
    status: z.enum(['OPEN', 'FILLED', 'CANCELLED']),
    createdAtBlock: z.number().int().nonnegative(),
    updatedAtBlock: z.number().int().nonnegative(),
    filledAtBlock: z.number().int().nonnegative().nullable(),
  })
  .strict() as unknown as z.ZodType<BookOrder>;

export const TokenSchema: z.ZodType<Token> = z
  .object({
    symbol: z.string().regex(SYMBOL),
    name: z.string().regex(NAME),
    precision: z.number().int().min(0).max(8),
    maxSupply: z.string().regex(UINT),
    supply: z.string().regex(DECIMAL),
    issuer: z.string().regex(ACCOUNT),
    url: z.string().max(255),
    metadata: z.string().max(1000),
    createdAtBlock: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
  })
  .strict() as unknown as z.ZodType<Token>;

export const BalanceSchema: z.ZodType<Balance> = z
  .object({
    account: z.string().regex(ACCOUNT),
    symbol: z.string().regex(SYMBOL),
    quantity: z.string().regex(DECIMAL),
  })
  .strict() as unknown as z.ZodType<Balance>;

const FeeScheduleSchema: z.ZodType<FeeSchedule> = z
  .object({
    nftCreationFee: z.string().regex(DECIMAL),
    addPropertyFee: z.string().regex(DECIMAL),
    tokenCreationFee: z.string().regex(DECIMAL),
    issueFee: z.string().regex(DECIMAL),
    fillOrderFeeBps: z.string().regex(UINT).refine((v) => Number(v) <= 10000, {
      message: 'fillOrderFeeBps must be <= 10000',
    }),
    // Optional: param rows written before the market contract existed carry no such
    // key (absence = "0" everywhere); strictness still rejects a malformed value.
    tradeFeeBps: z
      .string()
      .regex(UINT)
      .refine((v) => Number(v) <= 10000, { message: 'tradeFeeBps must be <= 10000' })
      .optional(),
  })
  .strict() as unknown as z.ZodType<FeeSchedule>;

export const ParamSchema: z.ZodType<Param> = z
  .object({
    admin: z.string().regex(ACCOUNT),
    treasury: z.string().regex(ACCOUNT),
    fees: FeeScheduleSchema,
    feeTokens: z.array(z.string().regex(SYMBOL)).max(10),
  })
  .strict() as unknown as z.ZodType<Param>;

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
    case 'marketOrder':
      return BookOrderSchema.parse(value);
    case 'token':
      return TokenSchema.parse(value);
    case 'balance':
      return BalanceSchema.parse(value);
    case 'param':
      return ParamSchema.parse(value);
    case 'meta':
      return metaSchema.parse(value);
    default: {
      const never: never = entity;
      throw new Error(`unknown entity ${String(never)}`);
    }
  }
}
