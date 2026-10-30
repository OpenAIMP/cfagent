// @vitest-environment node
/**
 * Issue #2432 (#1976 step 5a, ADR 0022 D-A.4) — SessionStore's
 * schema-version marker.
 *
 * SessionStore was the last Durable Object evolving schema with
 * no version marker: its constructor created `kv_store` with an
 * unversioned CREATE TABLE IF NOT EXISTS, so a future schema
 * change to kv_store had no commit record to land against. The
 * constructor now records generation 1 through the step-0 marker
 * mechanism (src/data/doSchemaMarker.ts).
 *
 * These pins hold the slice's contract for that change:
 *  - the marker is recorded on construction and readable through
 *    the marker module's own read/report functions;
 *  - recording is idempotent (a second construction over the
 *    same storage changes nothing);
 *  - an instance whose storage predates the marker (kv_store
 *    rows present, no marker row) keeps every row and gains the
 *    marker on its next construction — nothing migrates, nothing
 *    is rewritten;
 *  - the marker changes NO op behaviour: the same op script
 *    against a marker-less instance and a marked instance
 *    produces the same replies.
 *
 * The double is a node:sqlite-backed SqlStorage facade in the
 * shape of tests/audit_store_atomic_1760.test.ts — real SQL
 * semantics against the real SessionStore class.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  SessionStore,
  SESSION_STORE_SCHEMA_VERSION,
} from "../src/security/sessionStore";
import {
  readDoSchemaVersion,
  reportDoSchemaVersion,
  DO_SCHEMA_MARKER_TABLE,
  type DoSchemaSql,
} from "../src/data/doSchemaMarker";
import { IAAA_AUDIT_LOG_KEY } from "../src/security/iaaaAuditStore";

function makeDb() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...params: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const rows = stmt.all(...(params as never[]));
        return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
      }
      const info = stmt.run(...(params as never[]));
      return { toArray: () => [], rowsRead: 0, rowsWritten: info.changes };
    },
  };
  const ctx = { storage: { sql } };
  /** The marker module's DoSchemaSql view over the same database. */
  const markerSql: DoSchemaSql = {
    exec(query: string, ...params: unknown[]) {
      const stmt = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        return stmt.all(...(params as never[])) as Array<Record<string, unknown>>;
      }
      stmt.run(...(params as never[]));
      return [];
    },
  };
  return { db, ctx, markerSql };
}

async function call(
  store: SessionStore,
  body: Record<string, unknown>,
): Promise<{ status: number; reply: Record<string, unknown> }> {
  const res = await store.fetch(
    new Request("https://session-store.internal/kv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, reply: (await res.json()) as Record<string, unknown> };
}

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const SESSION_VALUE = JSON.stringify({ githubLogin: "octocat", createdAt: 1_000_000 });

describe("SessionStore schema marker (#2432, D-A.4)", () => {
  it("records generation 1 on construction, readable via the marker module", () => {
    const { ctx, markerSql } = makeDb();
    expect(SESSION_STORE_SCHEMA_VERSION).toBe(1);
    expect(readDoSchemaVersion(markerSql)).toBe(0);

    new SessionStore(ctx as never, {} as never);

    expect(readDoSchemaVersion(markerSql)).toBe(SESSION_STORE_SCHEMA_VERSION);
    expect(reportDoSchemaVersion(markerSql, "session-store", 5_000)).toEqual({
      agentKey: "session-store",
      doSchemaVersion: SESSION_STORE_SCHEMA_VERSION,
      reportedAtMs: 5_000,
    });
  });

  it("is idempotent: a second construction over the same storage records nothing new", () => {
    const { db, ctx, markerSql } = makeDb();
    new SessionStore(ctx as never, {} as never);
    new SessionStore(ctx as never, {} as never);

    expect(readDoSchemaVersion(markerSql)).toBe(SESSION_STORE_SCHEMA_VERSION);
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM ${DO_SCHEMA_MARKER_TABLE}`)
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("a pre-marker instance keeps its rows and gains the marker on next construction", async () => {
    const { db, ctx, markerSql } = makeDb();
    // Simulate the pre-#2432 world: the generation-1 kv_store DDL
    // and live rows exist, the marker table does not.
    db.exec(
      `CREATE TABLE kv_store (
         ns TEXT NOT NULL,
         key TEXT NOT NULL,
         value TEXT NOT NULL,
         expires_at INTEGER,
         PRIMARY KEY (ns, key)
       )`,
    );
    const insert = db.prepare(
      "INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("sessions", SESSION_ID, SESSION_VALUE, null);
    insert.run("sessions", IAAA_AUDIT_LOG_KEY, "[]", null);
    expect(readDoSchemaVersion(markerSql)).toBe(0);

    const store = new SessionStore(ctx as never, {} as never);

    expect(readDoSchemaVersion(markerSql)).toBe(SESSION_STORE_SCHEMA_VERSION);
    const got = await call(store, { op: "get", ns: "sessions", key: SESSION_ID });
    expect(got.reply.value).toBe(SESSION_VALUE);
    const audit = await call(store, {
      op: "get",
      ns: "sessions",
      key: IAAA_AUDIT_LOG_KEY,
    });
    expect(audit.reply.value).toBe("[]");
    const count = db.prepare("SELECT COUNT(*) AS n FROM kv_store").get() as {
      n: number;
    };
    expect(count.n).toBe(2);
  });

  it("changes no op behaviour: the same op script replies identically with and without the marker", async () => {
    async function runScript(withMarker: boolean) {
      const { db, ctx } = makeDb();
      const store = new SessionStore(ctx as never, {} as never);
      if (!withMarker) {
        // Re-create the pre-marker state: same kv_store, no marker row.
        db.exec(`DROP TABLE ${DO_SCHEMA_MARKER_TABLE}`);
      }
      const replies: Array<Record<string, unknown>> = [];
      replies.push(
        (await call(store, { op: "put", ns: "sessions", key: SESSION_ID, value: SESSION_VALUE, ttl: 600 })).reply,
      );
      replies.push(
        (await call(store, { op: "get", ns: "sessions", key: SESSION_ID })).reply,
      );
      replies.push(
        (await call(store, { op: "consume", ns: "payments", key: "x402tx:0x1", value: "claimed", ttl: 60 })).reply,
      );
      replies.push(
        (await call(store, { op: "consume", ns: "payments", key: "x402tx:0x1", value: "claimed", ttl: 60 })).reply,
      );
      replies.push(
        (await call(store, { op: "list", ns: "sessions", key: "" })).reply,
      );
      replies.push(
        (await call(store, { op: "delete", ns: "sessions", key: SESSION_ID })).reply,
      );
      replies.push(
        (await call(store, { op: "get", ns: "sessions", key: SESSION_ID })).reply,
      );
      return replies;
    }

    const unmarked = await runScript(false);
    const marked = await runScript(true);
    expect(marked).toEqual(unmarked);
    // And the script itself exercised real behaviour, not vacuity:
    expect(unmarked[1].value).toBe(SESSION_VALUE);
    expect(unmarked[2].consumed).toBe(true);
    expect(unmarked[3].consumed).toBe(false);
    expect(unmarked[6].value).toBeNull();
  });
});
