/**
 * Issue #1819 — SessionStore returns measured rows per op (RED).
 *
 * The DO SQL cursor already exposes rowsRead/rowsWritten; the current fetch
 * discards them. These tests pin the reply contract: every op returns
 * rowsRead/rowsWritten summed across its statements, plus the parameterized
 * statement fingerprint — so the client funnel can attribute rows without a
 * second query and without ever seeing a bound value.
 *
 * The store is built via Object.create(SessionStore.prototype) with a fake
 * ctx, so the test exercises the real fetch logic without the Workers
 * DurableObject base constructor.
 */
import { describe, it, expect } from "vitest";
import { SessionStore } from "../src/security/sessionStore";

interface FakeCursor {
  toArray(): unknown[];
  rowsRead: number;
  rowsWritten: number;
}

function makeCtx() {
  const tokens = new Map<string, { value: string; expiresAt: number | null }>();
  tokens.set("etrade:etrade:token:alice", { value: "tok-alice", expiresAt: null });
  tokens.set("etrade:etrade:token:bob", { value: "tok-bob", expiresAt: null });
  tokens.set("etrade:etrade:token:stale", { value: "tok-stale", expiresAt: 1 });

  const exec = (sql: string, ..._params: unknown[]): FakeCursor => {
    if (sql.startsWith("CREATE TABLE")) return { toArray: () => [], rowsRead: 0, rowsWritten: 0 };
    if (sql.includes("SELECT key, value")) {
      // list: index range scan over the matching prefix rows.
      return {
        toArray: () => [...tokens.entries()].map(([key, row]) => ({ key, value: row.value })),
        rowsRead: tokens.size,
        rowsWritten: 0,
      };
    }
    if (sql.includes("SELECT value, expires_at")) {
      if (_params.includes("expired-key")) {
        return { toArray: () => [{ value: "sess", expires_at: 1 }], rowsRead: 1, rowsWritten: 0 };
      }
      return { toArray: () => [{ value: "sess", expires_at: null }], rowsRead: 1, rowsWritten: 0 };
    }
    if (sql.includes("SELECT expires_at")) {
      return { toArray: () => [], rowsRead: 1, rowsWritten: 0 };
    }
    if (sql.startsWith("DELETE")) return { toArray: () => [], rowsRead: 0, rowsWritten: 1 };
    if (sql.startsWith("INSERT")) return { toArray: () => [], rowsRead: 0, rowsWritten: 1 };
    throw new Error(`unexpected SQL in fake: ${sql}`);
  };

  const store = Object.create(SessionStore.prototype) as SessionStore;
  (store as unknown as { ctx: unknown }).ctx = { storage: { sql: { exec } } };
  return store;
}

async function post(store: SessionStore, body: Record<string, unknown>) {
  const res = await store.fetch(
    new Request("https://session-store.internal/kv", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
  return (await res.json()) as Record<string, unknown>;
}

describe("SessionStore measured replies (#1819)", () => {
  it("get returns rowsRead 1, rowsWritten 0, and the point-select fingerprint", async () => {
    const reply = await post(makeCtx(), { op: "get", ns: "sessions", key: "abc" });
    expect(reply.value).toBe("sess");
    expect(reply.rowsRead).toBe(1);
    expect(reply.rowsWritten).toBe(0);
    expect(reply.statement).toBe(
      "SELECT value, expires_at FROM kv_store WHERE ns = ? AND key = ?"
    );
  });

  it("list returns rowsRead equal to the scanned prefix rows", async () => {
    const reply = await post(makeCtx(), { op: "list", ns: "etrade", key: "etrade:token:" });
    expect((reply.entries as unknown[]).length).toBe(3);
    expect(reply.rowsRead).toBe(3);
    expect(reply.rowsWritten).toBe(0);
    expect(typeof reply.statement).toBe("string");
    expect(reply.statement as string).toContain("key LIKE ?");
  });

  it("consume sums the pre-read and the claim insert", async () => {
    const reply = await post(makeCtx(), {
      op: "consume",
      ns: "payments",
      key: "tx-1",
      value: "v",
    });
    expect(reply.consumed).toBe(true);
    expect(reply.rowsRead).toBe(1);
    expect(reply.rowsWritten).toBe(1);
  });

  it("put returns rowsWritten 1 and the upsert fingerprint", async () => {
    const reply = await post(makeCtx(), { op: "put", ns: "sessions", key: "s1", value: "v" });
    expect(reply.ok).toBe(true);
    expect(reply.rowsRead).toBe(0);
    expect(reply.rowsWritten).toBe(1);
    expect(reply.statement as string).toContain("INSERT INTO kv_store");
  });

  it("delete returns rowsWritten 1", async () => {
    const reply = await post(makeCtx(), { op: "delete", ns: "sessions", key: "s1" });
    expect(reply.ok).toBe(true);
    expect(reply.rowsWritten).toBe(1);
  });

  it("expired get sums the select and the lazy delete", async () => {
    const reply = await post(makeCtx(), { op: "get", ns: "sessions", key: "expired-key" });
    expect(reply.value).toBeNull();
    expect(reply.rowsRead).toBe(1);
    expect(reply.rowsWritten).toBe(1);
  });

  it("the reply never carries a bound value in the statement", async () => {
    const reply = await post(makeCtx(), { op: "get", ns: "sessions", key: "secret-session-id" });
    expect(reply.statement as string).not.toContain("secret-session-id");
  });
});
