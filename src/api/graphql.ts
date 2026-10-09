import { ApolloServer, HeaderMap, type HTTPGraphQLRequest } from '@apollo/server';
import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from 'graphql';
import type { NextFunction, Request, Response } from 'express';

import { getAccount, getCollection, getInstance, getOrder, type EngineStore } from '../state/store';
import type { Indexer } from '../indexer/indexer';
import type { Logger } from '../logger';

/** Pagination ceiling — deep offsets are a DoS vector on a public endpoint. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

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
