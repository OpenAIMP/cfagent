import type { KvLike } from "./kvResilience";

/**
 * Durable Object-backed KV replacement (issue #329 follow-up).
 *
 * Why: Workers KV's free tier caps reads at 100k/day, and exhausting it took
 * the whole site down (every `getSession` threw). Durable Object SQLite has no
 * equivalent daily read cap, and this Worker already runs six DOs — so session
 * and token storage move here, and KV becomes a one-time migration source.
 *
 * Wire format is deliberately a tiny JSON protocol over `stub.fetch` rather
 * than RPC: it needs no `cloudflare:workers` import on the client side, which
 * keeps this module (and the fallback logic) unit-testable under Node.
 */
export interface DoStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DoNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DoStubLike;
}

export interface StoreKvOptions {
  /** The DO namespace (env.SESSION_STORE). When absent, `legacy` is used alone. */
  namespace?: DoNamespaceLike | null;
  /** Legacy KV to read from on a DO miss (migration) and fall back to on failure. */
  legacy?: KvLike | null;
  /** Logical bucket inside the DO: "sessions", "etrade", ... */
  namespaceName: string;
  /** DO instance name; one instance holds every bucket. */
  instanceName?: string;
  /** Set false to stop consulting KV entirely (after migration). */
  legacyFallback?: boolean;
}

const STORE_URL = "https://session-store.internal/kv";
const CALL_TIMEOUT_MS = 2_000;

interface StoreReply {
  value?: string | null;
  ok?: boolean;
  error?: string;
}

function timeoutSignal(): AbortSignal | undefined {
  // Workers and Node 18+ both expose AbortSignal.timeout; guard for safety.
  const anySignal = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  return typeof anySignal.timeout === "function" ? anySignal.timeout(CALL_TIMEOUT_MS) : undefined;
}

/**
 * A KV-like store whose reads come from the Durable Object and which falls back
 * to the legacy KV exactly once per key (copying the value into the DO as it
 * goes). No call throws: a DO failure degrades to the legacy backend, and a
 * legacy failure degrades to a miss — never to a 1101.
 */
export function createStoreKv(options: StoreKvOptions): KvLike {
  const { namespace, legacy, namespaceName, instanceName = "kv", legacyFallback = true } = options;

  const send = async (payload: Record<string, unknown>): Promise<StoreReply | null> => {
    if (!namespace) return null;
    try {
      const stub = namespace.get(namespace.idFromName(instanceName));
      const response = await stub.fetch(
        new Request(STORE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: timeoutSignal(),
        })
      );
      if (!response.ok) {
        console.warn(`[store:${namespaceName}] ${String(payload.op)} failed: HTTP ${response.status}`);
        return null;
      }
      return (await response.json()) as StoreReply;
    } catch (error) {
      console.warn(
        `[store:${namespaceName}] ${String(payload.op)} failed:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  };

  return {
    async get(key: string): Promise<string | null> {
      const fromStore = await send({ op: "get", ns: namespaceName, key });
      if (fromStore && typeof fromStore.value === "string") return fromStore.value;

      // Miss (or store unavailable): consult the legacy KV once, then migrate.
      if (!legacyFallback || !legacy) return null;
      const legacyValue = await legacy.get(key);
      if (legacyValue === null) return null;

      // Copy through to the store so the next read is served from it. Awaited
      // (not fire-and-forget) so a cold isolate cannot drop the migration.
      await send({ op: "put", ns: namespaceName, key, value: legacyValue });
      return legacyValue;
    },

    async put(key: string, value: string, putOptions?: { expirationTtl?: number }): Promise<void> {
      const stored = await send({
        op: "put",
        ns: namespaceName,
        key,
        value,
        ttl: putOptions?.expirationTtl,
      });
      if (stored) return;
      // Store unavailable — keep the write somewhere durable rather than losing it.
      if (legacy) await legacy.put(key, value, putOptions);
    },

    async delete(key: string): Promise<void> {
      await send({ op: "delete", ns: namespaceName, key });
      if (legacy) await legacy.delete(key);
    },
  };
}
