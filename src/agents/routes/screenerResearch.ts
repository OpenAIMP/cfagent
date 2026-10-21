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
import type { DatabaseORM } from "../../orm";

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
  /** ORM accessor (owner: OrchestratorAgent.getOrm - was `this.getOrm()`); the #754 adaptation services take it as their SqlStorage (post-#887 the ORM satisfies that interface). */
  getOrm(): DatabaseORM;
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

    // Issue #335: research-run PDF download (mirrors screener/options PDFs).
    if (path.endsWith("/research/report.pdf") && request.method === "GET") {
      try {
        const url = new URL(request.url);
        const key = url.searchParams.get("key") || "latest";
        const userLogin =
          request.headers.get("x-user-login") ||
          (await ctx.getScreenerExecutionContext())?.userLogin ||
          "default_trader";
        const agent = ctx.getResearchAgent(userLogin);
        if (!agent) {
          return Response.json(
            { error: "ResearchAgent binding not configured." },
            { status: 503 }
          );
        }
        const pdf = await agent.getResearchPdfByKey(key);
        if (!pdf) {
          return Response.json(
            { error: "No research report PDF available yet" },
            { status: 404 }
          );
        }
        return new Response(pdf.bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${pdf.fileName}"`,
            "Content-Length": String(pdf.bytes.length),
          },
        });
      } catch (err: any) {
        return Response.json(
          { error: err.message || "Failed to load research report" },
          { status: 500 }
        );
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
        // #583 docx §9: after the scheduled run, evaluate runs due for
        // follow-up (older than 24h, no evaluation row). Best-effort: never
        // fails the tick.
        try {
          const agent = ctx.getResearchAgent(userLogin);
          if (agent) {
            const evalRes = await agent.evaluateDueRuns(userLogin);
            (out as Record<string, unknown>).evaluationsDue =
              evalRes.evaluated.length + evalRes.failed.length;
            (out as Record<string, unknown>).evaluationsDone =
              evalRes.evaluated;
          }
        } catch {
          // Evaluation is advisory; the research run already succeeded.
        }
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
    // Issue #340: track record — published ideas joined to evaluations.
    if (path.endsWith("/research/track-record") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const trackRecord = await agent.getTrackRecord();
      return Response.json({ trackRecord });
    }

    // Issue #754: strategy weights — read path. Current weights plus the
    // policy evaluation (weighted vs unweighted win rate + proposals).
    // Measurement surface; reading weights here changes no ranking —
    // production consumption stays behind #17's reviewed-config rule.
    if (path.endsWith("/adaptation/weights") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const { getStrategyWeights, buildWeightPolicyEvaluation } = await import("../../services/strategyWeights");
      const weights = getStrategyWeights(ctx.getOrm());
      const trackRecord = await agent.getTrackRecord();
      return Response.json({ weights, evaluation: buildWeightPolicyEvaluation(trackRecord, weights) });
    }

    // Issue #754: run the calibration-driven weight adjustment job.
    // Fire/no-fire for the scheduled ride is decided inside the job
    // (ISO-week guard + the #756 kill switch); a manual call may pass
    // { force: true }. Every application is budget-checked and audited
    // via #755's seam.
    if (path.endsWith("/adaptation/weights/run") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const body = (await request.json().catch(() => null)) as { force?: boolean } | null;
      const { runStrategyWeightAdjustment } = await import("../../services/strategyWeights");
      const trackRecord = await agent.getTrackRecord();
      const result = runStrategyWeightAdjustment(ctx.getOrm(), trackRecord, { force: body?.force === true });
      return Response.json({ success: true, ...result, timestamp: new Date().toISOString() });
    }

    // Issue #757: improvement candidates — the Phase 5 queue. Listing is
    // read-only; generation converts track-record anomalies, reflection
    // findings (recovered from reflection learnings), and human
    // learnings into structured candidates. Generation applies
    // nothing — candidates reach production only via #758 → #759 → #760.
    if (path.endsWith("/adaptation/candidates") && request.method === "GET") {
      const { listImprovementCandidates } = await import("../../services/improvementCandidates");
      const statusParam = url.searchParams.get("status") || undefined;
      const candidates = listImprovementCandidates(ctx.getOrm(), statusParam as any);
      return Response.json({ candidates });
    }
    if (path.endsWith("/adaptation/candidates/generate") && request.method === "POST") {
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const { generateImprovementCandidates, findingsFromReflectionLearnings } = await import("../../services/improvementCandidates");
      const { getActiveLearnings } = await import("../../services/learnings");
      const orm = ctx.getOrm();
      const learnings = getActiveLearnings(orm);
      const trackRecord = await agent.getTrackRecord();
      const result = generateImprovementCandidates(orm, {
        track: trackRecord,
        learnings,
        findings: findingsFromReflectionLearnings(learnings),
      });
      return Response.json({
        success: true,
        created: result.created.length,
        deduped: result.deduped.length,
        superseded: result.superseded.length,
        candidates: result.created,
        timestamp: new Date().toISOString(),
      });
    }

    // Issue #758: isolated candidate evaluation. Replay runs against
    // the recorded track record only — the harness cannot write live
    // state (pinned in tests/candidate_evaluation.test.ts).
    if (path.endsWith("/adaptation/candidates/evaluate") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : "";
      if (!candidateId) {
        return Response.json({ error: "candidateId is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const { getImprovementCandidate } = await import("../../services/improvementCandidates");
      const { evaluateCandidate } = await import("../../services/candidateEvaluation");
      const { getStrategyWeights } = await import("../../services/strategyWeights");
      const orm = ctx.getOrm();
      const candidate = getImprovementCandidate(orm, candidateId);
      if (!candidate) {
        return Response.json({ error: `candidate ${candidateId} not found.` }, { status: 404 });
      }
      const trackRecord = await agent.getTrackRecord();
      const weights = getStrategyWeights(orm);
      const window =
        body?.window && typeof body.window === "object"
          ? {
              from: typeof body.window.from === "string" ? body.window.from : undefined,
              to: typeof body.window.to === "string" ? body.window.to : undefined,
            }
          : undefined;
      const report = evaluateCandidate(orm, candidate, trackRecord, { weights, window });
      return Response.json({ success: true, evaluation: report, timestamp: new Date().toISOString() });
    }
    if (path.endsWith("/adaptation/candidates/evaluations") && request.method === "GET") {
      const candidateId = url.searchParams.get("candidateId") || "";
      if (!candidateId) {
        return Response.json({ error: "candidateId query parameter is required." }, { status: 400 });
      }
      const { listEvaluations } = await import("../../services/candidateEvaluation");
      return Response.json({ evaluations: listEvaluations(ctx.getOrm(), candidateId) });
    }

    // Issue #759: promotion gate — held-out significance + human
    // approval (the #653 decision pattern, in a dedicated approvals
    // store). The gate endpoint returns the persisted verdict either
    // way; failing candidates stay in "evaluating".
    if (path.endsWith("/adaptation/candidates/approve") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : "";
      if (!candidateId) {
        return Response.json({ error: "candidateId is required." }, { status: 400 });
      }
      const { getImprovementCandidate } = await import("../../services/improvementCandidates");
      const { requestPromotionApproval } = await import("../../services/promotionGate");
      const orm = ctx.getOrm();
      if (!getImprovementCandidate(orm, candidateId)) {
        return Response.json({ error: `candidate ${candidateId} not found.` }, { status: 404 });
      }
      const approval = requestPromotionApproval(orm, candidateId, request.headers.get("x-user-login") || sessionId);
      return Response.json({ success: true, approval });
    }
    if (path.endsWith("/adaptation/candidates/approve/decide") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const { approvalId, decision } = body ?? {};
      if (!approvalId || (decision !== "approved" && decision !== "rejected")) {
        return Response.json({ error: "approvalId and decision (approved|rejected) required" }, { status: 400 });
      }
      const { decidePromotionApproval } = await import("../../services/promotionGate");
      const ok = decidePromotionApproval(
        ctx.getOrm(),
        approvalId,
        decision,
        request.headers.get("x-user-login") || sessionId
      );
      return Response.json({ success: ok });
    }
    if (path.endsWith("/adaptation/candidates/gate") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : "";
      if (!candidateId) {
        return Response.json({ error: "candidateId is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const { getImprovementCandidate } = await import("../../services/improvementCandidates");
      const { runPromotionGate } = await import("../../services/promotionGate");
      const orm = ctx.getOrm();
      const candidate = getImprovementCandidate(orm, candidateId);
      if (!candidate) {
        return Response.json({ error: `candidate ${candidateId} not found.` }, { status: 404 });
      }
      const trackRecord = await agent.getTrackRecord();
      const verdict = runPromotionGate(orm, candidate, trackRecord);
      return Response.json({ success: true, verdict, timestamp: new Date().toISOString() });
    }

    // Issue #760: staged promotion. Start parks a gated candidate in
    // shadow (nothing applied); each advance runs the regression
    // check, respects the stage time-box, and applies through the
    // #755 seam. Regression rolls back automatically.
    if (path.endsWith("/adaptation/promotions/start") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : "";
      if (!candidateId) {
        return Response.json({ error: "candidateId is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const { getImprovementCandidate } = await import("../../services/improvementCandidates");
      const { startPromotion } = await import("../../services/stagedPromotion");
      const orm = ctx.getOrm();
      const candidate = getImprovementCandidate(orm, candidateId);
      if (!candidate) {
        return Response.json({ error: `candidate ${candidateId} not found.` }, { status: 404 });
      }
      const trackRecord = await agent.getTrackRecord();
      const result = startPromotion(orm, candidate, trackRecord);
      return Response.json({ success: result.ok, ...result, timestamp: new Date().toISOString() });
    }
    if (path.endsWith("/adaptation/promotions/advance") && request.method === "POST") {
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        /* empty body */
      }
      const promotionId = typeof body?.promotionId === "string" ? body.promotionId : "";
      if (!promotionId) {
        return Response.json({ error: "promotionId is required." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const agent = ctx.getResearchAgent(userLogin);
      if (!agent) {
        return Response.json({ error: "ResearchAgent binding not configured." }, { status: 503 });
      }
      const { advancePromotion } = await import("../../services/stagedPromotion");
      const trackRecord = await agent.getTrackRecord();
      const result = advancePromotion(ctx.getOrm(), promotionId, trackRecord);
      return Response.json({ success: result.ok, ...result, timestamp: new Date().toISOString() });
    }
    if (path.endsWith("/adaptation/promotions") && request.method === "GET") {
      const candidateId = url.searchParams.get("candidateId") || "";
      if (!candidateId) {
        return Response.json({ error: "candidateId query parameter is required." }, { status: 400 });
      }
      const { listPromotions } = await import("../../services/stagedPromotion");
      return Response.json({ promotions: listPromotions(ctx.getOrm(), candidateId) });
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

