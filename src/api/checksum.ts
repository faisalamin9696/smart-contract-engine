import { createHash } from 'node:crypto';

import type { EngineStore } from '../state/store';
import { getParam } from '../state/store';
import { balanceKey, instanceKey } from '../types/domain';
import { stableStringify } from '../utils/canonical';

const PAGE_SIZE = 100;
/** Safety valve: a runaway store should fail loudly, not stream forever. */
const MAX_ROWS = 5_000_000;
/**
 * The whole digest (cursor included) runs inside one repeatable-read transaction.
 * Walking a large ledger can take minutes, so let the row valve — not the 60s
 * block-application transaction budget — be the thing that fails first.
 */
const TX_TIMEOUT_MS = 300_000;
/** Bounded retries if a backend silently fails to honour the requested isolation. */
const MAX_ATTEMPTS = 3;

/**
 * Journaled meta counters folded into the digest. `order_seq` allocates NFT
 * marketplace order ids and `market_order_seq` allocates fungible book order ids —
 * a node whose counter diverged would mint colliding ids later, so the counters
 * themselves must be verifiable. Extend this list whenever the contract starts
 * writing a new `meta` key.
 */
const META_KEYS = ['order_seq', 'market_order_seq'] as const;

export interface StateChecksum {
  /** Cursor height the checksum was computed at — compare only at equal heights. */
  height: number;
  storage: 'postgres' | 'memory';
  /** Per-entity sha256 digests so a diverging node can pinpoint the table. */
  entities: Record<string, string>;
  /** Digest of all entity digests — equal on every honest node at the same height. */
  checksum: string;
}

type Row = { key: string; value: unknown };

/** Raised when the digest snapshot proves its own cursor moved mid-computation. */
class TornDigestError extends Error {
  constructor() {
    super('state-checksum: cursor advanced inside the digest transaction (isolation not honoured)');
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

async function collect(
  fetch: (limit: number, offset: number) => Promise<unknown[]>,
  keyOf: (row: Record<string, unknown>) => string,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    if (rows.length > MAX_ROWS) throw new Error(`state-checksum aborted: entity exceeds ${MAX_ROWS} rows`);
    const page = await fetch(PAGE_SIZE, offset);
    for (const row of page) rows.push({ key: keyOf(row as Record<string, unknown>), value: row });
    if (page.length < PAGE_SIZE) break;
  }
  // Deterministic ordering independent of storage insertion order.
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

function digestOf(rows: Row[]): string {
  // Canonical JSON per row (sorted keys) → stable across engines, locales and versions.
  const body = rows.map((row) => `${row.key}\t${stableStringify(row.value)}`).join('\n');
  return sha256Hex(body);
}

/**
 * One repeatable-read snapshot over cursor + every covered table. Because all reads
 * (including the block cursor that names the reported height) see the same committed
 * snapshot, the digest and its height label cannot disagree: either the rows and the
 * label both describe height H, or the computation fails loudly — never a mixed-height
 * verdict. MemoryStore serialises transactions against its process lock, which gives
 * the same single-snapshot guarantee for the in-process backend.
 */
async function digestInSnapshot(
  store: EngineStore,
  storage: 'postgres' | 'memory',
): Promise<{ result: StateChecksum; height: number; blockId: string }> {
  return store.transaction(
    async (tx) => {
      const before = await tx.getLatestBlock();

      const [collections, instances, tokens, balances, orders, bookOrders] = await Promise.all([
        collect((limit, offset) => tx.listCollections(limit, offset), (row) => String(row.symbol)),
        collect(
          (limit, offset) => tx.listInstances({ limit, offset }),
          (row) => instanceKey(String(row.symbol), String(row.id)),
        ),
        collect((limit, offset) => tx.listTokens({ limit, offset }), (row) => String(row.symbol)),
        collect(
          (limit, offset) => tx.listBalances({ limit, offset }),
          (row) => balanceKey(String(row.account), String(row.symbol)),
        ),
        collect((limit, offset) => tx.listOrders({ limit, offset }), (row) => String(row.id)),
        collect((limit, offset) => tx.listBookOrders({ limit, offset }), (row) => String(row.id)),
      ]);

      const param = await getParam(tx);
      const paramRows: Row[] = param === null ? [] : [{ key: 'param', value: param }];
      const metaRows: Row[] = [];
      for (const key of META_KEYS) {
        metaRows.push({ key, value: await tx.get('meta', key) });
      }

      const after = await tx.getLatestBlock();
      // Defence in depth: under repeatable read these two reads share one snapshot
      // and can never differ. If a backend silently ignored the isolation request,
      // refuse to emit a digest that is not provably bound to its height label.
      if (
        (before?.height ?? 0) !== (after?.height ?? 0) ||
        (before?.blockId ?? '') !== (after?.blockId ?? '')
      ) {
        throw new TornDigestError();
      }

      const entities: Record<string, string> = {
        collections: digestOf(collections),
        instances: digestOf(instances),
        tokens: digestOf(tokens),
        balances: digestOf(balances),
        orders: digestOf(orders),
        bookOrders: digestOf(bookOrders),
        param: digestOf(paramRows),
        meta: digestOf(metaRows),
      };

      const checksum = sha256Hex(
        Object.keys(entities)
          .sort()
          .map((name) => `${name}:${entities[name]}`)
          .join('\n'),
      );

      const height = before?.height ?? 0;
      return {
        result: { height, storage, entities, checksum },
        height,
        blockId: before?.blockId ?? '',
      };
    },
    { isolationLevel: 'repeatableRead', timeoutMs: TX_TIMEOUT_MS },
  );
}

/**
 * Deterministic fingerprint of the committed ledger state.
 *
 * Two nodes that have applied the same blocks must produce the identical checksum at
 * the same cursor height — this is the cross-node verification primitive for operators
 * running their own engine (docs/NODE-OPERATOR.md): sync, compare against a reference
 * node, and you have independently verified your state without trusting anyone.
 *
 * Consistency: the digest runs in a single repeatable-read transaction that includes
 * the block cursor, so concurrent indexing can never yield a mixed-height verdict
 * (the historical failure mode: cursor read first, then un-isolated table walks that a
 * block commit could interleave — false divergence, or row-skips masking real ones).
 *
 * Cost: concurrent callers coalesce onto one in-flight computation; for the production
 * backend the last result is served verbatim while the committed cursor still names its
 * block, and the route carries a dedicated low per-IP budget (src/api/rest.ts), so the
 * endpoint cannot fan one request into N full-table scans against the shared database.
 *
 * Covered: collections, instances, tokens, balances, market orders (NFT listings and
 * fungible book orders), the param row and the `order_seq`/`market_order_seq` meta
 * counters — every value-bearing entity. Deliberately excluded: cursor/settings
 * (operational, not consensus state) and accounts (name + creation block only,
 * derived from appearance order in blocks that also created collections/balances).
 * All covered rows are built exclusively from block-derived data (the schema stores
 * no host-clock timestamps), so the digest is reproducible on any machine.
 */
export async function computeStateChecksum(
  store: EngineStore,
  storage: 'postgres' | 'memory',
): Promise<StateChecksum> {
  // Serve the previous result while the committed cursor still names its block.
  // Rows and cursor only ever change together through block application; direct
  // store writes (tests, fixtures) bypass the cursor, so the cache is enabled only
  // for the production backend where that atomic-commit premise holds.
  if (storage === 'postgres' && lastResult !== null) {
    const cursor = await store.getLatestBlock();
    if (
      cursor !== null &&
      cursor.height === lastResult.height &&
      cursor.blockId === lastResult.blockId
    ) {
      return lastResult.result;
    }
  }

  // Coalesce concurrent callers onto a single in-flight computation. The check and
  // the assignment below happen with no intervening await, so only one caller can
  // ever create the promise.
  if (inFlight !== null) return inFlight;
  const run = (async (): Promise<StateChecksum> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const { result, height, blockId } = await digestInSnapshot(store, storage);
        if (storage === 'postgres') lastResult = { height, blockId, result };
        return result;
      } catch (err) {
        if (!(err instanceof TornDigestError) || attempt >= MAX_ATTEMPTS) throw err;
      }
    }
  })();
  inFlight = run.finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Last completed production digest (module-scoped single-flight state). */
let inFlight: Promise<StateChecksum> | null = null;
let lastResult: { height: number; blockId: string; result: StateChecksum } | null = null;
