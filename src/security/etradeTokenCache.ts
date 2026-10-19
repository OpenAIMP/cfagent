/**
 * In-isolate cache in front of the E*TRADE token KV read (issue #329
 * follow-up).
 *
 * Why this exists: `getValidTokens` runs from every auth-header builder, i.e.
 * once per E*TRADE request, and pays a KV `get()` (two when the legacy
 * unscoped key is the one holding the token). A single options scan over 25
 * underlyings paid that dozens of times. Sessions already had this treatment
 * (`security/sessionCache.ts`); tokens did not, even though they change far
 * less often — an access token lives until midnight US Eastern, not until the
 * next minute.
 *
 * Properties that matter for review:
 * - Per-isolate and best-effort; a cold isolate simply misses.
 * - Invalidated on every write path (`storeAccessTokens`, `revokeStoredTokens`),
 *   so a renewed or revoked token is never served stale from here.
 * - Misses are cached briefly, so an unauthenticated caller cannot turn every
 *   E*TRADE attempt into a KV read — but a token that appears moments later is
 *   not pinned for long.
 */
export interface CachedTokenSet {
  accessToken: string;
  accessTokenSecret: string;
  storedAt: string;
  environment: string;
  userLogin: string;
}

const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 10_000;
const MAX_ENTRIES = 200;

interface CacheEntry {
  tokens: CachedTokenSet | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Tokens are namespaced per environment: TEST and PROD never share an entry. */
export function tokenCacheKey(envName: string, userLogin: string): string {
  return `${envName.toUpperCase()}:${userLogin.toLowerCase()}`;
}

/** `undefined` means "not cached"; `null` means "cached: no tokens". */
export function readTokenCache(key: string): CachedTokenSet | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.tokens;
}

export function writeTokenCache(key: string, tokens: CachedTokenSet | null): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    // Map preserves insertion order, so the first key is the oldest write.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, {
    tokens,
    expiresAt: Date.now() + (tokens ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
}

/**
 * Drops every environment variant for a login. `revokeStoredTokens` deletes
 * PROD, TEST and unscoped keys, so a single-variant invalidation would leave
 * the other two serving a revoked token.
 */
export function invalidateTokenCacheFor(userLogin: string): void {
  const suffix = `:${userLogin.toLowerCase()}`;
  for (const key of [...cache.keys()]) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
}

/** Test seam: the cache is module-level and must be resettable per test. */
export function __resetTokenCache(): void {
  cache.clear();
}
