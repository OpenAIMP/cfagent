/**
 * Fake SessionStore Durable Object namespace for tests (#604).
 *
 * Sessions and E*TRADE tokens live in the SessionStore DO; the store protocol
 * is POST {op, ns, key, value?} → {value | ok}. This fake speaks that protocol
 * over an in-memory map, keyed by `${ns}:${key}`.
 *
 * Usage:
 *   const { namespace, seed } = makeFakeSessionStore();
 *   seed("sessions", SESSION_ID, { githubLogin: "octocat" });
 *   const env = { SESSION_STORE: namespace } as Env;
 */
export interface FakeSessionStore {
  namespace: {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { fetch: (req: Request) => Promise<Response> };
  };
  /** Seed or inspect raw entries. Keyed by `${ns}:${key}`. */
  store: Map<string, string>;
  /** Seed one entry; objects are JSON-encoded. */
  seed: (ns: string, key: string, value: unknown) => void;
}

export function makeFakeSessionStore(): FakeSessionStore {
  const store = new Map<string, string>();
  // Claim expiries for the consume op (the real DO tracks expires_at
  // per row; the fake's get/put ignore TTLs, so consume keeps its own
  // ledger — enough to mirror the single-flight semantics, #1245).
  const claims = new Map<string, number>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: async (req: Request) => {
        const body = (await req.json()) as {
          op: string;
          ns: string;
          key: string;
          value?: string;
          ttl?: number;
        };
        const k = `${body.ns}:${body.key}`;
        if (body.op === "get") {
          return Response.json({ value: store.get(k) ?? null });
        }
        if (body.op === "put") {
          store.set(k, body.value ?? "");
          return Response.json({ ok: true });
        }
        if (body.op === "delete") {
          store.delete(k);
          claims.delete(k);
          return Response.json({ ok: true });
        }
        if (body.op === "list") {
          // Mirrors the real SessionStore DO rule (#1758): list is
          // allowed for the sessions namespace (any prefix) and
          // for E*TRADE token entries only — nothing else.
          const sessionsAllowed = body.ns === "sessions";
          const etradeAllowed = body.ns === "etrade" && body.key.startsWith("etrade:token:");
          if (!sessionsAllowed && !etradeAllowed) {
            return Response.json({ error: "list is restricted" }, { status: 400 });
          }
          const entries: Array<{ key: string; value: string }> = [];
          for (const [k, v] of store) {
            if (!k.startsWith(`${body.ns}:`)) continue;
            const keyPart = k.slice(body.ns.length + 1);
            if (!keyPart.startsWith(body.key)) continue;
            entries.push({ key: keyPart, value: v });
          }
          entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
          return Response.json({ entries });
        }
        if (body.op === "consume") {
          const heldUntil = claims.get(k);
          if (heldUntil !== undefined && heldUntil > Date.now()) {
            return Response.json({ consumed: false });
          }
          claims.set(k, Date.now() + (typeof body.ttl === "number" ? body.ttl * 1000 : 0));
          store.set(k, body.value ?? "");
          return Response.json({ consumed: true });
        }
        return Response.json({ error: "unknown op" }, { status: 400 });
      },
    }),
  };
  return {
    namespace,
    store,
    seed: (ns: string, key: string, value: unknown) => {
      store.set(
        `${ns}:${key}`,
        typeof value === "string" ? value : JSON.stringify(value)
      );
    },
  };
}
