/**
 * Issue #359-01: reports + HITL routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move — no behavior change.
 *
 * The module handles the report generation/dispatch routes, the #277 HITL
 * confirmation routes (pending list + confirm), and the report-settings routes.
 * It is invoked from routeRequest at the EXACT position the original blocks
 * occupied in the sequential path.endsWith matching sequence. It returns a
 * Response when one of its paths matches, or null when none does — matching
 * order relative to all other handlers is preserved by the call site.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them via
 * the explicit ReportsRouteContext parameter; there are no new globals and no
 * back-references into the class.
 */

import type { AgentName } from "../../types";
import type { SqlStorage } from "../../orm";
import {
  canonicalResearchEmailBody,
  canonicalResearchWebhookBody,
} from "../../services/scheduledReports";

/** The subset of OrchestratorAgent surface the reports/HITL handlers need. */
export interface ReportsRouteContext {
  ensureTables(): SqlStorage;
  getReportDispatchHitl(): boolean;
  setReportDispatchHitl(enabled: boolean): void;
  getReportConfirmation(id: string): any | null;
  decideReportConfirmation(
    id: string,
    status: "approved" | "rejected" | "expired",
    decidedBy: string | null
  ): void;
  createReportConfirmation(
    kind: "email" | "webhook",
    payloadJson: string,
    reportId?: string | null
  ): string;
  confirmationDeliveryMeta(row: any): { recipient?: string };
  deliverStoredReportEmail(
    reportId: string,
    recipient: string,
    userLogin: string
  ): Promise<"sent" | "missing" | "failed">;
  deliverStoredReportWebhook(
    reportId: string,
    userLogin: string
  ): Promise<{
    outcome: "sent" | "missing" | "failed";
    result?: { success: boolean; status?: number; error?: string; notConfigured?: boolean };
  }>;
  sendReportEmail(
    recipient: string,
    title: string,
    fileName: string,
    attachmentBase64: string,
    userLogin: string
  ): Promise<boolean>;
  sendReportWebhook(
    title: string,
    query: string,
    sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>,
    userLogin: string
  ): Promise<{ success: boolean; status?: number; error?: string; notConfigured?: boolean }>;
  storeResearchReportCanonicalAsync(
    bodyJson: string,
    meta: { title: string; summary: string; userLogin?: string }
  ): Promise<{ reportId: string; generationId: string } | null>;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** OrchestratorAgent.REPORT_CONFIRMATION_TTL_MS */
  reportConfirmationTtlMs(): number;
}

/**
 * Handles the reports + HITL routes. Returns a Response on match, null when no
 * reports path matches (the orchestrator then continues its sequential matching).
 */
export async function handleReportsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: ReportsRouteContext
): Promise<Response | null> {
  // Issue #277: list pending report-dispatch confirmations for the
  // Settings UI. Summaries only — payloads stay server-side until decided.
  if (path.endsWith("/trading/reports/pending") && request.method === "GET") {
    try {
      const sql = ctx.ensureTables();
      const rows = Array.from(
        sql.exec(
          "SELECT id, kind, payload_json, created_at FROM mas_report_confirmations WHERE status = 'pending' ORDER BY created_at DESC"
        )
      ) as any[];
      return Response.json({
        pending: rows.map((row) => {
          let payload: any = {};
          try {
            payload = JSON.parse(String(row.payload_json));
          } catch {
            payload = {};
          }
          // Issue #308: new rows carry delivery metadata in payload_json
          // (sheetCount); legacy rows carry the full payload (sheets).
          const sheetCount =
            (payload.sheets || []).length || payload.sheetCount || 0;
          return {
            confirmationId: String(row.id),
            kind: String(row.kind),
            createdAt: String(row.created_at),
            detail:
              row.kind === "email"
                ? `${payload.recipient || "?"} · ${payload.fileName || "?"}`
                : `${payload.title || "Research report"} · ${sheetCount} sheets`,
          };
        }),
      });
    } catch (err) {
      return Response.json({ error: "Failed to list pending confirmations." }, { status: 500 });
    }
  }

  // Issue #277: server-side setting for optional HITL confirmation on
  // report dispatch. Default OFF (autonomous, today's behavior).
  if (path.endsWith("/trading/settings/report-dispatch-hitl") && request.method === "GET") {
    return Response.json({ enabled: ctx.getReportDispatchHitl() });
  }

  if (path.endsWith("/trading/settings/report-dispatch-hitl") && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
    if (!body || typeof body.enabled !== "boolean") {
      return Response.json({ error: "enabled (boolean) is required." }, { status: 400 });
    }
    ctx.setReportDispatchHitl(body.enabled);
    ctx.audit("report_dispatch_hitl.changed", "orchestrator", { enabled: body.enabled });
    return Response.json({ enabled: body.enabled });
  }

  // Issue #277: confirm (or reject) a pending report dispatch. Mirrors
  // POST /payments/confirm: the stored payload is executed only on
  // "approved"; nothing is sent on "rejected" or for unknown/expired ids.
  if (path.endsWith("/trading/reports/confirm") && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      confirmationId?: string;
      decision?: "approved" | "rejected";
      note?: string;
    };
    const confirmationId = (body.confirmationId || "").trim();
    const decision = body.decision || "approved";
    const note = (body.note || "").trim();
    if (!confirmationId) {
      return Response.json({ error: "confirmationId is required" }, { status: 400 });
    }
    const row = ctx.getReportConfirmation(confirmationId);
    if (!row) {
      return Response.json({ error: "Report confirmation not found." }, { status: 404 });
    }
    if (row.status !== "pending") {
      return Response.json(
        { error: `Report confirmation already ${row.status}.`, confirmationId },
        { status: 409 }
      );
    }
    const ageMs = Date.now() - new Date(String(row.created_at)).getTime();
    if (!Number.isFinite(ageMs) || ageMs > ctx.reportConfirmationTtlMs()) {
      ctx.decideReportConfirmation(confirmationId, "expired", null);
      ctx.audit("research_report.confirmation_expired", "trading", { confirmationId });
      return Response.json({ error: "Report confirmation expired.", confirmationId }, { status: 410 });
    }
    const userLogin = request.headers.get("x-user-login") || sessionId;
    if (decision === "approved") {
      // Issue #308: deliver the STORED canonical copy. New rows
      // reference mas_reports via report_id; legacy rows (pre-#308)
      // carry the full payload in payload_json (fallback below).
      if (row.report_id) {
        const reportId = String(row.report_id);
        const meta = ctx.confirmationDeliveryMeta(row);
        if (row.kind === "email") {
          const recipient = meta.recipient || "";
          if (!recipient) {
            return Response.json({ error: "The confirmation has no delivery recipient." }, { status: 500 });
          }
          const outcome = await ctx.deliverStoredReportEmail(reportId, recipient, userLogin);
          if (outcome === "missing") {
            return Response.json({ error: "The stored report is no longer available." }, { status: 500 });
          }
          if (outcome !== "sent") {
            return Response.json({ error: "Email delivery is unavailable; check the configured email binding." }, { status: 503 });
          }
          ctx.decideReportConfirmation(confirmationId, "approved", userLogin);
          ctx.audit("research_report.emailed", "trading", {
            confirmationId,
            recipient,
            reportId,
            via: "hitl_confirmation",
          });
          return Response.json({ success: true, status: "dispatched", confirmationId });
        }
        const delivered = await ctx.deliverStoredReportWebhook(reportId, userLogin);
        if (delivered.outcome === "missing") {
          return Response.json({ error: "The stored report is no longer available." }, { status: 500 });
        }
        const result = delivered.result!;
        if (!result.success) {
          const status = result.notConfigured ? 503 : 502;
          return Response.json({ error: result.error || `Webhook returned HTTP ${result.status}.` }, { status });
        }
        ctx.decideReportConfirmation(confirmationId, "approved", userLogin);
        ctx.audit("research_report.webhook_dispatched", "trading", {
          confirmationId,
          status: result.status,
          reportId,
          via: "hitl_confirmation",
        });
        return Response.json({ success: true, status: "dispatched", confirmationId });
      }
      const payload = JSON.parse(String(row.payload_json)) as any;
      if (row.kind === "email") {
        const sent = await ctx.sendReportEmail(
          String(payload.recipient),
          String(payload.title),
          String(payload.fileName),
          String(payload.attachmentBase64),
          userLogin
        );
        if (!sent) {
          return Response.json({ error: "Email delivery is unavailable; check the configured email binding." }, { status: 503 });
        }
        ctx.decideReportConfirmation(confirmationId, "approved", userLogin);
        ctx.audit("research_report.emailed", "trading", {
          confirmationId,
          recipient: payload.recipient,
          fileName: payload.fileName,
          via: "hitl_confirmation",
        });
        return Response.json({ success: true, status: "dispatched", confirmationId });
      }
      const result = await ctx.sendReportWebhook(
        String(payload.title),
        String(payload.query || ""),
        payload.sheets,
        userLogin
      );
      if (!result.success) {
        const status = result.notConfigured ? 503 : 502;
        return Response.json({ error: result.error || `Webhook returned HTTP ${result.status}.` }, { status });
      }
      ctx.decideReportConfirmation(confirmationId, "approved", userLogin);
      ctx.audit("research_report.webhook_dispatched", "trading", {
        confirmationId,
        status: result.status,
        sheets: (payload.sheets || []).length,
        via: "hitl_confirmation",
      });
      return Response.json({ success: true, status: "dispatched", confirmationId });
    }
    ctx.decideReportConfirmation(confirmationId, "rejected", userLogin);
    ctx.audit("research_report.confirmation_rejected", "trading", { confirmationId, note });
    return Response.json({ success: true, status: "rejected", confirmationId });
  }

  if (path.endsWith("/trading/reports/email") && request.method === "POST") {
    const body = await request.json().catch(() => null) as {
      to?: string;
      fileName?: string;
      attachmentBase64?: string;
      title?: string;
    } | null;
    const recipient = typeof body?.to === "string" ? body.to.trim() : "";
    const fileName = typeof body?.fileName === "string" ? body.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") : "";
    const attachmentBase64 = typeof body?.attachmentBase64 === "string" ? body.attachmentBase64 : "";
    if (!body || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient)) {
      return Response.json({ error: "A valid email recipient is required." }, { status: 400 });
    }
    if (!fileName.toLowerCase().endsWith(".xlsx") || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachmentBase64) || attachmentBase64.length > 7_000_000) {
      return Response.json({ error: "A valid .xlsx workbook under 5 MB is required." }, { status: 400 });
    }
    let workbookBytes: Uint8Array;
    try {
      const binary = atob(attachmentBase64);
      workbookBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      return Response.json({ error: "The workbook attachment is not valid base64." }, { status: 400 });
    }
    if (workbookBytes.length > 5 * 1024 * 1024 || workbookBytes[0] !== 0x50 || workbookBytes[1] !== 0x4b) {
      return Response.json({ error: "The attachment must be a valid .xlsx workbook under 5 MB." }, { status: 400 });
    }
    const userLogin = request.headers.get("x-user-login") || sessionId;
    const title = (typeof body.title === "string" ? body.title : "Research report").replace(/[\r\n]/g, " ").slice(0, 120);
    // Issue #308: store the canonical copy FIRST — every channel
    // delivers the stored report, never the request in memory.
    const reportBodyJson = canonicalResearchEmailBody({ title, fileName, attachmentBase64 });
    const stored = await ctx.storeResearchReportCanonicalAsync(reportBodyJson, {
      title,
      summary: `Research report workbook: ${fileName} (${title})`,
      userLogin,
    });
    if (!stored) {
      return Response.json({ error: "The report could not be stored; dispatch aborted." }, { status: 500 });
    }
    if (ctx.getReportDispatchHitl()) {
      // Issue #277: hold for human confirmation instead of sending.
      // Issue #308: the pending row references the stored report id;
      // payload_json carries delivery metadata only (no report bytes).
      const confirmationId = ctx.createReportConfirmation(
        "email",
        JSON.stringify({ recipient, title, fileName }),
        stored.reportId
      );
      ctx.audit("research_report.pending_confirmation", "trading", { confirmationId, recipient, fileName, reportId: stored.reportId });
      return Response.json({ success: true, status: "pending_confirmation", confirmationId });
    }
    const outcome = await ctx.deliverStoredReportEmail(stored.reportId, recipient, userLogin);
    if (outcome === "missing") {
      return Response.json({ error: "The stored report is unavailable; dispatch aborted." }, { status: 500 });
    }
    if (outcome !== "sent") return Response.json({ error: "Email delivery is unavailable; check the configured email binding." }, { status: 503 });
    ctx.audit("research_report.emailed", "trading", { recipient, fileName, reportId: stored.reportId });
    return Response.json({ success: true });
  }

  if (path.endsWith("/trading/reports/webhook") && request.method === "POST") {
    const body = await request.json().catch(() => null) as {
      title?: string;
      query?: string;
      sheets?: Array<{ name: string; rows: Array<Record<string, unknown>> }>;
    } | null;
    if (!body || !Array.isArray(body.sheets) || body.sheets.length === 0 ||
      body.sheets.some((sheet) => !sheet || typeof sheet.name !== "string" || !Array.isArray(sheet.rows))) {
      return Response.json({ error: "A research report with named data sheets is required." }, { status: 400 });
    }
    // Issue #308: store the canonical copy FIRST — every channel
    // delivers the stored report, never the request in memory.
    const wtitle = (typeof body.title === "string" ? body.title : "Research report").replace(/[\r\n]/g, " ").slice(0, 120);
    const wuserLogin = request.headers.get("x-user-login") || sessionId;
    const reportBodyJson = canonicalResearchWebhookBody({
      title: wtitle,
      query: typeof body.query === "string" ? body.query : "",
      sheets: body.sheets,
    });
    const stored = await ctx.storeResearchReportCanonicalAsync(reportBodyJson, {
      title: wtitle,
      summary: `Research report: ${wtitle} (${body.sheets.length} sheets)`,
      userLogin: wuserLogin,
    });
    if (!stored) {
      return Response.json({ error: "The report could not be stored; dispatch aborted." }, { status: 500 });
    }
    if (ctx.getReportDispatchHitl()) {
      // Issue #277: hold for human confirmation instead of dispatching.
      // Issue #308: the pending row references the stored report id;
      // payload_json carries delivery metadata only (no report bytes).
      const confirmationId = ctx.createReportConfirmation(
        "webhook",
        JSON.stringify({ title: wtitle, query: typeof body.query === "string" ? body.query : "", sheetCount: body.sheets.length }),
        stored.reportId
      );
      ctx.audit("research_report.pending_confirmation", "trading", {
        confirmationId,
        sheets: body.sheets.length,
        reportId: stored.reportId,
      });
      return Response.json({ success: true, status: "pending_confirmation", confirmationId });
    }
    const userLogin = request.headers.get("x-user-login") || sessionId;
    const delivered = await ctx.deliverStoredReportWebhook(stored.reportId, userLogin);
    if (delivered.outcome === "missing") {
      return Response.json({ error: "The stored report is unavailable; dispatch aborted." }, { status: 500 });
    }
    const result = delivered.result!;
    if (!result.success) {
      const status = result.notConfigured ? 503 : 502;
      return Response.json({ error: result.error || `Webhook returned HTTP ${result.status}.` }, { status });
    }
    ctx.audit("research_report.webhook_dispatched", "trading", { status: result.status, sheets: body.sheets.length, reportId: stored.reportId });
    return Response.json({ success: true, status: result.status });
  }

  // List persisted reports (issue #309). Queries mas_reports (populated by #278, #308).
  // Supports ?q=search query and ?source=screener|options_scanner|iv_collection
  if ((path.endsWith("/reports") || path === "/reports" || path === "/api/reports") && request.method === "GET") {
    try {
      const { searchScheduledReports, listScheduledReports, ensureScheduledReportsTable } = await import("../../services/scheduledReports");
      const query = url.searchParams.get("q") || "";
      const sourceFilter = url.searchParams.get("source") || undefined;
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100));
      // #584 EP-003: tenant scoping from the caller's login. No header →
      // undefined → legacy unfiltered behavior (identity strings are not
      // yet unified; see scheduledReports.ts).
      const headerLogin = request.headers.get("x-user-login");
      const userLogin = headerLogin && headerLogin.trim() ? headerLogin : undefined;

      ensureScheduledReportsTable(ctx.ensureTables());

      let reports: any[];
      if (query.trim()) {
        // Search with query (user-scoped)
        reports = searchScheduledReports(ctx.ensureTables(), query, limit, { userLogin });
      } else {
        // List all (user-scoped), newest first
        // Note: mas_reports has no report_url column (see #307 R2 discussion).
        // The PDF URL is constructed from the runId via /api/screener/report.pdf
        reports = listScheduledReports(ctx.ensureTables(), { userLogin, sourceFilter, limit });
      }

      // Apply source filter to search results (search doesn't support it natively)
      if (sourceFilter && query.trim()) {
        reports = reports.filter((r: any) => r.source === sourceFilter);
      }

      return Response.json({
        count: reports.length,
        reports: reports.map((r: any) => ({
          id: r.id,
          runId: r.runId,
          title: r.title,
          source: r.source,
          summary: r.summary,
          createdAt: r.createdAt,
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list reports", reports: [] }, { status: 500 });
    }
  }

  return null;
}
