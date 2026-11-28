import { FailoverRpc, type RpcScheduleWindow } from '../../src/chain/rpc';

/**
 * Endpoint selection policy (default = round-robin load division), automatic
 * failover with cooldown exclusion, and STEEM_RPC_SCHEDULE time-window pinning.
 *
 * Quorum cross-checking is disabled here (quorumDepth 0) — verification is covered
 * in rpcQuorum.test.ts, which pins its fixtures to sticky selection so the primary
 * endpoint stays deterministic. Everything below runs on an injected clock so
 * cooldowns and UTC windows are exact, and every "call" is a getHead (no block
 * bodies involved).
 */

const HEAD = { head_block_number: 1000, time: '2026-11-28T00:00:00' };
const A = 'https://a';
const B = 'https://b';
const C = 'https://c';
const D = 'https://d';
const URLS = [A, B, C, D];

function harness(
  opts: {
    urls?: string[];
    /** Mutable at runtime: URL -> throws instead of answering. */
    failing?: Record<string, boolean>;
    now?: () => number;
    schedule?: RpcScheduleWindow[];
    strategy?: 'rotate' | 'sticky';
  } = {},
) {
  const urls = opts.urls ?? URLS;
  const failing = opts.failing ?? {};
  const calls: Record<string, number> = {};
  const rpc = new FailoverRpc(urls, {
    quorumDepth: 0,
    timeoutMs: 500,
    cooldownMs: 30_000,
    strategy: opts.strategy ?? 'rotate',
    schedule: opts.schedule ?? [],
    now: opts.now,
    clientFactory: (url) => ({
      call: async (_api: string, method: string): Promise<unknown> => {
        // Count every ATTEMPT (including failed ones) so failover is observable.
        calls[url] = (calls[url] ?? 0) + 1;
        if (failing[url]) throw new Error(`boom ${url}`);
        if (method !== 'get_dynamic_global_properties') throw new Error(`unexpected method ${method}`);
        return HEAD;
      },
    }),
  });
  return { rpc, calls, failing };
}

describe('FailoverRpc load division (rotate, the default)', () => {
  it('divides an even number of requests exactly evenly across healthy endpoints', async () => {
    const { rpc, calls } = harness();

    for (let i = 0; i < 8; i += 1) await rpc.getHead();

    expect(calls).toEqual({ [A]: 2, [B]: 2, [C]: 2, [D]: 2 });
  });

  it('keeps rotating around a cooling endpoint instead of hammering it', async () => {
    let t = Date.parse('2026-11-28T10:00:00Z');
    const { rpc, calls, failing } = harness({ now: () => t });
    failing[A] = true;

    await rpc.getHead(); // first pick A fails → B answers, A enters cooldown
    expect(calls[A]).toBe(1);
    expect(rpc.endpointsSnapshot.find((e) => e.url === A)?.coolingDown).toBe(true);

    for (let i = 0; i < 6; i += 1) await rpc.getHead();
    expect(calls).toEqual({ [A]: 1, [B]: 3, [C]: 2, [D]: 2 });
  });

  it('brings a recovered endpoint back after its cooldown and resets its failure count', async () => {
    let t = Date.parse('2026-11-28T10:00:00Z');
    const { rpc, calls, failing } = harness({ now: () => t });
    failing[A] = true;
    await rpc.getHead();

    failing[A] = false;
    t += 31_000; // past the 30s cooldown

    for (let i = 0; i < 3; i += 1) await rpc.getHead();
    expect(calls[A]).toBe(2); // the failed attempt + one after recovery
    expect(rpc.endpointsSnapshot.find((e) => e.url === A)).toMatchObject({
      failures: 0,
      coolingDown: false,
    });
  });

  it('sticky strategy (opt-in) keeps every request on the last endpoint that answered', async () => {
    const { rpc, calls } = harness({ strategy: 'sticky' });

    for (let i = 0; i < 5; i += 1) await rpc.getHead();

    expect(calls).toEqual({ [A]: 5 });
  });

  it('fails over across ALL remaining endpoints when every endpoint is down (RPC_UNAVAILABLE)', async () => {
    const { rpc, calls, failing } = harness();
    for (const url of URLS) failing[url] = true;

    await expect(rpc.getHead()).rejects.toMatchObject({ code: 'RPC_UNAVAILABLE' });
    for (const url of URLS) expect(calls[url]).toBe(1);
  });
});

describe('FailoverRpc schedule windows (STEEM_RPC_SCHEDULE)', () => {
  const PIN_C: RpcScheduleWindow[] = [{ startMin: 10 * 60, endMin: 11 * 60, url: C }]; // 10:00–11:00 → C

  it('pins ALL load to the scheduled endpoint while its window is active', async () => {
    const t = Date.parse('2026-11-28T10:30:00Z'); // 10:30 UTC
    const { rpc, calls } = harness({ now: () => t, schedule: PIN_C });

    for (let i = 0; i < 5; i += 1) await rpc.getHead();

    expect(calls).toEqual({ [C]: 5 });
  });

  it('returns to even round-robin once the window closes', async () => {
    let t = Date.parse('2026-11-28T10:30:00Z');
    const { rpc, calls } = harness({ now: () => t, schedule: PIN_C });

    for (let i = 0; i < 3; i += 1) await rpc.getHead(); // pinned
    t = Date.parse('2026-11-28T12:00:00Z'); // window over
    for (let i = 0; i < 4; i += 1) await rpc.getHead();

    // 3 pinned to C, then one request each on D, A, B, C in rotation.
    expect(calls).toEqual({ [A]: 1, [B]: 1, [C]: 4, [D]: 1 });
  });

  it('wraps an overnight window past midnight (end < start)', async () => {
    let t = Date.parse('2026-11-28T23:30:00Z');
    const { rpc, calls } = harness({
      now: () => t,
      schedule: [{ startMin: 23 * 60, endMin: 60, url: D }], // 23:00–01:00 → D
    });

    await rpc.getHead();
    t = Date.parse('2026-11-29T00:30:00Z'); // still inside (wrapped)
    await rpc.getHead();
    expect(calls).toEqual({ [D]: 2 });

    t = Date.parse('2026-11-29T12:00:00Z'); // outside the window
    await rpc.getHead();
    expect(calls[D]).toBe(2); // untouched
    expect(calls[A]).toBe(1); // rotation resumed
  });

  it('fails over automatically when the pinned endpoint is down, inside the window', async () => {
    const t = Date.parse('2026-11-28T10:30:00Z');
    const { rpc, calls, failing } = harness({ now: () => t, schedule: PIN_C });
    failing[C] = true;

    // Request 1: the pin picks C, C fails, D (the next candidate) answers.
    // Request 2: C is cooling → the pin does not apply → round-robin takes over.
    await rpc.getHead();
    await rpc.getHead();
    await rpc.getHead();
    expect(calls).toEqual({ [C]: 1, [D]: 1, [A]: 1, [B]: 1 });
    expect(rpc.endpointsSnapshot.find((e) => e.url === C)?.coolingDown).toBe(true);
  });

  it('re-forms the pin automatically once the scheduled endpoint recovers', async () => {
    let t = Date.parse('2026-11-28T10:30:00Z');
    const { rpc, calls, failing } = harness({ now: () => t, schedule: PIN_C });
    failing[C] = true;
    await rpc.getHead(); // C fails → D serves; C on cooldown

    failing[C] = false;
    t += 31_000; // cooldown expired, still inside 10:00–11:00
    await rpc.getHead();
    await rpc.getHead();

    expect(calls[C]).toBe(3); // 1 failed attempt + 2 after recovery (the pin re-formed)
    expect(rpc.endpointsSnapshot.find((e) => e.url === C)?.coolingDown).toBe(false);
  });

  it('ignores a schedule entry whose endpoint is not configured (config rejects it first)', async () => {
    const t = Date.parse('2026-11-28T10:30:00Z');
    const { rpc, calls } = harness({
      now: () => t,
      schedule: [{ startMin: 600, endMin: 660, url: 'https://not-configured.example' }],
    });

    await rpc.getHead();

    expect(calls[A]).toBe(1); // unknown pin skipped → plain round-robin
  });
});
