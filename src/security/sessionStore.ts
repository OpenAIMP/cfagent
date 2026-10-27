import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/**
 * Session and credential store (issue #329 follow-up).
 *
 * Workers KV's free tier caps reads at 100k/day and, once exhausted, every
 * `get()` throws — which took authentication, and therefore the whole site,
 * down with Cloudflare error 1101. Sessions and E*TRADE tokens now live in this
 * Durable Object's SQLite store instead: no daily read cap, and the same
 * durability the rest of the app already relies on.
 *
 * One instance (`idFromName("kv")`) holds every bucket, namespaced by `ns`, so
 * the client only has to add a binding — not a second index or routing scheme.
 */
interface StoreOp {
  op: "get" | "put" | "delete" | "consume" | "list";
  ns: string;
  key: string;
  value?: string;
  ttl?: number;
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
        if (ns !== "etrade" || !key.startsWith("etrade:token:")) {
          return Response.json({ error: "list is restricted to E*TRADE token entries" }, { status: 400 });
        }
        const entries = this.ctx.storage.sql
          .exec(
            "SELECT key, value FROM kv_store WHERE ns = ? AND key LIKE ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key",
            ns,
            `${key.replace(/[\\%_]/g, "\\$&")}%`,
            Date.now()
          )
          .toArray() as Array<{ key: string; value: string }>;
        return Response.json({ entries });
      }

      if (op === "get") {
        const row = this.ctx.storage.sql
          .exec("SELECT value, expires_at FROM kv_store WHERE ns = ? AND key = ?", ns, key)
          .toArray()[0] as { value: string; expires_at: number | null } | undefined;

        if (!row) return Response.json({ value: null });
        if (row.expires_at !== null && row.expires_at <= Date.now()) {
          this.ctx.storage.sql.exec("DELETE FROM kv_store WHERE ns = ? AND key = ?", ns, key);
          return Response.json({ value: null });
        }
        return Response.json({ value: row.value });
      }

      if (op === "consume") {
        // Replay guard (issue #329 P3). A DO handles one request at a time, so
        // this read-then-write cannot interleave — unlike the KV get-then-put it
        // replaces, where two colos could both see "not consumed".
        const existing = this.ctx.storage.sql
          .exec("SELECT expires_at FROM kv_store WHERE ns = ? AND key = ?", ns, key)
          .toArray()[0] as { expires_at: number | null } | undefined;

        if (existing && (existing.expires_at === null || existing.expires_at > Date.now())) {
          return Response.json({ consumed: false });
        }

        const claimedUntil =
          typeof body.ttl === "number" ? Date.now() + body.ttl * 1000 : null;
        this.ctx.storage.sql.exec(
          `INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
          ns,
          key,
          body.value ?? "",
          claimedUntil
        );
        return Response.json({ consumed: true });
      }

      if (op === "put") {
        if (typeof body.value !== "string") {
          return Response.json({ error: "value is required for put" }, { status: 400 });
        }
        const expiresAt = typeof body.ttl === "number" ? Date.now() + body.ttl * 1000 : null;
        this.ctx.storage.sql.exec(
          `INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
          ns,
          key,
          body.value,
          expiresAt
        );
        return Response.json({ ok: true });
      }

      this.ctx.storage.sql.exec("DELETE FROM kv_store WHERE ns = ? AND key = ?", ns, key);
      return Response.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[SessionStore] op failed", op, message);
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
