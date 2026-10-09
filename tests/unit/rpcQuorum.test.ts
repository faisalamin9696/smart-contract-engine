import { FailoverRpc, RpcError, blockFingerprint, type RawBlock } from '../../src/chain/rpc';

/**
 * Cross-endpoint quorum verification (security: a single RPC endpoint must not be
 * able to feed the indexer a fabricated block while honest endpoints disagree).
 *
 * The head poll is always issued first — it seeds the freshness window the quorum
 * gate uses, exactly like the indexer's streamer does in production.
 */

const HEAD = { head_block_number: 1000, time: '2026-10-09T00:00:00' };

function block(overrides: Partial<RawBlock> = {}): RawBlock {
  return {
    previous: '0692dc972a751a4100be97e57b3eca101e322938',
    timestamp: '2026-10-09T00:00:00',
    block_id: '0692dc9890a71564639564dba3e23832597f1ca0',
    witness: 'steemchiller',
    transaction_merkle_root: '8e9b4854de43b024ce0f1e8f76aac5a74d83a640',
    transaction_ids: ['01a5794951a12f7adec8e43df1a06f9cca386419'],
    transactions: [{ operations: [['custom_json', { id: 'sce-mainnet1', json: '{}' }]], signatures: [] }],
    extensions: [],
    ...overrides,
  };
}

type Behavior = {
  head?: typeof HEAD;
  block?: RawBlock | null;
  /** Simulate a transport-level failure on get_block. */
  blockError?: Error;
};

type Calls = Record<string, number>;

function rpcFor(
  behaviors: Record<string, Behavior>,
  opts: { quorumDepth?: number } = {},
): { rpc: FailoverRpc; calls: Calls } {
  const calls: Calls = {};
  const rpc = new FailoverRpc(Object.keys(behaviors), {
    quorumDepth: opts.quorumDepth ?? 50,
    timeoutMs: 1_000,
    cooldownMs: 30_000,
    clientFactory: (url) => ({
      call: async (_api: string, method: string): Promise<unknown> => {
        const behavior = behaviors[url];
        if (method === 'get_dynamic_global_properties') return behavior.head ?? HEAD;
        if (method === 'get_block') {
          calls[url] = (calls[url] ?? 0) + 1;
          if (behavior.blockError) throw behavior.blockError;
          return behavior.block ?? null;
        }
        throw new Error(`unexpected method ${method}`);
      },
    }),
  });
  return { rpc, calls };
}

describe('FailoverRpc quorum verification', () => {
  it('corroborates a block with a second endpoint on agreement', async () => {
    const good = block();
    const { rpc, calls } = rpcFor({ a: { block: good }, b: { block: good } });

    await rpc.getHead();
    const result = await rpc.getBlock(990);

    expect(result).toBe(good);
    expect(calls.a).toBe(1);
    expect(calls.b).toBe(1); // one witness request
  });

  it('skips quorum entirely with a single endpoint (nothing to compare against)', async () => {
    const good = block();
    const { rpc, calls } = rpcFor({ a: { block: good } });

    await rpc.getHead();
    expect(await rpc.getBlock(990)).toBe(good);
    expect(calls.a).toBe(1);
  });

  it('skips quorum when depth is 0 (operator opt-out)', async () => {
    const good = block();
    const { rpc, calls } = rpcFor({ a: { block: good }, b: { block: block() } }, { quorumDepth: 0 });

    await rpc.getHead();
    expect(await rpc.getBlock(990)).toBe(good);
    expect(calls.b).toBeUndefined();
  });

  it('skips quorum for deep-history sync (height far below the head)', async () => {
    const good = block();
    const { rpc, calls } = rpcFor({ a: { block: good }, b: { block: block() } });

    await rpc.getHead(); // head 1000, depth 50 → verify only >= 950
    expect(await rpc.getBlock(100)).toBe(good);
    expect(calls.b).toBeUndefined();
  });

  it('skips quorum when no fresh head has been observed', async () => {
    const good = block();
    const { rpc, calls } = rpcFor({ a: { block: good }, b: { block: block() } });

    // No getHead() call → lastHead is null → cannot vouch for the window.
    expect(await rpc.getBlock(990)).toBe(good);
    expect(calls.b).toBeUndefined();
  });

  it('refuses to apply a block two endpoints contradict (QUORUM_DISAGREE)', async () => {
    const { rpc } = rpcFor({
      a: { block: block({ block_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) },
      b: { block: block({ block_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }) },
    });

    await rpc.getHead();
    await expect(rpc.getBlock(990)).rejects.toMatchObject({ code: 'QUORUM_DISAGREE' });
  });

  it('takes the witness majority when the primary served a fabricated block', async () => {
    const good = block();
    const fake = block({ block_id: 'ffffffffffffffffffffffffffffffffffffffff', transaction_merkle_root: 'dead' });
    const { rpc, calls } = rpcFor({
      a: { block: fake },
      b: { block: good },
      c: { block: good },
    });

    await rpc.getHead();
    const result = await rpc.getBlock(990);
    expect(result).toBe(good);
    expect(blockFingerprint(result!)).toBe(blockFingerprint(good));

    // The dissenting primary is now on cooldown: a follow-up fetch must not consult it.
    calls.a = calls.a ?? 0;
    const before = calls.a;
    await rpc.getBlock(990);
    expect(calls.a).toBe(before);
  });

  it('keeps the primary and marks a lying witness down (majority = primary + witness 2)', async () => {
    const good = block();
    const fake = block({ block_id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' });
    const { rpc, calls } = rpcFor({
      a: { block: good },
      b: { block: fake },
      c: { block: good },
    });

    await rpc.getHead();
    expect(await rpc.getBlock(990)).toBe(good);

    const before = calls.b ?? 0;
    await rpc.getBlock(990);
    expect(calls.b).toBe(before); // lying witness excluded from rotation
  });

  it('lets the primary stand when the witness is unreachable (transport failure)', async () => {
    const good = block();
    const { rpc } = rpcFor({
      a: { block: good },
      b: { blockError: new Error('ECONNRESET') },
    });

    await rpc.getHead();
    expect(await rpc.getBlock(990)).toBe(good);
  });

  it('treats a witness that is still syncing as no testimony, not a contradiction', async () => {
    const good = block();
    const { rpc } = rpcFor({
      a: { block: good },
      b: { block: null, head: { head_block_number: 500, time: 't' } }, // behind 990
    });

    await rpc.getHead();
    expect(await rpc.getBlock(990)).toBe(good);
  });

  it('block fingerprints differ when any consensus-relevant field differs', () => {
    const base = block();
    expect(blockFingerprint(base)).toBe(blockFingerprint({ ...base }));
    expect(blockFingerprint(base)).not.toBe(blockFingerprint({ ...base, timestamp: '2026-10-09T00:00:03' }));
    expect(blockFingerprint(base)).not.toBe(
      blockFingerprint({ ...base, transactions: [{ operations: [['custom_json', { id: 'evil' }]], signatures: [] }] }),
    );
    expect(blockFingerprint(base)).not.toBe(blockFingerprint({ ...base, transaction_ids: [] }));
  });
});

describe('FailoverRpc error semantics', () => {
  it('wraps total failure as RPC_UNAVAILABLE', async () => {
    const { rpc } = rpcFor({ a: { blockError: new Error('boom') } });
    await expect(rpc.getBlock(1)).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
  });

  it('rejects malformed block payloads before quorum (BAD_RESPONSE)', async () => {
    const { rpc } = rpcFor({ a: { block: { block_id: 42 } as unknown as RawBlock }, b: { block: block() } });
    await expect(rpc.getBlock(990)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('exposes RpcError with code for programmatic handling', () => {
    const err = new RpcError('x', 'QUORUM_DISAGREE');
    expect(err.code).toBe('QUORUM_DISAGREE');
    expect(err).toBeInstanceOf(Error);
  });
});
