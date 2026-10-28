import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../src/security/sessionStore";
import {
  createAtomicAuditStore,
  IAAA_AUDIT_LOG_KEY,
} from "../src/security/iaaaAuditStore";
import {
  recordAuditEvent,
  verifyChain,
  type CreateIaaaAuditEventInput,
} from "../src/security/iaaaAudit";

/**
 * Issue #1760 — the audit store's read-modify-write race, closed by a
 * transactional append.
 *
 * The production guarantee has two halves, and this suite is honest
 * about which half it proves:
 *
 * 1. The append itself is ONE Durable Object request (the new
 *    `audit-append` op): the DO reads the tail, chains the event,
 *    rotates, and writes back inside that request. No client-side
 *    list-then-link step exists on this path, so there is no
 *    interleaving window for a second appender to slip into.
 * 2. The DO runtime serializes requests to one instance (the same
 *    premise the `consume` replay guard already relies on: "A DO
 *    handles one request at a time, so this read-then-write cannot
 *    interleave"). The namespace stub below models that input gate
 *    with a promise-chain mutex around the real SessionStore
 *    instance — without it, Node's event loop would interleave two
 *    concurrent fetch() calls at the WebCrypto await, which the
 *    real DO runtime does not do.
 *
 * What the concurrency test therefore proves: under parallel client
 * appends against a serialized DO, no event is lost and the chain
 * never forks. The contrasting Red evidence for the legacy path (a
 * delaying Kv store under parallel recordAuditEvent calls loses
 * events / forks the chain) is recorded in the #1760 PR body, not
 * as a committed test — a test asserting loss on the legacy path
 * would be timing-fragile by construction.
 */

function makeDoNamespace() {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    storage: {
      sql: {
        exec(sql: string, ...params: unknown[]) {
          const stmt = db.prepare(sql);
          if (/^\s*SELECT/i.test(sql)) {
            const rows = stmt.all(...params);
            return {
              toArray: () => rows,
              rowsRead: rows.length,
              rowsWritten: 0,
            };
          }
          const info = stmt.run(...params);
          return { toArray: () => [], rowsRead: 0, rowsWritten: info.changes };
        },
      },
    },
  };
  const store = new SessionStore(ctx as never, {} as never);
  // Model the DO input gate: one fetch at a time, in call order.
  let queue: Promise<unknown> = Promise.resolve();
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (request: Request) => {
        const run = queue.then(() => store.fetch(request));
        queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    }),
  };
  return { namespace, store };
}

function auditInput(action: string, timestamp: number): CreateIaaaAuditEventInput {
  return {
    timestamp,
    type: "auth.login",
    actorPrincipalId: "user-1",
    actorType: "human",
    initiatingPrincipalId: "user-1",
    tenantId: "tenant-1",
    correlationId: `corr-${action}`,
    action,
    decision: "allow",
    policyVersion: "iaaa-audit-1",
    outcome: "succeeded",
  };
}

describe("atomic audit backend (#1760)", () => {
  it("parallel appends lose no events and fork no chain", async () => {
    const { namespace } = makeDoNamespace();
    const store = createAtomicAuditStore(namespace);
    const count = 40;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        recordAuditEvent(store, auditInput(`auth.login:${i}`, 1_000_000 + i)),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const events = await store.list();
    expect(events).toHaveLength(count);
    expect(new Set(events.map((e) => e.id)).size).toBe(count);
    expect(new Set(events.map((e) => e.action)).size).toBe(count);
    expect(await verifyChain(events)).toBe(true);
  });

  it("rotation preserves the chain and the total cap fails visible, never deleting", async () => {
    const { namespace, store: doInstance } = makeDoNamespace();
    const store = createAtomicAuditStore(namespace, {
      liveMax: 5,
      segmentSize: 2,
      maxArchiveSegments: 2,
    });
    // Cap = live 5 + 2 segments x 2 = 9 events.
    for (let i = 0; i < 9; i++) {
      const result = await recordAuditEvent(store, auditInput(`event:${i}`, 2_000_000 + i));
      expect(result.ok).toBe(true);
    }
    const events = await store.list();
    expect(events).toHaveLength(9);
    expect(await verifyChain(events)).toBe(true);
    // The first event survives rotation: nothing was deleted.
    expect(events[0].action).toBe("event:0");
    expect(events[8].action).toBe("event:8");

    const full = await recordAuditEvent(store, auditInput("event:9", 2_000_009));
    expect(full.ok).toBe(false);
    if (!full.ok) {
      expect(full.code).toBe("AUDIT_STORE_FULL");
    }
    const after = await store.list();
    expect(after).toHaveLength(9);
    expect(await verifyChain(after)).toBe(true);

    // The live key alone is bounded: it never holds more than liveMax.
    const liveRaw = await doInstance.fetch(
      new Request("https://session-store.internal/kv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "get", ns: "sessions", key: IAAA_AUDIT_LOG_KEY }),
      }),
    );
    const liveReply = (await liveRaw.json()) as { value: string };
    expect((JSON.parse(liveReply.value) as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it("a corrupt live log fails visible and the corrupt bytes are left untouched", async () => {
    const { namespace, store: doInstance } = makeDoNamespace();
    await doInstance.fetch(
      new Request("https://session-store.internal/kv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "put",
          ns: "sessions",
          key: IAAA_AUDIT_LOG_KEY,
          value: "{not json",
        }),
      }),
    );
    const store = createAtomicAuditStore(namespace);
    const result = await recordAuditEvent(store, auditInput("auth.login:0", 3_000_000));
    expect(result.ok).toBe(false);
    const raw = await doInstance.fetch(
      new Request("https://session-store.internal/kv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "get", ns: "sessions", key: IAAA_AUDIT_LOG_KEY }),
      }),
    );
    const reply = (await raw.json()) as { value: string };
    expect(reply.value).toBe("{not json");
  });

  it("an empty store chains the first event from null", async () => {
    const { namespace } = makeDoNamespace();
    const store = createAtomicAuditStore(namespace);
    const result = await recordAuditEvent(store, auditInput("auth.login:0", 4_000_000));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.previousEventHash).toBeNull();
    }
    expect(await verifyChain(await store.list())).toBe(true);
  });
});
