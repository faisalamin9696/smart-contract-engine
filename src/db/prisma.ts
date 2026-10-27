import { PrismaClient } from '@prisma/client';

/**
 * Creates the Prisma client.
 *
 * The URL is taken from `DATABASE_URL` (validated by the config loader). When it is not
 * configured the engine falls back to the in-memory store, so a demo/test run never needs a
 * database, but a production deployment always has one.
 */
export function createPrismaClient(databaseUrl?: string | null): PrismaClient {
  return new PrismaClient(
    databaseUrl
      ? { datasources: { db: { url: databaseUrl } } }
      : undefined,
  );
}

/** Cheap boot-time connectivity probe (called from src/index.ts); the health
 * endpoint tracks store reachability through the indexer cursor read instead. */
export async function pingDatabase(client: PrismaClient): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
