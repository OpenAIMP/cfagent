/**
 * Resilient wrapper around a KV binding.
 *
 * Why: Workers KV has a hard daily `get()` quota on the Free plan. When it is
 * exhausted every `get()` throws `KV get() limit exceeded for the day.`, and an
 * uncaught throw is exactly what surfaces to the visitor as Cloudflare error
 * 1101. One exhausted quota therefore turned into a site-wide outage instead of
 * a degraded state.
 *
 * This wrapper makes KV failure a normal, handled outcome:
 * - reads never throw; a failure reads as `null` (callers treat it as a miss),
 * - a quota/limit error opens a breaker for a few minutes, so the Worker stops
 *   hammering KV and stops generating one exception per request,
 * - writes and deletes never throw either (a failed session write is logged,
 *   not fatal — the caller already redirects).
 *
 * It is deliberately small and dependency-free so it can wrap any KV-like
 * object, including the Durable Object adapter in `durableKv.ts`.
 */

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

const DEFAULT_BLOCK_MS = 5 * 60_000;

interface KvHealth {
  blockedUntil: number;
  lastError: string | null;
  suppressedReads: number;
}

const health = new Map<string, KvHealth>();

function healthFor(label: string): KvHealth {
  let entry = health.get(label);
  if (!entry) {
    entry = { blockedUntil: 0, lastError: null, suppressedReads: 0 };
    health.set(label, entry);
  }
  return entry;
}

/**
 * True for the errors that mean "the daily quota is gone" rather than "this key
 * is bad". Both Workers KV's message and the 429 the REST API returns are
 * covered; the match is intentionally loose so a wording change still trips it.
 */
export function isKvLimitError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error ?? "");
  return /limit exceeded|quota|too many requests|\b429\b/i.test(message);
}

/** Test seam: the breaker is module-level state. */
export function __resetKvHealth(): void {
  health.clear();
}

export function kvHealth(label: string): Readonly<KvHealth> {
  return { ...healthFor(label) };
}

/**
 * Wraps `kv` so no call can throw. When `kv` is undefined the wrapper is a
 * no-op backend (reads miss, writes vanish), which keeps callers free of
 * `if (kv)` branches.
 */
export function createResilientKv(
  kv: KvLike | KVNamespace | null | undefined,
  label: string,
  options: { blockMs?: number } = {}
): KvLike {
  const blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;
  const state = healthFor(label);

  const trip = (error: unknown): void => {
    state.lastError = error instanceof Error ? error.message : String(error);
    if (isKvLimitError(error)) {
      state.blockedUntil = Date.now() + blockMs;
      console.warn(
        `[kv:${label}] quota error — pausing KV reads for ${Math.round(blockMs / 1000)}s: ${state.lastError}`
      );
    }
  };

  return {
    async get(key: string): Promise<string | null> {
      if (!kv) return null;
      if (Date.now() < state.blockedUntil) {
        state.suppressedReads += 1;
        return null;
      }
      try {
        return await kv.get(key);
      } catch (error) {
        trip(error);
        return null;
      }
    },

    async put(key: string, value: string, putOptions?: { expirationTtl?: number }): Promise<void> {
      if (!kv) return;
      if (Date.now() < state.blockedUntil) {
        state.suppressedReads += 1;
        return;
      }
      try {
        await kv.put(key, value, putOptions);
      } catch (error) {
        trip(error);
      }
    },

    async delete(key: string): Promise<void> {
      if (!kv) return;
      if (Date.now() < state.blockedUntil) {
        state.suppressedReads += 1;
        return;
      }
      try {
        await kv.delete(key);
      } catch (error) {
        trip(error);
      }
    },
  };
}
