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
  // Audit logs endpoint
  // #1644: the event query executes through the get_audit_events command.
  // The route keeps its contract as presentation: the 1..100 limit clamp,
  // the session_id filter (defense-in-depth — the ORM is per-DO-instance,
  // and recordAudit writes this instance's session key on every row),
  // the payload-JSON parse with { raw } fallback, and the 5-field
  // projection. The command is fetched without a limit so the filter-then-
  // slice order matches the old WHERE-then-LIMIT order exactly.
  if (path.endsWith("/audit") && request.method === "GET") {
    try {
      const limitParam = Number(url.searchParams.get("limit") || 50);
      const limit = Math.max(1, Math.min(100, limitParam));
      const orm = ctx.getOrm?.() ?? new DatabaseORM(ctx.ensureTables());
      const out = (await runRestTool("get_audit_events", {}, {
        orm,
        sessionId,
        audit: (type, agent, payload) => ctx.audit(type, agent, payload),
      })) as { events: Array<{ id: string; sessionId: string; type: string; agent: string; payload: string; createdAt: string }> };

      const parsed = out.events
        .filter((e) => e.sessionId === sessionId)
        .slice(0, limit)
        .map((e) => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(e.payload);
          } catch {
            payload = { raw: e.payload };
          }
          return { id: e.id, type: e.type, agent: e.agent, payload, created_at: e.createdAt };
        });

      return Response.json({ count: parsed.length, events: parsed });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch audit log" }, { status: 500 });
    }
  }

  if (path.endsWith("/audit") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
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
      } | null;
      if (!body || typeof body !== "object") {
        return Response.json({ error: "A JSON object body is required" }, { status: 400 });
      }
      const type = typeof body.type === "string" ? body.type.trim() : "";
      if (!type) {
        return Response.json({ error: "type (non-empty string) is required" }, { status: 400 });
      }
      if (type.length > 120) {
        return Response.json({ error: "type must be at most 120 characters" }, { status: 400 });
      }
      const agent =
        typeof body.agent === "string" && body.agent.trim()
          ? body.agent.trim().slice(0, 64)
          : "orchestrator";
      const payload =
        body.payload && typeof body.payload === "object"
          ? (body.payload as Record<string, unknown>)
          : {};
      const serialized = JSON.stringify(payload);
      if (serialized.length > 65536) {
        return Response.json({ error: "payload must serialize to at most 64 KB" }, { status: 400 });
      }
      const record = ctx.recordAudit(type, agent, JSON.parse(serialized));
      return Response.json(record, { status: 201 });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to record audit event" }, { status: 500 });
    }
  }

  return null;
}
