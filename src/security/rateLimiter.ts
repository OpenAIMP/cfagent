/**
 * Minimal in-worker token-bucket rate limiter (issue #241).
 *
 * Guards expensive ingress routes (NLQ webhook, memory search) against
 * floods without any external dependency. Buckets live in isolate memory,
 * so limits are per-isolate approximations — good enough for abuse
 * throttling, not for precise accounting.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds the caller should wait before retrying (0 when allowed). */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

// Opportunistic hygiene: avoid unbounded growth on high-cardinality keys.
const MAX_BUCKETS = 5000;
const BUCKET_TTL_MS = 10 * 60 * 1000;

function pruneBuckets(now: number): void {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, b] of buckets) {
    if (now - b.updatedAt > BUCKET_TTL_MS) buckets.delete(key);
    if (buckets.size <= MAX_BUCKETS) break;
  }
}

/**
 * Token bucket: `maxRequests` tokens per `windowMs`, refilled continuously.
 * Returns `{ allowed: true }` and consumes one token, or `{ allowed: false }`
 * with a `retryAfterMs` hint. `now` is injectable for tests.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
  now: number = Date.now()
): RateLimitResult {
  if (maxRequests <= 0 || windowMs <= 0) return { allowed: true, retryAfterMs: 0 };
  pruneBuckets(now);

  const capacity = maxRequests;
  const refillPerMs = capacity / windowMs;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, updatedAt: now };
    buckets.set(key, bucket);
  }
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
  bucket.updatedAt = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterMs: 0 };
  }
  return {
    allowed: false,
    retryAfterMs: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs)),
  };
}

/** Test/introspection helper: number of live buckets. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}

/** Test helper: reset all buckets. */
export function resetRateLimits(): void {
  buckets.clear();
}
