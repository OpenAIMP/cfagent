import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStoreKv, type DoNamespaceLike } from "../src/security/durableKv";
import { createResilientKv } from "../src/security/kvResilience";

/**
 * Issue #329 — sessions and credentials moved off KV onto the SessionStore
 * Durable Object. These tests model the DO protocol in memory and pin the
 * migration path: the DO is authoritative, the legacy KV is consulted only on a
 * miss (and then written through), and neither backend failure throws.
 */
interface Row {
  value: string;
  expiresAt: number | null;
}

function makeStore(options: { fail?: boolean } = {}) {
  const rows = new Map<string, Row>();

  const namespace: DoNamespaceLike = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        if (options.fail) throw new Error("DO unavailable");
        const { op, ns, key, value, ttl } = (await request.json()) as {
          op: string;
          ns: string;
          key: string;
          value?: string;
          ttl?: number;
        };
        const id = `${ns}:${key}`;

        if (op === "get") {
          const row = rows.get(id);
          if (!row) return Response.json({ value: null });
          if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
            rows.delete(id);
            return Response.json({ value: null });
          }
          return Response.json({ value: row.value });
        }
        if (op === "put") {
          rows.set(id, { value: value as string, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
          return Response.json({ ok: true });
        }
        rows.delete(id);
        return Response.json({ ok: true });
      },
    }),
  };

  return { namespace, rows };
}

function makeLegacy() {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
  };
}

describe("Durable Object backed store (#329)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serves reads from the store without touching KV", async () => {
    const store = makeStore();
    const legacy = makeLegacy();
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });

    await kv.put("session-1", "payload");

    expect(await kv.get("session-1")).toBe("payload");
    expect(legacy.get).not.toHaveBeenCalled();
    expect(store.rows.get("sessions:session-1")?.value).toBe("payload");
  });

  it("migrates a legacy value on first read, then stops consulting KV", async () => {
    const store = makeStore();
    const legacy = makeLegacy();
    legacy.data.set("old-session", "legacy-payload");
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });

    expect(await kv.get("old-session")).toBe("legacy-payload");
    expect(legacy.get).toHaveBeenCalledTimes(1);
    expect(store.rows.get("sessions:old-session")?.value).toBe("legacy-payload");

    expect(await kv.get("old-session")).toBe("legacy-payload");
    expect(legacy.get).toHaveBeenCalledTimes(1);
  });

  it("honours the TTL it was given", async () => {
    const store = makeStore();
    const kv = createStoreKv({ namespace: store.namespace, namespaceName: "sessions" });

    await kv.put("short", "payload", { expirationTtl: 60 });
    expect(await kv.get("short")).toBe("payload");

    vi.advanceTimersByTime(61_000);
    expect(await kv.get("short")).toBeNull();
  });

  it("skips the legacy read entirely when the fallback is off", async () => {
    const store = makeStore();
    const legacy = makeLegacy();
    legacy.data.set("old-session", "legacy-payload");
    const kv = createStoreKv({
      namespace: store.namespace,
      legacy,
      namespaceName: "sessions",
      legacyFallback: false,
    });

    expect(await kv.get("old-session")).toBeNull();
    expect(legacy.get).not.toHaveBeenCalled();
  });

  it("keeps working from KV when the store is unavailable", async () => {
    const store = makeStore({ fail: true });
    const legacy = makeLegacy();
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });

    await kv.put("k", "v");
    expect(legacy.data.get("k")).toBe("v");
    expect(await kv.get("k")).toBe("v");
  });

  it("still writes to KV when the store is absent (local dev)", async () => {
    const legacy = makeLegacy();
    const kv = createStoreKv({ namespace: null, legacy, namespaceName: "sessions" });

    await kv.put("k", "v");
    expect(await kv.get("k")).toBe("v");
  });

  it("deletes from both backends so logout cannot leave a stale copy", async () => {
    const store = makeStore();
    const legacy = makeLegacy();
    legacy.data.set("k", "legacy");
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });
    await kv.put("k", "v");

    await kv.delete("k");

    expect(store.rows.has("sessions:k")).toBe(false);
    expect(legacy.data.has("k")).toBe(false);
  });

  it("does not throw when both backends fail", async () => {
    const store = makeStore({ fail: true });
    const legacy = createResilientKv(
      {
        get: async () => {
          throw new Error("KV get() limit exceeded for the day.");
        },
        put: async () => undefined,
        delete: async () => undefined,
      },
      "sessions-test"
    );
    const kv = createStoreKv({ namespace: store.namespace, legacy, namespaceName: "sessions" });

    await expect(kv.get("k")).resolves.toBeNull();
    await expect(kv.put("k", "v")).resolves.toBeUndefined();
    await expect(kv.delete("k")).resolves.toBeUndefined();
  });
});
