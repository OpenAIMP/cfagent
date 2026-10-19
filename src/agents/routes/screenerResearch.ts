/**
 * Issue #359-15: screener + autonomous research routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the contiguous screener and research block (invoked at the EXACT
 * original position in routeRequest's sequential matching sequence, after
 * the FOSS compare/screen delegation and before the task schedules block):
 *   GET         /screener/latest                    (issue #212/#261)
 *   GET         /screener/report.pdf                (issue #269)
 *   GET         /options/report.pdf                 (issue #361)
 *   POST        /research/run                       (issue #319, manual)
 *   POST        /research/scheduled-tick            (issue #319/#354, daily)
 *   GET         /research/latest
 *   GET         /research/history
 *   GET         /research/settings
 *   POST        /research/settings
 *   POST        /research/evaluate
 *
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * ScreenerResearchRouteContext parameter; there are no new globals and no
 * back-references into the class. The #308 canonical-report seam is
 * untouched: these blocks never called the store seam directly - the
 * runResearchAndPublish pipeline stays orchestrator-owned and arrives via
 * the context; the scheduled-tick guard keeps its write-after-success
 * mas_settings semantics via ctx.writeSetting.
 */

import {
  triggerManualResearch,
  triggerScheduledResearch,
} from "../../services/researchTriggers";
import {
  shouldFireResearchTick,
  RESEARCH_SCHEDULED_LAST_RUN_KEY,
} from "../../services/researchScheduleGuard";
import type { ScreenerAgent } from "../screener-agent";
import type { ResearchAgent } from "../research-agent";

/** Structural mirror of OrchestratorAgent's private ScreenerExecutionContext
 * (src/agents/orchestrator.ts) - the module reads only `userLogin` from it. */
type ScreenerExecutionContext = { userLogin: string; environment?: "TEST" | "PROD" };

/** The subset of OrchestratorAgent surface the screener/research handlers need. */
export interface ScreenerResearchRouteContext {
  /** ScreenerAgent accessor (owner: OrchestratorAgent.getScreenerAgent - was `this.getScreenerAgent`). */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
  /** Execution-context accessor (owner: OrchestratorAgent.getScreenerExecutionContext - was `this.getScreenerExecutionContext`). */
  getScreenerExecutionContext(): Promise<ScreenerExecutionContext | undefined>;
  /** ResearchAgent accessor (owner: OrchestratorAgent.getResearchAgent - was `this.getResearchAgent`). */
  getResearchAgent(userLogin?: string): ResearchAgent | null;
  /** Single-owner research run pipeline (owner: OrchestratorAgent.runResearchAndPublish - was `(t, u) => this.runResearchAndPublish(t, u)`); the #308 canonical store lives inside it. */
  runResearchAndPublish(
    trigger: "manual" | "scheduled",
    userLogin?: string
  ): Promise<{
    success: boolean;
    error?: string;
    reportId?: string | null;
    created?: boolean;
    emailed?: boolean;
    report?: unknown;
  }>;
  /** mas_settings raw read (owner: OrchestratorAgent.readSettingRaw - was `this.readSettingRaw`). */
  readSettingRaw(key: string): string | null;
  /** mas_settings write (owner: OrchestratorAgent.writeSetting - was `this.writeSetting`). */
  writeSetting(key: string, value: string): void;
}

/**
 * Screener + autonomous research routes. Invoked from routeRequest at the
 * exact position the original blocks occupied (after the
 * handleFossCompareScreenRoutes delegation, before the task schedules
 * block); returns a Response when one of the owned paths matches, or null
 * to continue sequential matching.
 */
export async function handleScreenerResearchRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: ScreenerResearchRouteContext
): Promise<Response | null> {
    // Issue #212/#261: latest screener runs (GET /api/screener/latest).
    // Served by ScreenerAgent — one agent owns all screening results.
    // Note: server.ts strips the /api prefix before forwarding, so the DO
    // sees /screener/latest.
    if (path.endsWith("/screener/latest") && request.method === "GET") {
      try {
        const context = await ctx.getScreenerExecutionContext();
        const agent = ctx.getScreenerAgent(request.headers.get("x-user-login") || context?.userLogin || "default_trader");
        const latest = await agent.getLatest();
        const history = await agent.getHistory();
        return Response.json({
          count: history.length,
          runs: history,
          latest,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load screener runs", runs: [] }, { status: 500 });
      }
    }

    // Issue #269: downloadable PDF report of the latest screener run.
    if (path.endsWith("/screener/report.pdf") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key");
        const pdf = key
          ? await ctx.getScreenerAgent(request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin || "default_trader").getPdfByKey(key)
          : await ctx.getScreenerAgent(request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin || "default_trader").getLatestPdf();
        if (!pdf) {
          return Response.json({ error: "No screener report available yet" }, { status: 404 });
        }
        return new Response(pdf.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${pdf.fileName}"`,
            "Content-Length": String(pdf.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load report" }, { status: 500 });
      }
    }

    // Issue #361: Options PDF download endpoint (mirrors stock).
    if (path.endsWith("/options/report.pdf") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key") || url.searchParams.get("filename");
        const pdf = key
          ? await ctx.getScreenerAgent(request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin || "default_trader").getOptionsPdfByKey(key)
          : await ctx.getScreenerAgent(request.headers.get("x-user-login") || (await ctx.getScreenerExecutionContext())?.userLogin || "default_trader").getLatestOptionsPdf();
        if (!pdf) {
          return Response.json({ error: "No options report available yet" }, { status: 404 });
        }
        return new Response(pdf.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${pdf.fileName}"`,
            "Content-Length": String(pdf.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to load report" }, { status: 500 });
      }
    }

    // ==========================================
    // Issue #319: autonomous options research.
    // The manual route and the scheduled tick are thin triggers over the
    // single runResearchAndPublish entry (amendment 2) — only the trigger
    // source differs. Note: server.ts strips the /api prefix before
    // forwarding, so the DO sees /research/*.
    // ==========================================

    // Manual run (dashboard "Run now").
    if (path.endsWith("/research/run") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      try {
        const out = await triggerManualResearch(
          ctx.runResearchAndPublish,
          userLogin
        );
        return Response.json(out);
      } catch (err: any) {
        return Response.json(
          { success: false, error: err?.message || "Research run failed." },
          { status: 500 }
        );
      }
    }

    // Scheduled tick (server.ts folds the daily run into the */30 tick,
    // issue #354 — a dedicated 0 21 * * 1-5 cron cannot exist at the
    // Workers Free 5-trigger ceiling). Fires exactly once per weekday at
    // or after 21:00 UTC; the manual route above is never guarded.
    if (path.endsWith("/research/scheduled-tick") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || "default";
      try {
        // Issue #354 — idempotency guard against double-fire across the
        // 21:00/21:30 ticks. The last-fired date lives in mas_settings
        // (durable across ticks AND isolates); it is written only after a
        // successful run so a failed 21:00 run retries at 21:30.
        const decision = shouldFireResearchTick(
          new Date(),
          ctx.readSettingRaw(RESEARCH_SCHEDULED_LAST_RUN_KEY)
        );
        if (!decision.fire) {
          return Response.json({
            success: true,
            skipped: true,
            reason: decision.reason,
            dateKey: decision.dateKey,
          });
        }
        const out = await triggerScheduledResearch(
          ctx.runResearchAndPublish,
          userLogin
        );
        ctx.writeSetting(RESEARCH_SCHEDULED_LAST_RUN_KEY, decision.dateKey);
        return Response.json(out);
      } catch (err: any) {
        return Response.json(
          { success: false, error: err?.message || "Scheduled research run failed." },
          { status: 500 }
        );
      }
    }

    // Latest + history (trigger-labeled; one view serves both run types).
    if (path.endsWith("/research/latest") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) return Response.json({ latest: null });
      const latest = await agent.getLatest();
      return Response.json({ latest });
    }
    if (path.endsWith("/research/history") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) return Response.json({ history: [] });
      const history = await agent.getHistory();
      return Response.json({ history });
    }

    // Typed filter/config API (amendment 1; mirrors the #277 settings pattern).
    if (path.endsWith("/research/settings") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const config = await agent.getResearchConfig();
      return Response.json({ config });
    }
    if (path.endsWith("/research/settings") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const patch = (await request.json().catch(() => null)) as Partial<import("../../services/researchConfig").ResearchConfig> | null;
      const out = await agent.saveConfig(patch ?? {});
      return Response.json(out);
    }

    // §9 evaluation pass over a published run.
    if (path.endsWith("/research/evaluate") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const body = (await request.json().catch(() => null)) as { runId?: string } | null;
      if (!body?.runId) {
        return Response.json({ error: "runId is required." }, { status: 400 });
      }
      const evaluation = await agent.evaluateRun(body.runId, userLogin);
      return Response.json({ evaluation });
    }
  return null;
}

