import { Router, type NextFunction, type Request, type Response } from 'express';

import type { Indexer } from '../indexer/indexer';
import {
  computeBookDepth,
  getAccount,
  getBookOrder,
  getCollection,
  getInstance,
  getOrder,
  getParam,
  getToken,
  listMarketTrades,
  tokenIcon,
  type EngineStore,
} from '../state/store';
import { appVersion, buildSha } from '../version';
import { computeStateChecksum } from './checksum';
import { createRateLimiter } from './rateLimit';
import type { Logger } from '../logger';

export interface RestDeps {
  store: EngineStore;
  indexer: Indexer;
  storage: 'postgres' | 'memory';
  logger: Logger;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

const ORDER_STATUSES = new Set(['OPEN', 'FILLED', 'CANCELLED']);
const BOOK_SIDES = new Set(['BUY', 'SELL']);
const TX_STATUSES = new Set(['APPLIED', 'FAILED', 'IGNORED']);

/** Express 4 does not catch rejected promises — route every handler through this. */
function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function intParam(
  req: Request,
  name: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  const min = opts.min ?? 0;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(n) || n < min || n > max) {
    throw httpError(400, 'BAD_REQUEST', `${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function strParam(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return undefined;
  return String(raw);
}

function enumParam(req: Request, name: string, allowed: Set<string>): string | undefined {
  const value = strParam(req, name);
  if (value === undefined) return undefined;
  if (!allowed.has(value)) {
    throw httpError(400, 'BAD_REQUEST', `${name} must be one of: ${[...allowed].join(', ')}`);
  }
  return value;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function httpError(status: number, code: string, message: string): HttpError {
  return new HttpError(status, code, message);
}

function page(req: Request): { limit: number; offset: number } {
  return {
    limit: intParam(req, 'limit', DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT }),
    offset: intParam(req, 'offset', 0, { min: 0 }),
  };
}

/**
 * Read-only JSON API.
 *
 * Every route maps 1:1 onto an indexed store query — no N+1 joins, no JSON scanning — so
 * the API layer stays a thin, cacheable projection over the same state the indexer
 * maintains (and rolls back atomically on a re-org).
 */
export function createRestRouter(deps: RestDeps): Router {
  const router = Router();
  const { store, indexer, storage } = deps;

  router.get(
    '/status',
    wrap(async (_req, res) => {
      const status = indexer.status() as {
        running: boolean;
        headHeight: number;
        sandbox: string;
        opId: string;
        buffer: { undoDepth: number; redoSize: number };
        stats: Record<string, number | string | null>;
      };
      const cursor = await indexer.cursor();
      res.json({
        data: {
          running: status.running,
          headHeight: status.headHeight,
          cursorHeight: cursor?.height ?? 0,
          cursorBlockId: cursor?.blockId ?? null,
          opId: status.opId,
          sandbox: status.sandbox,
          storage,
          undoDepth: status.buffer.undoDepth,
          redoSize: status.buffer.redoSize,
          stats: status.stats,
          version: appVersion,
          buildSha,
        },
      });
    }),
  );

  // ---- collections ---------------------------------------------------------

  router.get(
    '/collections',
    wrap(async (req, res) => {
      const { limit, offset } = page(req);
      const data = await store.listCollections(limit, offset);
      res.json({ data, meta: { limit, offset, count: data.length } });
    }),
  );

  router.get(
    '/collections/:symbol',
    wrap(async (req, res) => {
      const collection = await getCollection(store, req.params.symbol);
      if (!collection) throw httpError(404, 'NOT_FOUND', 'collection not found');
      res.json({ data: collection });
    }),
  );

  router.get(
    '/collections/:symbol/instances',
    wrap(async (req, res) => {
      const collection = await getCollection(store, req.params.symbol);
      if (!collection) throw httpError(404, 'NOT_FOUND', 'collection not found');
      const { limit, offset } = page(req);
      const data = await store.listInstances({ symbol: collection.symbol, limit, offset });
      const total = await store.countInstances({ symbol: collection.symbol });
      res.json({ data, meta: { limit, offset, total } });
    }),
  );

  // ---- instances -----------------------------------------------------------

  router.get(
    '/instances',
    wrap(async (req, res) => {
      const { limit, offset } = page(req);
      const owner = strParam(req, 'owner');
      const symbol = strParam(req, 'symbol');
      const data = await store.listInstances({ owner, symbol, limit, offset });
      const total = await store.countInstances({ owner, symbol });
      res.json({ data, meta: { limit, offset, total } });
    }),
  );

  router.get(
    '/instances/:id',
    wrap(async (req, res) => {
      // `:id` accepts the global reference `SYMBOL:id` (e.g. /instances/DRAGON:5).
      const instance = await getInstance(store, req.params.id);
      if (!instance) throw httpError(404, 'NOT_FOUND', 'instance not found');
      res.json({ data: instance });
    }),
  );

  router.get(
    '/instances/:symbol/:id',
    wrap(async (req, res) => {
      // Wiki-style lookup: ids are only unique per symbol.
      const instance = await getInstance(store, req.params.id, req.params.symbol);
      if (!instance) throw httpError(404, 'NOT_FOUND', 'instance not found');
      res.json({ data: instance });
    }),
  );

  // ---- accounts ------------------------------------------------------------

  router.get(
    '/accounts/:name',
    wrap(async (req, res) => {
      const account = await getAccount(store, req.params.name);
      if (!account) throw httpError(404, 'NOT_FOUND', 'account not found');
      const total = await store.countInstances({ owner: account.name });
      res.json({ data: { ...account, instanceCount: total } });
    }),
  );

  router.get(
    '/accounts/:name/instances',
    wrap(async (req, res) => {
      const { limit, offset } = page(req);
      const owner = req.params.name;
      const data = await store.listInstances({ owner, limit, offset });
      const total = await store.countInstances({ owner });
      res.json({ data, meta: { limit, offset, total } });
    }),
  );

  // ---- marketplace ---------------------------------------------------------

  router.get(
    '/orders',
    wrap(async (req, res) => {
      const { limit, offset } = page(req);
      const status = enumParam(req, 'status', ORDER_STATUSES);
      const symbol = strParam(req, 'symbol');
      const seller = strParam(req, 'seller');
      const data = await store.listOrders({
        status: status as never,
        symbol,
        seller,
        limit,
        offset,
      });
      const total = await store.countOrders({ symbol });
      res.json({ data, meta: { limit, offset, total } });
    }),
  );

  router.get(
    '/orders/:id',
    wrap(async (req, res) => {
      const order = await getOrder(store, req.params.id);
      if (!order) throw httpError(404, 'NOT_FOUND', 'order not found');
      res.json({ data: order });
    }),
  );

  // ---- market (fungible order book) ----------------------------------------

  router.get(
    '/market/orders',
    wrap(async (req, res) => {
      const { limit, offset } = page(req);
      const status = enumParam(req, 'status', ORDER_STATUSES) as never;
      const side = enumParam(req, 'side', BOOK_SIDES) as never;
      const symbol = strParam(req, 'symbol');
      const quote = strParam(req, 'quote');
      const account = strParam(req, 'account');
      const filter = { status, side, symbol, quote, account };
      const data = await store.listBookOrders({ ...filter, limit, offset });
      const total = await store.countBookOrders(filter);
      res.json({ data, meta: { limit, offset, total } });
    }),
  );

  router.get(
    '/market/orders/:id',
    wrap(async (req, res) => {
      const order = await getBookOrder(store, req.params.id);
      if (!order) throw httpError(404, 'NOT_FOUND', 'market order not found');
      res.json({ data: order });
    }),
  );

  /**
   * Aggregated depth for one pair: bids (BUY) and asks (SELL), each best price
   * first — the ladder a trading UI renders.
   */
  router.get(
    '/market/book',
    wrap(async (req, res) => {
      const symbol = strParam(req, 'symbol');
      const quote = strParam(req, 'quote');
      if (!symbol || !quote) {
        throw httpError(400, 'BAD_REQUEST', 'symbol and quote are required');
      }
      res.json({ data: await computeBookDepth(store, symbol, quote) });
    }),
  );

  /**
   * Recent fills, flattened from the `MARKET_FILLED` events of applied market ops
   * (paginated per operation — one op's fills are never split across pages).
   */
  router.get(
    '/market/trades',
    wrap(async (req, res) => {
      const { limit, offset } = page(req);
      const data = await listMarketTrades(store, {
        symbol: strParam(req, 'symbol'),
        quote: strParam(req, 'quote'),
        limit,
        offset,
      });
      res.json({ data, meta: { limit, offset, count: data.length } });
    }),
  );

  // ---- fungible tokens -----------------------------------------------------

  router.get(
    '/tokens',
    wrap(async (req, res) => {
      const { limit, offset } = page(req);
      const issuer = strParam(req, 'issuer');
      const rows = await store.listTokens({ issuer, limit, offset });
      // icon is a read-side projection of metadata.icon (see tokenIcon()).
      const data = rows.map((t) => ({ ...t, icon: tokenIcon(t.metadata) }));
      res.json({ data, meta: { limit, offset, count: data.length } });
    }),
  );

  router.get(
    '/tokens/:symbol',
    wrap(async (req, res) => {
      const token = await getToken(store, req.params.symbol);
      if (!token) throw httpError(404, 'NOT_FOUND', 'token not found');
      res.json({ data: { ...token, icon: tokenIcon(token.metadata) } });
    }),
  );

  router.get(
    '/balances',
    wrap(async (req, res) => {
      const account = strParam(req, 'account');
      const symbol = strParam(req, 'symbol');
      // Symbol-scoped reads are the holders-list view (portal token pages);
      // account-less *unscoped* reads would dump every balance row — refuse them.
      if (!account && !symbol) {
        throw httpError(400, 'BAD_REQUEST', 'account or symbol is required');
      }
      const orderParam = strParam(req, 'order');
      if (orderParam !== undefined && orderParam !== 'account' && orderParam !== 'quantity') {
        throw httpError(400, 'BAD_REQUEST', "order must be 'account' or 'quantity'");
      }
      const order = orderParam ?? 'account';
      const { limit, offset } = page(req);
      const data = await store.listBalances({ account, symbol, order, limit, offset });
      const total = await store.countBalances({ account, symbol });
      res.json({ data, meta: { limit, offset, total } });
    }),
  );

  router.get(
    '/params',
    wrap(async (_req, res) => {
      const params = await getParam(store);
      if (!params) throw httpError(404, 'NOT_FOUND', 'params not found');
      res.json({ data: params });
    }),
  );

  // ---- history -------------------------------------------------------------

  router.get(
    '/logs',
    wrap(async (req, res) => {
      const { limit, offset } = page(req);
      const actor = strParam(req, 'actor');
      const instanceId = strParam(req, 'instanceId');
      const symbol = strParam(req, 'symbol');
      const status = enumParam(req, 'status', TX_STATUSES);
      const heightRaw = strParam(req, 'height');
      let height: number | undefined;
      if (heightRaw !== undefined) {
        height = intParam(req, 'height', 0, { min: 0 });
      }
      const data = await store.listLogs({
        actor,
        instanceId,
        symbol,
        height,
        status: status as never,
        limit,
        offset,
      });
      res.json({ data, meta: { limit, offset, count: data.length } });
    }),
  );

  router.get(
    '/blocks/latest',
    wrap(async (_req, res) => {
      const block = await store.getLatestBlock();
      if (!block) throw httpError(404, 'NOT_FOUND', 'no blocks indexed yet');
      res.json({ data: block });
    }),
  );

  router.get(
    '/blocks/:height',
    wrap(async (req, res) => {
      const height = Number.parseInt(req.params.height, 10);
      if (!Number.isInteger(height) || height < 0) {
        throw httpError(400, 'BAD_REQUEST', 'height must be a non-negative integer');
      }
      const block = await store.getBlock(height);
      if (!block) throw httpError(404, 'NOT_FOUND', 'block not found');
      res.json({ data: block });
    }),
  );

  // ---- cross-node verification ---------------------------------------------

  // Dedicated, much lower budget than the generic 600 rpm per-IP limiter: one
  // request fans out into full-table scans over six entities, so cap the route
  // itself (single-flight coalescing + the digest's snapshot cache in checksum.ts
  // collapse repeat polls, and this bound caps what one IP can restart per minute).
  const stateChecksumLimiter = createRateLimiter({ rpm: 12, burst: 12 });

  /**
   * Deterministic fingerprint of the committed ledger (docs/NODE-OPERATOR.md):
   * operators running their own engine compare this against a reference node at the
   * same cursor height to prove their state matches the network — no trust required.
   * Full-table digest computed inside one repeatable-read snapshot (rows + cursor
   * bound together), so treat it as a verification call, not a hot path.
   */
  router.get(
    '/state-checksum',
    stateChecksumLimiter,
    wrap(async (_req, res) => {
      res.json({ data: await computeStateChecksum(store, storage) });
    }),
  );

  return router;
}

/** Express error middleware (must be registered last, after all routes). */
export function restErrorHandler(logger: Logger) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    const error = err as Error;
    logger.error('rest api error', { message: error?.message ?? String(err) });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal server error' } });
  };
}
