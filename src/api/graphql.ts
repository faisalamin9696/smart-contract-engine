import { ApolloServer, HeaderMap, type HTTPGraphQLRequest } from '@apollo/server';
import { GraphQLError, GraphQLScalarType, Kind, type DocumentNode, type FragmentDefinitionNode, type SelectionNode, type ValidationContext, type ValueNode } from 'graphql';
import type { NextFunction, Request, Response } from 'express';

import {
  getAccount,
  getCollection,
  getInstance,
  getOrder,
  getParam,
  getToken,
  type EngineStore,
} from '../state/store';
import type { Indexer } from '../indexer/indexer';
import type { Logger } from '../logger';

/** Pagination ceiling — deep offsets are a DoS vector on a public endpoint. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/* ------------------------------------------------------- query cost ceilings */
/**
 * Per-request query-cost caps (SECURITY.md → "Query complexity"). GraphQL
 * validation already bounds *depth* to the schema's shape; the caps that earn
 * their keep here are **alias breadth** (N copies of a list field = N×100 rows
 * read) and directive counts. Depth is kept as defence-in-depth for future
 * schema growth and fragment tricks. Pure constants — tuning them is a code
 * change, not an env knob, so behaviour is identical on every node.
 */
export const MAX_QUERY_DEPTH = 15;
export const MAX_QUERY_ALIASES = 50;
export const MAX_QUERY_DIRECTIVES = 100;

export interface QueryCost {
  /** Deepest field nesting reached (fragment spreads resolved, cycles guarded). */
  depth: number;
  /** Aliased fields — the breadth multiplier stacked on top of list sizes. */
  aliases: number;
  /** Total @include/@skip directives (parse/validate CPU). */
  directives: number;
}

/**
 * Measures what a parsed operation actually costs us. Fragment definitions are
 * followed — an attacker would otherwise hide breadth inside fragments — with a
 * per-path cycle guard so self-referential fragments terminate (and are rejected
 * by validation anyway).
 */
export function analyzeQuery(document: DocumentNode): QueryCost {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  }
  let depth = 0;
  let aliases = 0;
  let directives = 0;

  const walk = (selections: readonly SelectionNode[], current: number, spreads: ReadonlySet<string>): void => {
    for (const selection of selections) {
      if (selection.kind === Kind.FIELD) {
        if (selection.alias) aliases += 1;
        directives += selection.directives?.length ?? 0;
        const next = current + 1;
        if (next > depth) depth = next;
        if (selection.selectionSet) walk(selection.selectionSet.selections, next, spreads);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        directives += selection.directives?.length ?? 0;
        walk(selection.selectionSet.selections, current, spreads);
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        directives += selection.directives?.length ?? 0;
        if (spreads.has(selection.name.value)) continue; // cycle guard
        const fragment = fragments.get(selection.name.value);
        if (!fragment) continue; // unresolved — validation rejects it anyway
        const next = new Set(spreads).add(selection.name.value);
        walk(fragment.selectionSet.selections, current, next);
      }
    }
  };

  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) walk(definition.selectionSet.selections, 0, new Set());
  }
  return { depth, aliases, directives };
}

/**
 * Validation rule enforcing {@link analyzeQuery}'s ceilings. Reporting through
 * `context.reportError` (instead of throwing mid-pipeline) makes graphql-js
 * fail validation normally: the request is answered **400** with the error's
 * `BAD_USER_INPUT` code and *no resolver ever runs*.
 */
export function queryCostRule(context: ValidationContext) {
  let checked = false;
  return {
    OperationDefinition(): void {
      if (checked) return; // analyzeQuery measures the whole document at once
      checked = true;
      const cost = analyzeQuery(context.getDocument());
      if (
        cost.depth > MAX_QUERY_DEPTH ||
        cost.aliases > MAX_QUERY_ALIASES ||
        cost.directives > MAX_QUERY_DIRECTIVES
      ) {
        context.reportError(
          new GraphQLError(
            `query rejected: depth ${cost.depth}/${MAX_QUERY_DEPTH}, aliases ${cost.aliases}/${MAX_QUERY_ALIASES}, directives ${cost.directives}/${MAX_QUERY_DIRECTIVES}`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          ),
        );
      }
    },
  };
}

export interface GraphQLContext {
  store: EngineStore;
  indexer: Indexer;
  storage: 'postgres' | 'memory';
}

const typeDefs = /* GraphQL */ `
  scalar JSON

  enum OrderStatus {
    OPEN
    FILLED
    CANCELLED
  }

  enum TxStatus {
    APPLIED
    FAILED
    IGNORED
  }

  "NFT series definition."
  type Collection {
    symbol: String!
    name: String!
    issuer: String!
    "Project URL (wiki updateUrl)"
    url: String!
    "Company/organization (wiki updateOrgName)"
    orgName: String!
    "Product/brand (wiki updateProductName)"
    productName: String!
    "0 = unlimited"
    maxSupply: String!
    "Tokens ever issued — the id sequence"
    supply: String!
    burned: String!
    "supply - burned"
    circulatingSupply: String!
    "Accounts allowed to issue (max 10)"
    authorizedIssuingAccounts: [String!]!
    "Smart contracts allowed to issue (max 10)"
    authorizedIssuingContracts: [String!]!
    "Declared data-property schemas, keyed by property name"
    properties: JSON!
    "Market grouping (set once; empty = not yet set)"
    groupBy: [String!]!
    royaltyBps: String!
    royaltyRecipient: String!
    "Free-form token metadata (wiki updateMetadata)"
    metadata: JSON!
    createdAtBlock: Int!
    createdAt: String!
    instances(limit: Int = 20, offset: Int = 0): [Instance!]!
    instanceCount: Int!
  }

  "A single minted NFT."
  type Instance {
    "Wiki token id — unique per symbol; combine with symbol for a global reference"
    id: String!
    symbol: String!
    seq: Int!
    owner: String!
    properties: JSON!
    listedOrderId: String
    "Previous holder, set after the first transfer/sale"
    previousAccount: String
    createdAtBlock: Int!
    createdAt: String!
    collection: Collection
  }

  type Account {
    name: String!
    createdAtBlock: Int!
    createdAt: String!
    instances(limit: Int = 20, offset: Int = 0): [Instance!]!
    instanceCount: Int!
  }

  "Fungible token row (wiki tokens contract)."
  type Token {
    symbol: String!
    name: String!
    "Decimal places (0-8)"
    precision: Int!
    "0 = unlimited"
    maxSupply: String!
    "Issued minus burned (decimal string)"
    supply: String!
    issuer: String!
    url: String!
    "Free-form metadata (plain string, at most 1000 chars)"
    metadata: String!
    createdAtBlock: Int!
    createdAt: String!
  }

  "One holder's balance for one token (keyed account + symbol)."
  type Balance {
    account: String!
    symbol: String!
    quantity: String!
  }

  "In-state engine parameters: admin, treasury and the fee schedule."
  type Params {
    admin: String!
    treasury: String!
    fees: FeeSchedule!
    "Symbols accepted for fee payment (chargeFee validation)"
    feeTokens: [String!]!
  }

  "Fee schedule charged on state-changing actions."
  type FeeSchedule {
    nftCreationFee: String!
    addPropertyFee: String!
    tokenCreationFee: String!
    issueFee: String!
    "Marketplace fill fee in basis points, credited to the treasury"
    fillOrderFeeBps: String!
  }

  type Settlement {
    price: String!
    royalty: String!
    fee: String
    sellerProceeds: String!
    royaltyRecipient: String!
    buyer: String!
    seller: String!
  }

  "Marketplace order (list / fill / cancel)."
  type Order {
    id: String!
    symbol: String!
    instanceId: String!
    seller: String!
    price: String!
    priceSymbol: String!
    status: OrderStatus!
    royaltyBps: String!
    royaltyRecipient: String!
    createdAtBlock: Int!
    updatedAtBlock: Int!
    filledAtBlock: Int
    fillBy: String
    settlement: Settlement
    instance: Instance
  }

  "Deterministic execution trace of one operation."
  type TransactionLog {
    id: String!
    height: Int!
    blockId: String!
    txId: String!
    opIndex: Int!
    action: String!
    actor: String!
    authLevel: String!
    symbol: String
    instanceId: String
    status: TxStatus!
    params: JSON!
    error: JSON
    mutations: JSON
    events: JSON
    timestamp: String!
  }

  type Block {
    height: Int!
    blockId: String!
    previous: String!
    timestamp: String!
    txCount: Int!
    opCount: Int!
    appliedAt: String!
  }

  type EngineStats {
    blocksApplied: Int!
    blocksRolledBack: Int!
    opsApplied: Int!
    opsFailed: Int!
    reorgs: Int!
    lastBlockAt: String
    consecutiveFailures: Int!
  }

  type EngineStatus {
    running: Boolean!
    headHeight: Int!
    cursorHeight: Int!
    sandbox: String!
    storage: String!
    undoDepth: Int!
    redoSize: Int!
    stats: EngineStats!
  }

  type Query {
    collections(limit: Int = ${DEFAULT_LIMIT}, offset: Int = 0): [Collection!]!
    collection(symbol: String!): Collection
    instances(owner: String, symbol: String, limit: Int = ${DEFAULT_LIMIT}, offset: Int = 0): [Instance!]!
    instance(id: String!, symbol: String): Instance
    account(name: String!): Account
    tokens(issuer: String, limit: Int = ${DEFAULT_LIMIT}, offset: Int = 0): [Token!]!
    token(symbol: String!): Token
    balances(
      account: String!
      symbol: String
      limit: Int = ${DEFAULT_LIMIT}
      offset: Int = 0
    ): [Balance!]!
    params: Params
    orders(status: OrderStatus, symbol: String, seller: String, limit: Int = ${DEFAULT_LIMIT}, offset: Int = 0): [Order!]!
    order(id: String!): Order
    logs(actor: String, instanceId: String, symbol: String, height: Int, status: TxStatus, limit: Int = ${DEFAULT_LIMIT}, offset: Int = 0): [TransactionLog!]!
    block(height: Int!): Block
    latestBlock: Block
    status: EngineStatus!
  }
`;

/* ------------------------------------------------------------------ JSON scalar */

function astToJson(node: ValueNode): unknown {
  switch (node.kind) {
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.INT:
      return Number.parseInt(node.value, 10);
    case Kind.FLOAT:
      // Literals with a decimal point are refused: the engine never emits them.
      throw new GraphQLError('floating point literals are not supported (determinism)');
    case Kind.BOOLEAN:
      return node.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map(astToJson);
    case Kind.OBJECT: {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name.value] = astToJson(field.value);
      return out;
    }
    default:
      throw new GraphQLError(`unsupported literal kind: ${node.kind}`);
  }
}

const JSONScalar = new GraphQLScalarType<unknown, unknown>({
  name: 'JSON',
  description: 'Arbitrary JSON value (integers only — floats are rejected for determinism).',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: astToJson,
});

/* ------------------------------------------------------------------- helpers */

function clampLimit(limit: number | null | undefined): number {
  const n = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n < 1) throw new GraphQLError('limit must be a positive integer');
  return Math.min(n, MAX_LIMIT);
}

function clampOffset(offset: number | null | undefined): number {
  const n = offset ?? 0;
  if (!Number.isInteger(n) || n < 0) throw new GraphQLError('offset must be a non-negative integer');
  return n;
}

/* ------------------------------------------------------------------ resolvers */

function buildResolvers() {
  return {
    JSON: JSONScalar,

    Query: {
      collections: (_: unknown, args: { limit?: number; offset?: number }, ctx: GraphQLContext) =>
        ctx.store.listCollections(clampLimit(args.limit), clampOffset(args.offset)),

      collection: (_: unknown, args: { symbol: string }, ctx: GraphQLContext) =>
        getCollection(ctx.store, args.symbol),

      instances: (
        _: unknown,
        args: { owner?: string; symbol?: string; limit?: number; offset?: number },
        ctx: GraphQLContext,
      ) =>
        ctx.store.listInstances({
          owner: args.owner ?? undefined,
          symbol: args.symbol ?? undefined,
          limit: clampLimit(args.limit),
          offset: clampOffset(args.offset),
        }),

      instance: (
        _: unknown,
        args: { id: string; symbol?: string },
        ctx: GraphQLContext,
      ) => getInstance(ctx.store, args.id, args.symbol ?? undefined),

      account: (_: unknown, args: { name: string }, ctx: GraphQLContext) =>
        getAccount(ctx.store, args.name),

      tokens: (
        _: unknown,
        args: { issuer?: string; limit?: number; offset?: number },
        ctx: GraphQLContext,
      ) =>
        ctx.store.listTokens({
          issuer: args.issuer ?? undefined,
          limit: clampLimit(args.limit),
          offset: clampOffset(args.offset),
        }),

      token: (_: unknown, args: { symbol: string }, ctx: GraphQLContext) =>
        getToken(ctx.store, args.symbol),

      balances: (
        _: unknown,
        args: { account: string; symbol?: string; limit?: number; offset?: number },
        ctx: GraphQLContext,
      ) =>
        ctx.store.listBalances({
          account: args.account,
          symbol: args.symbol ?? undefined,
          limit: clampLimit(args.limit),
          offset: clampOffset(args.offset),
        }),

      params: (_: unknown, __: unknown, ctx: GraphQLContext) => getParam(ctx.store),

      orders: (
        _: unknown,
        args: { status?: string; symbol?: string; seller?: string; limit?: number; offset?: number },
        ctx: GraphQLContext,
      ) =>
        ctx.store.listOrders({
          status: (args.status ?? undefined) as never,
          symbol: args.symbol ?? undefined,
          seller: args.seller ?? undefined,
          limit: clampLimit(args.limit),
          offset: clampOffset(args.offset),
        }),

      order: (_: unknown, args: { id: string }, ctx: GraphQLContext) =>
        getOrder(ctx.store, args.id),

      logs: (
        _: unknown,
        args: {
          actor?: string;
          instanceId?: string;
          symbol?: string;
          height?: number;
          status?: string;
          limit?: number;
          offset?: number;
        },
        ctx: GraphQLContext,
      ) =>
        ctx.store.listLogs({
          actor: args.actor ?? undefined,
          instanceId: args.instanceId ?? undefined,
          symbol: args.symbol ?? undefined,
          height: args.height,
          status: (args.status ?? undefined) as never,
          limit: clampLimit(args.limit),
          offset: clampOffset(args.offset),
        }),

      block: (_: unknown, args: { height: number }, ctx: GraphQLContext) =>
        ctx.store.getBlock(args.height),

      latestBlock: (_: unknown, __: unknown, ctx: GraphQLContext) => ctx.store.getLatestBlock(),

      status: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
        const status = ctx.indexer.status() as {
          running: boolean;
          headHeight: number;
          sandbox: string;
          buffer: { undoDepth: number; redoSize: number };
          stats: Record<string, number | string | null>;
        };
        const cursor = await ctx.indexer.cursor();
        return {
          running: status.running,
          headHeight: status.headHeight,
          cursorHeight: cursor?.height ?? 0,
          sandbox: status.sandbox,
          storage: ctx.storage,
          undoDepth: status.buffer.undoDepth,
          redoSize: status.buffer.redoSize,
          stats: status.stats,
        };
      },
    },

    Collection: {
      instances: (
        parent: { symbol: string },
        args: { limit?: number; offset?: number },
        ctx: GraphQLContext,
      ) =>
        ctx.store.listInstances({
          symbol: parent.symbol,
          limit: clampLimit(args.limit),
          offset: clampOffset(args.offset),
        }),
      instanceCount: (parent: { symbol: string }, _: unknown, ctx: GraphQLContext) =>
        ctx.store.countInstances({ symbol: parent.symbol }),
    },

    Instance: {
      collection: (parent: { symbol: string }, _: unknown, ctx: GraphQLContext) =>
        getCollection(ctx.store, parent.symbol),
    },

    Account: {
      instances: (
        parent: { name: string },
        args: { limit?: number; offset?: number },
        ctx: GraphQLContext,
      ) =>
        ctx.store.listInstances({
          owner: parent.name,
          limit: clampLimit(args.limit),
          offset: clampOffset(args.offset),
        }),
      instanceCount: (parent: { name: string }, _: unknown, ctx: GraphQLContext) =>
        ctx.store.countInstances({ owner: parent.name }),
    },

    Order: {
      instance: (parent: { instanceId: string }, _: unknown, ctx: GraphQLContext) =>
        getInstance(ctx.store, parent.instanceId),
    },
  };
}

/* ------------------------------------------------------------------- factory */

export interface GraphQLDeps {
  store: EngineStore;
  indexer: Indexer;
  storage: 'postgres' | 'memory';
  logger: Logger;
}

export type GraphQLHandler = (req: Request, res: Response, next: NextFunction) => void;

export interface GraphQLHandle {
  server: ApolloServer<GraphQLContext>;
  /** Ready-to-mount express handler (context is bound at construction). */
  handler: GraphQLHandler;
}

function toHeaderMap(req: Request): HeaderMap {
  const headers = new HeaderMap();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/**
 * Minimal express adapter around `executeHTTPGraphQLRequest`.
 *
 * Apollo Server 5 ships no express integration (the v4 `express4` entrypoint was
 * removed), so we bridge the supported low-level HTTP API ourselves: parse once, forward
 * headers/query/body, then stream the response back verbatim.
 */
function createHandler(
  server: ApolloServer<GraphQLContext>,
  context: () => Promise<GraphQLContext>,
): GraphQLHandler {
  return (req, res, next) => {
    void (async () => {
      const url = req.originalUrl || req.url;
      const queryIndex = url.indexOf('?');
      const search = queryIndex >= 0 ? url.slice(queryIndex + 1) : '';
      const httpGraphQLRequest: HTTPGraphQLRequest = {
        method: req.method,
        headers: toHeaderMap(req),
        search,
        body: req.body,
      };
      const response = await server.executeHTTPGraphQLRequest({
        httpGraphQLRequest,
        context,
      });
      res.status(response.status ?? 200);
      for (const [key, value] of response.headers) res.setHeader(key, value);
      if (response.body.kind === 'complete') {
        res.send(response.body.string);
        return;
      }
      // Incremental delivery (defer/stream): pipe chunks as they are produced.
      for await (const chunk of response.body.asyncIterator) {
        res.write(chunk);
      }
      res.end();
    })().catch(next);
  };
}

export async function createGraphQL(deps: GraphQLDeps): Promise<GraphQLHandle> {
  const logger = deps.logger;
  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers: buildResolvers(),
    introspection: true,
    includeStacktraceInErrorResponses: false,
    validationRules: [queryCostRule],
    plugins: [
      {
        async requestDidStart() {
          return {
            async didEncounterErrors({ errors }) {
              for (const error of errors) {
                logger.warn('graphql error', { message: error.message });
              }
            },
          };
        },
      },
    ],
  });
  await server.start();
  const handler = createHandler(server, async () => ({
    store: deps.store,
    indexer: deps.indexer,
    storage: deps.storage,
  }));
  return { server, handler };
}
