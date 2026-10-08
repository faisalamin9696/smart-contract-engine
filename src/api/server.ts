import http from 'node:http';

import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import type { Config } from '../config';
import type { Logger } from '../logger';
import type { EngineEventBus } from '../indexer/events';
import type { Indexer } from '../indexer/indexer';
import type { EngineStore } from '../state/store';
import { createGraphQL, type GraphQLHandle } from './graphql';
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
  app.set('trust proxy', true);

  app.get('/health', async (_req: Request, res: Response) => {
    const status = indexer.status() as { running: boolean; headHeight: number; sandbox: string };
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
      },
    });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'sce-engine',
      api: {
        health: 'GET /health',
        rest: config.restEnabled ? 'GET /api/v1/{collections,instances,accounts,orders,logs,blocks,status}' : null,
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
      cors(),
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
  const httpPort = config.restEnabled || config.graphqlEnabled ? await listen(server, config.port) : null;
  if (httpPort !== null) log.info('http server listening', { port: httpPort, graphql: config.graphqlEnabled, rest: config.restEnabled });

  const hub = new WebSocketHub(bus, { port: config.wsPort }, logger);
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
