import type { Env, SessionData } from "../types";
import { getSession } from "./session";
import type {
  ResourceAttribution,
  ResourceUsagePort,
} from "../telemetry/resourceUsagePorts";

/**
 * In-isolate cache in front of `getSession` (issue #329).
 *
 * Why this exists: `requireAuth` runs on every `/api/*` request and each call
 * performed one backing-store read — in the KV era a Workers KV read, charged
 * against the free tier (100,000/day) — and `requireAuth` is the first store
 * call in the request path,
 * so UI polling alone could exhaust the day's budget — at which point every
 * authenticated route returns 401 rather than merely losing writes.
 *
 * This absorbs the polling traffic without changing the auth model: the
 * SessionStore DO stays the source of truth (#604), and the staleness bound
 * is the TTL below. #411 raised the positive TTL to 60s and the cap to 2000
 * entries to cut backing-store reads further; explicit invalidation remains
 * the immediate path for revocations, so the longer TTL only governs how
 * long an un-invalidated stale copy can linger.
 *
 * Properties that matter for review:
 * - Per-isolate and best-effort. A cold or recycled isolate simply misses, so
 *   the cache can never become a correctness dependency.
 * - Bounded. Oldest entry is evicted at the cap; entries expire on read.
 * - Misses are cached too, but for much less time, so a session that does not
 *   exist cannot be pinned as absent.
 * - Any path that invalidates a session must call `invalidateSessionCache`.
 *   Other isolates keep their stale copy until TTL — which is why the TTL is
 *   short and why sensitive routes are not meant to rely on it.
 */
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;
const MAX_ENTRIES = 2000;

interface CacheEntry {
  data: SessionData | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function readEntry(sessionId: string): CacheEntry | undefined {
  const entry = cache.get(sessionId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(sessionId);
    return undefined;
  }
  return entry;
}

function writeEntry(sessionId: string, data: SessionData | null): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(sessionId)) {
    // Map preserves insertion order, so the first key is the oldest write.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(sessionId, {
    data,
    expiresAt: Date.now() + (data ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
}

/**
 * Returns the session, serving it from the isolate cache when possible.
 * Semantically equivalent to `getSession`, so callers can swap it in directly.
 * A cache hit performs no store op and therefore emits no resource event —
 * correctly: no rows were read. The optional resource opts are forwarded only
 * on the miss path, where the backing read happens (#1819).
 */
export async function getSessionCached(
  env: Env,
  sessionId: string,
  resource?: { attribution?: ResourceAttribution; resourceSink?: ResourceUsagePort }
): Promise<SessionData | null> {
  const cached = readEntry(sessionId);
  if (cached) return cached.data;

  const session = await getSession(env, sessionId, resource);
  // A corrupt payload comes back as null from getSession; caching that for the
  // negative TTL is acceptable because the session is unusable either way.
  writeEntry(sessionId, session);
  return session;
}

/**
 * Drops a session from this isolate's cache. Call from anything that revokes a
 * session, otherwise the stale copy survives here until TTL.
 */
export function invalidateSessionCache(sessionId: string): void {
  cache.delete(sessionId);
}

/** Test seam: the cache is module-level and must be resettable per test. */
export function __resetSessionCache(): void {
  cache.clear();
}
