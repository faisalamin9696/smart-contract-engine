import type { PrismaClient } from '@prisma/client';

import { PrismaStateStore } from '../../src/db/prismaStateStore';

/**
 * `acquireIndexLock` is the only raw SQL in the persistence layer, and its original
 * form returned PostgreSQL's `void` — a column type Prisma refuses to deserialize,
 * which made *every* block apply throw before a single block could be stored
 * ("Failed to deserialize column of type 'void'"). These tests pin the boolean
 * try-lock contract: poll, wait, give up with a precise error — no database needed.
 */
describe('PrismaStateStore.acquireIndexLock', () => {
  const makeStore = () => {
    const queryRaw = jest.fn();
    const client = { $queryRaw: queryRaw } as unknown as PrismaClient;
    return { store: PrismaStateStore.root(client), queryRaw };
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns as soon as the lock is granted', async () => {
    const { store, queryRaw } = makeStore();
    queryRaw.mockResolvedValueOnce([{ locked: true }]);

    await store.acquireIndexLock();

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  test('keeps polling while another process holds the lock', async () => {
    const { store, queryRaw } = makeStore();
    queryRaw
      .mockResolvedValueOnce([{ locked: false }])
      .mockResolvedValueOnce([{ locked: false }])
      .mockResolvedValueOnce([{ locked: true }]);

    await store.acquireIndexLock();

    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  test('gives up with a precise error instead of hanging the transaction', async () => {
    jest.useFakeTimers();
    const { store, queryRaw } = makeStore();
    queryRaw.mockResolvedValue([{ locked: false }]);

    const pending = store.acquireIndexLock();
    pending.catch(() => undefined); // attach early; asserted below

    await jest.advanceTimersByTimeAsync(56_000);

    await expect(pending).rejects.toThrow(
      /timed out after 55000ms waiting for the block-processing lock/,
    );
    // Polled roughly every 100ms for the full window before giving up.
    expect(queryRaw.mock.calls.length).toBeGreaterThan(500);
  });
});
