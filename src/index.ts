import { FailoverRpc } from './chain/rpc';
import { startApi } from './api/server';
import { loadConfig, type Config } from './config';
import { createPrismaClient, pingDatabase } from './db/prisma';
import { PrismaStateStore } from './db/prismaStateStore';
import { EngineEventBus } from './indexer/events';
import { Indexer } from './indexer/indexer';
import { ConsoleLogger, type Logger } from './logger';
import { MemoryStore } from './state/memoryStore';
import type { EngineStore } from './state/store';
import { createSandbox, type Sandbox } from './vm/sandbox';
import { maskDatabaseUrl } from './utils/redact';

type Storage = 'postgres' | 'memory';

async function createStore(config: Config, logger: Logger): Promise<{ store: EngineStore; storage: Storage }> {
  // Explicit in-process store (tests/demo). Never touches a database.
  if (config.storage === 'memory') {
    logger.warn('STORAGE=memory — state is kept in-process and lost on restart');
    return { store: new MemoryStore(), storage: 'memory' };
  }

  // Production mode: no silent fallback. A missing URL or an unreachable server must stop
  // the engine rather than let it serve (and silently discard) in-memory state.
  if (config.storage === 'postgres' && !config.databaseUrl) {
    throw new Error('STORAGE=postgres requires DATABASE_URL to be set');
  }

  if (!config.databaseUrl) {
    logger.error(
      'DATABASE_URL is not set — falling back to the in-memory store; all state is lost on restart',
      { storage: config.storage, hint: 'set DATABASE_URL in the Dokploy Environment tab and redeploy' },
    );
    return { store: new MemoryStore(), storage: 'memory' };
  }

  const client = createPrismaClient(config.databaseUrl);
  if (!(await pingDatabase(client))) {
    await client.$disconnect();
    throw new Error(`cannot reach PostgreSQL at ${maskDatabaseUrl(config.databaseUrl)}`);
  }
  logger.info('connected to PostgreSQL', { target: maskDatabaseUrl(config.databaseUrl) });
  return { store: PrismaStateStore.root(client), storage: 'postgres' };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new ConsoleLogger(config.logLevel, { service: 'sce-engine' });

  const { store, storage } = await createStore(config, logger);

  // The sandbox is compiled once at boot; every operation reuses the same isolate/script so
  // execution cost stays flat and behaviour is identical across blocks.
  const sandbox: Sandbox = await createSandbox({
    provider: config.sandboxProvider,
    timeoutMs: config.sandboxTimeoutMs,
    memoryLimitMb: config.sandboxMemoryLimitMb,
    logger,
  });
  logger.info('contract sandbox ready', { provider: sandbox.provider });

  const bus = new EngineEventBus();
  const rpc = new FailoverRpc(config.rpcEndpoints, {
    timeoutMs: 15_000,
    cooldownMs: 30_000,
    quorumDepth: config.quorumVerifyDepth,
    logger,
  });

  const indexer = new Indexer(
    store,
    rpc,
    sandbox,
    bus,
    {
      pollIntervalMs: config.blockPollIntervalMs,
      undoBufferDepth: config.undoBufferDepth,
      opId: config.opId,
      startBlockHeight: config.startBlockHeight,
      failOnDeepFork: config.failOnDeepFork,
    },
    logger,
  );

  const api = await startApi({ config, store, indexer, bus, storage, logger });

  // Start ingestion only after the APIs are reachable, so a freshly started replica never
  // serves stale reads while it is still wiring up.
  await indexer.start();

  logger.info('engine ready', {
    storage,
    sandbox: sandbox.provider,
    httpPort: api.port,
    wsPort: api.wsPort,
    opId: config.opId,
    endpoints: config.rpcEndpoints,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown requested', { signal });
    const timeout = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 15_000);
    timeout.unref?.();
    try {
      // Order matters: stop ingesting first, then close consumers, then resources.
      await indexer.stop();
      await api.close();
      await sandbox.dispose();
      await store.close();
      logger.info('shutdown complete', { signal });
      process.exit(0);
    } catch (error) {
      logger.error('shutdown failed', { error: (error as Error).message });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception — shutting down', { error: error.message });
    void shutdown('uncaughtException');
  });
}

main().catch((error: Error) => {
  // Startup failures are fatal: without a store/indexer there is nothing to serve.
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'engine failed to start',
      error: error.message,
      stack: error.stack,
    }) + '\n',
  );
  process.exit(1);
});
