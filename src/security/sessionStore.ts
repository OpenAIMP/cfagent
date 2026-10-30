import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { runDoSchemaMigration } from "../data/doSchemaMarker";
import {
  computeEventHash,
  type CreateIaaaAuditEventInput,
  type IaaaAuditEvent,
} from "./iaaaAudit";
import {
  IAAA_AUDIT_ARCHIVE_KEY_PREFIX,
  IAAA_AUDIT_LOG_KEY,
} from "./iaaaAuditStore";

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
  op: "get" | "put" | "delete" | "consume" | "list" | "audit-append";
  ns: string;
  key: string;
  value?: string;
  ttl?: number;
  /** #1760 audit-append caps requested by the client (clamped server-side, see below). */
  liveMax?: number;
  segmentSize?: number;
  maxArchiveSegments?: number;
}

/** Parameterized statement templates (placeholders only, never bound values). */
const STMT_POINT_GET = "SELECT value, expires_at FROM kv_store WHERE ns = ? AND key = ?";
const STMT_EXPIRES_GET = "SELECT expires_at FROM kv_store WHERE ns = ? AND key = ?";
const STMT_LIST =
  "SELECT key, value FROM kv_store WHERE ns = ? AND key LIKE ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key";
const STMT_UPSERT =
  "INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at";
const STMT_DELETE = "DELETE FROM kv_store WHERE ns = ? AND key = ?";
const STMT_ARCHIVE_LIST =
  "SELECT key, value FROM kv_store WHERE ns = ? AND key LIKE ? ORDER BY key";
const STMT_ARCHIVE_INSERT =
  "INSERT INTO kv_store (ns, key, value, expires_at) VALUES (?, ?, ?, NULL)";

/**
 * #1760 — hard ceilings for the audit bound. A client may request
 * SMALLER caps (tests, tighter deployments) but never larger ones:
 * the bound is enforcement, not a caller preference, so a caller
 * widening it would be disabling its own limit. Out-of-range or
 * missing values fall back to the ceiling.
 */
const AUDIT_LIVE_MAX_HARD = 2000;
const AUDIT_SEGMENT_HARD = 2000;
const AUDIT_SEGMENTS_HARD = 10;

function clampAuditCap(requested: unknown, hard: number): number {
  return typeof requested === "number" &&
    Number.isInteger(requested) &&
    requested > 0
    ? Math.min(requested, hard)
    : hard;
}

/** Minimal re-check of a client-validated audit input (defense in depth). */
function isAuditAppendInput(value: unknown): value is CreateIaaaAuditEventInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const str = (k: string): boolean =>
    typeof v[k] === "string" && (v[k] as string).trim().length > 0;
  return (
    str("type") &&
    str("actorPrincipalId") &&
    ["human", "service", "agent"].includes(String(v.actorType)) &&
    str("initiatingPrincipalId") &&
    str("tenantId") &&
    str("correlationId") &&
    str("action") &&
    ["allow", "deny"].includes(String(v.decision)) &&
    str("policyVersion") &&
    ["succeeded", "failed", "pending", "unknown"].includes(String(v.outcome)) &&
    typeof v.timestamp === "number" &&
    Number.isFinite(v.timestamp)
  );
}

function auditEventFromInput(
  input: CreateIaaaAuditEventInput,
): Omit<IaaaAuditEvent, "id" | "previousEventHash" | "eventHash"> {
  // Whitelist: only canonical fields reach the stored event.
  return {
    timestamp: input.timestamp,
    type: input.type,
    actorPrincipalId: input.actorPrincipalId,
    actorType: input.actorType,
    initiatingPrincipalId: input.initiatingPrincipalId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    agentInstanceId: input.agentInstanceId,
    agentRunId: input.agentRunId,
    delegationId: input.delegationId,
    correlationId: input.correlationId,
    action: input.action,
    resourceId: input.resourceId,
    decision: input.decision,
    policyVersion: input.policyVersion,
    approvalId: input.approvalId,
    outcome: input.outcome,
    errorCode: input.errorCode,
  };
}

interface Measured<T> {
  rows: T[];
  rowsRead: number;
  rowsWritten: number;
}

/**
 * The kv_store schema generation this code creates and serves
 * (ADR 0022 D-A.4). Generation 1 is the original shape — the
 * `kv_store` table below — recorded in the D-A.4 marker by the
 * constructor (#2432). Bump this only alongside a schema change
 * to kv_store itself, under runDoSchemaMigration discipline:
 * the marker row is the commit record for the change.
 */
export const SESSION_STORE_SCHEMA_VERSION = 1;

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
    // #2432 (ADR 0022 D-A.4): record the schema-version marker
    // for this instance. SessionStore was the last DO evolving
    // schema with no version marker; generation 1's body is the
    // CREATE TABLE above, which stays unconditional and
    // IF NOT EXISTS exactly as before — the migration call only
    // records that the generation is in place (marker written
    // last, and only when the recorded version is older). The
    // write is additive and idempotent: it touches only the
    // marker module's own table, never kv_store, and no op's
    // behaviour depends on it.
    //
    // The marker module is served through execCounted rather
    // than the raw SqlStorage: execCounted's toArray() is the
    // cursor surface every statement in this class already
    // standardises on (#1819), while the marker's DoSchemaSql
    // contract iterates the exec result — an adapter over
    // execCounted satisfies it without a second cursor idiom.
    runDoSchemaMigration(
      {
        exec: (query: string, ...params: unknown[]) =>
          this.execCounted<Record<string, unknown>>(query, ...params).rows,
      },
      SESSION_STORE_SCHEMA_VERSION,
      () => {},
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

      if (op === "audit-append") {
        // #1760 — transactional audit append. This whole branch runs
        // inside ONE Durable Object request, and a DO handles one
        // request at a time, so the tail read, the chaining, the
        // rotation, and the write cannot interleave with a second
        // appender — the read-modify-write race in the old Kv audit
        // store (F-18) is closed here, not merely detected. The op
        // is restricted to the sessions bucket's audit log key;
        // arbitrary keys cannot be appended through it.
        if (ns !== "sessions" || key !== IAAA_AUDIT_LOG_KEY) {
          return Response.json(
            { error: "audit-append is restricted to the sessions audit log key" },
            { status: 400 },
          );
        }
        if (typeof body.value !== "string") {
          return Response.json({ error: "value is required for audit-append" }, { status: 400 });
        }
        let input: unknown;
        try {
          input = JSON.parse(body.value);
        } catch {
          return Response.json({ error: "invalid audit event" }, { status: 400 });
        }
        if (!isAuditAppendInput(input)) {
          return Response.json({ error: "invalid audit event" }, { status: 400 });
        }
        const liveMax = clampAuditCap(body.liveMax, AUDIT_LIVE_MAX_HARD);
        const segmentSize = clampAuditCap(body.segmentSize, AUDIT_SEGMENT_HARD);
        const maxSegments = clampAuditCap(body.maxArchiveSegments, AUDIT_SEGMENTS_HARD);
        const totalCap = liveMax + maxSegments * segmentSize;

        let rowsRead = 0;
        let rowsWritten = 0;
        const liveMeasured = this.execCounted<{ value: string }>(STMT_POINT_GET, ns, key);
        rowsRead += liveMeasured.rowsRead;
        rowsWritten += liveMeasured.rowsWritten;
        const liveRow = liveMeasured.rows[0];
        let live: IaaaAuditEvent[];
        if (!liveRow) {
          live = [];
        } else {
          try {
            const parsed: unknown = JSON.parse(liveRow.value);
            if (!Array.isArray(parsed)) throw new Error("not an array");
            live = parsed as IaaaAuditEvent[];
          } catch {
            // Corrupt evidence is never overwritten: fail loud and
            // leave the bytes untouched for investigation.
            return Response.json({ error: "audit log corrupt" }, { status: 500 });
          }
        }
        const archiveMeasured = this.execCounted<{ key: string; value: string }>(
          STMT_ARCHIVE_LIST,
          ns,
          `${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}%`,
        );
        rowsRead += archiveMeasured.rowsRead;
        rowsWritten += archiveMeasured.rowsWritten;
        const segments: IaaaAuditEvent[][] = [];
        let nextSegmentIndex = 0;
        for (const row of archiveMeasured.rows) {
          const suffix = row.key.slice(IAAA_AUDIT_ARCHIVE_KEY_PREFIX.length);
          const parsedIndex = Number.parseInt(suffix, 10);
          if (Number.isInteger(parsedIndex)) nextSegmentIndex = Math.max(nextSegmentIndex, parsedIndex + 1);
          try {
            const parsed: unknown = JSON.parse(row.value);
            if (!Array.isArray(parsed)) throw new Error("not an array");
            segments.push(parsed as IaaaAuditEvent[]);
          } catch {
            return Response.json({ error: "audit log corrupt" }, { status: 500 });
          }
        }
        const archivedCount = segments.reduce((sum, seg) => sum + seg.length, 0);
        if (live.length + archivedCount >= totalCap) {
          // The bound is enforced, never silently exceeded and never
          // met by deleting evidence: the client reports
          // AUDIT_STORE_FULL, fail-visible. Destructive retention
          // (deleting old events) needs the Q7 retention decision
          // (owner Mubasher), which has not been made — see the
          // #1760 slice doc.
          return Response.json({
            storeFull: true,
            rowsRead,
            rowsWritten,
            statement: STMT_POINT_GET,
          });
        }
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
        const unsigned = {
          ...auditEventFromInput(input),
          id: crypto.randomUUID(),
          previousEventHash,
        };
        const event: IaaaAuditEvent = {
          ...unsigned,
          eventHash: await computeEventHash(unsigned),
        };
        live.push(event);
        // Rotation preserves evidence: the oldest segment moves to
        // a new archive key; nothing is deleted. The live key stays
        // bounded at liveMax, the whole store at totalCap.
        while (live.length > liveMax) {
          const segment = live.splice(0, segmentSize);
          const segmentKey = `${IAAA_AUDIT_ARCHIVE_KEY_PREFIX}${String(nextSegmentIndex).padStart(6, "0")}`;
          nextSegmentIndex += 1;
          const inserted = this.execCounted(STMT_ARCHIVE_INSERT, ns, segmentKey, JSON.stringify(segment));
          rowsRead += inserted.rowsRead;
          rowsWritten += inserted.rowsWritten;
        }
        const written = this.execCounted(STMT_UPSERT, ns, key, JSON.stringify(live), null);
        rowsRead += written.rowsRead;
        rowsWritten += written.rowsWritten;
        return Response.json({
          ok: true,
          event,
          rowsRead,
          rowsWritten,
          statement: STMT_UPSERT,
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
