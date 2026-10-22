import { Think, type ChatResponseResult, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { AgentContext, Schedule } from "agents";
import type { ToolSet } from "ai";
import { getWorkersAIModel } from "./model";
import { buildOrchestratorSystemPrompt, resolveShadowMaxSteps } from "./chatPrompt";
import { LLMJudge } from "./judge";
import { VectorMemory } from "../memory/vector-memory";
import { planNLQ, executeNLQQuery, executeNLQQueryAsync, executeNaturalLanguageQuery, type NLQSchedulingPort, type NLQStockScreenPort } from "./nlq";
import { resolveErrorAspect, AgentErrorCode } from "../aspects/errorCodes";
import { logAspectEvent } from "../aspects/loggingAspect";
import { DatabaseORM } from "../orm";
import { ensureSharedTable } from "../orm/schema";
import { PaymentGatewayService, normalizeGateway, isWebhookGateway, isSupportedGateway, SUPPORTED_GATEWAYS, type SupportedGateway } from "../services/payments";
import { getValidTokens } from "../security/etradeOAuth";
import { ETradeRestClient } from "../trading";
import { computePortfolioRisk, aggregatePortfolioRisk, resolvePositionsSnapshot, evaluatePostTradeTotals, type CandidateGreekContribution } from "../services/portfolioRisk";
import { ETradeThinkHarness } from "../services/thinkHarness";
import { SqlPausedScheduleStore } from "../services/scheduleManagement";
import {
  evaluatePolicy,
  describeVerdict,
  attestVerdict,
  normalizeAutopilotLimits,
  buildAccountStateFromBalance,
  type AutopilotAccountState,
  type OrderIntent,
  type PolicyVerdict,
  type PolicyVerdictAttestation,
} from "../services/riskPolicyEngine";
import { assessPortfolioConcentration } from "../services/portfolioConcentration";
import { sizeCandidateAgainstPortfolio, type SizingCandidate } from "../services/positionSizing";
import { generateHedgeProposals } from "../services/hedgeProposals";
import { sharedCorrelationService } from "../services/correlationService";
import type { ScreenerAgent, ScreenerRunRequest } from "./screener-agent";
import { recordOptionsRun } from "./optionsRuns";
import type { ResearchAgent } from "./research-agent";
import { evaluateResearchOutcome, type ResearchExecutionPath } from "../services/researchTaskLedger";
import { getEtapiConfig, setRuntimeEtapiConfigOverrides } from "../config/etapiConfig";
import { isDemoCalibratedChainsEnabled } from "../config/demoMode";
import { SqlScanRunStore, diffScanRuns } from "../trading";
import { SqlDiscoveryRunStore } from "../trading";
import { SqlIvHistoryStore } from "../trading";
import { SqlStrategyProfileStore } from "../trading";
import { AGENT_DIDS, createDidAttestation, getUserDid, resolveAgentDidDocument } from "./did";
import { createMAS } from "./mas";
import { createAgentMcpTools } from "./mcpAdapter";
import { buildChatErrorFallback, type ChatErrorFallbackContext } from "./chatErrorFallback";
import { ETradeEmailTradingService } from "../trading";
import { ETradeBrowserService } from "../services/browserAgent";
import { ETradeWebhookService } from "../services/tradingWebhooks";
import { deliverScreenerToSlackA2A } from "../services/screenerSlackDelivery";
import { McpSystemFacade } from "../patterns/facade";
import { executeMCPTool } from "../mcp";
import { ScheduledTasksService, type AutonomousOptionsAnalysisOptions, type AutonomousStrategyDiscoveryOptions } from "../services/scheduledTasks";
// Issue #278: durable scheduled-run reports for the AI Search agent.
// Issue #308: the single generate→store seam + canonical report bodies.
import {
  canonicalResearchEmailBody,
  canonicalResearchWebhookBody,
  getCanonicalReport,
  parseResearchReportBody,
  sha256Hex,
  storeReportAtGeneration,
} from "../services/scheduledReports";
// Issue #359-01: reports + HITL routes live in src/agents/routes/reports.ts;
// routeRequest delegates to handleReportsRoutes at the original position.
import { handleReportsRoutes } from "./routes/reports";
import { handleMcpChatNlqRoutes } from "./routes/mcpChatNlq";
import { handleSchemaRoutes } from "./routes/schema";
import { handleAdsRevenueReferralsRoutes, handleReferralsAdsRoutes } from "./routes/adsRevenueReferrals";
import { handleAuditRoutes } from "./routes/audit";
import { handleAutopilotRoutes } from "./routes/autopilot";
import { handleMemoryResetRoutes } from "./routes/memoryReset";
import { handlePaymentsRoutes } from "./routes/payments";
import { handleAgenticPaymentsRoutes } from "./routes/agenticPayments";
// Issue #359-08: premium routes live in src/agents/routes/premium.ts;
// routeRequest delegates to handlePremiumRoutes at the original position.
import { handlePremiumRoutes } from "./routes/premium";
import { handleTradingIntegrationsRoutes } from "./routes/tradingIntegrations";
import {
  handleEtradeBrokerRoutes,
  handleEtradeBrokerActivityRoutes,
} from "./routes/etradeBroker";
import { handleEtradeOptionsRoutes } from "./routes/etradeOptions";
import { handleWatchlistsRoutes } from "./routes/watchlists";
import { handleAlpacaFossRoutes, handleAlpacaTradingRoutes } from "./routes/alpaca";
import { handleFossQuoteResearchRoutes, handleFossCompareScreenRoutes } from "./routes/fossResearch";
import { handleScreenerResearchRoutes } from "./routes/screenerResearch";
import { handleSchedulesRoutes } from "./routes/schedules";
import { TRADING_PAID_SERVICES } from "../services/agenticPayments";
import type {
  Env,
  AgentName,
  AuditEvent,
  MessageRecord,
  TransactionRecord,
  CategoryRecord,
  ExternalAdRecord,
  RevenueSummary,
  ETradeOptionChain,
  ETradeOptionExpireDate,
  AsyncJobPayload,
  AsyncJobRecord,
  AsyncJobSubmission,
  AsyncJobStatus,
  TransactionSnapData,
  AgentScheduleItem,
  RouteDecision,
} from "../types";

/**
 * Issue #686: message normalization for the model call now lives
 * in Think's session assembly (the agents-SDK session store); the
 * AIChatAgent-era normalizeMessagesForSDK helper was removed with
 * the cutover.
 */

/**
 * Callbacks a caller may arm through POST /api/schedules/create (#111).
 *
 * This route is the public way to create schedules, so it accepts only
 * user-creatable jobs. Internal-only callbacks — `executeAsyncJob` (the
 * async-job plumbing) and `expireStaleOrderDraft` (order-draft expiry) —
 * are armed by the agent itself and are deliberately NOT in this list;
 * the route rejects them with HTTP 400. Only stock screening, options
 * screening, and saved-request strategy discovery (issue #126)
 * callbacks can be created through this route. NLQ scheduling (#109)
 * uses its separate agent scheduling port.
 */
export const CREATABLE_SCHEDULE_CALLBACKS = [
  "autonomousOptionsAnalysis",
  "autonomousMarketScreen",
  "autonomousStrategyDiscovery",
] as const;

const ACCOUNT_SCOPED_SCHEDULE_CALLBACKS = new Set<string>([
  "autonomousOptionsAnalysis",
  "autonomousMarketScreen",
  "autonomousStrategyDiscovery",
]);

export type CreatableScheduleCallback = (typeof CREATABLE_SCHEDULE_CALLBACKS)[number];

type ETradeEnvironment = "TEST" | "PROD";
type ScreenerExecutionContext = { userLogin: string; environment?: ETradeEnvironment };
const SCREENER_EXECUTION_CONTEXT_KEY = "screener:execution-context";
const LEGACY_SCHEDULE_MIGRATION_KEY = "screener:legacy-baseline-migration:v3";
/** Issue #618: interval between automatic stale-task sweeps (6 hours). */
const STALE_SWEEP_INTERVAL_SECONDS = 6 * 60 * 60;
/**
 * Issue #275: the hourly full-catalog Strategy/Symbol Scanner run.
 * Minute :35 staggers it off the equity screens (commonly armed at
 * :05) and the :15/:22 system jobs, so the E*TRADE budget is not hit
 * by every job in the same minute.
 */
export const STRATEGY_SCAN_CRON = "35 * * * *";
/** Issue #624: research task heartbeat interval while a run is in flight (2 minutes). */
const RESEARCH_TASK_HEARTBEAT_MS = 120_000;

function screenerAgentName(userLogin: string): string {
  // Preserve the original shared agent for the legacy system identity.
  return userLogin === "default_trader" ? "default" : `screener:${userLogin}`;
}

export class OrchestratorAgent extends Think<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Issue #686 (R8): the sanitized step clamp is the production
    // bound — a non-numeric MAS_MAX_STEPS falls back to the default
    // instead of propagating NaN into the turn's stop condition.
    this.maxSteps = resolveShadowMaxSteps(env);
  }

  private scheduledScreenerSlots = new Set<string>();
  private scheduledOptionsSlots = new Set<string>();
  private scheduledDiscoverySlots = new Set<string>();
  /**
   * ScreenerAgent stub (issue #261) — one agent owns all screening.
   * E*TRADE-only market data; honest failure when unavailable.
   */
  private getScreenerAgent(userLogin = "default_trader"): ScreenerAgent {
    const id = this.env.SCREENER_AGENT.idFromName(screenerAgentName(userLogin));
    return this.env.SCREENER_AGENT.get(id) as unknown as ScreenerAgent;
  }

  private async getScreenerExecutionContext(): Promise<ScreenerExecutionContext | undefined> {
    // Some lightweight route harnesses omit Durable Object storage. The
    // authenticated context is best-effort in those environments; real DO
    // instances always provide storage.
    const storage = this.ctx?.storage;
    if (!storage || typeof storage.get !== "function") return undefined;
    return storage.get<ScreenerExecutionContext>(SCREENER_EXECUTION_CONTEXT_KEY);
  }

  /** Retire old internal maintenance jobs while preserving account screening schedules. */
  private async migrateLegacyScreenSchedules(context: ScreenerExecutionContext): Promise<void> {
    const storage = this.ctx?.storage;
    if (!storage || typeof storage.get !== "function" || typeof storage.put !== "function") return;
    const environment = context.environment || "PROD";
    const migrationKey = `${LEGACY_SCHEDULE_MIGRATION_KEY}:${context.userLogin}:${environment}`;
    if (await storage.get(migrationKey)) return;
    const existing = await this.listSchedules();
    let cleanupComplete = true;
    for (const schedule of existing) {
      const item = schedule as any;
      const payload = item.payload || {};
      const callback = item.callback;
      const isLegacyTokenRenewal = callback === "autoRenewETradeTokens" && payload.userLogin === context.userLogin;
      const isLegacyIvCollection =
        callback === "collectIvHistory" && payload.userLogin === context.userLogin && item.cron === "15 22 * * 1-5";
      if (isLegacyTokenRenewal || isLegacyIvCollection) {
        console.warn(`[OrchestratorAgent] Removing app-created legacy schedule ${item.id} (${callback})`);
        try {
          await this.cancelSchedule(item.id);
        } catch (error) {
          cleanupComplete = false;
          console.warn(`[OrchestratorAgent] Could not remove legacy schedule ${item.id}:`, error);
        }
      }
    }
    if (cleanupComplete) {
      await storage.put(migrationKey, { userLogin: context.userLogin, environment, migratedAt: new Date().toISOString() });
    }
  }

  private async removeUnownedBaselineSchedules(): Promise<void> {
    const schedules = await this.listSchedules().catch(() => [] as Schedule<unknown>[]);
    for (const schedule of schedules) {
      const item = schedule as any;
      const payload = item.payload || {};
      const callback = item.callback;
      const orphanedBaseline =
        (["autonomousMarketScreen", "autonomousOptionsAnalysis", "autonomousStrategyDiscovery", "autoRenewETradeTokens", "collectIvHistory"].includes(callback) && !payload.userLogin);
      if (orphanedBaseline) {
        console.warn(`[OrchestratorAgent] Removing unowned baseline schedule ${item.id} (${callback})`);
        await this.cancelSchedule(item.id).catch(() => undefined);
      }
    }
  }

  /**
   * ResearchAgent stub (issue #319) — one agent owns options research.
   * Per-tenant instance id: research:<userLogin>.
   */
  private getResearchAgent(userLogin?: string): ResearchAgent | null {
    const ns = this.env.RESEARCH_AGENT;
    if (!ns) return null;
    const login = userLogin || "default";
    const id = ns.idFromName(`research:${login}`);
    return ns.get(id) as unknown as ResearchAgent;
  }

  /**
   * Issue #319: THE single publish entry for autonomous options research.
   * The manual route and the scheduled tick are thin triggers over this
   * method (amendment 2). The ResearchAgent runs the pipeline; the
   * canonical copy is stored here via the #308 seam on the orchestrator's
   * mas_reports — the table the Reports tab (#318) and AI Search read.
   */
  async runResearchAndPublish(
    trigger: "manual" | "scheduled",
    userLogin?: string
  ): Promise<{
    success: boolean;
    error?: string;
    reportId?: string | null;
    created?: boolean;
    emailed?: boolean;
    report?: unknown;
    taskId?: string | null;
    executionPath?: ResearchExecutionPath;
  }> {
    const login = userLogin || "default";
    const agent = this.getResearchAgent(login);
    if (!agent) {
      return { success: false, error: "ResearchAgent binding not configured." };
    }
    // Dispatch discovery through the Think agent-tool workflow. The child
    // invokes its deterministic, read-only pipeline tool and persists the
    // typed report before returning its summary.
    const { ResearchAgent } = await import("./research-agent");
    const previousRunId = (await agent.getLatest())?.runId;
    // Issue #577: durable task record for this delegated run (mandate §6;
    // design in docs/agents/agentic-architecture.md §5/§7). The ledger
    // dedups the *record* for duplicate dispatches after the same
    // predecessor report; execution suppression is deliberately not
    // implied. Ledger failures never break research — warn, continue.
    let taskId: string | null = null;
    try {
      const created = await agent.createResearchTask({
        trigger,
        userLogin: login,
        idempotencyKey: `research:${trigger}:${login}:${previousRunId ?? "none"}`,
      });
      taskId = created.task.id;
      if (created.task.status === "queued") {
        await agent.beginResearchTask(taskId);
      }
    } catch (err) {
      console.warn(
        `[OrchestratorAgent] Research task ledger unavailable (create/begin): ${err instanceof Error ? err.message : String(err)}`
      );
      taskId = null;
    }
    // Issue #624: heartbeat the task while dispatch is in flight —
    // both the Think turn and the fallback run below are awaited here,
    // so one timer bounds the heartbeat gap for either path. Cleared
    // in the finally on every exit; the ledger rejects heartbeats
    // from terminal states, so a stray tick would be harmless anyway.
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    if (taskId) {
      const id = taskId;
      heartbeatTimer = setInterval(() => {
        void agent.heartbeatResearchTask(id).catch(() => undefined);
      }, RESEARCH_TASK_HEARTBEAT_MS);
    }
    try {
      let executionPath: ResearchExecutionPath = "think";
      const child = await this.runAgentTool(ResearchAgent, {
        input: { trigger, userLogin: login },
      });
      let report = await agent.getLatest();
      if (child.status !== "completed" || !report || report.runId === previousRunId || report.trigger !== trigger || report.userLogin !== login) {
        // Keep scheduled discovery dependable if a provider cannot complete
        // the Think turn. The same read-only deterministic pipeline remains
        // the recovery path and persists through the same ResearchAgent.
        // Issue #543: the fallback must not silently mask which execution
        // path ran — emit a structured warning carrying the identifiers an
        // operator needs to correlate the bypass in Workers Logs.
        console.warn(
          `[OrchestratorAgent] Think research turn bypassed — falling back to direct pipeline: trigger=${trigger} userLogin=${login} childStatus=${child.status} childError=${child.error ?? "none"} previousRunId=${previousRunId ?? "none"} latestRunId=${report?.runId ?? "none"}`
        );
        const fallback = await agent.runResearch({ trigger, userLogin: login });
        if (!fallback.success || !fallback.report) {
          const failure = fallback.error || child.error || `Research agent finished with status ${child.status}.`;
          // Issue #577: a total failure escalates the task for a human
          // instead of vanishing into this error return.
          if (taskId) {
            try {
              await agent.failResearchTask(taskId, failure, true);
            } catch {
              // Ledger is best-effort; the error return stands either way.
            }
          }
          return { success: false, error: failure, taskId };
        }
        executionPath = "fallback";
        report = fallback.report;
      }
      const sql = this.ensureTables();
      const stored = storeReportAtGeneration(sql, {
        runId: report.runId,
        generationId: report.generationId,
        title: `Options research — ${report.createdAt.slice(0, 10)} (${report.trigger})`,
        source: "options_research",
        summary: report.summary,
        body: report as unknown as Record<string, unknown>,
      });
      // #337: index the canonical report for semantic search (best-effort).
      if (stored?.reportId) {
        try {
          const { indexReport } = await import("../services/reportSemanticIndex");
          const ideaText = report.ideas
            .slice(0, 5)
            .map((i) => `${i.symbol} ${i.outlook} ${i.structure}: ${i.thesis}`)
            .join("\n");
          void indexReport(this.env, {
            reportId: stored.reportId,
            title: `Options research — ${report.createdAt.slice(0, 10)} (${report.trigger})`,
            source: "options_research",
            text: `${report.summary}\n${ideaText}`,
          });
        } catch {
          // Indexing never fails the run.
        }
      }
      // #335: render the run PDF from the canonical stored report (best-effort;
      // the PDF is a delivery artifact, never a second copy).
      // #680: PDF generation is owned by ReportAssetAgent (single owner for
      // the Generate step). Best-effort; never fails the run.
      let pdfKey: string | null = null;
      try {
        const { generatePdfAsset } = await import("./report-asset-agent");
        const asset = await generatePdfAsset(this.env, login, "research", report);
        pdfKey = asset?.key ?? null;
      } catch (err) {
        console.warn("[OrchestratorAgent] Research PDF generation failed:", err);
      }
      // #336: full delivery through the #308 seams (Slack, email, webhook),
      // delivering the canonical stored copy. Best-effort; never fails the run.
      let emailed = false;
      try {
        const delivery = await this.deliverResearchReport(
          agent,
          report,
          {
            reportId: stored?.reportId ?? null,
            pdfKey,
            trigger,
            userLogin: login,
          }
        );
        emailed = delivery.emailed;
      } catch (err) {
        console.warn("[OrchestratorAgent] Research delivery failed:", err);
      }
      // Issue #577: complete the task with the path actually taken and a
      // deterministic evaluation of the outcome (never a model grading
      // itself). Best-effort — the published result stands either way.
      if (taskId) {
        try {
          const evaluation = evaluateResearchOutcome(
            {
              reportRunId: report.runId,
              previousRunId: previousRunId ?? null,
              expectedTrigger: trigger,
              expectedUserLogin: login,
              reportTrigger: report.trigger,
              reportUserLogin: report.userLogin,
              summary: report.summary,
              ideas: report.ideas.length,
              watchlist: report.watchlist.length,
              rejected: report.rejected.length,
            },
            new Date().toISOString()
          );
          await agent.completeResearchTask(taskId, {
            path: executionPath,
            reportRunId: report.runId,
            evaluation,
          });
        } catch (err) {
          console.warn(
            `[OrchestratorAgent] Research task ledger unavailable (complete): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      // #584 EP-009: meter the research run — attribute compute to tenant + task.
      // Best-effort and never throws; metering must not break the run.
      try {
        const { recordUsageEvent } = await import("../services/scheduledReports");
        recordUsageEvent(this.ctx.storage.sql, {
          userLogin: login,
          runId: report.runId,
          category: "research_run",
          detail: { trigger, ideas: report.ideas.length, taskId },
        });
      } catch {
        // Metering is advisory; the published result stands either way.
      }
      return {
        success: true,
        reportId: stored?.reportId ?? null,
        created: stored?.created ?? false,
        emailed,
        report,
        taskId,
        executionPath,
      };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }

  /**
   * #336: dispatch a research run's report through the #308 delivery seams
   * (Slack, email, webhook), delivering the canonical stored copy — never a
   * regenerated one. Respects the #277 HITL setting; attaches the run PDF
   * where the channel supports files; flags pre-entry-refresh outcomes.
   * Best-effort: delivery never fails the run.
   */
  private async deliverResearchReport(
    agent: { getResearchPdfByKey(k: string): Promise<{ bytes: Uint8Array; fileName: string } | null>; refreshIdeaQuotes(r: unknown, u?: string): Promise<Array<{ symbol: string; status: string; detail: string }>>; getResearchConfig(): Promise<{ autoEmail?: boolean; emailTo?: string }> },
    report: {
      runId: string;
      trigger: string;
      createdAt: string;
      summary: string;
      ideas: Array<{ rank: number; symbol: string; outlook: string; structure: string; score: number; thesis: string }>;
      watchlist: Array<{ symbol: string }>;
      rejected: Array<unknown>;
      userLogin?: string;
    },
    opts: { reportId: string | null; pdfKey: string | null; trigger: string; userLogin: string }
  ): Promise<{ emailed: boolean; slack: boolean; webhook: boolean; held: boolean }> {
    const result = { emailed: false, slack: false, webhook: false, held: false };

    // Pre-entry refresh: flag ideas that moved or went stale.
    const refreshFlags = await agent.refreshIdeaQuotes(report as never, opts.userLogin);
    const flagLines = refreshFlags.map(
      (f) => `⚠ ${f.symbol}: ${f.detail}`
    );

    // Delivery text from the canonical report.
    const ideaLines = report.ideas.slice(0, 5).map(
      (i) => `• #${i.rank} ${i.symbol} (${i.outlook}, ${i.structure}, score ${i.score.toFixed(1)})`
    );
    const text = [
      `🔬 Options research — ${report.trigger} run ${report.runId}`,
      report.summary,
      "",
      `Qualified ideas (${report.ideas.length}):`,
      ...ideaLines,
      ...(report.watchlist.length > 0 ? ["", `Watchlist: ${report.watchlist.map((w) => w.symbol).join(", ")}`] : []),
      ...(flagLines.length > 0 ? ["", "Pre-entry refresh:", ...flagLines] : []),
      "",
      "Research only; no trades were placed.",
    ].join("\n");

    // #277 HITL: hold for approval instead of delivering.
    if (this.getReportDispatchHitl()) {
      try {
        this.createReportConfirmation(
          "email",
          JSON.stringify({
            kind: "research",
            runId: report.runId,
            reportId: opts.reportId,
            pdfKey: opts.pdfKey,
            trigger: opts.trigger,
            userLogin: opts.userLogin,
          }),
          opts.reportId
        );
        result.held = true;
      } catch (err) {
        console.warn("[OrchestratorAgent] HITL hold failed:", err);
      }
      return result;
    }

    const pdf = opts.pdfKey
      ? await agent.getResearchPdfByKey(opts.pdfKey).catch(() => null)
      : null;
    const reportUrl = `${this.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/research/report.pdf${opts.pdfKey ? `?key=${encodeURIComponent(opts.pdfKey)}` : ""}`;

    // 1. Slack via cfpay A2A (with PDF attach where supported).
    try {
      const { getCfpayConfig } = await import("../services/cfpayA2A");
      const { deliverScreenerToSlackA2A } = await import("../services/screenerSlackDelivery");
      const cfpay = getCfpayConfig(this.env);
      const slackChannel =
        (this.env as any).SCREENER_SLACK_CHANNEL || (this.env as any).SLACK_CHANNEL;
      if (cfpay) {
        const delivery = await deliverScreenerToSlackA2A(this.env, {
          text,
          channel: slackChannel,
          ...(pdf
            ? {
                pdf: {
                  ...pdf,
                  title: `Options research — ${report.trigger} ${report.createdAt.slice(0, 10)}`,
                  comment: text,
                },
              }
            : {}),
        });
        result.slack = delivery.ok;
        if (!delivery.ok) console.warn("[OrchestratorAgent] Research Slack delivery failed:", delivery.error);
      }
    } catch (err) {
      console.warn("[OrchestratorAgent] Research Slack delivery failed:", err);
    }

    // 2. Email (opt-in via research config), with PDF attachment.
    try {
      const cfg = await agent.getResearchConfig();
      if (cfg.autoEmail && cfg.emailTo) {
        const { validateEmailRecipient } = await import("../security/webhookReplay");
        const check = validateEmailRecipient(cfg.emailTo, this.env.EMAIL_TO_ALLOWED_DOMAINS);
        if (check.ok) {
          const { getCfpayConfig, cfpaySendEmail, cfpaySendEmailWithAttachments } = await import("../services/cfpayA2A");
          const cfpay = getCfpayConfig(this.env);
          const subject = `🔬 Options research — ${report.ideas.length} qualified idea(s)${flagLines.length > 0 ? " (⚠ refresh flags)" : ""}`;
          let sent = false;
          if (cfpay) {
            let r;
            if (pdf) {
              let binary = "";
              for (let i = 0; i < pdf.bytes.length; i += 8192)
                binary += String.fromCharCode(...pdf.bytes.subarray(i, i + 8192));
              r = await cfpaySendEmailWithAttachments(cfpay, {
                to: cfg.emailTo,
                subject,
                body: `${text}\n\nPDF report: ${reportUrl}`,
                attachments: [{ filename: pdf.fileName, contentB64: btoa(binary), contentType: "application/pdf" }],
              });
            } else {
              r = await cfpaySendEmail(cfpay, cfg.emailTo, subject, `${text}\n\nPDF report: ${reportUrl}`);
            }
            sent = r.ok;
          }
          if (!sent) {
            const emailService = new ETradeEmailTradingService(this.env, this.getOrm(), opts.userLogin);
            sent = await emailService.sendOutboundEmail(
              cfg.emailTo,
              subject,
              `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br/>")}</p>`,
              `${text}\n\nPDF report: ${reportUrl}`,
              pdf
                ? (() => {
                    let binary = "";
                    for (let i = 0; i < pdf.bytes.length; i += 8192)
                      binary += String.fromCharCode(...pdf.bytes.subarray(i, i + 8192));
                    return { fileName: pdf.fileName, contentType: "application/pdf", contentBase64: btoa(binary) };
                  })()
                : undefined
            );
          }
          result.emailed = sent;
        }
      }
    } catch (err) {
      console.warn("[OrchestratorAgent] Research email delivery failed:", err);
    }

    // 3. Webhook.
    try {
      const webhookUrl = (this.env as any).OUTBOUND_WEBHOOK_URL;
      if (webhookUrl) {
        const { ETradeWebhookService } = await import("../services/tradingWebhooks");
        const webhook = new ETradeWebhookService(this.getOrm(), this.env, opts.userLogin);
        await webhook.dispatchOutboundWebhook("research.completed", {
          runId: report.runId,
          trigger: report.trigger,
          qualified: report.ideas.length,
          watchlist: report.watchlist.length,
          rejected: report.rejected.length,
          refreshFlags,
          reportUrl,
          reportId: opts.reportId,
        });
        result.webhook = true;
      }
    } catch (err) {
      console.warn("[OrchestratorAgent] Research webhook delivery failed:", err);
    }

    return result;
  }

  /** Issue #319: opt-in email delivery of the stored research summary. */
  private async sendResearchSummaryEmail(
    recipient: string,
    summary: string,
    ideaCount: number,
    reportId: string | null,
    userLogin: string
  ): Promise<boolean> {
    const { validateEmailRecipient } = await import("../security/webhookReplay");
    const check = validateEmailRecipient(recipient, this.env.EMAIL_TO_ALLOWED_DOMAINS);
    if (!check.ok) return false;
    try {
      const emailService = new ETradeEmailTradingService(this.env, this.getOrm(), userLogin);
      return await emailService.sendOutboundEmail(
        recipient,
        `Options research report — ${ideaCount} qualified idea(s)`,
        `<p>${summary.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p><p>Full report${reportId ? ` (id ${reportId})` : ""} is available in the dashboard Reports tab. Research only; no trades were placed.</p>`,
        `${summary}\n\nFull report${reportId ? ` (id ${reportId})` : ""} is available in the dashboard Reports tab.\nResearch only; no trades were placed.`
      );
    } catch {
      return false;
    }
  }

  /** Cloudflare Agents lifecycle: initialize SQLite and recover durable work. */
  async onStart(props?: Record<string, unknown>): Promise<void> {
    this.ensureTables();

    try {
      await this.recoverQueuedAsyncJobs();
    } catch (error) {
      console.error("[OrchestratorAgent][onStart] Could not reschedule queued async jobs:", error);
    }

    try {
      // A newly initialized Agent has only an opaque DO id, not its account
      // owner. Never use that id as an E*TRADE login. Authenticated requests
      // perform the one-time migration away from app-created baseline jobs.
      const context = await this.getScreenerExecutionContext();
      if (context?.userLogin) {
        await this.migrateLegacyScreenSchedules(context);
        // Issue #275: the hourly full-catalog strategy scan rides the
        // same authenticated maintenance path (armed once per user).
        await this.ensureStrategyScanSchedule(context);
      } else await this.removeUnownedBaselineSchedules();
    } catch (schedErr) {
      console.warn("[OrchestratorAgent][onStart] Legacy maintenance schedule reconciliation failed:", schedErr);
    }

    try {
      // Issue #618: on the same maintenance path, close any task
      // records already stale for this user and arm the recurring
      // sweep. Best-effort: a sweep problem never blocks startup.
      const context = await this.getScreenerExecutionContext();
      if (context?.userLogin) {
        await this.sweepStaleLedgerTasks({ userLogin: context.userLogin });
        await this.ensureStaleSweepSchedule(context.userLogin);
      }
    } catch (sweepErr) {
      console.warn("[OrchestratorAgent][onStart] Stale-task sweep setup failed:", sweepErr);
    }

    try {
      // Issue #686: residual legacy-session lift (see
      // liftLegacyChatMessages). Best-effort: never blocks startup.
      await this.liftLegacyChatMessages();
    } catch (liftErr) {
      console.warn("[OrchestratorAgent][onStart] Legacy session lift failed:", liftErr);
    }
  }

  /**
   * Issue #686 (R6): one-time transform-migration for any residual
   * pre-SDK `cf_ai_chat_agent_messages` rows. The AIChatAgent base
   * lifted this table into the agents-SDK session store at every
   * wake and dropped it on a clean lift, so production instances
   * are already migrated; Think does not perform the lift, so this
   * covers an instance whose earlier lift was left incomplete.
   * Semantics mirror the incumbent migration: existence check,
   * idempotent import by message id (addMessages upserts by id),
   * drop the table only on a fully clean lift — otherwise leave it
   * in place and log, so the rows remain recoverable.
   */
  private async liftLegacyChatMessages(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const exists =
      Array.from(
        sql.exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_ai_chat_agent_messages'"
        )
      ).length > 0;
    if (!exists) return;
    const rows = Array.from(
      sql.exec(
        "SELECT id, message, created_at FROM cf_ai_chat_agent_messages ORDER BY created_at ASC, rowid ASC"
      )
    ) as Array<{ id: string; message: string; created_at: unknown }>;
    const valid: any[] = [];
    let skipped = 0;
    for (const row of rows) {
      try {
        const message = JSON.parse(row.message);
        if (
          !message ||
          typeof message.id !== "string" ||
          typeof message.role !== "string" ||
          !Array.isArray(message.parts)
        ) {
          skipped++;
          continue;
        }
        valid.push(message);
      } catch {
        skipped++;
      }
    }
    if (valid.length > 0) await this.addMessages(valid as any);
    if (skipped === 0) {
      sql.exec("DROP TABLE cf_ai_chat_agent_messages");
      return;
    }
    console.error(
      `[OrchestratorAgent] Legacy lift imported ${valid.length} of ${rows.length} rows (${skipped} skipped); leaving cf_ai_chat_agent_messages in place so they remain recoverable.`
    );
  }

  /**
   * Issue #618 (R4 follow-up): Cloudflare Agents Scheduled Callback
   * that closes stale research and screener task records (#615) for
   * this instance's user. Each ledger is swept in isolation so one
   * failure cannot block the other; swept tasks end escalated, never
   * auto-rerun.
   */
  async sweepStaleLedgerTasks(payload?: { userLogin?: string }): Promise<{ userLogin: string | null; researchSwept: number; screenerSwept: number; researchPruned: number; screenerPruned: number }> {
    const context = await this.getScreenerExecutionContext();
    const userLogin = context?.userLogin || payload?.userLogin;
    if (!userLogin) {
      console.warn("[OrchestratorAgent] Skipping stale-task sweep without an authenticated account owner.");
      return { userLogin: null, researchSwept: 0, screenerSwept: 0, researchPruned: 0, screenerPruned: 0 };
    }
    let researchSwept = 0;
    try {
      const research = this.getResearchAgent(userLogin);
      if (research) researchSwept = (await research.sweepStaleResearchTasks()).length;
    } catch (error) {
      console.warn(`[OrchestratorAgent] Stale research sweep failed for ${userLogin}:`, error);
    }
    let screenerSwept = 0;
    try {
      screenerSwept = (await this.getScreenerAgent(userLogin).sweepStaleScreenerTasks()).length;
    } catch (error) {
      console.warn(`[OrchestratorAgent] Stale screener sweep failed for ${userLogin}:`, error);
    }
    // Issue #635: retention pruning rides the same maintenance path,
    // in its own isolated legs — a prune failure never affects sweeps.
    let researchPruned = 0;
    try {
      const research = this.getResearchAgent(userLogin);
      if (research) researchPruned = (await research.pruneExpiredResearchTasks()).length;
    } catch (error) {
      console.warn(`[OrchestratorAgent] Research retention prune failed for ${userLogin}:`, error);
    }
    let screenerPruned = 0;
    try {
      screenerPruned = (await this.getScreenerAgent(userLogin).pruneExpiredScreenerTasks()).length;
    } catch (error) {
      console.warn(`[OrchestratorAgent] Screener retention prune failed for ${userLogin}:`, error);
    }
    if (researchSwept > 0 || screenerSwept > 0 || researchPruned > 0 || screenerPruned > 0) {
      console.info(`[OrchestratorAgent] Task maintenance for ${userLogin}: research swept=${researchSwept} pruned=${researchPruned}; screener swept=${screenerSwept} pruned=${screenerPruned}.`);
    }
    return { userLogin, researchSwept, screenerSwept, researchPruned, screenerPruned };
  }

  /** Issue #618: arm the recurring stale-sweep interval once per user. */
  private async ensureStaleSweepSchedule(userLogin: string): Promise<void> {
    const existing = await this.listSchedules().catch(() => [] as Schedule<unknown>[]);
    const already = existing.some((s) => {
      const item = s as any;
      return item.callback === "sweepStaleLedgerTasks" && item.payload?.userLogin === userLogin;
    });
    if (already) return;
    await this.scheduleEvery(STALE_SWEEP_INTERVAL_SECONDS, "sweepStaleLedgerTasks", { userLogin });
  }

  /**
   * Issue #275: arm the hourly Strategy/Symbol Scanner run once per
   * authenticated user — the full strategy catalog (no
   * allowedStrategies restriction) over the NASDAQ100 universe,
   * published through the same audit + Slack path as the equity
   * screens. Follows the ensureStaleSweepSchedule pattern, with one
   * addition: a scan the user paused in the Schedules tab (#273's
   * paused store) is never silently re-armed.
   */
  async ensureStrategyScanSchedule(context: ScreenerExecutionContext): Promise<void> {
    const userLogin = context.userLogin;
    const environment = context.environment || "PROD";
    const existing = await this.listSchedules().catch(() => [] as Schedule<unknown>[]);
    const already = existing.some((s) => {
      const item = s as any;
      return item.callback === "autonomousOptionsAnalysis" && item.payload?.userLogin === userLogin;
    });
    if (already) return;
    try {
      const paused = new SqlPausedScheduleStore(this.ctx.storage.sql).list();
      const pausedForUser = paused.some(
        (r) =>
          r.callback === "autonomousOptionsAnalysis" &&
          (r.payload as { userLogin?: string } | undefined)?.userLogin === userLogin
      );
      if (pausedForUser) return;
    } catch {
      // Paused-store unavailable: the SDK arming below is idempotent,
      // so a missed pause check can only re-arm a job the user can
      // pause again — never duplicate one.
    }
    await this.schedule(
      STRATEGY_SCAN_CRON,
      "autonomousOptionsAnalysis" as keyof this,
      { userLogin, environment, universe: "NASDAQ100", trigger: "scheduled" },
      { idempotent: true }
    );
    this.audit("schedule.created", "orchestrator", {
      callback: "autonomousOptionsAnalysis",
      scheduleType: "cron",
      cron: STRATEGY_SCAN_CRON,
      origin: "strategy-scan-baseline",
    });
  }

  /**
   * Cloudflare Agents Scheduled Callback: Proactively renews E*TRADE tokens before midnight ET
   */
  async autoRenewETradeTokens(payload?: { userLogin?: string; env?: string }): Promise<void> {
    try {
      await this.waitUntilStable({ timeout: 30_000 });
    } catch {
      // Continue if timeout or unhandled
    }
    const context = await this.getScreenerExecutionContext();
    const user = context?.userLogin || payload?.userLogin;
    if (!user) {
      await this.removeUnownedBaselineSchedules();
      console.warn("[OrchestratorAgent] Skipping token renewal without an authenticated account owner.");
      return;
    }
    const environment = context?.environment || payload?.env;
    const service = new ScheduledTasksService(this.env, this.getOrm(), user, new SqlScanRunStore(this.ctx.storage.sql));
    const res = await service.autoRenewETradeTokens(user, environment);
    if (!res.success) {
      console.warn("[OrchestratorAgent] autoRenewETradeTokens error:", res.error);
    }
  }

  /**
   * Cloudflare Agents Scheduled Callback: Runs periodic market screening
   * Protected with keepAliveWhile to avoid DO inactivity eviction
   */
  async autonomousMarketScreen(payload?: {
    sector?: string;
    universe?: string;
    maxItems?: number;
    broadcast?: boolean;
    trigger?: "manual" | "scheduled";
    userLogin?: string;
    environment?: ETradeEnvironment;
    emailTo?: string;
    slackChannel?: string;
    webhookUrl?: string;
    pushToSlack?: boolean;
    filters?: import("../types").StockScreenerFilter;
  }): Promise<void> {
    try {
      await this.waitUntilStable({ timeout: 30_000 });
    } catch {
      // Continue if timeout or unhandled
    }
    const runScreen = async () => {
      const trigger = payload?.trigger || "scheduled";
      const universe = payload?.universe || "NASDAQ100";
      const savedContext = await this.getScreenerExecutionContext();
      const userLogin = savedContext?.userLogin || payload?.userLogin;
      const environment = savedContext?.environment || payload?.environment;
      if (trigger === "scheduled" && !userLogin) {
        // A pre-auth startup schedule has no safe account mapping. Remove it
        // before it can emit the same Slack failure every hour.
        await this.removeUnownedBaselineSchedules();
        console.warn("[OrchestratorAgent] Skipping unowned scheduled market screen.");
        return;
      }
      if (trigger === "scheduled") {
        // Old or duplicate cron records can still invoke the same universe
        // more than once in an hour. Keep the last delivered slot per
        // universe in DO storage so only one run publishes to Slack.
        const slot = new Date().toISOString().slice(0, 16);
        const slotKey = `${universe}:${slot}`;
        this.scheduledScreenerSlots ??= new Set<string>();
        if (this.scheduledScreenerSlots.has(slotKey)) return;
        if (this.scheduledScreenerSlots.size > 32) this.scheduledScreenerSlots.clear();
        this.scheduledScreenerSlots.add(slotKey);
        const key = `screener:scheduled:last-slot:${universe}`;
        const last = await this.ctx.storage.get<{ slot: string }>(key);
        if (last?.slot === slot) {
          console.warn(`[OrchestratorAgent] Suppressing duplicate scheduled screen for ${universe} in ${slot}Z`);
          return;
        }
        await this.ctx.storage.put(key, { slot });
      }
      const orm = this.getOrm();
      // Scheduled callbacks have no authenticated HTTP headers. Use the
      // identity and environment saved from the user's schedules requests.
      const service = new ScheduledTasksService(this.env, orm, userLogin || "", new SqlScanRunStore(this.ctx.storage.sql));
      const res = await service.autonomousMarketScreen({ ...payload, userLogin, environment, trigger });
      if ((res as any).skipped) return;
      // Issue #212: persist the run for the "last results" UX endpoint.
      try {
        const key = "screener:last_runs";
        const existing = ((await this.ctx.storage.get(key)) as any[]) || [];
        const run = {
          timestamp: res.timestamp,
          sector: res.data?.sector || payload?.sector || "ALL",
          universe: res.data?.universe || payload?.universe || "NASDAQ100",
          success: res.success,
          totalScanned: res.data?.totalScanned ?? 0,
          matchedCount: res.data?.matchedCount ?? 0,
          // Issue #261: opportunities arrive pre-shaped from ScreenerAgent.
          opportunities: res.data?.opportunities || [],
          // Issue #253: full scanned set so the panel can render the
          // per-symbol data table. Already shaped by the shared pipeline.
          allStocks: res.data?.allStocks || [],
          pdfKey: res.data?.pdfKey,
          error: res.success ? undefined : res.error,
        };
        await this.ctx.storage.put(key, [run, ...existing].slice(0, 20));
        // Issue #278: persist the scheduled run's report durably
        // (mas_reports) so the AI Search agent can surface it later.
        // Issue #308: through the single generate→store seam — one
        // canonical row per generation (generationId = run id).
        orm.storeCanonicalReport({
          runId: `screener:${res.timestamp}`,
          generationId: `screener:${res.timestamp}`,
          title: `Autonomous market screen — ${res.data?.universe || payload?.universe || "NASDAQ100"}`,
          source: "screener",
          summary: res.success
            ? `Scanned ${run.totalScanned} symbols, ${run.matchedCount} matched, ${run.opportunities.length} opportunities.`
            : `Scheduled screen failed: ${res.error ?? "unknown error"}.`,
          body: {
            ...run,
            pdfKey: run.pdfKey,
            reportUrl: run.pdfKey
              ? `${this.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/screener/report.pdf?key=${encodeURIComponent(String(run.pdfKey))}`
              : undefined,
          },
          createdAt: res.timestamp,
        });
      } catch {
        // Non-critical: persistence failure must not break the screen.
      }
      if (res.success && res.data?.opportunities && res.data.opportunities.length > 0) {
        if (typeof (this as any).broadcast === "function") {
          try {
            (this as any).broadcast(
              JSON.stringify({
                type: "market_alert",
                title: "Autonomous Screener Alert",
                count: res.data.opportunities.length,
                opportunities: res.data.opportunities,
                timestamp: res.timestamp,
              })
            );
          } catch {
            // Non-critical broadcast error
          }
        }
      } else if (!res.success) {
        // Failure surfacing (issue #112): a failed screen used to vanish
        // silently. The service now audits it and records a session
        // message; broadcast the failure too so live clients see it.
        // Deliberately no throw: platform callback retry is not used
        // for scheduled jobs — see the failure contract on
        // ScheduledTasksService.
        if (typeof (this as any).broadcast === "function") {
          try {
            (this as any).broadcast(
              JSON.stringify({
                type: "market_alert",
                title: "Autonomous Screener Failed",
                success: false,
                sector: payload?.sector,
                error: res.error,
                timestamp: res.timestamp,
              })
            );
          } catch {
            // Non-critical broadcast error
          }
        }
      }
    };

    if (typeof (this as any).keepAliveWhile === "function") {
      await (this as any).keepAliveWhile(runScreen);
    } else {
      await runScreen();
    }
  }

  /**
   * Cloudflare Agents Scheduled Callback: Autonomous Options Intelligence
   * Runs cross-symbol options discovery and dispatches omnichannel push alerts
   */
  async autonomousOptionsAnalysis(payload?: AutonomousOptionsAnalysisOptions): Promise<void> {
    try {
      await this.waitUntilStable({ timeout: 30_000 });
    } catch {
      // Continue if timeout or unhandled
    }
    const runAnalysis = async () => {
      const savedContext = await this.getScreenerExecutionContext();
      const userLogin = savedContext?.userLogin || payload?.userLogin || "";
      const environment = savedContext?.environment || payload?.environment;
      if (payload?.trigger !== "manual" && !userLogin) {
        await this.removeUnownedBaselineSchedules();
        console.warn("[OrchestratorAgent] Skipping unowned scheduled options screen.");
        return;
      }
      if (payload?.trigger !== "manual") {
        const slot = new Date().toISOString().slice(0, 16);
        const thesis = payload?.thesis || "bullish";
        const slotKey = `${thesis}:${slot}`;
        this.scheduledOptionsSlots ??= new Set<string>();
        if (this.scheduledOptionsSlots.has(slotKey)) return;
        if (this.scheduledOptionsSlots.size > 32) this.scheduledOptionsSlots.clear();
        this.scheduledOptionsSlots.add(slotKey);
        const key = `options:scheduled:last-slot:${thesis}`;
        const last = await this.ctx.storage.get<{ slot: string }>(key);
        if (last?.slot === slot) {
          console.warn(`[OrchestratorAgent] Suppressing duplicate scheduled options scan (${thesis}) in ${slot}Z`);
          return;
        }
        await this.ctx.storage.put(key, { slot });
      }
      const service = new ScheduledTasksService(this.env, this.getOrm(), userLogin, new SqlScanRunStore(this.ctx.storage.sql));
      const res = await service.autonomousOptionsAnalysis({ ...payload, userLogin, environment });
      if ((res as any).skipped) return;
      // Issue #223: persist the run so GET /api/options/latest can report what
      // the scheduler produced. History is auxiliary — a storage failure must
      // not turn a completed analysis into a failed one.
      try {
        await recordOptionsRun(this.ctx.storage, {
          timestamp: res.timestamp,
          success: res.success,
          trigger: payload?.trigger === "manual" ? "manual" : "scheduled",
          thesis: payload?.thesis || "bullish",
          symbols: res.data?.symbols || payload?.symbols || [],
          withTrades: res.data?.withTrades ?? 0,
          summary: res.data?.summary || "",
          opportunities: (res.data?.opportunities || []).slice(0, 10),
          ...(res.success ? {} : { error: res.error }),
        });
      } catch (err) {
        console.warn("[OrchestratorAgent] Could not persist options run:", err);
      }
      // Issue #910: unified pipeline — options scheduled runs must also
      // write to mas_reports so they appear in the Reports tab like all
      // other screener types. Single generate→store→serve→deliver path.
      try {
        const orm = this.getOrm();
        const generationId = `options:${res.timestamp}`;
        orm.storeCanonicalReport({
          runId: generationId,
          generationId,
          title: `Autonomous options analysis — ${payload?.thesis || "bullish"} (${payload?.trigger === "manual" ? "manual" : "scheduled"})`,
          source: "options_scanner",
          summary: res.success
            ? res.data?.summary || `Analyzed ${(res.data?.symbols || []).length} symbols.`
            : `Options analysis failed: ${res.error ?? "unknown error"}.`,
          body: {
            timestamp: res.timestamp,
            trigger: payload?.trigger === "manual" ? "manual" : "scheduled",
            thesis: payload?.thesis || "bullish",
            success: res.success,
            symbols: res.data?.symbols || [],
            withTrades: res.data?.withTrades ?? 0,
            opportunities: res.data?.opportunities || [],
            error: res.error,
          },
          createdAt: new Date().toISOString(),
          userLogin: userLogin || undefined,
        });
      } catch (err) {
        console.warn("[OrchestratorAgent] Could not store options report canonical:", err);
      }
      if (res.success && res.data) {
        if (typeof (this as any).broadcast === "function") {
          try {
            (this as any).broadcast(
              JSON.stringify({
                type: "options_alert",
                title: "Autonomous Options Intelligence Alert",
                summary: res.data.summary,
                symbols: res.data.symbols,
                withTrades: res.data.withTrades,
                opportunities: res.data.opportunities,
                notifications: res.data.notifications,
                timestamp: res.timestamp,
              })
            );
          } catch {
            // Non-critical broadcast error
          }
        }
      } else if (!res.success) {
        // Failure surfacing (issue #112): mirror the success broadcast
        // for failures — the service audits the failure and records a
        // session message, and live clients get this broadcast.
        // Deliberately no throw: platform callback retry is not used
        // for scheduled jobs — see the failure contract on
        // ScheduledTasksService.
        if (typeof (this as any).broadcast === "function") {
          try {
            (this as any).broadcast(
              JSON.stringify({
                type: "options_alert",
                title: "Autonomous Options Intelligence Failed",
                success: false,
                symbols: payload?.symbols,
                error: res.error,
                timestamp: res.timestamp,
              })
            );
          } catch {
            // Non-critical broadcast error
          }
        }
      }
    };

    if (typeof (this as any).keepAliveWhile === "function") {
      await (this as any).keepAliveWhile(runAnalysis);
    } else {
      await runAnalysis();
    }
  }

  /**
   * Cloudflare Agents Scheduled Callback: Scheduled Strategy Discovery
   * (issue #126, PR-E). Re-runs the schedule payload's SAVED
   * StrategyRequests verbatim through the discovery pipeline and
   * persists the run (SqlDiscoveryRunStore) for the panel to read
   * back. Mirrors the autonomousOptionsAnalysis wrapper: saved
   * execution context wins for identity/environment, unowned
   * scheduled fires are skipped, duplicate fires within the same
   * minute slot for the same saved-request set are suppressed, and
   * results AND failures are broadcast (issue #112) — the service
   * itself audits and records the session message. Deliberately no
   * throw: see the failure contract on ScheduledTasksService.
   */
  async autonomousStrategyDiscovery(payload?: AutonomousStrategyDiscoveryOptions): Promise<void> {
    try {
      await this.waitUntilStable({ timeout: 30_000 });
    } catch {
      // Continue if timeout or unhandled
    }
    const runDiscovery = async () => {
      const savedContext = await this.getScreenerExecutionContext();
      const userLogin = savedContext?.userLogin || payload?.userLogin || "";
      const environment = savedContext?.environment || payload?.environment;
      if (payload?.trigger !== "manual" && !userLogin) {
        await this.removeUnownedBaselineSchedules();
        console.warn("[OrchestratorAgent] Skipping unowned scheduled strategy discovery.");
        return;
      }
      if (payload?.trigger !== "manual") {
        // Duplicate-fire suppression, keyed on the saved-request set
        // (not a thesis): the same schedule re-firing inside one
        // minute slot is a platform duplicate; a different request
        // set in the same minute is a different run and proceeds.
        // Issue #533: profile-derived payloads carry no requests —
        // the slot keys on the derived identity (input model, symbol
        // source, profile) instead, so two different derived
        // schedules in the same minute never suppress each other.
        // Saved-request payloads hash exactly as before. Issue #534:
        // no-view payloads carry no requests either — their
        // constraint sets join the key the same way (absent on the
        // other models, where JSON.stringify drops the key and the
        // hash is unchanged).
        const slot = new Date().toISOString().slice(0, 16);
        const requestsJson = JSON.stringify(
          payload?.requests ?? {
            inputModel: payload?.inputModel,
            symbols: payload?.symbols,
            watchlistName: payload?.watchlistName,
            profileId: payload?.profileId,
            constraintSets: payload?.constraintSets,
          }
        );
        let hash = 0;
        for (let i = 0; i < requestsJson.length; i++) {
          hash = ((hash << 5) - hash + requestsJson.charCodeAt(i)) | 0;
        }
        const slotKey = `${userLogin}:${slot}:${(hash >>> 0).toString(36)}`;
        this.scheduledDiscoverySlots ??= new Set<string>();
        if (this.scheduledDiscoverySlots.has(slotKey)) return;
        if (this.scheduledDiscoverySlots.size > 32) this.scheduledDiscoverySlots.clear();
        this.scheduledDiscoverySlots.add(slotKey);
        const key = `discovery:scheduled:last-slot:${(hash >>> 0).toString(36)}`;
        const last = await this.ctx.storage.get<{ slot: string; userLogin: string }>(key);
        if (last?.slot === slot && last?.userLogin === userLogin) {
          console.warn(`[OrchestratorAgent] Suppressing duplicate scheduled strategy discovery in ${slot}Z`);
          return;
        }
        await this.ctx.storage.put(key, { slot, userLogin });
      }
      const service = new ScheduledTasksService(
        this.env,
        this.getOrm(),
        userLogin,
        new SqlScanRunStore(this.ctx.storage.sql),
        undefined,
        new SqlDiscoveryRunStore(this.ctx.storage.sql),
        new SqlStrategyProfileStore(this.ctx.storage.sql)
      );
      const res = await service.autonomousStrategyDiscovery({ ...payload, userLogin, environment });
      if ((res as any).skipped) return;
      if (typeof (this as any).broadcast === "function") {
        try {
          if (res.success && res.data) {
            (this as any).broadcast(
              JSON.stringify({
                type: "discovery_alert",
                title: "Scheduled Strategy Discovery",
                success: true,
                runId: res.data.runId,
                status: res.data.status,
                symbols: res.data.symbols,
                requestCount: res.data.requestCount,
                completedCount: res.data.completedCount,
                failedCount: res.data.failedCount,
                timestamp: res.timestamp,
              })
            );
          } else if (!res.success) {
            (this as any).broadcast(
              JSON.stringify({
                type: "discovery_alert",
                title: "Scheduled Strategy Discovery Failed",
                success: false,
                symbols: payload?.requests?.length
                  ? payload.requests.map((r) => r?.symbol)
                  : (payload?.symbols ?? (payload?.constraintSets ?? []).map((s) => s?.symbol)),
                error: res.error,
                timestamp: res.timestamp,
              })
            );
          }
        } catch {
          // Non-critical broadcast error
        }
      }
    };

    if (typeof (this as any).keepAliveWhile === "function") {
      await (this as any).keepAliveWhile(runDiscovery);
    } else {
      await runDiscovery();
    }
  }

  /**
   * Cloudflare Agents Scheduled Callback: Daily IV History Collection
   * (issue #15). Persists one ATM IV record per tracked name per day;
   * names whose chains fail are reported failed in the run's audit —
   * no record is ever fabricated for a missing day.
   */
  async collectIvHistory(payload?: { symbols?: string[]; environment?: string; userLogin?: string }): Promise<void> {
    try {
      await this.waitUntilStable({ timeout: 30_000 });
    } catch {
      // Continue if timeout or unhandled
    }
    const runCollection = async () => {
      const context = await this.getScreenerExecutionContext();
      const userLogin = context?.userLogin || payload?.userLogin;
      if (!userLogin) {
        await this.removeUnownedBaselineSchedules();
        console.warn("[OrchestratorAgent] Skipping IV collection without an authenticated account owner.");
        return;
      }
      const environment = context?.environment || payload?.environment;
      const service = new ScheduledTasksService(
        this.env,
        this.getOrm(),
        userLogin,
        new SqlScanRunStore(this.ctx.storage.sql),
        new SqlIvHistoryStore(this.ctx.storage.sql)
      );
      const res = await service.collectDailyIvHistory({ symbols: payload?.symbols, environment });
      if (!res.success) {
        console.warn("[OrchestratorAgent] collectIvHistory error:", res.error);
      } else if (typeof (this as any).broadcast === "function") {
        try {
          (this as any).broadcast(
            JSON.stringify({
              type: "iv_collection",
              title: "Daily IV History Collection",
              date: res.data?.date,
              recorded: res.data?.recorded,
              alreadyRecorded: res.data?.alreadyRecorded,
              failed: res.data?.failed,
              tracked: res.data?.trackedCount,
              timestamp: res.timestamp,
            })
          );
        } catch {
          // Non-critical broadcast error
        }
      }
    };

    if (typeof (this as any).keepAliveWhile === "function") {
      await (this as any).keepAliveWhile(runCollection);
    } else {
      await runCollection();
    }
  }

  // Issue #686: the AIChatAgent-era submitMessages wrapper — an
  // emulation of the documented autonomous-admission API over
  // saveMessages — is removed. Think provides submitMessages
  // natively as the durable submissions queue (its own signature
  // and acceptance result), which is what external admissions
  // (webhooks, Slack, cron) now use.

  /**
   * Cloudflare Agents Scheduled Callback: Auto-expires a stale unconfirmed order draft
   */
  async expireStaleOrderDraft(payload: { orderId: string; userLogin?: string }): Promise<void> {
    if (!payload?.orderId) return;
    const service = new ScheduledTasksService(this.env, this.getOrm(), payload.userLogin || this.sessionKey(), new SqlScanRunStore(this.ctx.storage.sql));
    await service.expireStaleOrderDraft(payload.orderId);
  }

  /**
   * Cloudflare Agents Scheduled Callback: Dispatches a user reminder
   */
  async sendScheduledReminder(payload: { reminderId: string; message: string; userLogin?: string }): Promise<void> {
    if (!payload?.reminderId) return;
    const service = new ScheduledTasksService(this.env, this.getOrm(), payload.userLogin || this.sessionKey(), new SqlScanRunStore(this.ctx.storage.sql));
    const res = await service.dispatchReminder(payload.reminderId, payload.message);
    if (typeof (this as any).broadcast === "function") {
      try {
        // Issue #123 (F19): the broadcast mirrors the dispatch result —
        // a reminder whose chat-history delivery failed is broadcast in
        // the same message family with success: false + the error (the
        // #112 failure-surfacing pattern), never as a fired reminder.
        (this as any).broadcast(
          JSON.stringify(
            res.success
              ? {
                  type: "scheduled_reminder",
                  reminderId: payload.reminderId,
                  message: payload.message,
                  timestamp: res.timestamp,
                }
              : {
                  type: "scheduled_reminder",
                  reminderId: payload.reminderId,
                  message: payload.message,
                  success: false,
                  error: res.error,
                  timestamp: res.timestamp,
                }
          )
        );
      } catch {
        // Non-critical broadcast error
      }
    }
  }

  /**
   * Issue #109: binds this agent's Cloudflare Agents scheduling API
   * into the narrow port the NLQ executor consumes, so schedules
   * created/listed/cancelled from natural language are real SDK
   * schedules with real ids.
   *
   * Issue #108: the bindings call the typed Agent methods directly —
   * schedule/scheduleEvery/cancelSchedule/listSchedules are typed
   * members of the Agent base class, so the old `(this as any)` +
   * typeof-guard layer is gone. The port receives callback names as
   * plain strings from NLQ plan parsing; the narrow `as keyof this`
   * assertion is the one cast that remains, because the SDK signature
   * requires a method-name key. It cannot fabricate success: an
   * unknown name makes the SDK call throw, and the NLQ executor
   * converts any throw into an honest failure reply.
   */
  private nlqSchedulingPort(): NLQSchedulingPort {
    return {
      schedule: async (when, callback, payload, options) =>
        (await this.schedule(when, callback as keyof this, payload, options)) as AgentScheduleItem,
      scheduleEvery: async (intervalSeconds, callback, payload) =>
        (await this.scheduleEvery(intervalSeconds, callback as keyof this, payload)) as AgentScheduleItem,
      cancelSchedule: async (id) => await this.cancelSchedule(id),
      listSchedules: async () => (await this.listSchedules()) as AgentScheduleItem[],
    };
  }

  /**
   * Issue #982: the NLQ stock-screen port — binds the ScreenerAgent
   * (the stock screening service the REST /etrade/screen route
   * delegates to) into the NLQ execution deps, so NLQ stock screens
   * run the same pipeline as REST screens. The agent persists its
   * own run record; the canonical mas_reports copy is persisted by
   * the NLQ executor at its layer, mirroring how the REST route
   * persists it at its layer (persistScreenerReportCanonical).
   * maxItems 10: the port's consumers take up to ten standout picks
   * (the watchlist_save fallback's top-10).
   */
  private nlqStockScreenPort(): NLQStockScreenPort {
    return {
      runScreen: async ({ filters, userLogin }) => {
        const universe = typeof (filters as { universe?: unknown })?.universe === "string"
          ? ((filters as { universe?: string }).universe as ScreenerRunRequest["universe"])
          : undefined;
        return this.getScreenerAgent(userLogin).runScreen({
          trigger: "manual",
          filters,
          universe,
          userLogin,
          maxItems: 10,
        });
      },
    };
  }

  private ensureTables() {
    const storage = this.ctx.storage;
    const sql = storage.sql;
    // Shared mas_* tables come from the canonical DDL in src/orm/schema
    // (issue #782) — do not re-add their DDL here.
    ensureSharedTable(sql, "mas_messages");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_async_jobs (
        job_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        response_status INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_session_created ON mas_async_jobs(session_id, created_at DESC)");
    ensureSharedTable(sql, "mas_events");
    ensureSharedTable(sql, "mas_memory");
    // Autopilot policy state (autopilot Phase 1): server-owned run state,
    // limits, kill switch, and daily order budget. Previously all four lived in
    // browser localStorage, so a reload cleared the kill switch and a second
    // browser ran its own envelope.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_autopilot (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // Server-owned settings (issue #277): per-key runtime flags readable by
    // the agent and writable through the /trading/settings routes. Same
    // shape as mas_autopilot; DELETE+INSERT is used for upsert so the
    // MockSqlStorage harness (which does not parse INSERT OR REPLACE)
    // stays byte-compatible with real SQLite.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // Issue #277: pending HITL confirmations for research-report dispatch.
    // Payloads are stored verbatim at creation time; the actual email or
    // webhook send happens only when a human approves via
    // POST /trading/reports/confirm. Mirrors the /payments/confirm flow.
    // Issue #308: payload_json carries delivery metadata only (recipient /
    // fileName / title); the report bytes themselves live once in
    // mas_reports, referenced by report_id. Legacy rows (pre-#308) carry
    // the full payload in payload_json and are read via a fallback.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_report_confirmations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        report_id TEXT
      )
    `);
    // Additive migration for tables created before issue #308.
    try {
      const cols = Array.from(
        sql.exec("PRAGMA table_info(mas_report_confirmations)")
      ) as Array<{ name?: unknown }>;
      const names = cols.map((c) => String(c?.name ?? ""));
      if (!names.includes("report_id")) {
        sql.exec("ALTER TABLE mas_report_confirmations ADD COLUMN report_id TEXT");
      }
    } catch {
      // Non-critical: best-effort migration; fresh installs get the column.
    }
    // Append-only verdict ledger: every policy decision, its inputs, and a
    // signature produced server-side where the decision is made.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_policy_verdicts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        quantity REAL NOT NULL,
        notional REAL,
        mode TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL,
        execution_allowed INTEGER NOT NULL,
        requires_approval INTEGER NOT NULL,
        binding_rule TEXT,
        detail TEXT NOT NULL,
        limits_json TEXT NOT NULL,
        projections_json TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        signing_key_id TEXT NOT NULL,
        proposer_did TEXT NOT NULL,
        authorizer_did TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_mas_policy_verdicts_created ON mas_policy_verdicts(created_at DESC)");
    ensureSharedTable(sql, "mas_referrals");
    ensureSharedTable(sql, "mas_ads");

    ensureSharedTable(sql, "mas_watchlists");

    // Seed default sponsor offers if ads table is empty
    try {
      const adCount = Array.from(sql.exec("SELECT COUNT(*) AS count FROM mas_ads")) as Array<{ count: number }>;
      if ((adCount[0]?.count ?? 0) === 0) {
        const now = new Date().toISOString();
        const seedAds = [
          {
            id: "ad_workers_ai",
            title: "Cloudflare Workers AI",
            tagline: "Run state-of-the-art models (GLM-4.7, Llama 3.3) on serverless GPUs with zero cold starts.",
            sponsor: "Cloudflare",
            badge: "FLAGSHIP PARTNER",
            url: "https://developers.cloudflare.com/workers-ai/",
            cta_text: "Deploy in 60s →",
            accent_color: "#f38020",
          },
          {
            id: "ad_ai_search",
            title: "Cloudflare AI Search",
            tagline: "Build enterprise RAG pipelines with native auto-chunking, Vectorize indexes, and real-time semantic retrieval.",
            sponsor: "Cloudflare AI",
            badge: "FEATURED TOOL",
            url: "https://developers.cloudflare.com/ai-search/",
            cta_text: "Explore Docs →",
            accent_color: "#38bdf8",
          },
          {
            id: "ad_durable_objects",
            title: "Durable Objects SQLite",
            tagline: "Strongly consistent transactional databases running natively at the edge for stateful AI agents.",
            sponsor: "Cloudflare Platform",
            badge: "INFRASTRUCTURE",
            url: "https://developers.cloudflare.com/durable-objects/",
            cta_text: "Learn More →",
            accent_color: "#a855f7",
          },
          {
            id: "ad_openaimp",
            title: "OpenAIMP Agent Studio",
            tagline: "Scale autonomous multi-agent workflows with real-time LLM Judge routing and persistent memory.",
            sponsor: "OpenAIMP",
            badge: "SPONSOR",
            url: "https://agent.openaimp.com",
            cta_text: "Join Program →",
            accent_color: "#10b981",
          },
        ];

        for (const ad of seedAds) {
          sql.exec(
            "INSERT OR IGNORE INTO mas_ads (id, title, tagline, sponsor, badge, url, cta_text, accent_color, impressions, clicks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)",
            ad.id,
            ad.title,
            ad.tagline,
            ad.sponsor,
            ad.badge,
            ad.url,
            ad.cta_text,
            ad.accent_color,
            now
          );
        }
      }
    } catch {
      // Ignore if seeding fails
    }

    ensureSharedTable(sql, "mas_transactions");

    // Issue #175: this store previously seeded two fabricated "default"
    // transactions on first use — completed charges carrying invented
    // proof signatures and live-shaped gateway references, stamped with
    // the user's own DID as authorizer and rendered by the payments
    // ledger (including its volume/completed summary) as real payments.
    // They are removed, not relabelled: nothing depends on them (wallet
    // status counts only x402/mpp rows; the confirm flow requires a
    // "previewed" draft, which these never were). Real draft ids are
    // `pay_` + 8 random hex characters, so the two seed ids can only
    // ever have come from that seeding — purge exactly those rows from
    // stores seeded before this fix.
    try {
      sql.exec("DELETE FROM mas_transactions WHERE id = ?", "pay_init_stripe");
      sql.exec("DELETE FROM mas_transactions WHERE id = ?", "pay_init_paypal");
    } catch {
      // Ignore if the purge fails
    }

    return sql;
  }

  private async submitAsyncJob(
    job: AsyncJobSubmission,
  ): Promise<{ jobId: string; status: "queued"; statusUrl: string }> {
    const sql = this.ensureTables();
    const payloadJson = JSON.stringify(job.payload);
    if (new TextEncoder().encode(payloadJson).byteLength > 17_000_000) {
      throw new Error("Async job payload exceeds the 17 MB serialized storage limit.");
    }
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    sql.exec(
      "DELETE FROM mas_async_jobs WHERE session_id = ? AND status IN ('completed', 'failed') AND created_at < ?",
      this.sessionKey(),
      cutoff,
    );
    sql.exec(
      `DELETE FROM mas_async_jobs WHERE job_id IN (
        SELECT job_id FROM mas_async_jobs WHERE session_id = ?
        AND status IN ('completed', 'failed') ORDER BY created_at DESC LIMIT -1 OFFSET 500
      )`,
      this.sessionKey(),
    );
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const displayName = job.capability === "http.request"
      ? `${job.payload.method} ${job.payload.pathAndQuery.split("?")[0]}`
      : job.capability === "mcp.tool"
        ? `MCP: ${job.payload.toolName}`
        : job.capability === "nlq.execute"
          ? `NLQ: ${job.payload.query.slice(0, 100)}`
          : `Task: ${job.payload.title}`;
    sql.exec(
      `INSERT INTO mas_async_jobs
        (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      jobId,
      this.sessionKey(),
      job.capability,
      displayName,
      payloadJson,
      now,
      now,
    );

    try {
      await this.schedule(0, "executeAsyncJob", { jobId } satisfies AsyncJobPayload, {
        idempotent: true,
        retry: { maxAttempts: 1 },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sql.exec(
        "UPDATE mas_async_jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'queued'",
        `Could not schedule async work: ${message}`,
        new Date().toISOString(),
        new Date().toISOString(),
        jobId,
      );
      throw error;
    }

    this.audit("async_job.queued", "orchestrator", { jobId, capability: job.capability });
    return { jobId, status: "queued", statusUrl: `/api/jobs/${jobId}` };
  }

  private async recoverQueuedAsyncJobs(): Promise<void> {
    const pending = Array.from(this.ensureTables().exec(
      "SELECT job_id FROM mas_async_jobs WHERE session_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 100",
      this.sessionKey(),
    )) as Array<{ job_id: string }>;
    for (const { job_id: jobId } of pending) {
      try {
        await this.schedule(0, "executeAsyncJob", { jobId } satisfies AsyncJobPayload, {
          idempotent: true,
          retry: { maxAttempts: 1 },
        });
      } catch (error) {
        console.error(`[OrchestratorAgent] Could not reschedule queued async job ${jobId}:`, error);
      }
    }
  }

  private getAsyncJob(jobId: string): AsyncJobRecord | undefined {
    const sql = this.ensureTables();
    const rows = Array.from(sql.exec(
      `SELECT job_id, session_id, capability, display_name, status, result_json, response_status,
              error, created_at, updated_at, started_at, completed_at
       FROM mas_async_jobs WHERE job_id = ? AND session_id = ?`,
      jobId,
      this.sessionKey(),
    )) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return undefined;
    if (row.status === "running" && typeof row.started_at === "string" &&
      Date.now() - Date.parse(row.started_at) > 2 * 60 * 60 * 1000) {
      const completedAt = new Date().toISOString();
      sql.exec(
        `UPDATE mas_async_jobs SET status = 'failed',
         error = 'Execution stopped before a result was recorded; the outcome may be unknown. Verify external side effects before submitting again.',
         updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'running'`,
        completedAt,
        completedAt,
        jobId,
      );
      return this.getAsyncJob(jobId);
    }
    let result: unknown;
    if (typeof row.result_json === "string") {
      try {
        result = JSON.parse(row.result_json);
      } catch (error) {
        throw new Error(`Stored result for async job ${jobId} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      jobId: String(row.job_id),
      sessionId: String(row.session_id),
      capability: String(row.capability),
      label: String(row.display_name),
      status: row.status as AsyncJobStatus,
      result,
      responseStatus: typeof row.response_status === "number" ? row.response_status : undefined,
      error: typeof row.error === "string" ? row.error : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      startedAt: typeof row.started_at === "string" ? row.started_at : undefined,
      completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
    };
  }

  private listAsyncJobs(limit = 50): AsyncJobRecord[] {
    const rows = Array.from(this.ensureTables().exec(
      `SELECT job_id, session_id, capability, display_name, status, error, created_at, updated_at, started_at, completed_at
       FROM mas_async_jobs WHERE session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      this.sessionKey(),
      Math.max(1, Math.min(100, Math.floor(limit))),
    )) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      if (row.status === "running") {
        const updated = this.getAsyncJob(String(row.job_id));
        if (updated?.status === "failed") return updated;
      }
      return {
        jobId: String(row.job_id),
        sessionId: String(row.session_id),
        capability: String(row.capability),
        label: String(row.display_name),
        status: row.status as AsyncJobStatus,
        error: typeof row.error === "string" ? row.error : undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        startedAt: typeof row.started_at === "string" ? row.started_at : undefined,
        completedAt: typeof row.completed_at === "string" ? row.completed_at : undefined,
      };
    });
  }

  async executeAsyncJob({ jobId }: AsyncJobPayload): Promise<void> {
    const sql = this.ensureTables();
    const now = new Date().toISOString();
    const claimed = sql.exec(
      `UPDATE mas_async_jobs SET status = 'running', started_at = ?, updated_at = ?
       WHERE job_id = ? AND session_id = ? AND status = 'queued'`,
      now,
      now,
      jobId,
      this.sessionKey(),
    );
    if (claimed.rowsWritten !== 1) return;

    const rows = Array.from(sql.exec(
      "SELECT capability, payload_json FROM mas_async_jobs WHERE job_id = ? AND session_id = ?",
      jobId,
      this.sessionKey(),
    )) as Array<{ capability: string; payload_json: string }>;
    const job = rows[0];
    if (!job) throw new Error(`Async job ${jobId} disappeared after it was claimed.`);

    try {
      const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
      let result: unknown;
      let responseStatus: number | undefined;

      if (job.capability === "http.request") {
        const pathAndQuery = String(payload.pathAndQuery || "");
        const method = String(payload.method || "GET");
        const headers = new Headers(payload.headers as HeadersInit);
        const body = typeof payload.body === "string" ? payload.body : undefined;
        const response = await this.routeRequest(new Request(new URL(pathAndQuery, "https://agent.internal"), {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : body,
        }));
        const responseBody = await response.text();
        if (new TextEncoder().encode(responseBody).byteLength > 5_000_000) {
          throw new Error("Async API response exceeds the 5 MB job-result limit.");
        }
        responseStatus = response.status;
        result = {
          body: responseBody,
          headers: Object.fromEntries(response.headers.entries()),
        };
      } else if (job.capability === "mcp.tool") {
        const toolName = String(payload.toolName || "");
        const args = (payload.arguments || {}) as Record<string, unknown>;
        result = await executeMCPTool(toolName, args, {
          env: this.env,
          orm: this.getOrm(),
          sessionId: this.sessionKey(),
          audit: (type, agent, detail) => this.audit(type, agent, detail),
        });
      } else if (job.capability === "task.draft") {
        result = {
          taskId: `task_${crypto.randomUUID().slice(0, 8)}`,
          status: "draft",
          requiresConfirmation: true,
          ...payload,
          message: "Task draft created. Awaiting human confirmation.",
        };
      } else if (job.capability === "nlq.execute") {
        const query = String(payload.query || "").trim();
        if (!query) throw new Error("NLQ job requires a non-empty query.");
        result = await executeNaturalLanguageQuery(
          this.getOrm(),
          this.sessionKey(),
          query,
          this.env,
          typeof payload.userLogin === "string" ? payload.userLogin : this.sessionKey(),
          getUserDid(this.sessionKey()),
          { scanRunStore: new SqlScanRunStore(this.ctx.storage.sql), profileStore: new SqlStrategyProfileStore(this.ctx.storage.sql), schedulingPort: this.nlqSchedulingPort(), stockScreenPort: this.nlqStockScreenPort() },
        );
      } else {
        throw new Error(`Unsupported async capability: ${job.capability}`);
      }

      const serializedResult = JSON.stringify(result);
      if (new TextEncoder().encode(serializedResult).byteLength > 12_000_000) {
        throw new Error("Async job result exceeds the 12 MB serialized result limit.");
      }
      const completedAt = new Date().toISOString();
      sql.exec(
        `UPDATE mas_async_jobs SET status = 'completed', result_json = ?, response_status = ?,
         updated_at = ?, completed_at = ? WHERE job_id = ? AND status = 'running'`,
        serializedResult,
        responseStatus ?? null,
        completedAt,
        completedAt,
        jobId,
      );
      this.audit("async_job.completed", "orchestrator", { jobId, capability: job.capability });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = new Date().toISOString();
      sql.exec(
        `UPDATE mas_async_jobs SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
         WHERE job_id = ? AND status = 'running'`,
        message,
        completedAt,
        completedAt,
        jobId,
      );
      this.audit("async_job.failed", "orchestrator", { jobId, capability: job.capability, error: message });
      console.error(`[OrchestratorAgent] Async job ${jobId} failed:`, error);
    }
  }

  private sessionKey(): string {
    return this.ctx.id.toString();
  }

  private getOrm(): DatabaseORM {
    this.ensureTables();
    const orm = new DatabaseORM(this.ctx.storage.sql);
    orm.initializeSchema(this.sessionKey());
    return orm;
  }

  /**
   * Inserts one audit row into mas_events and returns the stored record.
   * Single owner of audit-row inserts (issue #270): this.audit() and the
   * POST /audit/event route both funnel through here.
   */
  private recordAudit(
    type: string,
    agent: string,
    payload: Record<string, unknown>
  ): { id: string; type: string; agent: string; payload: Record<string, unknown>; created_at: string } {
    const sql = this.ensureTables();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    sql.exec(
      "INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      this.sessionKey(),
      type,
      agent,
      JSON.stringify(payload),
      now
    );
    return { id, type, agent, payload, created_at: now };
  }

  private audit(type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) {
    try {
      this.recordAudit(type, agent, payload);
    } catch {
      // Don't fail execution if audit insertion fails
    }
  }

  // ---------------------------------------------------------------------------
  // Autopilot policy envelope (autopilot Phase 1)
  //
  // The Durable Object owns run state, limits, and the kill switch so that one
  // envelope governs every client and channel, and so the kill switch survives
  // a page reload. Policy decisions are recorded with a server-side signature.
  // ---------------------------------------------------------------------------

  private static readonly AUTOPILOT_STATE_KEY = "autopilot_state_v1";

  private marketDateKey(now: Date = new Date()): string {
    // Daily order budgets roll at 00:00 UTC. Deliberately simple and
    // deterministic; an exchange-local (America/New_York) rollover is a
    // follow-up that needs tz-aware handling.
    return now.toISOString().slice(0, 10);
  }

  private readAutopilotStateRaw(): Record<string, any> {
    try {
      const sql = this.ensureTables();
      const rows = Array.from(
        sql.exec("SELECT value FROM mas_autopilot WHERE key = ?", OrchestratorAgent.AUTOPILOT_STATE_KEY)
      ) as Array<{ value: string }>;
      const raw = rows[0]?.value;
      return raw ? (JSON.parse(raw) as Record<string, any>) : {};
    } catch {
      return {};
    }
  }

  private getAutopilotState() {
    const raw = this.readAutopilotStateRaw();
    const today = this.marketDateKey();
    const storedDate = typeof raw.ordersDate === "string" ? raw.ordersDate : today;
    return {
      running: Boolean(raw.running),
      killSwitch: Boolean(raw.killSwitch),
      killSwitchReason: (raw.killSwitchReason as string | null) ?? null,
      limits: normalizeAutopilotLimits(raw.limits ?? null),
      ordersToday: storedDate === today ? Number(raw.ordersToday) || 0 : 0,
      ordersDate: today,
      peakEquity: typeof raw.peakEquity === "number" && Number.isFinite(raw.peakEquity) ? raw.peakEquity : null,
      updatedAt: (raw.updatedAt as string | null) ?? null,
    };
  }

  private writeAutopilotState(patch: Record<string, unknown>) {
    const current = this.getAutopilotState();
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    try {
      const sql = this.ensureTables();
      sql.exec(
        "INSERT OR REPLACE INTO mas_autopilot (key, value, updated_at) VALUES (?, ?, ?)",
        OrchestratorAgent.AUTOPILOT_STATE_KEY,
        JSON.stringify(next),
        next.updatedAt
      );
    } catch (err) {
      console.warn("[OrchestratorAgent] Autopilot: failed to persist state:", err);
    }
    return next;
  }

  /** Issue #277: setting key for optional HITL confirmation on report dispatch. */
  private static readonly REPORT_DISPATCH_HITL_KEY = "report_dispatch_hitl";
  /** Pending report confirmations expire unconfirmed after this long. */
  private static readonly REPORT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

  private readSettingRaw(key: string): string | null {
    try {
      const sql = this.ensureTables();
      const rows = Array.from(
        sql.exec("SELECT value FROM mas_settings WHERE key = ?", key)
      ) as Array<{ value: string }>;
      return rows[0]?.value ?? null;
    } catch {
      return null;
    }
  }

  private writeSetting(key: string, value: string): void {
    const sql = this.ensureTables();
    const now = new Date().toISOString();
    // DELETE+INSERT (not INSERT OR REPLACE) so MockSqlStorage stays compatible.
    sql.exec("DELETE FROM mas_settings WHERE key = ?", key);
    sql.exec("INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)", key, value, now);
  }

  /** Issue #277: true when report dispatch requires human confirmation. Default OFF. */
  private getReportDispatchHitl(): boolean {
    return this.readSettingRaw(OrchestratorAgent.REPORT_DISPATCH_HITL_KEY) === "1";
  }

  private setReportDispatchHitl(enabled: boolean): void {
    this.writeSetting(OrchestratorAgent.REPORT_DISPATCH_HITL_KEY, enabled ? "1" : "0");
  }

  /**
   * Stores a pending report-dispatch confirmation; returns its confirmation id.
   * Issue #308: payloadJson carries delivery metadata only (recipient /
   * fileName / title — never report bytes); the canonical report copy
   * lives once in mas_reports and is referenced by reportId.
   */
  private createReportConfirmation(
    kind: "email" | "webhook",
    payloadJson: string,
    reportId?: string | null
  ): string {
    const sql = this.ensureTables();
    const now = new Date().toISOString();
    // Lazy sweep: drop confirmations that expired unconfirmed.
    sql.exec(
      "DELETE FROM mas_report_confirmations WHERE status = 'pending' AND created_at < ?",
      new Date(Date.now() - OrchestratorAgent.REPORT_CONFIRMATION_TTL_MS).toISOString()
    );
    const id = `rc_${crypto.randomUUID().slice(0, 8)}`;
    sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at, report_id) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      kind,
      payloadJson,
      "pending",
      now,
      reportId ?? null
    );
    return id;
  }

  private getReportConfirmation(id: string): any | null {
    try {
      const sql = this.ensureTables();
      const rows = Array.from(
        sql.exec("SELECT * FROM mas_report_confirmations WHERE id = ?", id)
      ) as any[];
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private decideReportConfirmation(id: string, status: "approved" | "rejected" | "expired", decidedBy: string | null): void {
    try {
      const sql = this.ensureTables();
      sql.exec(
        "UPDATE mas_report_confirmations SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?",
        status,
        new Date().toISOString(),
        decidedBy,
        id
      );
    } catch (err) {
      console.warn("[OrchestratorAgent] Failed to decide report confirmation:", err);
    }
  }

  /**
   * Issue #308: store the canonical report copy at generation time via the
   * single seam. The generation id is a content hash, so re-posts and
   * re-deliveries of the same report dedupe to one row. Returns the
   * mas_reports row id, or null when the store failed (dispatch routes
   * fail closed in that case — no copy is sent that search cannot see).
   */
  private async storeResearchReportCanonicalAsync(
    bodyJson: string,
    meta: { title: string; summary: string; userLogin?: string }
  ): Promise<{ reportId: string; generationId: string } | null> {
    const generationId = await sha256Hex(bodyJson);
    const orm = this.getOrm();
    const stored = orm.storeCanonicalReport({
      runId: generationId,
      generationId,
      title: meta.title,
      source: "research_report",
      summary: meta.summary,
      body: JSON.parse(bodyJson),
      createdAt: new Date().toISOString(),
      userLogin: meta.userLogin,
    });
    return stored ? { reportId: stored.reportId, generationId } : null;
  }

  /**
   * Issue #308: delivery metadata from a confirmation row. For #308 rows
   * this is exactly what was stored (no report bytes); for legacy rows
   * (pre-#308) it is parsed from the embedded full payload.
   */
  private confirmationDeliveryMeta(row: any): { recipient?: string } {
    try {
      const payload = JSON.parse(String(row.payload_json)) as any;
      if (payload && typeof payload === "object") {
        return {
          recipient:
            typeof payload.recipient === "string" ? payload.recipient : undefined,
        };
      }
    } catch {
      // fall through
    }
    return {};
  }

  /**
   * Issue #308: deliver the STORED canonical copy by email. Returns
   * "sent" | "missing" (stored row gone) | "failed" (email service).
   */
  private async deliverStoredReportEmail(
    reportId: string,
    recipient: string,
    userLogin: string
  ): Promise<"sent" | "missing" | "failed"> {
    const stored = getCanonicalReport(this.ensureTables(), reportId);
    if (!stored) return "missing";
    const delivery = parseResearchReportBody(stored.body);
    if (!delivery || !delivery.attachmentBase64) return "missing";
    const sent = await this.sendReportEmail(
      recipient,
      delivery.title,
      delivery.fileName,
      delivery.attachmentBase64,
      userLogin
    );
    return sent ? "sent" : "failed";
  }

  /**
   * Issue #308: deliver the STORED canonical copy by webhook. Returns
   * "sent" | "missing" (stored row gone) | "failed" (dispatch failed).
   */
  private async deliverStoredReportWebhook(
    reportId: string,
    userLogin: string
  ): Promise<{ outcome: "sent" | "missing" | "failed"; result?: { success: boolean; status?: number; error?: string; notConfigured?: boolean } }> {
    const stored = getCanonicalReport(this.ensureTables(), reportId);
    if (!stored) return { outcome: "missing" };
    const delivery = parseResearchReportBody(stored.body);
    if (!delivery || !Array.isArray(delivery.sheets) || delivery.sheets.length === 0) {
      return { outcome: "missing" };
    }
    const result = await this.sendReportWebhook(
      delivery.title,
      delivery.query,
      delivery.sheets,
      userLogin
    );
    return { outcome: result.success ? "sent" : "failed", result };
  }

  /**
   * Issue #308: persist a screener run's canonical report copy in the
   * orchestrator instance's mas_reports (the store the AI Search read
   * path queries — issue #307). ScreenerAgent.persistRun() keeps writing
   * the delivery cache (latest/history/per-run PDFs) in the screener
   * instance's own DO storage; the SEARCHABLE copy is written once here,
   * keyed by generationId `screener:<timestamp>`, so the scheduled
   * wrapper and manual runs cannot create duplicate rows for one run.
   */
  private persistScreenerReportCanonical(result: {
    timestamp: string;
    universe?: unknown;
    sector?: unknown;
    success: boolean;
    totalScanned: number;
    matchedCount: number;
    opportunities: unknown[];
    allStocks: unknown[];
    pdfKey?: string;
    error?: string;
    trigger?: unknown;
    userLogin?: string;
  }): void {
    try {
      const orm = this.getOrm();
      const generationId = `screener:${result.timestamp}`;
      orm.storeCanonicalReport({
        runId: generationId,
        generationId,
        title: `Market screen — ${String(result.universe ?? result.sector ?? "ALL")} (${String(result.trigger ?? "scheduled")})`,
        source: "screener",
        summary: result.success
          ? `Scanned ${result.totalScanned} symbols, ${result.matchedCount} matched, ${result.opportunities.length} opportunities.`
          : `Screen failed: ${result.error ?? "unknown error"}.`,
        userLogin: result.userLogin,
        body: {
          timestamp: result.timestamp,
          universe: result.universe,
          sector: result.sector,
          trigger: result.trigger,
          success: result.success,
          totalScanned: result.totalScanned,
          matchedCount: result.matchedCount,
          opportunities: result.opportunities,
          allStocks: result.allStocks,
          pdfKey: result.pdfKey,
          reportUrl: result.pdfKey
            ? `${this.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/screener/report.pdf?key=${encodeURIComponent(result.pdfKey)}`
            : undefined,
          error: result.error,
        },
        createdAt: result.timestamp,
      });
    } catch {
      // Non-critical: persistence failure must not break the screen.
    }
  }

  /** Shared send leg for POST /trading/reports/email (immediate + confirmed paths). */
  private async sendReportEmail(
    recipient: string,
    title: string,
    fileName: string,
    attachmentBase64: string,
    userLogin: string
  ): Promise<boolean> {
    const emailService = new ETradeEmailTradingService(this.env, this.getOrm(), userLogin);
    return emailService.sendOutboundEmail(
      recipient,
      `Research report: ${title}`,
      "<p>Your requested research workbook is attached.</p><p>Research only; no trades were placed.</p>",
      "Your requested research workbook is attached.\nResearch only; no trades were placed.",
      {
        fileName,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        contentBase64: attachmentBase64,
      }
    );
  }

  /** Shared send leg for POST /trading/reports/webhook (immediate + confirmed paths). */
  private async sendReportWebhook(
    title: string,
    query: string,
    sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>,
    userLogin: string
  ): Promise<{ success: boolean; status?: number; error?: string; notConfigured?: boolean }> {
    const reportData = JSON.stringify({ title: title || "Research report", query: query || "", sheets });
    if (reportData.length > 512_000) {
      return { success: false, error: "The recommendation report exceeds the 512 KB webhook limit." };
    }
    if (!this.env.OUTBOUND_WEBHOOK_URL || !this.env.OUTBOUND_WEBHOOK_SECRET) {
      return {
        success: false,
        notConfigured: true,
        error: "Configure OUTBOUND_WEBHOOK_URL and OUTBOUND_WEBHOOK_SECRET to publish recommendations.",
      };
    }
    const webhook = new ETradeWebhookService(this.getOrm(), this.env, userLogin);
    return webhook.dispatchOutboundWebhook("research.recommendations", JSON.parse(reportData));
  }

  /** Counts a broker submission against today's autonomous order budget. */
  private incrementAutopilotOrdersToday(): void {
    const state = this.getAutopilotState();
    this.writeAutopilotState({ ordersToday: state.ordersToday + 1, ordersDate: state.ordersDate });
  }

  /** Best-effort broker balance snapshot; null when unavailable. */
  private async fetchBrokerBalanceSnapshot(userLogin: string, requestedEnv: unknown): Promise<unknown | null> {
    try {
      const valid = await getValidTokens(this.env, userLogin, requestedEnv as any);
      if (!valid) return null;
      const client = new ETradeRestClient(this.env, userLogin, requestedEnv as any);
      const accounts = await client.fetchAccounts();
      const key = accounts?.[0]?.accountKey || accounts?.[0]?.accountId;
      if (!key) return null;
      return await client.fetchBalance(key);
    } catch (err) {
      console.warn("[OrchestratorAgent] Autopilot: balance snapshot unavailable:", err);
      return null;
    }
  }

  /**
   * Net open exposure for a symbol from the executed trade ledger. A canonical
   * live-book feed is a follow-up; until then this is the book view available
   * server-side, and a null result makes the envelope fail closed.
   */
  private openNotionalForSymbol(symbol: string): number | null {
    try {
      const trades = this.getOrm().trades?.findMany({}) as Array<Record<string, any>> | undefined;
      if (!trades) return null;
      const target = symbol.toUpperCase();
      let net = 0;
      for (const t of trades) {
        if (String(t.symbol || "").toUpperCase() !== target) continue;
        if (String(t.status || "") !== "executed") continue;
        const qty = Number(t.quantity) || 0;
        const price = Number(t.price) || 0;
        net += String(t.action || "").toUpperCase().startsWith("SELL") ? -qty * price : qty * price;
      }
      return Math.max(0, net);
    } catch {
      return null;
    }
  }

  /**
   * Evaluates the envelope, signs the verdict server-side, and records it.
   * Used by the preview gate, the execute gate, and the dry-run endpoint.
   */
  private async evaluateAndRecordAutopilotVerdict(params: {
    userLogin: string;
    requestedEnv: unknown;
    sessionId: string;
    intent: OrderIntent;
    draftId?: string | null;
    dryRun?: boolean;
  }): Promise<{ verdict: PolicyVerdict; attestation: PolicyVerdictAttestation }> {
    const state = this.getAutopilotState();
    const balance = await this.fetchBrokerBalanceSnapshot(params.userLogin, params.requestedEnv);
    const accountState: AutopilotAccountState = buildAccountStateFromBalance(balance, {
      ordersToday: state.ordersToday,
      peakEquity: state.peakEquity,
      asOf: new Date().toISOString(),
    });
    // Overlay the per-symbol exposure a balance payload cannot express.
    accountState.positionNotionalForSymbol = this.openNotionalForSymbol(params.intent.symbol);

    const verdict = evaluatePolicy({
      intent: params.intent,
      limits: state.limits,
      flags: { running: state.running, killSwitch: state.killSwitch, killSwitchReason: state.killSwitchReason },
      state: accountState,
      dryRun: params.dryRun,
    });

    const attestation = await attestVerdict(verdict, {
      signingKey: this.env.SESSION_SECRET,
      authorizerDid: state.running ? AGENT_DIDS.ORCHESTRATOR : "did:user:pending-human-authorization",
    });

    // Track peak equity so drawdown can be computed on later evaluations.
    if (accountState.equity !== null && (state.peakEquity === null || accountState.equity > state.peakEquity)) {
      this.writeAutopilotState({ peakEquity: accountState.equity });
    }

    try {
      const sql = this.ensureTables();
      sql.exec(
        "INSERT INTO mas_policy_verdicts (id, session_id, symbol, action, quantity, notional, mode, dry_run, passed, execution_allowed, requires_approval, binding_rule, detail, limits_json, projections_json, findings_json, signature, signing_key_id, proposer_did, authorizer_did, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        verdict.verdictId,
        params.sessionId,
        verdict.intents.symbol,
        verdict.intents.action,
        verdict.intents.quantity,
        verdict.intents.notional,
        verdict.mode,
        verdict.dryRun ? 1 : 0,
        verdict.passed ? 1 : 0,
        verdict.executionAllowed ? 1 : 0,
        verdict.requiresApproval ? 1 : 0,
        verdict.bindingRule,
        verdict.detail,
        JSON.stringify(verdict.limits),
        JSON.stringify(verdict.projections),
        JSON.stringify(verdict.findings),
        attestation.signature,
        attestation.keyId,
        attestation.proposerDid,
        attestation.authorizerDid,
        verdict.evaluatedAt
      );
    } catch (err) {
      console.warn("[OrchestratorAgent] Autopilot: failed to persist verdict:", err);
    }

    // Ledger event the control center already knows how to render.
    this.audit("autopilot.policy_verdict", "trading", {
      verdictId: verdict.verdictId,
      draftId: params.draftId ?? null,
      symbol: verdict.intents.symbol,
      summary: `${verdict.intents.action} ${verdict.intents.quantity} ${verdict.intents.symbol}${
        verdict.dryRun ? " (dry run)" : ""
      }`,
      policyCheckRule: describeVerdict(verdict),
      policyCheckPassed: verdict.passed,
      status: !verdict.passed || !verdict.executionAllowed
        ? "blocked"
        : verdict.requiresApproval
        ? "routed_to_approval"
        : "verified",
      bindingRule: verdict.bindingRule,
      dryRun: Boolean(verdict.dryRun),
      mode: verdict.mode,
      proposerDid: attestation.proposerDid,
      authorizerDid: attestation.authorizerDid,
      proofSignature: attestation.signature,
      projections: verdict.projections,
    });

    return { verdict, attestation };
  }

  private recordMessage(role: "user" | "assistant" | "system", content: string, agent: AgentName | "orchestrator") {
    try {
      const sql = this.ensureTables();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      sql.exec(
        "INSERT INTO mas_messages (id, session_id, role, content, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        this.sessionKey(),
        role,
        content.slice(0, 30000),
        agent,
        now
      );
    } catch {
      // Don't fail execution if record insertion fails
    }
  }

  private extractMessageText(message: unknown): string {
    if (!message || typeof message !== "object") return "";
    const m = message as { content?: unknown; text?: unknown; parts?: Array<{ type?: string; text?: string }> };

    if (typeof m.content === "string" && m.content.trim()) {
      return m.content.trim();
    }

    if (Array.isArray(m.parts) && m.parts.length > 0) {
      const extracted = m.parts
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("")
        .trim();
      if (extracted) return extracted;
    }

    if (typeof m.text === "string" && m.text.trim()) {
      return m.text.trim();
    }

    return "";
  }

  /**
   * Issue #686 (Think migration step 4 — CUTOVER): the turn stash.
   * runAgenticChatTurn (the HTTP driver) fills it before driving
   * runTurn; beforeTurn creates it for turns Think itself drives
   * (WebSocket chat, saveMessages admissions). onChatResponse
   * consumes it. One in-flight chat turn per DO instance is the live
   * semantic — the AIChatAgent base serialized turns the same way.
   */
  private pendingTurn?: {
    userText: string;
    userLogin: string;
    sourceTab?: string;
    isAutoOptionsResearchRequest: boolean;
    recentTurns: Array<{ role?: string; content: string }>;
    /** HTTP re-send of the history tail: the user mas_messages
     * record already exists, so beforeTurn must not write it again. */
    suppressUserRecord?: boolean;
    route?: RouteDecision;
    requestId: string;
  };

  /** Think configuration: the constructed model arm (step-2 decision). */
  getModel() {
    return getWorkersAIModel(this.env);
  }

  /**
   * Think configuration: the fallback system prompt for turns that
   * reach inference without beforeTurn instructions — the shared
   * builder with a neutral route, mirroring the live prompt's shape.
   */
  getSystemPrompt(): string {
    return buildOrchestratorSystemPrompt({
      route: { agent: "orchestrator", confidence: 1, reason: "Direct chat turn" },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
    });
  }

  /** Think configuration: the live per-turn tool factory (#312 single owner). */
  getTools(): ToolSet {
    return this.createTurnTools(crypto.randomUUID());
  }

  /**
   * The per-turn McpToolContext construction the AIChatAgent-era
   * runAgenticChatTurn performed inline (Facade + async-job ports +
   * audit), now shared by getTools for every Think-driven turn.
   */
  private createTurnTools(requestId: string): ToolSet {
    const orm = this.getOrm();
    const sessionId = this.sessionKey();
    const facade = new McpSystemFacade(this.env, orm, sessionId);
    return createAgentMcpTools({
      env: this.env,
      orm,
      sessionId,
      requestId,
      facade,
      submitJob: (job) => this.submitAsyncJob(job),
      getJob: (jobId) => this.getAsyncJob(jobId),
      listJobs: () => this.listAsyncJobs().map(({ result: _result, ...job }) => job),
      audit: (type: string, agent: any, payload: Record<string, unknown>) =>
        this.audit(type, agent, payload),
    });
  }

  /**
   * Think configuration: the session-memory context block (top-8
   * mas_memory facts), refreshed by Think before every turn — the
   * configureContext form of the grounding the live prompt inlined.
   */
  configureContext() {
    return [
      {
        label: "session-memory",
        description: "Persistent session facts recorded by earlier turns (mas_memory).",
        resolve: async () => {
          this.ensureTables();
          const rows = Array.from(
            this.ctx.storage.sql.exec(
              "SELECT key, value FROM mas_memory ORDER BY updated_at DESC LIMIT 8"
            )
          ) as Array<{ key: string; value: string }>;
          if (rows.length === 0) return null;
          return rows.map((m) => `- ${m.key}: "${m.value}"`).join("\n");
        },
      },
    ];
  }

  /**
   * Issue #686: derive the turn inputs for a turn Think drives
   * itself (the WebSocket chat protocol, saveMessages admissions) —
   * the recovery the AIChatAgent-era onChatMessage performed from
   * its in-memory message array: the user text from the submitted
   * session message,
   * sourceTab / userLogin from the client-stamped message metadata
   * (falling back to Think's persisted turn metadata), and recent
   * history from the turn's model messages.
   */
  private async deriveTurn(ctx: TurnContext): Promise<{
    userText: string;
    userLogin: string;
    sourceTab?: string;
    isAutoOptionsResearchRequest: boolean;
    recentTurns: Array<{ role?: string; content: string }>;
  }> {
    const sessionId = this.sessionKey();
    const uiMessages = await this.getMessages();
    const lastUser = [...uiMessages].reverse().find((m: any) => m?.role === "user");
    const userText = this.extractMessageText(lastUser);
    const metadata = ((lastUser as any)?.metadata ?? this.activeTurnMetadata ?? {}) as {
      sourceTab?: string;
      userLogin?: string;
    };
    const recentTurns = (ctx.messages ?? []).slice(-6).map((m: any) => ({
      role: m?.role as string | undefined,
      content:
        typeof m?.content === "string"
          ? m.content
          : Array.isArray(m?.content)
            ? m.content
                .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
                .map((p: any) => p.text)
                .join("")
            : "",
    }));
    return {
      userText,
      userLogin: metadata.userLogin || sessionId,
      sourceTab: metadata.sourceTab,
      isAutoOptionsResearchRequest: metadata.sourceTab === "E*TRADE · Auto Options Research",
      recentTurns,
    };
  }

  /** Grounding for the turn prompt: session facts + best-effort vector recall. */
  private async assembleGrounding(userText: string): Promise<{ memoryContext: string; vectorContext: string }> {
    const sql = this.ensureTables();
    const activeMemories = Array.from(
      sql.exec("SELECT key, value FROM mas_memory ORDER BY updated_at DESC LIMIT 8")
    ) as Array<{ key: string; value: string }>;
    const memoryContext = activeMemories.length > 0
      ? `\nActive Persistent Memory (SQLite Session Facts):\n` + activeMemories.map((m) => `- ${m.key}: "${m.value}"`).join("\n")
      : "";
    let vectorContext = "";
    const vectorizeBinding = (this.env as any).VECTOR_MEMORY;
    if (userText && userText.trim().length > 0 && this.env.AI && vectorizeBinding) {
      try {
        const vm = new VectorMemory(this.env.AI, vectorizeBinding, undefined);
        const chunks = await vm.recallForPlan(userText);
        if (chunks.length > 0) {
          vectorContext = `\nRelevant past outcomes (vector memory, most similar first):\n${VectorMemory.brief(chunks)}`;
        }
      } catch (err) {
        console.warn("[VectorMemory] recall failed:", err instanceof Error ? err.message : String(err));
      }
    }
    return { memoryContext, vectorContext };
  }

  /**
   * Issue #686: Think lifecycle — runs before every chat turn,
   * whatever entry point drove it. Carries the duties the
   * AIChatAgent-era onChatMessage + runAgenticChatTurn split between
   * them: Judge routing (+ route.decided audit), the session-hygiene
   * purge of empty assistant messages, the user mas_messages record
   * (single writer for both entry points; suppressed only for an
   * HTTP re-send whose record already exists), the auto-research
   * NLQ pre-dispatch, grounding, and the per-turn TurnConfig (shared
   * prompt builder; tools suppressed on auto-research turns via
   * activeTools: [] — TurnConfig.tools is additive-only).
   */
  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    this.ensureTables();
    const turn: NonNullable<typeof this.pendingTurn> = this.pendingTurn ?? {
      ...(await this.deriveTurn(ctx)),
      requestId: crypto.randomUUID(),
    };
    this.pendingTurn = turn;
    const { userText, userLogin, isAutoOptionsResearchRequest, sourceTab } = turn;

    // Session hygiene: delete empty assistant messages left behind
    // by interrupted turns (the messages the live turn used to
    // filter out of its model input); activity entries are kept.
    try {
      const uiMessages = await this.getMessages();
      const staleIds = uiMessages
        .filter((m: any) => {
          if (!m || m.role !== "assistant" || m.metadata?.activity) return false;
          const parts = Array.isArray(m.parts) ? m.parts : [];
          const hasText = parts.some((p: any) => p && p.type === "text" && typeof p.text === "string" && p.text.trim());
          const hasTool = parts.some((p: any) => p && p.type !== "text");
          return !hasText && !hasTool;
        })
        .map((m: any) => m.id as string);
      if (staleIds.length > 0) await this.session.deleteMessages(staleIds);
    } catch {
      // Best-effort hygiene; never break the turn.
    }

    const judge = new LLMJudge(this.env);
    const route = isAutoOptionsResearchRequest
      ? {
        agent: "trading" as const,
        confidence: 1,
        reason: "Source-tagged Auto Options Research request; executing its options NLQ workflow directly",
        needsConfirmation: false,
      }
      : await judge.route(userText, turn.recentTurns);
    turn.route = route;
    this.audit("route.decided", "judge", {
      route: route.agent,
      confidence: route.confidence,
      reason: route.reason,
      needsConfirmation: route.needsConfirmation,
    });

    if (userText && !turn.suppressUserRecord) {
      this.recordMessage("user", userText, "orchestrator");
    }

    let optionsResearchContext = "";
    if (isAutoOptionsResearchRequest) {
      try {
        const job = await this.submitAsyncJob({
          capability: "nlq.execute",
          payload: { query: userText, userLogin },
        });
        optionsResearchContext = [
          "AUTO_OPTIONS_RESEARCH_JOB_SUBMITTED:",
          JSON.stringify({
            query: userText,
            ...job,
          }),
        ].join("\n");
        this.audit("options_research.chat_query_executed", "nlq", {
          query: userText,
          sourceTab: sourceTab,
          jobId: job.jobId,
          status: job.status,
        });
      } catch (error) {
        optionsResearchContext = [
          "AUTO_OPTIONS_RESEARCH_EXECUTION_ERROR:",
          error instanceof Error ? error.message : "The Auto Options Research workflow failed.",
        ].join("\n");
        this.audit("options_research.chat_query_failed", "nlq", {
          query: userText,
          sourceTab: sourceTab,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const { memoryContext, vectorContext } = await this.assembleGrounding(userText);
    return {
      instructions: buildOrchestratorSystemPrompt({
        route,
        memoryContext,
        vectorContext,
        optionsResearchContext,
        isAutoOptionsResearchRequest,
      }),
      maxSteps: this.maxSteps,
      ...(isAutoOptionsResearchRequest ? { activeTools: [] as string[] } : {}),
    };
  }

  /**
   * Issue #686: Think lifecycle — fires after a chat turn completes
   * (any entry point) once the assistant message is persisted.
   * Applies the live streamText onFinish side-effects: the assistant
   * mas_messages record (route.agent attribution), judge.evaluate →
   * response.evaluated audit, and best-effort VectorMemory remember.
   * Consumes the turn stash.
   */
  async onChatResponse(result: ChatResponseResult): Promise<void> {
    const turn = this.pendingTurn;
    this.pendingTurn = undefined;
    if (!turn || result.status === "error" || !result.message) return;
    const text = this.extractMessageText(result.message);
    if (!text || !turn.route) return;
    const route = turn.route;
    this.recordMessage("assistant", text, route.agent);
    const judge = new LLMJudge(this.env);
    const quality = await judge.evaluate({ question: turn.userText, answer: text, agent: route.agent });
    this.audit("response.evaluated", "judge", {
      score: quality.score,
      grounded: quality.grounded,
      safe: quality.safe,
      issues: quality.issues,
    });
    const vectorizeBinding = (this.env as any).VECTOR_MEMORY;
    try {
      if (this.env.AI && vectorizeBinding) {
        const vm = new VectorMemory(this.env.AI, vectorizeBinding, undefined);
        await vm.remember({
          jobId: turn.requestId,
          operation: `chat:${route.agent}`,
          summary: `Q: ${turn.userText.slice(0, 300)}\nA: ${text.slice(0, 500)}`,
          success: quality.safe !== false && quality.grounded !== false,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn("[VectorMemory] remember failed:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Issue #686: Think lifecycle — a chat turn that fails terminally
   * surfaces the aspect format the AIChatAgent-era UI stream's
   * onError produced ([code] title: message + remediation steps),
   * after logging the same aspect event that handler recorded.
   */
  onChatError(error: unknown): string {
    const aspect = resolveErrorAspect(error);
    logAspectEvent({
      aspect: "ChatStream",
      operationName: "uiStreamError",
      code: aspect.code,
      level: "error",
      error: aspect.message,
      audit: (e, _c, p) => this.audit(e, "orchestrator", p),
    });
    return `[${aspect.code}] ${aspect.title}: ${aspect.message}\n\nRemediation:\n${aspect.resolutionSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
  }

  /**
   * Issue #312: the single-owner agentic chat turn. Judge routing, sub-agent
   * tools, memory/vector grounding, and the model call live here and only here.
   * The WebSocket chat streams the result (Think's native chat, driven by the
   * same beforeTurn/onChatResponse lifecycle); POST /api/chat awaits the final
   * text via this driver. Never duplicate this pipeline.
   * Issue #686: the driver runs the turn through Think (runTurn, wait
   * mode) and returns the adapter shape the routes expect, {result,
   * route}. The user message enters the session through the factory
   * input (delta-by-id), so an HTTP re-send of the history tail does
   * not duplicate it.
   */
  private async runAgenticChatTurn(opts: {
    userText: string;
    recentTurns: Array<{ role?: string; content: string }>;
    userLogin: string;
    isAutoOptionsResearchRequest: boolean;
    /** WS chat only: the originating UI tab, for options-research audit context. */
    sourceTab?: string;
  }) {
    const turn: NonNullable<typeof this.pendingTurn> = {
      ...opts,
      requestId: crypto.randomUUID(),
    };
    this.pendingTurn = turn;
    try {
      const existing = await this.getMessages();
      const tailUser = [...existing].reverse().find((m: any) => m?.role === "user");
      const isResend = !!tailUser && this.extractMessageText(tailUser) === opts.userText;
      if (isResend) turn.suppressUserRecord = true;
      const result = await this.runTurn({
        input: (current: any[]) =>
          isResend
            ? current
            : [
                ...current,
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts: [{ type: "text", text: opts.userText }],
                } as any,
              ],
      });
      const text = result?.message ? this.extractMessageText(result.message) : "";
      const route = turn.route ?? {
        agent: "search",
        confidence: 0,
        reason: "Turn completed without a recorded route decision.",
        needsConfirmation: false,
      };
      return { result: { text }, route };
    } finally {
      if (this.pendingTurn === turn) this.pendingTurn = undefined;
    }
  }

  /** Issue #669: the this-bound context for the shared fallback
   * (src/agents/chatErrorFallback.ts), so the Think shadow builds the
   * identical degraded answer from the same implementation.
   * Issue #686: the shadow is gone; the context now serves the
   * production class alone. */
  private chatErrorFallbackContext(): ChatErrorFallbackContext {
    return {
      env: this.env,
      orm: this.getOrm(),
      sessionId: this.sessionKey(),
      audit: (type, payload) => this.audit(type, "orchestrator", payload),
      scanRunStore: new SqlScanRunStore(this.ctx.storage.sql),
      profileStore: new SqlStrategyProfileStore(this.ctx.storage.sql),
      schedulingPort: this.nlqSchedulingPort(),
      stockScreenPort: this.nlqStockScreenPort(),
    };
  }

  /**
   * Issue #312: shared degraded-answer builder for chat turns. Runs the
   * deterministic NLQ fallback and returns the same diagnostic text the
   * WebSocket chat streams; POST /api/chat returns it as JSON instead.
   * Issue #669: the implementation lives in ./chatErrorFallback,
   * shared with the Think shadow; this method only binds the context.
   */
  private async buildChatErrorFallback(
    streamErr: unknown,
    userText: string,
    userLogin: string
  ): Promise<string> {
    return buildChatErrorFallback(this.chatErrorFallbackContext(), streamErr, userText, userLogin);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    this.ensureTables();

    // Scheduled callbacks have no request headers. Remember the authenticated
    // owner/environment on every authenticated app request, not only the
    // schedules panel, so all existing cron records gain the right context.
    const userLogin = request.headers.get("x-user-login") || "";
    const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
    const storage = this.ctx?.storage;
    if (/^[A-Za-z0-9._-]{1,80}$/.test(userLogin) && storage && typeof storage.put === "function") {
      const previous = await this.getScreenerExecutionContext();
      const context: ScreenerExecutionContext = {
        userLogin,
        environment: rawEnvironment === "TEST" || rawEnvironment === "PROD"
          ? rawEnvironment
          : previous?.environment,
      };
      await storage.put(SCREENER_EXECUTION_CONTEXT_KEY, context);
      try {
        await this.migrateLegacyScreenSchedules(context);
      } catch (scheduleError) {
        // Authentication-context persistence must not make unrelated API
        // routes fail if Durable Object schedule registration is unavailable.
        console.warn("[OrchestratorAgent] Could not reconcile authenticated baseline schedules:", scheduleError);
      }
    }

    if (/(?:^|\/api)\/jobs$/.test(path) && request.method === "GET") {
      const jobs = this.listAsyncJobs(Number(url.searchParams.get("limit")) || 50).map((job) => {
        const { result: _result, ...summary } = job;
        return summary;
      });
      return Response.json({ jobs });
    }

    const jobMatch = path.match(/(?:^|\/api)\/jobs\/([0-9a-f-]{36})$/i);
    if (jobMatch && request.method === "GET") {
      const job = this.getAsyncJob(jobMatch[1]);
      return job
        ? Response.json(job)
        : Response.json({ error: "Async job not found." }, { status: 404 });
    }

    if (/(?:^|\/api)\/chat-activity$/.test(path) && request.method === "POST") {
      return this.logChatActivity(request);
    }

    // The Worker strips the /api prefix when forwarding and marks queue-eligible requests.
    const isMcpEndpoint = /\/mcp(?:\/|$)/i.test(path);
    const isScheduleEndpoint = /(?:^|\/)(?:api\/)?schedules(?:\/|$)/i.test(path);
    const isImmediateEndpoint = /(?:^|\/)(?:api\/)?(?:clear|reset|memory|audit|chat|chat-activity|screener\/report\.pdf|etrade\/screen|etrade\/options\/profiles|etrade\/options\/scans|etrade\/options\/strategy)(?:\/|$)/i.test(path);
    const isApiRequest = path.startsWith("/api/") || request.headers.get("x-async-eligible") === "1";
    if (isApiRequest && !/(?:^|\/api)\/jobs(?:\/|$)/.test(path) && !isMcpEndpoint && !isScheduleEndpoint && !isImmediateEndpoint) {
      return this.enqueueHttpRequest(request, url);
    }

    return this.routeRequest(request);
  }

  /**
   * Records a request handled by another agent/tab in the shared chat transcript
   * without invoking the chat model. Entries with the same id are updated in place.
   */
  private async logChatActivity(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { id?: unknown; source?: unknown; text?: unknown } | null;
    const id = typeof body?.id === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(body.id) ? body.id : crypto.randomUUID();
    const source = typeof body?.source === "string" ? body.source.slice(0, 80) : "";
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
    if (!source || !text) {
      return Response.json({ error: "source and text are required." }, { status: 400 });
    }

    const entry = {
      id: `activity_${id}`,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text }],
      metadata: { sourceTab: source, activity: true },
    };
    // Issue #686: Think session upsert by id — an existing activity
    // entry is replaced, a new one appended (the semantics the
    // AIChatAgent-era findIndex/persistMessages pair encoded).
    await this.addMessages([entry] as any);
    this.recordMessage("system", `[${source}] ${text}`, "orchestrator");
    return Response.json({ id });
  }

  private async enqueueHttpRequest(request: Request, url: URL): Promise<Response> {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 8_000_000) {
      return Response.json({ error: "Async API request exceeds the 8 MB request limit." }, { status: 413 });
    }

    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    if (new TextEncoder().encode(body).length > 8_000_000) {
      return Response.json({ error: "Async API request exceeds the 8 MB request limit." }, { status: 413 });
    }

    const headers: Record<string, string> = {};
    for (const name of ["content-type", "accept", "x-environment"]) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    const userLogin = request.headers.get("x-user-login");
    headers["x-user-login"] = userLogin && /^[A-Za-z0-9._-]{1,80}$/.test(userLogin)
      ? userLogin
      : this.sessionKey();
    try {
      const job = await this.submitAsyncJob({
        capability: "http.request",
        payload: {
          pathAndQuery: `${url.pathname}${url.search}`,
          method: request.method,
          headers,
          body,
        },
      });
      return Response.json(job, {
        status: 202,
        headers: { "Location": job.statusUrl, "Retry-After": "1" },
      });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : "Could not queue API request.",
      }, { status: 503 });
    }
  }

  private async routeRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const sql = this.ensureTables();
    const sessionId = this.sessionKey();

    // Issue #359-01: reports + HITL routes are handled by
    // src/agents/routes/reports.ts. Invoked at this exact position in the
    // sequential path.endsWith matching sequence; a non-null return matched.
    const reportsResponse = await handleReportsRoutes(request, url, path, sessionId, {
      ensureTables: () => this.ensureTables(),
      getReportDispatchHitl: () => this.getReportDispatchHitl(),
      setReportDispatchHitl: (enabled) => this.setReportDispatchHitl(enabled),
      getReportConfirmation: (id) => this.getReportConfirmation(id),
      decideReportConfirmation: (id, status, decidedBy) =>
        this.decideReportConfirmation(id, status, decidedBy),
      createReportConfirmation: (kind, payloadJson, reportId) =>
        this.createReportConfirmation(kind, payloadJson, reportId),
      confirmationDeliveryMeta: (row) => this.confirmationDeliveryMeta(row),
      deliverStoredReportEmail: (reportId, recipient, userLogin) =>
        this.deliverStoredReportEmail(reportId, recipient, userLogin),
      deliverStoredReportWebhook: (reportId, userLogin) =>
        this.deliverStoredReportWebhook(reportId, userLogin),
      sendReportEmail: (recipient, title, fileName, attachmentBase64, userLogin) =>
        this.sendReportEmail(recipient, title, fileName, attachmentBase64, userLogin),
      sendReportWebhook: (title, query, sheets, userLogin) =>
        this.sendReportWebhook(title, query, sheets, userLogin),
      storeResearchReportCanonicalAsync: (bodyJson, meta) =>
        this.storeResearchReportCanonicalAsync(bodyJson, meta),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      reportConfirmationTtlMs: () => OrchestratorAgent.REPORT_CONFIRMATION_TTL_MS,
    });
    if (reportsResponse) return reportsResponse;

    // Issue #359-02: MCP + chat + NLQ routes are handled by
    // src/agents/routes/mcpChatNlq.ts. Invoked at this exact position in the
    // sequential path.endsWith matching sequence; a non-null return matched.
    const mcpChatNlqResponse = await handleMcpChatNlqRoutes(request, url, path, sessionId, {
      getOrm: () => this.getOrm(),
      getStorageSql: () => this.ctx.storage.sql,
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      submitAsyncJob: (job) => this.submitAsyncJob(job),
      getAsyncJob: (jobId) => this.getAsyncJob(jobId),
      listAsyncJobs: () => this.listAsyncJobs().map(({ result: _result, ...job }) => job),
      extractMessageText: (message) => this.extractMessageText(message),
      getMessages: () => this.getMessages(),
      recordMessage: (role, content, agent) => this.recordMessage(role, content, agent),
      runAgenticChatTurn: (opts) => this.runAgenticChatTurn(opts),
      buildChatErrorFallback: (err, userText, userLogin) => this.buildChatErrorFallback(err, userText, userLogin),
      nlqSchedulingPort: () => this.nlqSchedulingPort(),
    });
    if (mcpChatNlqResponse) return mcpChatNlqResponse;

    // Issue #359-17: schema introspection routes (GET /schema/tables,
    // POST /schema/query) are handled by src/agents/routes/schema.ts.
    // Invoked at this exact position in the sequential path.endsWith
    // matching sequence (between the MCP/chat/NLQ handler and the
    // ads/revenue/referrals handler); a non-null return matched.
    const schemaResponse = await handleSchemaRoutes(request, url, path, sessionId, {
      getOrm: () => this.getOrm(),
    });
    if (schemaResponse) return schemaResponse;

    // Issue #359-03: ads / revenue / referrals (inventory group: categories,
    // revenue, external ads) are handled by
    // src/agents/routes/adsRevenueReferrals.ts. Invoked at this exact
    // position in the sequential path.endsWith matching sequence (between
    // /schema/query and /audit); a non-null return matched.
    const adsRevenueReferralsResponse = await handleAdsRevenueReferralsRoutes(request, url, path, sessionId, {
      getOrm: () => this.getOrm(),
      ensureTables: () => this.ensureTables(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (adsRevenueReferralsResponse) return adsRevenueReferralsResponse;

    // Issue #359-04: audit routes (GET/POST /audit, POST /audit/event) are
    // handled by src/agents/routes/audit.ts. Invoked at this exact position
    // in the sequential path.endsWith matching sequence (between the
    // ads/revenue/referrals handler and the autopilot block); a non-null
    // return matched.
    const auditResponse = await handleAuditRoutes(request, url, path, sessionId, {
      ensureTables: () => this.ensureTables(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      recordAudit: (type, agent, payload) => this.recordAudit(type, agent, payload),
    });
    if (auditResponse) return auditResponse;

    // Issue #359-05: autopilot control center routes (GET /autopilot,
    // POST /autopilot/state, POST /autopilot/kill-switch,
    // POST|PUT /autopilot/limits, POST /autopilot/evaluate) are handled
    // by src/agents/routes/autopilot.ts. Invoked at this exact position
    // in the sequential matching sequence (between the audit handler and
    // the Persistent Memory endpoint); a non-null return matched.
    const autopilotResponse = await handleAutopilotRoutes(request, url, path, sessionId, {
      ensureTables: () => this.ensureTables(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      getAutopilotState: () => this.getAutopilotState(),
      writeAutopilotState: (patch) => this.writeAutopilotState(patch),
      evaluateAndRecordAutopilotVerdict: (params) => this.evaluateAndRecordAutopilotVerdict(params),
    });
    if (autopilotResponse) return autopilotResponse;

    // Issue #359-06: memory + reset routes (GET/DELETE /memory,
    // POST|DELETE|GET /clear|/reset) are handled by
    // src/agents/routes/memoryReset.ts. Invoked at this exact position
    // in the sequential path.endsWith matching sequence (between the
    // autopilot handler and the referrals+ads handler); a non-null
    // return matched.
    const memoryResetResponse = await handleMemoryResetRoutes(request, url, path, sessionId, {
      ensureTables: () => this.ensureTables(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      abortAllRequests: (_reason) => this.abortAllRequests(),
      resetTurnState: () => this.resetTurnState(),
      clearConversationMessages: async () => {
        await this.clearMessages();
      },
    });
    if (memoryResetResponse) return memoryResetResponse;

    // Issue #359-03: referrals + sponsored ads (community group) are
    // handled by src/agents/routes/adsRevenueReferrals.ts. Invoked at this
    // exact position in the sequential path.endsWith matching sequence
    // (between /memory and the payments block); a non-null return matched.
    const referralsAdsResponse = await handleReferralsAdsRoutes(request, url, path, sessionId, {
      getOrm: () => this.getOrm(),
      ensureTables: () => this.ensureTables(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (referralsAdsResponse) return referralsAdsResponse;

    // Issue #359-07: payments routes (Multi-Gateway Payments & DID
    // Management API) are handled by src/agents/routes/payments.ts.
    // Invoked at this exact position in the sequential path.endsWith
    // matching sequence (between the referrals+ads handler and the
    // Cloudflare Agentic Payments block); a non-null return matched.
    const paymentsResponse = await handlePaymentsRoutes(request, url, path, sessionId, {
      env: this.env,
      ensureTables: () => this.ensureTables(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (paymentsResponse) return paymentsResponse;

    // Issue #359-17: Cloudflare Agentic Payments routes (x402 & MPP:
    // GET /payments/agentic/wallet, GET|POST
    // /payments/agentic/auto-approve-limit) are handled by
    // src/agents/routes/agenticPayments.ts. Invoked at this exact
    // position in the sequential path.endsWith matching sequence
    // (between the payments handler and the premium handler);
    // a non-null return matched.
    const agenticPaymentsResponse = await handleAgenticPaymentsRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (agenticPaymentsResponse) return agenticPaymentsResponse;

    // Issue #359-08: premium paid-trading routes (Paid Trading Service:
    // Institutional Options Screener, Equity Research, Anomaly Signals)
    // are handled by src/agents/routes/premium.ts. Invoked at this exact
    // position in the sequential matching sequence (between the Cloudflare
    // Agentic Payments block and the Environment & E*TRADE Trading APIs
    // block); a non-null return matched.
    const premiumResponse = await handlePremiumRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
    });
    if (premiumResponse) return premiumResponse;

    // Issue #359-09: E*TRADE broker routes (Environment & E*TRADE Trading
    // APIs block) are handled by src/agents/routes/etradeBroker.ts
    // (handleEtradeBrokerRoutes). Invoked at this exact position in the
    // sequential matching sequence (after the premium delegation);
    // a non-null return matched.
    const etradeBrokerResponse = await handleEtradeBrokerRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      getScreenerAgent: (userLogin) => this.getScreenerAgent(userLogin || "default_trader"),
      persistScreenerReportCanonical: (result) => this.persistScreenerReportCanonical(result),
      evaluateAndRecordAutopilotVerdict: (params) => this.evaluateAndRecordAutopilotVerdict(params),
      getAutopilotState: () => this.getAutopilotState(),
      incrementAutopilotOrdersToday: () => this.incrementAutopilotOrdersToday(),
      schedule: (when, callback, payload) => this.schedule(when, callback as keyof this, payload),
      cancelSchedule: (id) => this.cancelSchedule(id),
    });
    if (etradeBrokerResponse) return etradeBrokerResponse;

    // The requestedEnv binding stays inline in the dispatcher: it is
    // computed once here and passed through the context to the E*TRADE
    // options and watchlists delegations below. The broker handlers
    // recompute their own copy inside the module.
    const rawEnvHeader = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
    const requestedEnv: "TEST" | "PROD" | undefined = (rawEnvHeader === "TEST" || rawEnvHeader === "PROD") ? rawEnvHeader : undefined;

    // Issue #359-10: omnichannel trading channel routes (email / slack /
    // browser / voice trading integrations) are handled by
    // src/agents/routes/tradingIntegrations.ts
    // (handleTradingIntegrationsRoutes). Invoked at this exact position in
    // the sequential path.endsWith matching sequence (after the E*TRADE
    // broker routes block, before the broker activity delegation); a
    // non-null return matched.
    const tradingIntegrationsResponse = await handleTradingIntegrationsRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      agentCtx: this.ctx,
      nlqSchedulingPort: () => this.nlqSchedulingPort(),
    });
    if (tradingIntegrationsResponse) return tradingIntegrationsResponse;

    // Issue #359-09: E*TRADE broker account-activity routes (transactions,
    // alerts, product lookup) are handled by
    // src/agents/routes/etradeBroker.ts (handleEtradeBrokerActivityRoutes).
    // Invoked at this exact position in the sequential matching sequence
    // (after the trading channels block, before the options block);
    // a non-null return matched.
    const etradeBrokerActivityResponse = await handleEtradeBrokerActivityRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      getScreenerAgent: (userLogin) => this.getScreenerAgent(userLogin || "default_trader"),
      persistScreenerReportCanonical: (result) => this.persistScreenerReportCanonical(result),
      evaluateAndRecordAutopilotVerdict: (params) => this.evaluateAndRecordAutopilotVerdict(params),
      getAutopilotState: () => this.getAutopilotState(),
      incrementAutopilotOrdersToday: () => this.incrementAutopilotOrdersToday(),
      schedule: (when, callback, payload) => this.schedule(when, callback as keyof this, payload),
      cancelSchedule: (id) => this.cancelSchedule(id),
    });
    if (etradeBrokerActivityResponse) return etradeBrokerActivityResponse;

    // Issue #359-11: E*TRADE options routes (chains / expire-dates / scans /
    // iv-history / profiles / strategy) and the trading/options routes
    // (llm-ideas / compare / recommend / catalog / strategies / screen /
    // unified / config) are handled by src/agents/routes/etradeOptions.ts
    // (handleEtradeOptionsRoutes). Invoked at this exact position in the
    // sequential path.endsWith matching sequence (after the E*TRADE broker
    // account-activity delegation, before the watchlists block); a non-null
    // return matched. The requestedEnv binding stays inline in the
    // dispatcher (shared with the watchlists delegation below) and is
    // passed through the context.
    const etradeOptionsResponse = await handleEtradeOptionsRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
      agentCtx: this.ctx,
      ensureTables: () => this.ensureTables(),
      requestedEnv,
      getScreenerAgent: (userLogin) => this.getScreenerAgent(userLogin || "default_trader"),
    });
    if (etradeOptionsResponse) return etradeOptionsResponse;

    // Issue #359-12: E*TRADE watchlists routes (list / details / create /
    // save-screen / delete) are handled by src/agents/routes/watchlists.ts
    // (handleWatchlistsRoutes). Invoked at this exact position in the
    // sequential path.endsWith matching sequence (after the E*TRADE options
    // delegation, before the Alpaca block); a non-null return matched. The
    // requestedEnv binding stays inline and is passed through the context.
    const watchlistsResponse = await handleWatchlistsRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
      requestedEnv,
    });
    if (watchlistsResponse) return watchlistsResponse;

    const alpacaTradingResponse = await handleAlpacaTradingRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (alpacaTradingResponse) return alpacaTradingResponse;

    // ==========================================
    // FOSS Market Research & Quoting APIs (yfinance & Alpaca)
    // ==========================================

    const fossResearchResponse = await handleFossQuoteResearchRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (fossResearchResponse) return fossResearchResponse;

    const alpacaFossResponse = await handleAlpacaFossRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (alpacaFossResponse) return alpacaFossResponse;

    const fossScreeningResponse = await handleFossCompareScreenRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (fossScreeningResponse) return fossScreeningResponse;

    // ==========================================
    // Cloudflare Agents Task Scheduling Management APIs
    // ==========================================

    // Issue #359-15: screener + autonomous research routes (stock screener
    // /screener/*, options PDF, and /research/*) are handled by
    // src/agents/routes/screenerResearch.ts (handleScreenerResearchRoutes).
    // Invoked at this exact position in the sequential path.endsWith
    // matching sequence (after the FOSS compare/screen delegation, before
    // the task schedules block); a non-null return matched. Orchestrator-
    // owned helpers (getScreenerAgent, getResearchAgent, runResearchAndPublish,
    // mas_settings) arrive via the context object.
    const screenerResearchResponse = await handleScreenerResearchRoutes(request, url, path, sessionId, {
      getScreenerAgent: (userLogin?: string) => this.getScreenerAgent(userLogin),
      getScreenerExecutionContext: () => this.getScreenerExecutionContext(),
      getResearchAgent: (userLogin?: string) => this.getResearchAgent(userLogin),
      runResearchAndPublish: (trigger, userLogin) => this.runResearchAndPublish(trigger, userLogin),
      getOrm: () => this.getOrm(),
      readSettingRaw: (key) => this.readSettingRaw(key),
      writeSetting: (key, value) => this.writeSetting(key, value),
    });
    if (screenerResearchResponse) return screenerResearchResponse;
    // Issue #359-16: schedules task-scheduling routes (list/create/cancel/
    // trigger-*) are handled by src/agents/routes/schedules.ts
    // (handleSchedulesRoutes). Invoked at this exact position in the
    // sequential path.endsWith matching sequence (after the screener +
    // research delegation, before the Not-found fallthrough); a non-null
    // return matched. Orchestrator-owned helpers (the SDK scheduling
    // port, audit, getOrm, autonomousMarketScreen/autoRenewETradeTokens,
    // getScreenerExecutionContext, the #111 callback allow-list constants)
    // arrive via the context object.
    const schedulesResponse = await handleSchedulesRoutes(request, url, path, sessionId, {
      env: this.env,
      agentCtx: this.ctx,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      listSchedules: (criteria) => this.listSchedules(criteria),
      cancelSchedule: (id) => this.cancelSchedule(id),
      getScheduleById: (id) => this.getScheduleById(id),
      schedule: (when, callback, payload, options) => this.schedule(when, callback as keyof this, payload, options),
      scheduleEvery: (intervalSeconds, callback, payload) => this.scheduleEvery(intervalSeconds, callback as keyof this, payload),
      getScreenerExecutionContext: () => this.getScreenerExecutionContext(),
      getOrm: () => this.getOrm(),
      autonomousMarketScreen: (payload) => this.autonomousMarketScreen(payload),
      autoRenewETradeTokens: (payload) => this.autoRenewETradeTokens(payload),
      creatableScheduleCallbacks: CREATABLE_SCHEDULE_CALLBACKS,
      accountScopedScheduleCallbacks: ACCOUNT_SCOPED_SCHEDULE_CALLBACKS,
      runScheduleCallback: async (callback: string, payload: unknown) => {
        const fn = (this as unknown as Record<string, unknown>)[callback];
        if (typeof fn !== "function") {
          throw new Error(`Schedule callback '${callback}' is not callable on the orchestrator.`);
        }
        await (fn as (p: unknown) => Promise<void>).call(this, payload);
      },
    });
    if (schedulesResponse) return schedulesResponse;

    return new Response("Not found", { status: 404 });
  }
}
