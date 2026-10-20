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
  const namespace = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: async (req: Request) => {
        const body = (await req.json()) as {
          op: string;
          ns: string;
          key: string;
          value?: string;
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
          return Response.json({ ok: true });
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
