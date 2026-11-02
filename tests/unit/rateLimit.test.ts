import type { Request, RequestHandler, Response } from 'express';

import { createRateLimiter } from '../../src/api/rateLimit';

/* ------------------------------------------------------------ test doubles */

interface FakeRes extends Partial<Response> {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

function fakeRes(): FakeRes {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    set(key: string, value: string) {
      res.headers[key] = value;
      return res;
    },
  };
  return res as unknown as FakeRes;
}

function fakeReq(ip: string, path = '/api/v1/collections', method = 'GET'): Request {
  return { ip, path, method, socket: {} } as unknown as Request;
}

/** Runs the middleware; resolves true when the request was allowed through. */
function run(mw: RequestHandler, req: Request): { allowed: boolean; res: FakeRes } {
  const res = fakeRes();
  let allowed = false;
  mw(req, res as unknown as Response, (() => {
    allowed = true;
  }) as never);
  return { allowed, res };
}

/* -------------------------------------------------------------------- tests */

describe('createRateLimiter', () => {
  it('allows up to the rpm budget then answers 429 with Retry-After', () => {
    let t = 1_000_000;
    const mw = createRateLimiter({ rpm: 3, now: () => t });

    for (let i = 0; i < 3; i++) {
      expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(true);
    }

    const { allowed, res } = run(mw, fakeReq('1.2.3.4'));
    expect(allowed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
    expect(res.body).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('refills continuously (one token every 60_000/rpm ms)', () => {
    let t = 0;
    const mw = createRateLimiter({ rpm: 3, now: () => t });

    expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(true);
    expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(true);
    expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(true);
    expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(false);

    t += 20_000; // exactly one token at 3 rpm
    expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(true);
    expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(false);

    t += 3_600_000; // full window idle → burst capacity restored
    expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(true);
    expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(true);
    expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(true);
    expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(false);
  });

  it('never rate-limits /health (orchestrators must always get through)', () => {
    let t = 0;
    const mw = createRateLimiter({ rpm: 1, now: () => t });

    expect(run(mw, fakeReq('9.9.9.9', '/health')).allowed).toBe(true);
    expect(run(mw, fakeReq('9.9.9.9', '/health')).allowed).toBe(true);
    expect(run(mw, fakeReq('9.9.9.9', '/health')).allowed).toBe(true);
    // the API itself is still limited
    expect(run(mw, fakeReq('9.9.9.9')).allowed).toBe(true);
    expect(run(mw, fakeReq('9.9.9.9')).allowed).toBe(false);
  });

  it('never rate-limits CORS preflights (OPTIONS) — they must not double cross-origin traffic', () => {
    let t = 0;
    const mw = createRateLimiter({ rpm: 1, now: () => t });

    for (let i = 0; i < 50; i++) {
      expect(run(mw, fakeReq('7.7.7.7', '/api/v1/collections', 'OPTIONS')).allowed).toBe(true);
    }
    // GETs from the same IP are still metered
    expect(run(mw, fakeReq('7.7.7.7')).allowed).toBe(true);
    expect(run(mw, fakeReq('7.7.7.7')).allowed).toBe(false);
  });

  it('isolates buckets per client IP', () => {
    let t = 0;
    const mw = createRateLimiter({ rpm: 1, now: () => t });

    expect(run(mw, fakeReq('1.1.1.1')).allowed).toBe(true);
    expect(run(mw, fakeReq('1.1.1.1')).allowed).toBe(false);
    expect(run(mw, fakeReq('2.2.2.2')).allowed).toBe(true);
    expect(run(mw, fakeReq('2.2.2.2')).allowed).toBe(false);
  });

  it('passes everything through when rpm is 0 (disabled)', () => {
    const mw = createRateLimiter({ rpm: 0 });
    for (let i = 0; i < 100; i++) {
      expect(run(mw, fakeReq('1.2.3.4')).allowed).toBe(true);
    }
  });

  it('bounds its memory: evicts the oldest entry when maxEntries is exceeded', () => {
    let t = 0;
    const mw = createRateLimiter({ rpm: 2, now: () => t, maxEntries: 2 });

    expect(run(mw, fakeReq('ip1')).allowed).toBe(true);
    expect(run(mw, fakeReq('ip1')).allowed).toBe(true);
    expect(run(mw, fakeReq('ip1')).allowed).toBe(false); // ip1 exhausted

    expect(run(mw, fakeReq('ip2')).allowed).toBe(true);
    expect(run(mw, fakeReq('ip3')).allowed).toBe(true); // evicts ip1 (oldest)

    // Eviction gives ip1 a fresh bucket; ip2 churns through its own fresh budget and
    // ends exhausted — the cap keeps memory bounded no matter how many addresses appear.
    expect(run(mw, fakeReq('ip1')).allowed).toBe(true);
    expect(run(mw, fakeReq('ip2')).allowed).toBe(true);
    expect(run(mw, fakeReq('ip2')).allowed).toBe(true);
    expect(run(mw, fakeReq('ip2')).allowed).toBe(false);
  });
});
