import http from 'node:http';

import compression from 'compression';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import type { Config } from '../config';
import type { Logger } from '../logger';
import type { EngineEventBus } from '../indexer/events';
import type { Indexer } from '../indexer/indexer';
import type { EngineStore } from '../state/store';
import { createGraphQL, type GraphQLHandle } from './graphql';
import { createRateLimiter } from './rateLimit';
import { createRestRouter, restErrorHandler } from './rest';
import { WebSocketHub } from './ws';

export interface ApiDeps {
  config: Config;
  store: EngineStore;
  indexer: Indexer;
  bus: EngineEventBus;
  storage: 'postgres' | 'memory';
  logger: Logger;
}

export interface ApiServer {
  /** HTTP port actually bound (null when both REST and GraphQL are disabled). */
  port: number | null;
  /** WebSocket port actually bound. */
  wsPort: number | null;
  close(): Promise<void>;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => reject(error);
    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      const address = server.address();
      resolve(address && typeof address === 'object' ? address.port : port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    // Drop keep-alive sockets first so shutdown never waits on idle clients.
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * HTTP + WebSocket surface of the engine.
 *
 * Three independent endpoints are exposed:
 *   - REST    `GET /api/v1/...`     (REST_ENABLED)
 *   - GraphQL `POST /graphql`       (GRAPHQL_ENABLED)
 *   - WebSocket push notifications  (WS_PORT)
 *
 * plus `GET /health` for orchestrators. All of them are read-only projections over the
 * same committed state; nothing here can mutate the ledger.
 */
export async function startApi(deps: ApiDeps): Promise<ApiServer> {
  const { config, store, indexer, bus, logger } = deps;
  const log = logger.child({ component: 'api' });

  const app: Express = express();
  app.disable('x-powered-by');
  // Recover the real client IP from X-Forwarded-For trusting exactly one proxy hop.
  // `true` (trust every hop) would let a client spoof its way past the rate limiter by
  // prepending its own X-Forwarded-For values; a hop count cannot be spoofed.
  app.set('trust proxy', config.trustProxyHops);

  // Baseline security headers on every response (including errors) — this is a
  // JSON API, so: no MIME sniffing, no framing of our responses, no referrer leak.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // The API is a public, read-only surface that accepts no credentials: allow any
  // origin once, globally (REST included — browser clients third parties build on
  // this API need it; credentialed requests stay impossible because we never set
  // `credentials` and never read cookies/authorization).
  app.use(cors());

  // JSON responses compress ~5-10× — the single biggest lever for serving traffic
  // (default 1kB threshold skips tiny payloads; WebSockets are a separate server).
  app.use(compression());

  // Per-IP request budget over REST + GraphQL + discovery (/health is exempt).
  app.use(createRateLimiter({ rpm: config.rateLimitRpm }));

  app.get('/health', async (_req: Request, res: Response) => {
    const status = indexer.status() as { running: boolean; headHeight: number; sandbox: string; opId: string };
    const cursor = await indexer.cursor().catch(() => null);
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      storage: deps.storage,
      indexer: {
        running: status.running,
        headHeight: status.headHeight,
        cursorHeight: cursor?.height ?? 0,
        sandbox: status.sandbox,
        opId: status.opId,
      },
    });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'sce-engine',
      api: {
        health: 'GET /health',
        rest: config.restEnabled
          ? 'GET /api/v1/{collections,instances,accounts,orders,logs,blocks,status,state-checksum}'
          : null,
        graphql: config.graphqlEnabled ? `POST ${config.graphqlPath}` : null,
        websocket: {
          port: config.wsPort,
          subscribe: { type: 'subscribe', channels: ['*', 'account:<name>', 'collection:<SYMBOL>', 'market', 'chain'] },
        },
      },
    });
  });

  if (config.restEnabled) {
    app.use('/api/v1', createRestRouter({ store, indexer, storage: deps.storage, logger }));
  }

  let graphql: GraphQLHandle | null = null;
  if (config.graphqlEnabled) {
    graphql = await createGraphQL({ store, indexer, storage: deps.storage, logger });
    app.use(
      config.graphqlPath,
      express.json({ limit: '256kb' }),
      graphql.handler,
    );
  }

  // 404 + error funnel (must come after every route).
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `no route for ${req.method} ${req.path}` },
    });
  });
  app.use(restErrorHandler(logger));

  const server = http.createServer(app);
  // Slowloris/backpressure hygiene: every payload here is small JSON — a request
  // that has not completed within a minute is broken or hostile, and must not
  // hold a socket. (WebSockets live on a separate server with ping/pong heartbeat.)
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  const httpPort = config.restEnabled || config.graphqlEnabled ? await listen(server, config.port) : null;
  if (httpPort !== null) log.info('http server listening', { port: httpPort, graphql: config.graphqlEnabled, rest: config.restEnabled });

  const hub = new WebSocketHub(
    bus,
    { port: config.wsPort, maxClients: config.wsMaxClients },
    logger,
  );
  try {
    await hub.ready;
  } catch (error) {
    if (httpPort !== null) await closeServer(server);
    await graphql?.server.stop();
    throw error;
  }
  const wsPort = hub.port ?? config.wsPort;
  log.info('websocket server listening', { port: wsPort, clients: hub.clientCount });

  return {
    port: httpPort,
    wsPort,
    async close(): Promise<void> {
      await hub.close();
      if (httpPort !== null) await closeServer(server);
      if (graphql) await graphql.server.stop();
      log.info('api server closed');
    },
  };
}

/** Shared express error helper for ad-hoc handlers. */
export function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}
