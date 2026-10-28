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
import type { IaaaAuditEvent } from "../src/security/iaaaAudit";
import { computeEventHash } from "../src/security/iaaaAudit";
import {
  IAAA_AUDIT_ARCHIVE_KEY_PREFIX,
  IAAA_AUDIT_LOG_KEY,
} from "../src/security/iaaaAuditStore";
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
        if (body.op === "audit-append") {
          // #1760: mirrors the real SessionStore DO's audit-append
          // op (single-flight in this fake: no await between the
          // tail read and the write, exactly like the real DO's
          // serialized request). Same caps, same clamps, same
          // rotation, same storeFull signal.
          const caps = body as unknown as {
            liveMax?: number;
            segmentSize?: number;
            maxArchiveSegments?: number;
          };
          const clamp = (v: unknown, hard: number): number =>
            typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, hard) : hard;
          const liveMax = clamp(caps.liveMax, 2000);
          const segmentSize = clamp(caps.segmentSize, 2000);
          const maxSegments = clamp(caps.maxArchiveSegments, 10);
          if (body.ns !== "sessions" || body.key !== IAAA_AUDIT_LOG_KEY) {
            return Response.json({ error: "audit-append is restricted" }, { status: 400 });
          }
          const parseArray = (raw: string | undefined): IaaaAuditEvent[] | null => {
            if (raw === undefined) return [];
            try {
              const parsed: unknown = JSON.parse(raw);
              return Array.isArray(parsed) ? (parsed as IaaaAuditEvent[]) : null;
            } catch {
              return null;
            }
          };
          const live = parseArray(store.get(k));
          if (live === null) {
            return Response.json({ error: "audit log corrupt" }, { status: 500 });
          }
          const archiveKeys = [...store.keys()]
            .filter((kk) => kk.startsWith(`${body.ns}:${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}`))
            .sort();
          const segments: IaaaAuditEvent[][] = [];
          for (const ak of archiveKeys) {
            const seg = parseArray(store.get(ak));
            if (seg === null) {
              return Response.json({ error: "audit log corrupt" }, { status: 500 });
            }
            segments.push(seg);
          }
          const archived = segments.reduce((sum, seg) => sum + seg.length, 0);
          if (live.length + archived >= liveMax + maxSegments * segmentSize) {
            return Response.json({ storeFull: true });
          }
          const input = JSON.parse(body.value ?? "") as Omit<
            IaaaAuditEvent,
            "id" | "previousEventHash" | "eventHash"
          >;
          const lastArchived =
            segments.length > 0 && segments[segments.length - 1].length > 0
              ? segments[segments.length - 1][segments[segments.length - 1].length - 1]
              : null;
          const previousEventHash =
            live.length > 0
              ? live[live.length - 1].eventHash
              : lastArchived
                ? lastArchived.eventHash
                : null;
          const unsigned = { ...input, id: crypto.randomUUID(), previousEventHash };
          const event: IaaaAuditEvent = {
            ...unsigned,
            eventHash: await computeEventHash(unsigned),
          };
          live.push(event);
          let nextIndex = archiveKeys.length;
          while (live.length > liveMax) {
            const segment = live.splice(0, segmentSize);
            store.set(
              `${body.ns}:${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}${String(nextIndex).padStart(6, "0")}`,
              JSON.stringify(segment),
            );
            nextIndex += 1;
          }
          store.set(k, JSON.stringify(live));
          return Response.json({ ok: true, event });
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
