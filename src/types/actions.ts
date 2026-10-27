import { z } from 'zod';
import { assertUintString } from '../utils/bn';

/**
 * Action envelopes carried by `custom_json` operations with `id === sce-mainnet1`.
 *
 * Two wire formats are accepted (both parse to the same {@link Envelope}):
 *
 *  1. **Standard (wiki)** — the steemsmartcontracts contract format:
 *     `{ "contractName": "nft", "contractAction": "issue", "contractPayload": { ... } }`
 *  2. **Engine shorthand** — `{ "action": "issue", "params": { ... } }`, optionally
 *     carrying `"contract": "tokens"` (defaults to `nft` for back-compatibility).
 *
 * One op id multiplexes all three contracts (`nft`, `tokens` and `engine`) — the same
 * pattern as the real Steem Engine, where `contractName` inside the payload selects the
 * contract even though every call shares a single `custom_json` id. Shared action names
 * (`create`, `issue`, `transfer`, `burn`, `updateUrl`, `updateMetadata`,
 * `transferOwnership`) are resolved per contract: each contract has its own action list,
 * param schemas and entity allow list.
 *
 * Action names and parameters follow
 * https://github.com/hive-engine/steemsmartcontracts-wiki/blob/master/NFT-Contracts.md
 * and .../Tokens-Contract.md (the marketplace actions are an engine extension — they
 * live in a separate contract upstream and are exposed here under the same envelope).
 *
 * Payloads are validated twice: structurally here (ingestion time, so malformed user
 * input is rejected before it ever reaches the VM) and semantically inside the sandbox.
 */

/** Contracts implemented under this op id (anything else is `UNKNOWN_CONTRACT`). */
export const CONTRACTS = ['nft', 'tokens', 'engine', 'market'] as const;
export type ContractName = (typeof CONTRACTS)[number];

/** Standard `nft` contract actions (wiki NFT-Contracts + the marketplace extension). */
export const NFT_ACTIONS = [
  'create',
  'updateUrl',
  'updateMetadata',
  'updateName',
  'updateOrgName',
  'updateProductName',
  'addAuthorizedIssuingAccounts',
  'removeAuthorizedIssuingAccounts',
  'addAuthorizedIssuingContracts',
  'removeAuthorizedIssuingContracts',
  'transferOwnership',
  'addProperty',
  'setPropertyPermissions',
  'setProperties',
  'setGroupBy',
  'updatePropertyDefinition',
  'issue',
  'issueMultiple',
  'transfer',
  'burn',
  // ---- engine marketplace extension --------------------------------------
  'placeOrder',
  'fillOrder',
  'cancelOrder',
] as const;

/** `tokens` contract actions — v1 scope of docs/TOKENS-DESIGN.md (wiki Tokens-Contract). */
export const TOKENS_ACTIONS = [
  'create',
  'issue',
  'transfer',
  'burn',
  'updateUrl',
  'updateMetadata',
  'transferOwnership',
  'updatePrecision',
] as const;

/**
 * `market` contract actions — the fungible order book of docs/MARKET-DESIGN.md
 * (wiki steemsmartcontracts `market`: buy/sell/cancel, escrow at placement,
 * in-VM price-time matching).
 */
export const MARKET_ACTIONS = ['buy', 'sell', 'cancel'] as const;

export type NftActionName = (typeof NFT_ACTIONS)[number];
export type TokenActionName = (typeof TOKENS_ACTIONS)[number];
/** `engine` meta-actions (not part of either wiki contract — fee admin, see step 3). */
export const ENGINE_ACTIONS = ['setParam'] as const;
export type EngineActionName = (typeof ENGINE_ACTIONS)[number];
export type MarketActionName = (typeof MARKET_ACTIONS)[number];
/** Any action name across all four contracts (shared names appear in several lists). */
export type ActionName = NftActionName | TokenActionName | EngineActionName | MarketActionName;

/** Every action any contract accepts (union — used for diagnostics). */
export const ACTIONS = [...NFT_ACTIONS, ...TOKENS_ACTIONS, ...ENGINE_ACTIONS, ...MARKET_ACTIONS] as const;

export const ACTIONS_BY_CONTRACT: Record<ContractName, readonly ActionName[]> = {
  nft: NFT_ACTIONS,
  tokens: TOKENS_ACTIONS,
  engine: ENGINE_ACTIONS,
  market: MARKET_ACTIONS,
};

/**
 * Actions we deliberately do not implement, with the reason surfaced to the sender.
 * (Delegation, staking and locked tokens need state/entities this L2 does not model
 * yet — see the deferral table in docs/TOKENS-DESIGN.md.)
 */
export const UNSUPPORTED_ACTION_HINTS: Record<string, string> = {
  enableDelegation: 'delegation is not supported by this engine',
  delegate: 'delegation is not supported by this engine',
  undelegate: 'delegation is not supported by this engine',
  // ---- tokens v1 deferrals ----
  transferToContract: 'contract accounts are not supported yet (deferred, see docs/TOKENS-DESIGN.md)',
  enableStaking: 'staking is not supported by this engine',
  stake: 'staking is not supported by this engine',
  unstake: 'staking is not supported by this engine',
  cancelUnstake: 'staking is not supported by this engine',
  // Pre-alignment names: tell old clients what replaced them.
  createCollection: 'renamed to "create" (wiki NFT-Contracts)',
  mint: 'renamed to "issue" (wiki NFT-Contracts)',
  batchMint: 'renamed to "issueMultiple" (wiki NFT-Contracts)',
  updateProperties: 'renamed to "setProperties" (wiki NFT-Contracts)',
};

export const AccountNameSchema = z.string().regex(/^[a-z][a-z0-9.-]{2,15}$/, 'invalid Steem account name');
/** Wiki: uppercase letters only, max length 10 (floor of 3 to keep ids readable). */
export const SymbolSchema = z.string().regex(/^[A-Z]{3,10}$/, 'symbol must be 3 to 10 uppercase letters');
/** Wiki: "Token IDs are always represented as strings" and are numeric. */
export const TokenIdSchema = z.string().regex(/^[0-9]{1,15}$/, 'token id must be a numeric string');
/** Wiki: letters, numbers, whitespace only; max length 50. */
export const NameSchema = z
  .string()
  .regex(/^[A-Za-z0-9 ]{1,50}$/, 'letters, numbers and whitespace only, max 50 characters');
/** Wiki: property names are letters & numbers only, max length 25. */
export const PropertyNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{1,25}$/, 'property name must be 1 to 25 letters/numbers');
export const PropertyTypeSchema = z.enum(['number', 'string', 'boolean']);
export const UintStringSchema = z.string().regex(/^[0-9]{1,20}$/, 'must be an unsigned integer string');
export const AmountSchema = z
  .string()
  .regex(/^[0-9]{1,15}(\.[0-9]{1,3})?$/, 'must be an amount with at most 3 decimal places');
/** Wiki token quantities: decimal strings; the fractional part is capped by the
 *  token's precision (0..8), which the contract validates against the token row. */
export const QuantitySchema = z
  .string()
  .regex(/^[0-9]{1,15}(\.[0-9]{1,8})?$/, 'must be a decimal amount with at most 8 decimal places');

/** Wiki allows `user | contract`; this engine only models Steem accounts. */
const TypeSchema = z.enum(['user', 'contract']);
const AccountList = z.array(AccountNameSchema).max(10);
const ContractList = z.array(AccountNameSchema).max(10);

const MAX_SAFE_INT = 9007199254740991;
const MAX_BATCH_TOKENS = 50;
const MAX_ISSUE_INSTANCES = 10;

const FreeForm = z.record(z.string(), z.any()).superRefine((value, ctx) => {
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number' && !Number.isInteger(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `floating point at ${path} is forbidden` });
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`);
    }
  };
  walk(value, '$');
});

/**
 * A data property value as it may appear on the wire: booleans, strings (<= 100 chars —
 * the wiki's string cap) and integers. Floats are refused for determinism; the contract
 * validates the value against the property's declared type (a `number` property also
 * accepts integer strings, e.g. `"2"`, exactly as the wiki shows).
 */
const PropertyValue = z.union([z.boolean(), z.string().max(100), z.number().int()]);
const PropertyValueMap = z.record(z.string(), PropertyValue);

/** A batch of token ids grouped by symbol, exactly like the wiki's `nfts` parameter. */
const NftGroups = z
  .array(z.object({ symbol: SymbolSchema, ids: z.array(TokenIdSchema).min(1) }).strict())
  .min(1);

function totalIds(groups: z.infer<typeof NftGroups>): number {
  return groups.reduce((sum, group) => sum + group.ids.length, 0);
}

function requireBatchLimit(groups: z.infer<typeof NftGroups>): void {
  if (totalIds(groups) > MAX_BATCH_TOKENS) {
    throw new Error(`at most ${MAX_BATCH_TOKENS} tokens may be handled in one action`);
  }
}

const royaltyBpsSchema = UintStringSchema.refine((v) => {
  try {
    assertUintString(v);
    return Number(v) <= 10000;
  } catch {
    return false;
  }
}, 'royaltyBps must be <= 10000');

/** Wiki `maxSupply`: an integer string between 1 and the JS max safe integer. */
function refineMaxSupply(value: { maxSupply?: string }, ctx: z.RefinementCtx): void {
  if (value.maxSupply === undefined) return;
  try {
    assertUintString(value.maxSupply);
    const n = BigInt(value.maxSupply);
    if (n < 1n || n > BigInt(MAX_SAFE_INT)) throw new Error('out of range');
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `maxSupply must be between 1 and ${MAX_SAFE_INT}`,
    });
  }
}

/* --------------------------------------------------------------- param schemas */

const CreateParams = z
  .object({
    symbol: SymbolSchema,
    name: NameSchema,
    orgName: NameSchema.optional(),
    productName: NameSchema.optional(),
    url: z.string().max(255).optional(),
    // Wiki: 1 .. 9007199254740991; omitted => unlimited (stored as "0").
    maxSupply: UintStringSchema.optional(),
    authorizedIssuingAccounts: AccountList.optional(),
    authorizedIssuingContracts: ContractList.optional(),
    // ---- engine marketplace extension (not part of the wiki's `create`) ----
    royaltyBps: royaltyBpsSchema.optional(),
    royaltyRecipient: AccountNameSchema.optional(),
  })
  .strict()
  .superRefine(refineMaxSupply);

const MetadataParams = z
  .object({ symbol: SymbolSchema, metadata: FreeForm })
  .strict()
  .superRefine((value, ctx) => {
    if (JSON.stringify(value.metadata).length > 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'metadata must stringify to at most 1000 characters (wiki limit)',
      });
    }
  });

const IssueParams = z
  .object({
    symbol: SymbolSchema,
    to: AccountNameSchema,
    properties: PropertyValueMap.optional(),
    // Wiki requires feeSymbol; it is validated against param.feeTokens once issueFee > 0.
    feeSymbol: z.string().min(1).max(10).optional(),
    fromType: TypeSchema.optional(),
    toType: TypeSchema.optional(),
    // Locked tokens/NFTs are not modelled — rejected explicitly by the contract.
    lockTokens: z.unknown().optional(),
    lockNfts: z.unknown().optional(),
  })
  .strict();

const IssueMultipleParams = z
  .object({ instances: z.array(IssueParams).min(1).max(MAX_ISSUE_INSTANCES) })
  .strict();

const TransferParams = z
  .object({
    to: AccountNameSchema,
    nfts: NftGroups,
    fromType: TypeSchema.optional(),
    toType: TypeSchema.optional(),
  })
  .strict();

const BurnParams = z
  .object({ nfts: NftGroups, fromType: TypeSchema.optional() })
  .strict();

const SetPropertiesParams = z
  .object({
    symbol: SymbolSchema,
    nfts: z
      .array(z.object({ id: TokenIdSchema, properties: PropertyValueMap }).strict())
      .min(1)
      .max(MAX_BATCH_TOKENS),
    fromType: TypeSchema.optional(),
  })
  .strict();

const AddPropertyParams = z
  .object({
    symbol: SymbolSchema,
    name: PropertyNameSchema,
    type: PropertyTypeSchema,
    isReadOnly: z.boolean().optional(),
    authorizedEditingAccounts: AccountList.optional(),
    authorizedEditingContracts: ContractList.optional(),
  })
  .strict();

const SetPropertyPermissionsParams = z
  .object({
    symbol: SymbolSchema,
    name: PropertyNameSchema,
    accounts: AccountList.optional(),
    contracts: ContractList.optional(),
  })
  .strict();

const SetGroupByParams = z
  .object({ symbol: SymbolSchema, properties: z.array(PropertyNameSchema).min(1).max(10) })
  .strict();

const UpdatePropertyDefinitionParams = z
  .object({
    symbol: SymbolSchema,
    name: PropertyNameSchema,
    newName: PropertyNameSchema.optional(),
    type: PropertyTypeSchema.optional(),
    isReadOnly: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.newName === undefined && value.type === undefined && value.isReadOnly === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one of newName, type, isReadOnly must be provided',
      });
    }
  });

const IssuerListParams = z.object({ symbol: SymbolSchema, accounts: AccountList.min(1) }).strict();
const ContractListParams = z.object({ symbol: SymbolSchema, contracts: ContractList.min(1) }).strict();
const SymbolParams = z.object({ symbol: SymbolSchema }).strict();
const TransferOwnershipParams = z.object({ symbol: SymbolSchema, to: AccountNameSchema }).strict();
const UpdateUrlParams = z.object({ symbol: SymbolSchema, url: z.string().max(255) }).strict();
const UpdateNameParams = z.object({ symbol: SymbolSchema, name: NameSchema }).strict();
const UpdateOrgNameParams = z.object({ symbol: SymbolSchema, orgName: NameSchema }).strict();
const UpdateProductNameParams = z.object({ symbol: SymbolSchema, productName: NameSchema }).strict();

const PlaceOrderParams = z
  .object({ symbol: SymbolSchema, id: TokenIdSchema, price: QuantitySchema, priceSymbol: SymbolSchema.optional() })
  .strict();
const FillOrderParams = z.object({ orderId: z.string().min(3).max(64) }).strict();
const CancelOrderParams = z.object({ orderId: z.string().min(3).max(64) }).strict();

/* ---------------------------------------------------- market contract params */

/**
 * `market.buy` / `market.sell` — one order per call: the base token (`symbol`), the
 * quote/currency token, the base quantity and the limit price (quote per base unit).
 * Quantity decimals are capped by the base token's precision, price decimals by the
 * quote token's precision (both enforced in-VM against the token rows).
 */
const MarketTradeParams = z
  .object({
    symbol: SymbolSchema,
    quote: SymbolSchema,
    quantity: QuantitySchema,
    price: QuantitySchema,
  })
  .strict();

/** `market.cancel` — same orderId reference shape as the nft marketplace cancel. */
const MarketCancelParams = z.object({ orderId: z.string().min(3).max(64) }).strict();

/* --------------------------------------------------- tokens contract params */

/**
 * Wiki `tokens.create` — name, symbol and precision are required; `maxSupply`
 * omitted means unlimited (stored as "0"), `url` optional, `metadata` starts empty
 * and is edited later through `updateMetadata`.
 */
const TokenCreateParams = z
  .object({
    symbol: SymbolSchema,
    name: NameSchema,
    precision: z.number().int().min(0).max(8),
    maxSupply: UintStringSchema.optional(),
    url: z.string().max(255).optional(),
  })
  .strict()
  .superRefine(refineMaxSupply);

/** Wiki `tokens.issue` — issuer only; `feeSymbol` must be in param.feeTokens when charged. */
const TokenIssueParams = z
  .object({
    symbol: SymbolSchema,
    to: AccountNameSchema,
    quantity: QuantitySchema,
    feeSymbol: z.string().min(1).max(10).optional(),
  })
  .strict();

const TokenTransferParams = z
  .object({ symbol: SymbolSchema, to: AccountNameSchema, quantity: QuantitySchema })
  .strict();

/** Engine extension (not on the wiki page): holder burns own tokens, supply decreases. */
const TokenBurnParams = z.object({ symbol: SymbolSchema, quantity: QuantitySchema }).strict();

/** Wiki: the new precision can only be greater than the current one (enforced in-VM). */
const UpdatePrecisionParams = z
  .object({ symbol: SymbolSchema, precision: z.number().int().min(0).max(8) })
  .strict();

/* --------------------------------------------------- engine contract params */

/** Fee cut in basis points — at most 100% (10000 bps). */
const FeeBpsSchema = UintStringSchema.refine((v) => Number(v) <= 10000, 'fillOrderFeeBps must be <= 10000');
const TradeFeeBpsSchema = UintStringSchema.refine((v) => Number(v) <= 10000, 'tradeFeeBps must be <= 10000');

/**
 * `engine.setParam` — partial patch of the in-state fee row (admin-only, enforced
 * in-VM against `param.admin`). `admin`/`treasury` never appear here: they are
 * immutable (IMMUTABLE_FIELDS + strict schemas reject them at both layers).
 */
const SetParamParams = z
  .object({
    fees: z
      .object({
        nftCreationFee: QuantitySchema.optional(),
        addPropertyFee: QuantitySchema.optional(),
        tokenCreationFee: QuantitySchema.optional(),
        issueFee: QuantitySchema.optional(),
        fillOrderFeeBps: FeeBpsSchema.optional(),
        tradeFeeBps: TradeFeeBpsSchema.optional(),
      })
      .strict()
      .optional(),
    feeTokens: z.array(SymbolSchema).max(10).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.fees === undefined && value.feeTokens === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'setParam requires a fees patch and/or feeTokens',
      });
    }
  });

const NFT_PARAM_SCHEMAS: Record<NftActionName, z.ZodTypeAny> = {
  create: CreateParams,
  updateUrl: UpdateUrlParams,
  updateMetadata: MetadataParams,
  updateName: UpdateNameParams,
  updateOrgName: UpdateOrgNameParams,
  updateProductName: UpdateProductNameParams,
  addAuthorizedIssuingAccounts: IssuerListParams,
  removeAuthorizedIssuingAccounts: IssuerListParams,
  addAuthorizedIssuingContracts: ContractListParams,
  removeAuthorizedIssuingContracts: ContractListParams,
  transferOwnership: TransferOwnershipParams,
  addProperty: AddPropertyParams,
  setPropertyPermissions: SetPropertyPermissionsParams,
  setProperties: SetPropertiesParams,
  setGroupBy: SetGroupByParams,
  updatePropertyDefinition: UpdatePropertyDefinitionParams,
  issue: IssueParams,
  issueMultiple: IssueMultipleParams,
  transfer: TransferParams,
  burn: BurnParams,
  placeOrder: PlaceOrderParams,
  fillOrder: FillOrderParams,
  cancelOrder: CancelOrderParams,
};

const TOKENS_PARAM_SCHEMAS: Record<TokenActionName, z.ZodTypeAny> = {
  create: TokenCreateParams,
  issue: TokenIssueParams,
  transfer: TokenTransferParams,
  burn: TokenBurnParams,
  // Shared shapes with the `nft` contract (same wiki field requirements).
  updateUrl: UpdateUrlParams,
  updateMetadata: MetadataParams,
  transferOwnership: TransferOwnershipParams,
  updatePrecision: UpdatePrecisionParams,
};

const PARAM_SCHEMAS: {
  nft: Record<NftActionName, z.ZodTypeAny>;
  tokens: Record<TokenActionName, z.ZodTypeAny>;
  engine: Record<EngineActionName, z.ZodTypeAny>;
  market: Record<MarketActionName, z.ZodTypeAny>;
} = {
  nft: NFT_PARAM_SCHEMAS,
  tokens: TOKENS_PARAM_SCHEMAS,
  engine: { setParam: SetParamParams },
  market: {
    buy: MarketTradeParams,
    sell: MarketTradeParams,
    cancel: MarketCancelParams,
  },
};

export class PayloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PayloadError';
  }
}

export interface Envelope {
  contract: ContractName;
  action: ActionName;
  params: Record<string, unknown>;
}

const CONTRACT_KEYS = ['contractName', 'contractAction', 'contractPayload'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses and fully validates a `custom_json` payload. Throws {@link PayloadError}.
 *
 * Accepts both the standard contract envelope (with `contractName` selecting `nft` or
 * `tokens`) and the engine shorthand (optional `contract`, defaulting to `nft`);
 * anything else — including arrays of contract calls or foreign contracts — is
 * rejected with an explicit code so the sender learns what to change.
 */
export function parseEnvelope(rawJson: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new PayloadError('INVALID_JSON', 'custom_json payload is not valid JSON');
  }

  let contract: unknown;
  let action: unknown;
  let params: unknown;

  if (Array.isArray(parsed)) {
    throw new PayloadError(
      'UNSUPPORTED_ENVELOPE',
      'one contract call per custom_json operation is required (arrays of calls are not supported)',
    );
  }

  if (isObject(parsed) && CONTRACT_KEYS.some((key) => key in parsed)) {
    // ---- standard steemsmartcontracts envelope ----
    const missing = CONTRACT_KEYS.filter((key) => !(key in parsed));
    if (missing.length > 0) {
      throw new PayloadError(
        'INVALID_ENVELOPE',
        `contract envelope is missing: ${missing.join(', ')}`,
      );
    }
    contract = parsed.contractName;
    action = parsed.contractAction;
    params = parsed.contractPayload;
  } else if (isObject(parsed)) {
    // ---- engine shorthand (contract optional, `nft` for back-compatibility) ----
    const explicit = (parsed as { contract?: unknown }).contract;
    contract = explicit === undefined ? 'nft' : explicit;
    action = (parsed as { action?: unknown }).action;
    params = (parsed as { params?: unknown }).params;
  } else {
    throw new PayloadError('INVALID_ENVELOPE', 'payload must be an object');
  }

  if (typeof contract !== 'string' || !(CONTRACTS as readonly string[]).includes(contract)) {
    throw new PayloadError(
      'UNKNOWN_CONTRACT',
      `only the ${CONTRACTS.map((c) => JSON.stringify(c)).join(', ')} contracts are implemented (got ${JSON.stringify(contract)})`,
    );
  }
  const name = contract as ContractName;

  if (typeof action !== 'string') {
    throw new PayloadError('INVALID_ENVELOPE', 'action (or contractAction) must be a string');
  }

  // Own-property lookup: a bare `HINTS[action]` would resolve inherited names like
  // `toString`/`constructor` through the prototype chain (fail-closed, but with a
  // nonsense hint) — hostile action strings must only ever match real hint keys.
  const hint = Object.prototype.hasOwnProperty.call(UNSUPPORTED_ACTION_HINTS, action)
    ? UNSUPPORTED_ACTION_HINTS[action]
    : undefined;
  if (hint !== undefined) {
    throw new PayloadError('ACTION_UNSUPPORTED', `action "${action}" is unsupported: ${hint}`);
  }

  const allowed = ACTIONS_BY_CONTRACT[name];
  if (!(allowed as readonly string[]).includes(action)) {
    throw new PayloadError(
      'INVALID_ENVELOPE',
      `unknown action "${action}" for contract "${name}" (expected one of: ${allowed.join(', ')})`,
    );
  }

  if (!isObject(params)) {
    throw new PayloadError('INVALID_PARAMS', 'params (or contractPayload) must be an object');
  }

  const actionName = action as ActionName;
  const validated = (PARAM_SCHEMAS[name] as Record<ActionName, z.ZodTypeAny>)[actionName].safeParse(
    params,
  );
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ');
    throw new PayloadError('INVALID_PARAMS', issues);
  }

  // Batch ceilings are structural (they bound work before the VM sees the payload) —
  // the `nft` transfer/burn batch shape (`nfts: [...]`) exists only on that contract.
  if (name === 'nft' && (actionName === 'transfer' || actionName === 'burn')) {
    try {
      requireBatchLimit((validated.data as { nfts: z.infer<typeof NftGroups> }).nfts);
    } catch (err) {
      throw new PayloadError('BATCH_TOO_LARGE', (err as Error).message);
    }
  }

  return { contract: name, action: actionName, params: validated.data as Record<string, unknown> };
}

/**
 * Entities each action is allowed to mutate (defense-in-depth allow list,
 * scoped per contract — several action names appear in more than one list).
 * Fee-bearing actions may additionally move `balance` rows (payer → treasury), and
 * `nft.fillOrder` moves them as marketplace settlement (buyer → seller + royalty + treasury).
 */
export const ACTION_ENTITY_ALLOWLIST: {
  nft: Record<NftActionName, readonly string[]>;
  tokens: Record<TokenActionName, readonly string[]>;
  engine: Record<EngineActionName, readonly string[]>;
  market: Record<MarketActionName, readonly string[]>;
} = {
  nft: {
    create: ['collection', 'account', 'balance'],
    updateUrl: ['collection'],
    updateMetadata: ['collection'],
    updateName: ['collection'],
    updateOrgName: ['collection'],
    updateProductName: ['collection'],
    addAuthorizedIssuingAccounts: ['collection'],
    removeAuthorizedIssuingAccounts: ['collection'],
    addAuthorizedIssuingContracts: ['collection'],
    removeAuthorizedIssuingContracts: ['collection'],
    transferOwnership: ['collection', 'account'],
    addProperty: ['collection', 'balance'],
    setPropertyPermissions: ['collection'],
    setProperties: ['instance'],
    setGroupBy: ['collection'],
    updatePropertyDefinition: ['collection'],
    issue: ['collection', 'instance', 'account', 'balance'],
    issueMultiple: ['collection', 'instance', 'account', 'balance'],
    transfer: ['instance', 'account'],
    burn: ['collection', 'instance'],
    placeOrder: ['order', 'instance', 'account', 'meta'],
    fillOrder: ['order', 'instance', 'account', 'balance'],
    cancelOrder: ['order', 'instance'],
    // `meta` is only touched by counter increments, never by account/collection code paths.
  },
  tokens: {
    create: ['token', 'account', 'balance'],
    issue: ['token', 'balance', 'account'],
    transfer: ['balance', 'account'],
    burn: ['token', 'balance'],
    updateUrl: ['token'],
    updateMetadata: ['token'],
    transferOwnership: ['token', 'account'],
    updatePrecision: ['token'],
    // `param` stays closed to every tokens action — only `engine.setParam` writes it.
  },
  engine: {
    setParam: ['param'],
  },
  market: {
    // Matching moves balance legs (escrow debit, settlement, treasury fee) and the
    // order book itself; `meta` carries the market order-id counter and the synthetic
    // per-account open-order count the VM reads for its cap check.
    buy: ['marketOrder', 'balance', 'meta', 'account'],
    sell: ['marketOrder', 'balance', 'meta', 'account'],
    // Cancel only refunds the escrow and closes the row — no counter, no new accounts.
    cancel: ['marketOrder', 'balance'],
  },
};

/** Hard ceiling on raw payload size (DoS protection before parsing). */
export const MAX_PAYLOAD_BYTES = 16 * 1024;
