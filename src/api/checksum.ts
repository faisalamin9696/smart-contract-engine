import { createHash } from 'node:crypto';

import type { Indexer } from '../indexer/indexer';
import type { EngineStore } from '../state/store';
import { getParam } from '../state/store';
import { balanceKey, instanceKey } from '../types/domain';
import { stableStringify } from '../utils/canonical';

const PAGE_SIZE = 100;
/** Safety valve: a runaway store should fail loudly, not stream forever. */
const MAX_ROWS = 5_000_000;

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
 * Deterministic fingerprint of the committed ledger state.
 *
 * Two nodes that have applied the same blocks must produce the identical checksum at
 * the same cursor height — this is the cross-node verification primitive for operators
 * running their own engine (docs/NODE-OPERATOR.md): sync, compare against a reference
 * node, and you have independently verified your state without trusting anyone.
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
  indexer: Indexer,
  storage: 'postgres' | 'memory',
): Promise<StateChecksum> {
  const cursor = await indexer.cursor();

  const [collections, instances, tokens, balances, orders, bookOrders] = await Promise.all([
    collect((limit, offset) => store.listCollections(limit, offset), (row) => String(row.symbol)),
    collect(
      (limit, offset) => store.listInstances({ limit, offset }),
      (row) => instanceKey(String(row.symbol), String(row.id)),
    ),
    collect((limit, offset) => store.listTokens({ limit, offset }), (row) => String(row.symbol)),
    collect(
      (limit, offset) => store.listBalances({ limit, offset }),
      (row) => balanceKey(String(row.account), String(row.symbol)),
    ),
    collect((limit, offset) => store.listOrders({ limit, offset }), (row) => String(row.id)),
    collect((limit, offset) => store.listBookOrders({ limit, offset }), (row) => String(row.id)),
  ]);

  const param = await getParam(store);
  const paramRows: Row[] = param === null ? [] : [{ key: 'param', value: param }];
  const metaRows: Row[] = [];
  for (const key of META_KEYS) {
    metaRows.push({ key, value: await store.get('meta', key) });
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

  return {
    height: cursor?.height ?? 0,
    storage,
    entities,
    checksum,
  };
}
