import { createHash } from 'node:crypto';
import type { OpAuth, ParsedOp, RejectedOp } from '../../src/chain/opParser';
import type { RawBlock, RawTransaction, SteemRpc, HeadInfo } from '../../src/chain/rpc';

export const OP_ID = 'steem_nft_v1';

/** Chain-verified authorities for an account signing with active/ posting keys. */
export function active(account: string, ...rest: string[]): OpAuth {
  return { active: [account, ...rest], posting: [], actor: account, level: 'active' };
}

export function posting(account: string, ...rest: string[]): OpAuth {
  return { active: [], posting: [account, ...rest], actor: account, level: 'posting' };
}

export function customJsonTx(
  payload: Record<string, unknown>,
  auth: OpAuth,
  id: string = OP_ID,
): RawTransaction {
  return {
    operations: [
      [
        'custom_json',
        {
          id,
          json: JSON.stringify(payload),
          required_auths: auth.active,
          required_posting_auths: auth.posting,
        },
      ],
    ],
  } as RawTransaction;
}

/** A harmless non-engine operation used to pad transactions. */
export function commentTx(): RawTransaction {
  return { operations: [['comment', { author: 'alice', percel: 'x' }]] } as RawTransaction;
}

export interface BlockInput {
  height: number;
  previous: string;
  timestamp?: string;
  transactions: RawTransaction[];
  /** Changing the witness makes otherwise identical blocks hash differently (forks). */
  witness?: string;
}

export function blockIdFor(input: BlockInput): string {
  const material = JSON.stringify({
    previous: input.previous,
    timestamp: input.timestamp,
    witness: input.witness ?? 'STM000',
    transactions: input.transactions,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 40);
}

export function buildBlock(input: BlockInput): RawBlock {
  const timestamp = input.timestamp ?? isoForHeight(input.height);
  const withTimestamp = { ...input, timestamp };
  return {
    previous: input.previous,
    timestamp,
    block_id: blockIdFor(withTimestamp),
    witness: input.witness ?? 'STM000',
    transaction_merkle_root: blockIdFor({ ...withTimestamp, transactions: [] }),
    transaction_ids: input.transactions.map((_, i) =>
      createHash('sha256').update(`${withTimestamp.timestamp}:${input.height}:${i}`).digest('hex').slice(0, 40),
    ),
    transactions: input.transactions,
    extensions: [],
  } as RawBlock;
}

/** Steem produces one block every 3 seconds. */
export function isoForHeight(height: number, genesis = Date.parse('2026-01-01T00:00:00.000Z')): string {
  return new Date(genesis + (height - 1) * 3000).toISOString().replace(/\.\d{3}Z$/, '');
}

/**
 * Scriptable in-memory Steem node.
 *
 * Supports appending blocks, truncating (forking) and replaying an alternative chain,
 * which is everything the re-org handler has to cope with.
 */
export class MockRpc implements SteemRpc {
  private readonly chain = new Map<number, RawBlock>();
  private head = 0;
  /** Simulates RPC failures for failover tests. */
  failures = 0;

  get headHeight(): number {
    return this.head;
  }

  /** Appends the next block on top of the current head. */
  mine(input: { transactions?: RawTransaction[]; witness?: string; timestamp?: string } = {}): RawBlock {
    const height = this.head + 1;
    const previous = this.head === 0 ? '0'.repeat(40) : (this.chain.get(this.head) as RawBlock).block_id;
    const block = buildBlock({
      height,
      previous,
      transactions: input.transactions ?? [],
      witness: input.witness,
      timestamp: input.timestamp,
    });
    this.chain.set(height, block);
    this.head = height;
    return block;
  }

  /** Truncates the chain from `height` onwards (a micro-fork starts here). */
  rewind(height: number): void {
    for (const key of [...this.chain.keys()]) if (key >= height) this.chain.delete(key);
    this.head = height - 1;
  }

  /** Replaces an already produced block, forcing its id to change. */
  replace(height: number, input: { transactions: RawTransaction[]; witness: string; timestamp?: string }): RawBlock {
    const previous = height === 1 ? '0'.repeat(40) : (this.chain.get(height - 1) as RawBlock).block_id;
    const block = buildBlock({ height, previous, ...input });
    this.chain.set(height, block);
    return block;
  }

  setHead(height: number): void {
    this.head = height;
  }

  async getHead(): Promise<HeadInfo> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('mock rpc unavailable');
    }
    const block = this.chain.get(this.head);
    return { height: this.head, timestamp: block?.timestamp ?? isoForHeight(this.head) };
  }

  async getBlock(height: number): Promise<RawBlock | null> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('mock rpc unavailable');
    }
    return this.chain.get(height) ?? null;
  }

  /** Raw block id at a height (undefined when absent). */
  idAt(height: number): string | undefined {
    return this.chain.get(height)?.block_id;
  }

  /** Independent node with an identical chain (used to compare against a clean sync). */
  clone(): MockRpc {
    const copy = new MockRpc();
    for (const [height, block] of this.chain) copy.chain.set(height, block);
    copy.head = this.head;
    return copy;
  }
}

export function parsedOp(
  action: string,
  params: Record<string, unknown>,
  auth: OpAuth,
  overrides: Partial<ParsedOp> = {},
): ParsedOp {
  return {
    ok: true,
    action: action as ParsedOp['action'],
    params,
    txId: overrides.txId ?? 'tx-test-0001',
    opIndex: overrides.opIndex ?? 0,
    auth,
    ...overrides,
  } as ParsedOp;
}

export function rejectedOp(code: string, auth: OpAuth): RejectedOp {
  return {
    ok: false,
    action: 'unknown',
    code,
    message: 'test rejection',
    params: {},
    txId: 'tx-rejected',
    opIndex: 0,
    auth,
  };
}
