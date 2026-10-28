import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/**
 * Session and credential store (issue #329 follow-up).
 *
 * Workers KV's free tier caps reads at 100k/day and, once exhausted, every
 * `get()` throws — which took authentication, and therefore the whole site,
 * down with Cloudflare error 1101. Sessions and E*TRADE tokens now live in
 * this Durable Object's SQLite store instead. CORRECTION (issue #1819):
 * DO SQLite on the free tier is NOT uncapped — it carries its own daily
 * limits (5M rows read/day, 100k rows written/day at the time of writing),
 * and exhausting the rows-read cap on 2026-10-26 took sign-in down the same
 * way KV exhaustion once did. The earlier "no daily read cap" wording was
 * wrong and is the direct cause of the surprise; see
 * docs/architecture/security/sessionstore-resource-measurement-1819.md.
 *
 * One instance (`idFromName("kv")`) holds every bucket, namespaced by `ns`, so
 * the client only has to add a binding — not a second index or routing scheme.
 *
 * Measurement (#1819): every op reply carries the platform-measured
 * rowsRead/rowsWritten summed across its statements (cursor totals, which the
 * old code discarded) plus the parameterized statement template. No bound
 * value ever appears in the statement field.
 */
interface StoreOp {
  op: "get" | "put" | "delete" | "consume" | "list";
  ns: string;
  key: string;
  value?: string;
  ttl?: number;
}

/** Parameterized statement templates (placeholders only, never bound values). */
const STMT_POINT_GET = "SELECT value, expires_at FROM kv_store WHERE ns = ? AND key = ?";
const STMT_EXPIRES_GET = "SELECT expires_at FROM kv_store WHERE ns = ? AND key = ?";
const STMT_LIST =
  "SELECT key, value FROM kv_store WHERE ns = ? AND key LIKE ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key";
const STMT_UPSERT =
  "INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at";
const STMT_DELETE = "DELETE FROM kv_store WHERE ns = ? AND key = ?";

interface Measured<T> {
  rows: T[];
  rowsRead: number;
  rowsWritten: number;
}

export class SessionStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS kv_store (
         ns TEXT NOT NULL,
         key TEXT NOT NULL,
         value TEXT NOT NULL,
         expires_at INTEGER,
         PRIMARY KEY (ns, key)
       )`
    );
  }

  /**
   * Execute one statement and capture the platform-measured cursor totals.
   * The cursor must be fully consumed (toArray) before rowsRead/rowsWritten
   * are final — reading them off a partially iterated cursor understates.
   */
  private execCounted<T>(sql: string, ...params: unknown[]): Measured<T> {
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    const rows = cursor.toArray() as T[];
    return { rows, rowsRead: cursor.rowsRead ?? 0, rowsWritten: cursor.rowsWritten ?? 0 };
  }

  async fetch(request: Request): Promise<Response> {
    let body: StoreOp;
    try {
      body = (await request.json()) as StoreOp;
    } catch {
      return Response.json({ error: "invalid body" }, { status: 400 });
    }

    const { op, ns, key } = body;
    if (!op || !ns || !key) {
      return Response.json({ error: "op, ns and key are required" }, { status: 400 });
    }

    try {
      if (op === "list") {
        // #1758: the sessions namespace joins the E*TRADE token
        // namespace as listable. Listing sessions is what makes
        // bulk revocation possible: without it, an offboarding can
        // only revoke the session ids its caller already knows
        // (scan F-16). The DO itself performs no authorization —
        // it is reachable only through the Worker's internal stub
        // fetch, never from a client — so every list caller is a
        // server code path whose route gates the read (the IAAA
        // lifecycle routes are admin- or self-gated; the values
        // returned are full session records, so no new list caller
        // may be added without a route-level gate review).
        const sessionsListAllowed = ns === "sessions";
        const etradeListAllowed = ns === "etrade" && key.startsWith("etrade:token:");
        if (!sessionsListAllowed && !etradeListAllowed) {
          return Response.json({ error: "list is restricted to session entries and E*TRADE token entries" }, { status: 400 });
        }
        const measured = this.execCounted<{ key: string; value: string }>(
          STMT_LIST,
          ns,
          `${key.replace(/[\\%_]/g, "\\$&")}%`,
          Date.now()
        );
        return Response.json({
          entries: measured.rows,
          rowsRead: measured.rowsRead,
          rowsWritten: measured.rowsWritten,
          statement: STMT_LIST,
        });
      }

      if (op === "get") {
        const measured = this.execCounted<{ value: string; expires_at: number | null }>(
          STMT_POINT_GET,
          ns,
          key
        );
        const row = measured.rows[0];

        if (!row) {
          return Response.json({
            value: null,
            rowsRead: measured.rowsRead,
            rowsWritten: measured.rowsWritten,
            statement: STMT_POINT_GET,
          });
        }
        if (row.expires_at !== null && row.expires_at <= Date.now()) {
          const deleted = this.execCounted(STMT_DELETE, ns, key);
          return Response.json({
            value: null,
            rowsRead: measured.rowsRead + deleted.rowsRead,
            rowsWritten: measured.rowsWritten + deleted.rowsWritten,
            statement: STMT_POINT_GET,
          });
        }
        return Response.json({
          value: row.value,
          rowsRead: measured.rowsRead,
          rowsWritten: measured.rowsWritten,
          statement: STMT_POINT_GET,
        });
      }

      if (op === "consume") {
        // Replay guard (issue #329 P3). A DO handles one request at a time, so
        // this read-then-write cannot interleave — unlike the KV get-then-put it
        // replaces, where two colos could both see "not consumed".
        const existing = this.execCounted<{ expires_at: number | null }>(
          STMT_EXPIRES_GET,
          ns,
          key
        );
        const row = existing.rows[0];

        if (row && (row.expires_at === null || row.expires_at > Date.now())) {
          return Response.json({
            consumed: false,
            rowsRead: existing.rowsRead,
            rowsWritten: existing.rowsWritten,
            statement: STMT_EXPIRES_GET,
          });
        }

        const claimedUntil =
          typeof body.ttl === "number" ? Date.now() + body.ttl * 1000 : null;
        const claimed = this.execCounted(STMT_UPSERT, ns, key, body.value ?? "", claimedUntil);
        return Response.json({
          consumed: true,
          rowsRead: existing.rowsRead + claimed.rowsRead,
          rowsWritten: existing.rowsWritten + claimed.rowsWritten,
          statement: STMT_EXPIRES_GET,
        });
      }

      if (op === "put") {
        if (typeof body.value !== "string") {
          return Response.json({ error: "value is required for put" }, { status: 400 });
        }
        const expiresAt = typeof body.ttl === "number" ? Date.now() + body.ttl * 1000 : null;
        const measured = this.execCounted(STMT_UPSERT, ns, key, body.value, expiresAt);
        return Response.json({
          ok: true,
          rowsRead: measured.rowsRead,
          rowsWritten: measured.rowsWritten,
          statement: STMT_UPSERT,
        });
      }

      const deleted = this.execCounted(STMT_DELETE, ns, key);
      return Response.json({
        ok: true,
        rowsRead: deleted.rowsRead,
        rowsWritten: deleted.rowsWritten,
        statement: STMT_DELETE,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SessionStore] op failed", op, message);
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
