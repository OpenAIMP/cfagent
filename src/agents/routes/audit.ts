/**
 * Issue #359-04: audit routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move — no behavior change.
 *
 * Owns the audit-log read route (GET /api/audit) and the two audit-write
 * routes (POST /api/audit, POST /api/audit/event), all operating on the
 * mas_events table implemented under #270/PR #302. The three blocks were
 * contiguous in routeRequest (between the ads/revenue/referrals handler and
 * the autopilot block), so this module exports ONE handler invoked from
 * routeRequest at the EXACT position the original blocks occupied in the
 * sequential path.endsWith matching sequence. It returns a Response when one
 * of its paths matches, or null when none does — matching order relative to
 * all other handlers is preserved by the call site.
 *
 * The audit writes funnel through the single owner recordAudit() (issue
 * #270): POST /audit calls the audit() seam (which delegates to
 * recordAudit()), and POST /api/audit/event calls recordAudit() directly.
 * The extraction keeps that delegation exactly — nothing is inlined here.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them via
 * the explicit AuditRouteContext parameter; there are no new globals and no
 * back-references into the class.
 */

import type { AgentName } from "../../types";
import { DatabaseORM, type SqlStorage } from "../../orm";
import { runRestTool } from "./restToolBridge";
import {
  resolveAuditWriteRestSwitch,
  validateStrictAuditWrite,
  type RestTwinsScopedModes,
} from "../../config/restTwinsModes";

/** The subset of OrchestratorAgent surface the audit handlers need. */
export interface AuditRouteContext {
  ensureTables(): SqlStorage;
  /**
   * #1644: ORM accessor for command execution. Optional — routes without
   * it build a DatabaseORM over ensureTables() (same tables, no seeding).
   */
  getOrm?: () => DatabaseORM;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** Single owner of audit-row inserts (issue #270): inserts one mas_events row. */
  recordAudit(
    type: string,
    agent: string,
    payload: Record<string, unknown>
  ): { id: string; type: string; agent: string; payload: Record<string, unknown>; created_at: string };
  /** #1733: Worker env for the AUDIT_WRITE_MODE global-env level (optional — unset falls through to legacy). */
  env?: unknown;
  /** #1733: optional session/user carriers for AUDIT_WRITE_MODE (run comes from body `mode` / query `?mode=`). Populated by the execution-context owner; unset carriers fall through to env. See src/config/restTwinsModes.ts. */
  scopedAuditModes?: RestTwinsScopedModes;
}

/** #1733: adapts this module's route context to the restTwinsModes switch host (the ctx audit type is narrower than the host's, so it is wrapped rather than passed through). */
function auditSwitchHost(ctx: AuditRouteContext) {
  return {
    scopedAuditModes: ctx.scopedAuditModes,
    env: ctx.env,
    audit: (type: string, agent: any, payload: Record<string, unknown>) => ctx.audit(type, agent, payload),
  };
}

/** 5-field audit projection shared by the list and detail endpoints: the
 * payload-JSON parse with { raw } fallback. The payload column is TEXT
 * (recordAudit stringifies), so a stored object can only arrive via a
 * foreign writer — { raw } keeps it readable instead of throwing. */
function projectAuditEvent(e: { id: string; type: string; agent: string; payload: string; createdAt: string }) {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(e.payload);
  } catch {
    payload = { raw: e.payload };
  }
  return { id: e.id, type: e.type, agent: e.agent, payload, created_at: e.createdAt };
}

/**
 * Handles the audit routes. Returns a Response on match, null when no
 * audit path matches (the orchestrator then continues its sequential matching).
 */
export async function handleAuditRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AuditRouteContext
): Promise<Response | null> {
  // Audit event detail endpoint (#1968)
  // GET /api/audit/:id returns one event with its full payload. The id
  // is session-scoped: an unknown id and a row from another session both
  // answer the same 404, so the endpoint never leaks cross-session
  // existence. The "event" segment is excluded so the POST /audit/event
  // write route keeps its existing fall-through behavior.
  const detailMatch = path.match(/\/audit\/([^/]+)$/);
  if (detailMatch && detailMatch[1] !== "event" && request.method === "GET") {
    try {
      const orm = ctx.getOrm?.() ?? new DatabaseORM(ctx.ensureTables());
      const row = orm.events.findById(detailMatch[1]);
      if (!row || row.sessionId !== sessionId) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json(projectAuditEvent(row as unknown as { id: string; type: string; agent: string; payload: string; createdAt: string }));
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch audit event" }, { status: 500 });
    }
  }

  // Audit logs endpoint
  // #1644: the event query executes through the get_audit_events command.
  // The route keeps its contract as presentation: the 1..100 limit clamp,
  // the session_id filter (defense-in-depth — the ORM is per-DO-instance,
  // and recordAudit writes this instance's session key on every row),
  // the payload-JSON parse with { raw } fallback, and the 5-field
  // projection. #1968: the query params are passed INTO the command so
  // filtering happens before the limit is applied — the pre-fix route
  // fetched the newest 50 events overall and ignored every param, so a
  // type or time filter could never surface an older matching event.
  // `type` accepts the `event_type` alias; `before`/`after` accept the
  // `to`/`from` aliases. A non-numeric limit still clamps to NaN and
  // slices to zero rows (pinned by audit_routes_extraction.test.ts).
  if (path.endsWith("/audit") && request.method === "GET") {
    try {
      const limitParam = Number(url.searchParams.get("limit") || 50);
      const limit = Math.max(1, Math.min(100, limitParam));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) || 0);
      const type = url.searchParams.get("type") ?? url.searchParams.get("event_type") ?? undefined;
      const agent = url.searchParams.get("agent") ?? undefined;
      const before = url.searchParams.get("before") ?? url.searchParams.get("to") ?? undefined;
      const after = url.searchParams.get("after") ?? url.searchParams.get("from") ?? undefined;
      const orm = ctx.getOrm?.() ?? new DatabaseORM(ctx.ensureTables());
      const out = (await runRestTool("get_audit_events", {
        limit: before || after ? 1000 : limit,
        ...(type ? { type } : {}),
        ...(agent ? { agent } : {}),
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      }, {
        orm,
        sessionId,
        audit: (type, agent, payload) => ctx.audit(type, agent, payload),
      })) as { events: Array<{ id: string; sessionId: string; type: string; agent: string; payload: string; createdAt: string }> };

      const parsed = out.events
        .filter((e) => e.sessionId === sessionId)
        .slice(offset, offset + limit)
        .map(projectAuditEvent);

      return Response.json({ count: parsed.length, events: parsed });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch audit log" }, { status: 500 });
    }
  }

  if (path.endsWith("/audit") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      // #1733 R04: audit-write mode (run body `mode` / query `?mode=`
      // > session > user > env > legacy). legacy = this route's
      // untouched unvalidated contract below; strict = the
      // /audit/event validation applied to this spelling, keeping
      // its own defaults (type=autopilot.policy_check,
      // agent=trading) and its 200 shape. Invalid mode fails
      // closed to legacy + audit.config_error (in the resolver).
      const writeMode = resolveAuditWriteRestSwitch(
        auditSwitchHost(ctx),
        body?.mode ?? url.searchParams.get("mode"),
        "legacy"
      );
      if (writeMode === "strict") {
        const validated = validateStrictAuditWrite(
          { ...body, type: body?.type ?? "autopilot.policy_check" },
          "trading"
        );
        if (!validated.ok) {
          return Response.json({ error: validated.error }, { status: 400 });
        }
        ctx.audit(
          validated.value.type,
          validated.value.agent as AgentName | "judge" | "nlq" | "orchestrator",
          validated.value.payload
        );
        return Response.json({ success: true, message: "Audit event recorded" });
      }
      const type = String(body.type || "autopilot.policy_check");
      const agent = (body.agent || "trading") as AgentName | "judge" | "nlq" | "orchestrator";
      const payload = (body.payload && typeof body.payload === "object") ? body.payload : body;
      ctx.audit(type, agent, payload);
      return Response.json({ success: true, message: "Audit event recorded" });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to record audit event" }, { status: 500 });
    }
  }

  // Audit event append — advertised by the WorkflowsHub Observability card
  // as "POST /api/audit/event" (issue #270). Same mas_events idiom as
  // POST /audit, but with strict validation and the stored record echoed
  // back, so callers need no second GET. Tenant-scoped like every other
  // audit row: session_id is the per-user Durable Object instance key.
  if (path.endsWith("/audit/event") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => null)) as {
        type?: unknown;
        agent?: unknown;
        payload?: unknown;
        mode?: unknown;
      } | null;
      // #1733 R04: the switch is resolved here only so an invalid
      // value audits audit.config_error; this spelling is strict in
      // EVERY mode — the switch never loosens it. Validation is the
      // shared port helper (byte-identical messages and bounds to
      // the inline code it replaces).
      resolveAuditWriteRestSwitch(
        auditSwitchHost(ctx),
        body?.mode ?? url.searchParams.get("mode"),
        "legacy"
      );
      const validated = validateStrictAuditWrite(body, "orchestrator");
      if (!validated.ok) {
        return Response.json({ error: validated.error }, { status: 400 });
      }
      const record = ctx.recordAudit(validated.value.type, validated.value.agent, validated.value.payload);
      return Response.json(record, { status: 201 });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to record audit event" }, { status: 500 });
    }
  }

  return null;
}
