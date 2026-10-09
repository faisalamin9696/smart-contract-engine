import type { NextFunction, Request, Response } from 'express';

export interface RateLimiterOptions {
  /** Requests per minute allowed per client IP. 0 disables the limiter entirely. */
  rpm: number;
  /** Burst capacity (defaults to one full minute of budget). */
  burst?: number;
  /** Injected clock (tests). */
  now?: () => number;
  /** Upper bound on tracked client entries — protects memory from address floods. */
  maxEntries?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Per-IP token-bucket limiter for the HTTP surface (REST + GraphQL + discovery).
 *
 * Zero-dependency and in-memory: the engine is a single process, so shared state is
 * the process itself. The bucket refills continuously at `rpm / 60` requests per
 * second with a burst allowance of `burst` (default: one full minute), so a normal
 * dashboard (a few requests per second at most) never notices while a scraping or
 * query-flooding client is cut off with `429` + `Retry-After`.
 *
 * `/health` is exempt: orchestrators and load-balancers poll it on their own cadence
 * and must never be rate limited out of the cluster.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const rpm = options.rpm;
  if (rpm <= 0) {
    // Disabled — pass straight through.
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }
  const now = options.now ?? Date.now;
  const capacity = options.burst ?? rpm;
  const refillPerMs = rpm / 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const buckets = new Map<string, Bucket>();

  function evictIfNeeded(): void {
    if (buckets.size <= maxEntries) return;
    // Drop fully refilled (idle) entries first; otherwise evict the oldest insertion.
    const cutoff = now() - capacity / refillPerMs;
    for (const [key, bucket] of buckets) {
      if (buckets.size <= maxEntries) break;
      if (bucket.updatedAt <= cutoff) buckets.delete(key);
    }
    for (const key of buckets.keys()) {
      if (buckets.size <= maxEntries) break;
      buckets.delete(key);
    }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/health') return next();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const timestamp = now();

    let bucket = buckets.get(ip);
    if (bucket === undefined) {
      bucket = { tokens: capacity, updatedAt: timestamp };
      buckets.set(ip, bucket);
      evictIfNeeded();
    } else {
      const elapsed = Math.max(0, timestamp - bucket.updatedAt);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = timestamp;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return next();
    }

    const retryAfterMs = Math.ceil((1 - bucket.tokens) / refillPerMs);
    res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: `rate limit exceeded (${rpm}/min per IP); retry in ${Math.ceil(retryAfterMs / 1000)}s`,
      },
    });
  };
}
