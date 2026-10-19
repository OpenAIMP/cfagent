import { AIChatAgent } from "@cloudflare/ai-chat";
import type { Schedule, ScheduleCriteria } from "agents";
import { convertToModelMessages, streamText, stepCountIs, createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { DEFAULT_AI_MODEL, getWorkersAIModel } from "./model";
import { LLMJudge } from "./judge";
import { VectorMemory } from "../memory/vector-memory";
import { planNLQ, executeNLQQuery, executeNLQQueryAsync, executeNaturalLanguageQuery, formatMarketCap, type NLQSchedulingPort } from "./nlq";
import { resolveErrorAspect, AgentErrorCode } from "../aspects/errorCodes";
import { logAspectEvent } from "../aspects/loggingAspect";
import { DatabaseORM } from "../orm";
import { PaymentGatewayService, normalizeGateway, isWebhookGateway, isSupportedGateway, SUPPORTED_GATEWAYS, type SupportedGateway } from "../services/payments";
import { ETradeService } from "../services/etrade";
import { resolveEnvironmentConfig } from "../config/environment";
import { getValidTokens } from "../security/etradeOAuth";
import { runStorageRetention } from "../security/storageRetention";
import { ETradeRestClient } from "../trading";
import { FossResearchService, fossBarsSourceLabel } from "../services/fossResearch";
import { computePortfolioRisk, aggregatePortfolioRisk, resolvePositionsSnapshot, evaluatePostTradeTotals, type CandidateGreekContribution } from "../services/portfolioRisk";
import { ETradeThinkHarness } from "../services/thinkHarness";
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
import { YFinanceMarketScreener } from "../trading";
import { DynamicOptionsScreener } from "../trading";
import type { ScreenerAgent, ScreenerRunRequest } from "./screener-agent";
import { recommendOptionStrategies, type StrategyRequest } from "../trading";
import {
  OptionsAgentPipeline,
  UnifiedOptionsService,
  validateStrategyRequest,
  type StrategyScreenFilter,
  type RiskProfile,
  type UnifiedOptionsRequest,
} from "../trading";
import { getEtapiConfig, setRuntimeEtapiConfigOverrides } from "../config/etapiConfig";
import { buildCalibratedOptionChains } from "../trading";
import { isDemoCalibratedChainsEnabled } from "../config/demoMode";
import { describeLlmInput, rankCandidatesWithLlm } from "../trading";
import { SqlScanRunStore, diffScanRuns } from "../trading";
import { SqlIvHistoryStore } from "../trading";
import { flattenWatchlistSymbols, getIvHistoryEntry, resolveTrackedSymbols } from "../trading";
import { getCuratedStockUniverse } from "../config/curatedStockUniverse";
import { validateStrategyProfile, type StrategyProfileSpec } from "../trading";
import { SqlStrategyProfileStore } from "../trading";
import { generateSyntheticOptionChains } from "../trading";
import { defaultRegistry, REQUESTED_STRATEGY_NAMES } from "../trading";
import { AGENT_DIDS, createDidAttestation, getUserDid, resolveAgentDidDocument } from "./did";
import { createMAS } from "./mas";
import { createAgentMcpTools } from "./mcpAdapter";
import { ETradeEmailTradingService } from "../trading";
import { ETradeSlackTradingService } from "../trading";
import { ETradeBrowserService } from "../services/browserAgent";
import { BrowserAgent } from "./browserAgent";
import { SlackAgent } from "./slackAgent";
import { ETradeVoiceTradingService } from "../trading";
import { ETradeWebhookService } from "../services/tradingWebhooks";
import { McpSystemFacade } from "../patterns/facade";
import { executeMCPTool, handleMCPRequest, MCP_SERVER_INFO, MCP_TOOLS, MCP_RESOURCES, MCP_PROMPTS } from "../mcp";
import { ScheduledTasksService, type AutonomousOptionsAnalysisOptions } from "../services/scheduledTasks";
// Issue #278: durable scheduled-run reports for the AI Search agent.
import { toScheduledReportRecord } from "../services/scheduledReports";
import { ETradeAgenticPaymentService, TRADING_PAID_SERVICES } from "../services/agenticPayments";
import type {
  Env,
  AgentName,
  AuditEvent,
  MessageRecord,
  MemoryRecord,
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
} from "../types";

/**
 * Normalizes messages into valid UIMessage structures with populated `parts`.
 * Prevents AI SDK's convertToModelMessages from crashing on undefined `parts`.
 * Discards empty assistant messages from interrupted turns and merges consecutive user turns.
 */
function normalizeMessagesForSDK(messages: unknown[]): any[] {
  if (!Array.isArray(messages)) return [];
  const valid: any[] = [];

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const item = m as any;
    const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
    
    // Robustly extract text from content, parts, or text property
    let text = typeof item.content === "string" ? item.content.trim() : "";
    let parts = Array.isArray(item.parts) ? [...item.parts].filter(Boolean) : [];

    if (!text && parts.length > 0) {
      text = parts
        .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("")
        .trim();
    }
    if (!text && typeof item.text === "string") {
      text = item.text.trim();
    }

    if (parts.length === 0 && text) {
      parts = [{ type: "text", text }];
    }

    // Skip empty assistant messages from aborted/interrupted turns
    if (role === "assistant" && !text && parts.every((p: any) => p.type === "text" && !p.text?.trim())) {
      continue;
    }

    if (parts.length === 0) {
      if (role === "user") {
        parts = [{ type: "text", text: text || "Hello" }];
      } else {
        continue;
      }
    }

    // Merge consecutive user messages to maintain strictly alternating conversation flow
    if (valid.length > 0 && valid[valid.length - 1].role === "user" && role === "user") {
      const prev = valid[valid.length - 1];
      const mergedText = [prev.content, text].filter(Boolean).join("\n").trim();
      prev.content = mergedText || text || prev.content || "Hello";
      prev.parts = [{ type: "text", text: prev.content }];
      continue;
    }

    valid.push({
      id: item.id || crypto.randomUUID(),
      role,
      content: text,
      parts,
    });
  }

  return valid;
}

/**
 * Callbacks a caller may arm through POST /api/schedules/create (#111).
 *
 * This route is the public way to create schedules, so it accepts only
 * user-creatable jobs. Internal-only callbacks — `executeAsyncJob` (the
 * async-job plumbing) and `expireStaleOrderDraft` (order-draft expiry) —
 * are armed by the agent itself and are deliberately NOT in this list;
 * the route rejects them with HTTP 400. `collectIvHistory` is included by
 * user directive: IV history collection is a first-class schedulable job
 * (its baseline cron is registered in onStart, and the schedules UI can
 * create additional ones). NLQ scheduling (#109) does not use this list —
 * it goes through the agent's NLQ scheduling port, not this route.
 */
export const CREATABLE_SCHEDULE_CALLBACKS = [
  "autonomousOptionsAnalysis",
  "autonomousMarketScreen",
  "autoRenewETradeTokens",
  "collectIvHistory",
  "sendScheduledReminder",
] as const;

export type CreatableScheduleCallback = (typeof CREATABLE_SCHEDULE_CALLBACKS)[number];

export class OrchestratorAgent extends AIChatAgent<Env> {
  /**
   * ScreenerAgent stub (issue #261) — one agent owns all screening.
   * E*TRADE-only market data; honest failure when unavailable.
   */
  private getScreenerAgent(): ScreenerAgent {
    const id = this.env.SCREENER_AGENT.idFromName("default");
    return this.env.SCREENER_AGENT.get(id) as unknown as ScreenerAgent;
  }

  /**
   * Cloudflare Agents Lifecycle: onStart
   * Initializes SQLite tables and registers baseline idempotent cron and interval schedules
   */
  async onStart(props?: Record<string, unknown>): Promise<void> {
    this.ensureTables();

    try {
      await this.recoverQueuedAsyncJobs();
    } catch (error) {
      console.error("[OrchestratorAgent][onStart] Could not reschedule queued async jobs:", error);
    }

    try {
      // 1. Proactive daily E*TRADE token renewal. Cron expressions run in
      // UTC, and no single UTC cron can track an ET wall-clock time across
      // DST — so this is anchored to the invariant that matters, not to an
      // exact ET hour: "0 3 * * *" UTC fires at 23:00 EDT / 22:00 EST,
      // i.e. always at least 1 hour before the midnight-ET token expiry in
      // both DST regimes. (Idempotent by default for cron.)
      await this.schedule(
        "0 3 * * *",
        "autoRenewETradeTokens",
        { userLogin: this.sessionKey() },
        { idempotent: true }
      );

      // 2. Autonomous market screening — hourly per-universe runs
      // (issue #270). Each universe gets its own schedule + PDF report.
      // Staggered by 10 minutes to spread E*TRADE load.
      // NOTE: Legacy 5-min interval Technology screen cleanup reverted.
      // The migration was too aggressive and cleared all schedules.
      // Manual cleanup via UI recommended instead.
      const { shardableUniverses: _shardable, UNIVERSES: _U } = await import(
        "../trading"
      );
      let staggerMin = 5;
      const { getScreenerConfig } = await import("../trading");
      const screenerCfg = getScreenerConfig();
      for (const universe of _shardable()) {
        // Use per-universe max from config (externalized, not hardcoded)
        const maxItems = (screenerCfg.universes.defaultMaxSymbols as any)[universe] ?? screenerCfg.acquisition.defaultMaxSymbols;
        await this.schedule(
          `${staggerMin} * * * *`,
          "autonomousMarketScreen",
          { universe, maxItems },
          { idempotent: true }
        );
        staggerMin = (staggerMin + 10) % 60;
      }

      // 2b. Strategy/Symbol Scanner as a scheduled job (issue #275).
      // Runs the full strategy catalog hourly, staggered off the equity
      // screens. Thesis rotates to cover all directions across the day.
      const theses = ["bullish", "bearish", "range_bound", "large_move"];
      const thesisIdx = new Date().getHours() % theses.length;
      await this.schedule(
        "35 * * * *",
        "autonomousOptionsAnalysis",
        { thesis: theses[thesisIdx], pushToSlack: true },
        { idempotent: true }
      );

      // 3. IV history collection (issue #15) at 22:15 UTC, Mon–Fri —
      // after the US close in both EST and EDT, so the day's record
      // reads the closing chain. Weekdays only: the series is one
      // record per trading session, and a weekend run would restate
      // Friday's chain under a new date. (US holidays still record
      // the prior session's chain — a disclosed approximation of one
      // row, versus ~104 stale weekend rows a year.) Idempotent per
      // (symbol, day) at the store, so a retry or manual trigger the
      // same day is a no-op.
      await this.schedule(
        "15 22 * * 1-5",
        "collectIvHistory",
        { userLogin: this.sessionKey() },
        { idempotent: true }
      );
    } catch (schedErr) {
      console.warn("[OrchestratorAgent][onStart] Note on schedule registration:", schedErr);
    }
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
    const user = payload?.userLogin || this.sessionKey();
    const service = new ScheduledTasksService(this.env, this.getOrm(), user, new SqlScanRunStore(this.ctx.storage.sql));
    const res = await service.autoRenewETradeTokens(user, payload?.env);
    if (!res.success) {
      console.warn("[OrchestratorAgent] autoRenewETradeTokens error:", res.error);
    }
  }

  /**
   * Cloudflare Agents Scheduled Callback: Runs periodic market screening
   * Protected with keepAliveWhile to avoid DO inactivity eviction
   */
  async autonomousMarketScreen(payload?: { sector?: string; universe?: string; maxItems?: number; broadcast?: boolean }): Promise<void> {
    try {
      await this.waitUntilStable({ timeout: 30_000 });
    } catch {
      // Continue if timeout or unhandled
    }
    const runScreen = async () => {
      const orm = this.getOrm();
      const service = new ScheduledTasksService(this.env, orm, this.sessionKey(), new SqlScanRunStore(this.ctx.storage.sql));
      const res = await service.autonomousMarketScreen(payload);
      // Issue #212: persist the run for the "last results" UX endpoint.
      try {
        const key = "screener:last_runs";
        const existing = ((await this.ctx.storage.get(key)) as any[]) || [];
        const run = {
          timestamp: res.timestamp,
          sector: payload?.sector || "ALL",
          success: res.success,
          totalScanned: res.data?.totalScanned ?? 0,
          matchedCount: res.data?.matchedCount ?? 0,
          // Issue #261: opportunities arrive pre-shaped from ScreenerAgent.
          opportunities: res.data?.opportunities || [],
          // Issue #253: full scanned set so the panel can render the
          // per-symbol data table. Already shaped by the shared pipeline.
          allStocks: res.data?.allStocks || [],
          error: res.success ? undefined : res.error,
        };
        await this.ctx.storage.put(key, [run, ...existing].slice(0, 20));
        // Issue #278: persist the scheduled run's report durably
        // (mas_reports) so the AI Search agent can surface it later.
        orm.reports.create(
          toScheduledReportRecord({
            runId: `screener:${res.timestamp}`,
            title: `Autonomous market screen — ${payload?.sector || "ALL"}`,
            source: "screener",
            summary: res.success
              ? `Scanned ${run.totalScanned} symbols, ${run.matchedCount} matched, ${run.opportunities.length} opportunities.`
              : `Scheduled screen failed: ${res.error ?? "unknown error"}.`,
            body: run,
            createdAt: res.timestamp,
          })
        );
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
      const service = new ScheduledTasksService(this.env, this.getOrm(), this.sessionKey(), new SqlScanRunStore(this.ctx.storage.sql));
      const res = await service.autonomousOptionsAnalysis(payload);
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
      const service = new ScheduledTasksService(
        this.env,
        this.getOrm(),
        payload?.userLogin || this.sessionKey(),
        new SqlScanRunStore(this.ctx.storage.sql),
        new SqlIvHistoryStore(this.ctx.storage.sql)
      );
      const res = await service.collectDailyIvHistory(payload);
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

  /**
   * Cloudflare Autonomous Chat Agents: submitMessages
   * Conforms to Cloudflare Agents documentation (/autonomous-responses/ and /chat-agents/).
   * Safely admits external turns (from webhooks, Slack, or cron jobs) into the conversation,
   * waiting for stability before calling saveMessages to trigger an agent turn.
   */
  async submitMessages(
    messagesOrFactory: any[] | ((messages: any[]) => any[]),
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{ requestId?: string; status: "completed" | "skipped" | "aborted" }> {
    try {
      await this.waitUntilStable({ timeout: options?.timeoutMs ?? 30_000 });
    } catch {
      // Continue if timeout or unhandled
    }
    if (typeof (this as any).saveMessages === "function") {
      return await (this as any).saveMessages(messagesOrFactory, options);
    }
    const resolved = typeof messagesOrFactory === "function" ? messagesOrFactory(this.messages as any) : messagesOrFactory;
    await this.persistMessages(resolved as any);
    return { status: "completed" };
  }

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

  private ensureTables() {
    const storage = this.ctx.storage;
    const sql = storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
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
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
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
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_report_confirmations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT
      )
    `);
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
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_referrals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        category TEXT NOT NULL,
        reward_text TEXT NOT NULL,
        clicks INTEGER DEFAULT 0,
        signups INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_ads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tagline TEXT NOT NULL,
        sponsor TEXT NOT NULL,
        badge TEXT NOT NULL,
        url TEXT NOT NULL,
        cta_text TEXT NOT NULL,
        accent_color TEXT NOT NULL,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);

    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_watchlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_login TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        items_json TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

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

    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_transactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        customer TEXT NOT NULL,
        gateway TEXT NOT NULL,
        gateway_ref TEXT,
        status TEXT NOT NULL,
        checkout_url TEXT,
        proposer_did TEXT NOT NULL,
        authorizer_did TEXT,
        proof_signature TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Seed default transactions if table is empty
    try {
      const txCount = Array.from(sql.exec("SELECT COUNT(*) AS count FROM mas_transactions")) as Array<{ count: number }>;
      if ((txCount[0]?.count ?? 0) === 0) {
        const now = new Date().toISOString();
        const sessionId = this.sessionKey();
        const userDid = getUserDid(sessionId);

        sql.exec(
          "INSERT OR IGNORE INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          "pay_init_stripe",
          sessionId,
          "charge",
          25.00,
          "USD",
          "Enterprise Team",
          "stripe",
          "cs_live_seed_compute_tokens",
          "completed",
          "https://checkout.stripe.com/c/pay/cs_live_seed",
          AGENT_DIDS.PAYMENTS,
          userDid,
          "sig_0x4b78a9c2e1f40d89e5a1b3c7d6e8f2a4",
          "500,000 AI Inference Token Credits Bundle",
          now,
          now
        );

        sql.exec(
          "INSERT OR IGNORE INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          "pay_init_paypal",
          sessionId,
          "charge",
          15.00,
          "USD",
          "Acme Partner Corp",
          "paypal",
          "ORDER-789012345",
          "completed",
          "https://www.paypal.com/checkoutnow?token=ORDER-789012345",
          AGENT_DIDS.PAYMENTS,
          userDid,
          "sig_0x8f2d1e4c9b3a7f0e6d5c2a1b4e9f8a7d",
          "Developer Sandbox Token Allowance",
          now,
          now
        );
      }
    } catch {
      // Ignore if seeding fails
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
          { scanRunStore: new SqlScanRunStore(this.ctx.storage.sql), profileStore: new SqlStrategyProfileStore(this.ctx.storage.sql), schedulingPort: this.nlqSchedulingPort() },
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

  /** Stores a pending report-dispatch confirmation; returns its confirmation id. */
  private createReportConfirmation(kind: "email" | "webhook", payloadJson: string): string {
    const sql = this.ensureTables();
    const now = new Date().toISOString();
    // Lazy sweep: drop confirmations that expired unconfirmed.
    sql.exec(
      "DELETE FROM mas_report_confirmations WHERE status = 'pending' AND created_at < ?",
      new Date(Date.now() - OrchestratorAgent.REPORT_CONFIRMATION_TTL_MS).toISOString()
    );
    const id = `rc_${crypto.randomUUID().slice(0, 8)}`;
    sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      kind,
      payloadJson,
      "pending",
      now
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

  async onChatMessage() {
    const requestId = crypto.randomUUID();
    const sql = this.ensureTables();
    const sessionId = this.sessionKey();

    // Purge any empty assistant messages from prior failed turns in session memory
    this.messages = this.messages.filter((m: any) => {
      if (!m || typeof m !== "object") return false;
      if (m.metadata?.activity) return true;
      if (m.role === "assistant") {
        const text = typeof m.content === "string" ? m.content.trim() : "";
        const parts = Array.isArray(m.parts) ? m.parts : [];
        const hasText = parts.some((p: any) => p && p.type === "text" && typeof p.text === "string" && p.text.trim());
        const hasTool = parts.some((p: any) => p && p.type !== "text");
        return Boolean(text || hasText || hasTool);
      }
      return true;
    });

    // Safely retrieve last user question
    const lastUserMsg = [...this.messages].reverse().find((m: unknown) => (m as { role?: string })?.role === "user");
    const userText = this.extractMessageText(lastUserMsg);
    const messageMetadata = (lastUserMsg as { metadata?: { sourceTab?: string; userLogin?: string } } | undefined)?.metadata;
    const isAutoOptionsResearchRequest = messageMetadata?.sourceTab === "E*TRADE · Auto Options Research";
    const userLogin = messageMetadata?.userLogin || sessionId;

    if (userText) {
      this.recordMessage("user", userText, "orchestrator");
    }

    // Run Judge intent classification with recent conversation history
    const recentTurns = (this.messages || []).slice(-6).map((m: any) => ({
      role: m?.role,
      content: this.extractMessageText(m),
    }));

    const judge = new LLMJudge(this.env);
    const route = isAutoOptionsResearchRequest
      ? {
        agent: "trading" as const,
        confidence: 1,
        reason: "Source-tagged Auto Options Research request; executing its options NLQ workflow directly",
        needsConfirmation: false,
      }
      : await judge.route(userText, recentTurns);
    this.audit("route.decided", "judge", {
      route: route.agent,
      confidence: route.confidence,
      reason: route.reason,
      needsConfirmation: route.needsConfirmation,
    });

    // Instantiate GoF Facade & GRASP Controller
    const orm = this.getOrm();
    const facade = new McpSystemFacade(this.env, orm, sessionId);
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
          sourceTab: messageMetadata?.sourceTab,
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
          sourceTab: messageMetadata?.sourceTab,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Provide unified toolset adapting all 14 MCP commands directly into the AI SDK agent (GoF Adapter Pattern)
    const tools = createAgentMcpTools({
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

    // Fetch active session facts directly from SQLite to ground every turn
    const activeMemories = Array.from(
      sql.exec("SELECT key, value FROM mas_memory ORDER BY updated_at DESC LIMIT 8")
    ) as Array<{ key: string; value: string }>;
    const memoryContext = activeMemories.length > 0
      ? `\nActive Persistent Memory (SQLite Session Facts):\n` + activeMemories.map(m => `- ${m.key}: "${m.value}"`).join("\n")
      : "";

    // VectorMemory recall (issue #201): past job outcomes relevant to this
    // request, so the response is grounded in what worked/failed before.
    // Best-effort: a memory failure must never break the chat turn.
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

    const model = getWorkersAIModel(this.env);
    const maxSteps = Math.max(1, Math.min(10, Number(this.env.MAS_MAX_STEPS || 6)));

    // Safely normalize messages to prevent AI SDK convertToModelMessages crashes
    let modelMessages: any[];
    try {
      const cleanMessages = normalizeMessagesForSDK(this.messages.filter((m: any) => !m?.metadata?.activity));
      modelMessages = await convertToModelMessages(cleanMessages);
      if (!modelMessages || modelMessages.length === 0) {
        modelMessages = [{ role: "user", content: [{ type: "text", text: userText || "Hello" }] }];
      }
    } catch {
      modelMessages = [{ role: "user", content: [{ type: "text", text: userText || "Hello" }] }];
    }

    try {
      const result = streamText({
        model,
        system: `You are the master orchestrator for Multi-Agent Studio (OpenAIMP), an enterprise financial intelligence and multi-agent execution platform powered by Cloudflare Agents, Durable Objects, and SQLite.
Intent router classified request as: [${route.agent}] (confidence: ${(route.confidence * 100).toFixed(0)}%). Rationale: ${route.reason}.${memoryContext}${vectorContext}
${optionsResearchContext ? `\n${optionsResearchContext}\n${isAutoOptionsResearchRequest
    ? "If AUTO_OPTIONS_RESEARCH_JOB_SUBMITTED is present, tell the user it was accepted and include its job ID; do not claim analysis results yet. If AUTO_OPTIONS_RESEARCH_EXECUTION_ERROR is present, report that queueing failure clearly."
    : ""}` : ""}

Sub-agent & MCP capabilities directly available to you (GoF Command & Adapter Architecture):
- 'query_platform_knowledge' / 'queryPlatformKnowledge': Retrieve authoritative documentation and how-to guides for all 8 platform workflows, 8 quantitative FAQs, 6 decisioning engines (PickBestTrades, screeners), and UI navigation.
- 'knowledge_search' / 'searchKnowledge': Retrieve facts from Cloudflare AI Search knowledge base or platform documentation.
- 'draft_payment' / 'draftPayment': Prepare payment authorization drafts with Agent DIDs (charges, refunds, invoices) across Stripe, PayPal, Lemon Squeezy, Sandbox. NEVER execute unverified money movement.
- 'confirm_payment_draft' / 'confirmDraft': Formally approve, authorize, or cancel a pending payment or task draft upon explicit user confirmation.
- 'get_payment_gateways': Inspect processor health status and registered agent DIDs.
- 'get_transactions': Query transaction ledger and cryptographic proof signatures.
- 'execute_nlq': Execute natural language queries over database tables, schemas, trading, or conversations.
- 'list_database_tables': Inspect database tables, schema columns, and row counts via DatabaseORM.
- 'query_table_data': Query rows from any table (mas_categories, mas_referrals, mas_ads, mas_external_ads, mas_transactions, mas_events, mas_trades) with filters and pagination.
- 'manage_categories': Full CRUD for referral categories taxonomy in SQLite.
- 'manage_referrals': Manage developer referral links and track click attribution.
- 'manage_external_ads': Manage external ad placements (EthicalAds, Carbon, AdSense, Direct) and track CPM/CPC impressions.
- 'get_revenue_summary': Compute platform financial analytics across ad networks, transaction fees, and net profit.
- 'manage_session_memory' / 'rememberFact': Read, persist, or clear session facts in SQLite.
- 'get_audit_events': Stream real-time routing decisions, judge evaluations, and security logs.
- 'createTaskDraft': Draft actionable tasks with priorities and deadlines.
- 'etrade_market_scan': Screen and scan equities across technical and fundamental indicators (RSI, Market Cap, Sector, Price, MACD, Volume, Gainers/Losers).
- 'etrade_get_quote': Look up real-time equity quotes with Bid, Ask, Volume, and 52-week statistics.
- 'etrade_preview_order': Prepare an order proposal draft with cryptographic Agent DID attestation ('did:agent:openaimp:trading'). NEVER execute without human confirmation.
- 'etrade_execute_order': Submit and execute a confirmed order draft after explicit human authorization.
- 'etrade_get_positions': Retrieve broker account balances, equity holdings, and real-time unrealized P&L.
- 'get_async_job' / 'list_async_jobs': Retrieve the state and result of submitted background work.

Platform Workflows & UI Navigation Map:
1. Workflow 1: Stock Screener & Equity Discovery (Tab: 'trading' | APIs: /api/etrade/screen, /api/foss/screen)
   - Screens 8,000+ US equities with 14-period RSI & MACD. Fallback hierarchy: Nasdaq API -> Yahoo FOSS -> curatedStockUniverse.json.
2. Workflow 2: Options Strategy Discovery & Greeks (Tab: 'trading' | API: /api/etrade/options/strategy)
   - Evaluates the catalog of options strategies using Black-Scholes Greeks, IV rank, EV scoring, and strict user constraints (e.g. Max Loss <= $30, Max Profit > $0).
3. Workflow 3: Options Flow Estimates & Institutional Activity Tracker (Tab: 'options-flows' | API: /api/options/flows)
   - Modelled unusual options volume, sweeps ($100k+ aggressive-at-ask estimates), blocks, and sentiment derived from option-chain snapshots — not a live trade tape (no options print feed exists). Queries Stock Screener first for active underlyings.
4. Workflow 4: Visual Multi-Leg Strategy Builder & Payoff Visualizer (Tab: 'trading' | API: /api/options/builder/payoff)
   - Construct custom 1-4 leg positions with interactive payoff curves, breakevens, and net Greeks.
5. Workflow 5: Portfolio Positions & Account Sync (Tab: 'trading' | API: /api/etrade/positions)
   - Live position sync with balances and per-position unrealized PnL, plus portfolio-level Greeks aggregation (Delta/Gamma/Theta/Vega/Rho, SPY beta-weighted Delta with betas computed from live price history, defined max loss vs NAV) via /api/etrade/portfolio-risk, plus correlation & concentration flags via /api/etrade/portfolio-risk/correlation and portfolio-aware position sizing via /api/etrade/portfolio-risk/size, plus draft hedge proposals sized from the aggregates (HITL review only, never auto-executed) via /api/etrade/hedge/analyze.
6. Workflow 6: Brokerage Order Execution with HITL Guardrails (Tab: 'trading' | API: /api/etrade/order/preview)
   - Mandatory human approval for every trade. Order drafts are signed with Agent DIDs before confirmation.
7. Workflow 7: Autonomous Background Execution & Cron (Tab: 'trading' | Durable Objects)
   - Auto token renewal daily at 23:00 EDT / 22:00 EST (03:00 UTC — always at least 1h before the midnight-ET token expiry), interval market scans every 5m (300s), and WebSocket opportunity alerts.
8. Workflow 8: Natural Language Financial Intelligence (NLQ) (Tab: 'chat' / 'nlq')
   - Conversational analysis, SQLite ORM queries, and tool execution via chat.

Algorithmic & Decisioning Engines:
- PickBestTrades Engine: Evaluates trade setups across 5 dimensions: Expected Value (EV), Probability of Profit (POP = N(d2)), Bid-Ask Liquidity, Theta Yield, and Trend Alignment.
- Options Filter Engine: Enforces budget constraints (max loss <= $30, max profit > $0, win rate >= 60%, expiration windows, strike spreads).
- Stock Screener Ingestion: Live multi-exchange discovery across NASDAQ, NYSE, and AMEX with resilient fallback tree.

Agentic Best Practices & Workflow Rules:
1. Answering Platform Questions: When users ask about platform capabilities, available features, workflows, decisioning rules (e.g. pickBestTrades, screening criteria, max loss / max profit), or how to use them, invoke 'query_platform_knowledge' or provide clear, actionable, step-by-step instructions guiding them on which tab to visit ('trading', 'options-flows', 'workflows', 'research'), what parameters to enter, or what prompt to type into chat.
2. Direct MCP Tool Self-Consumption: You have direct access to database tables, revenue analytics, categories, ads, transactions, and trading. Always invoke these tools when answering user questions about data, finances, or system state.
3. RAG & Knowledge Retrieval: If 'knowledge_search' or 'query_platform_knowledge' returns matching documents, cite them accurately.
4. Human-in-the-Loop (HITL) Execution: For financial operations or task proposals, always require human confirmation. When a user approves (or mentions a draft ID like pay_xxx or task_xxx), call 'confirm_payment_draft' with decision: 'approved'.
5. Multi-Turn Context & Session Memory: Respect the active session memory facts shown above. When the user asks to remember a preference, call 'manage_session_memory' with action: 'remember'.
6. E*TRADE Trading & Market Screening: When user asks to scan, screen, quote, or trade stocks, invoke 'etrade_market_scan' or 'etrade_get_quote'. For trade orders (buy/sell), ALWAYS use 'etrade_preview_order' to draft a proposal. Only execute via 'etrade_execute_order' when the user explicitly confirms approval.
7. Be structured, transparent, accurate, and professional. Avoid repeating internal tool call boilerplate.
8. Background execution: MCP capabilities return queued job IDs instead of final results. Tell the user the job ID, and use 'get_async_job' or 'list_async_jobs' only when they ask for status or results. Never imply queued work is already complete.`,
        messages: modelMessages,
        tools: isAutoOptionsResearchRequest ? {} : tools,
        stopWhen: stepCountIs(maxSteps),
        onFinish: async ({ text }: { text?: string }) => {
          if (text) {
            this.recordMessage("assistant", text, route.agent);
            // Run background quality evaluation
            const quality = await judge.evaluate({ question: userText, answer: text, agent: route.agent });
            this.audit("response.evaluated", "judge", {
              score: quality.score,
              grounded: quality.grounded,
              safe: quality.safe,
              issues: quality.issues,
            });
            // VectorMemory remember (issue #201): store this turn's outcome
            // for future recall. Best-effort; never break the turn.
            try {
              if (this.env.AI && vectorizeBinding) {
                const vm = new VectorMemory(this.env.AI, vectorizeBinding, undefined);
                await vm.remember({
                  jobId: requestId,
                  operation: `chat:${route.agent}`,
                  summary: `Q: ${userText.slice(0, 300)}\nA: ${text.slice(0, 500)}`,
                  success: quality.safe !== false && quality.grounded !== false,
                  timestamp: new Date().toISOString(),
                });
              }
            } catch (err) {
              console.warn("[VectorMemory] remember failed:", err instanceof Error ? err.message : String(err));
            }
          }
        },
        onError: ({ error }: { error: unknown }) => {
          const aspect = resolveErrorAspect(error);
          logAspectEvent({
            aspect: "ChatStream",
            operationName: "streamError",
            code: aspect.code,
            level: "error",
            error: aspect.message,
            audit: (e, _c, p) => this.audit(e, "orchestrator", p),
          });
        },
      });

      return result.toUIMessageStreamResponse({
        onError: (error: unknown) => {
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
        },
      });
    } catch (streamErr) {
      const aspect = resolveErrorAspect(streamErr);
      logAspectEvent({
        aspect: "ChatStream",
        operationName: "streamInitializationError",
        code: aspect.code,
        level: "error",
        error: aspect.message,
        metadata: { userText, userLogin },
        audit: (e, _c, p) => this.audit(e, "orchestrator", p),
      });
      this.audit("stream.error", "orchestrator", { code: aspect.code, error: aspect.message });

      // Attempt deterministic query execution (e.g. Stock Screener or Research query)
      let deterministicSection = "";
      if (userText && userText.trim().length > 0) {
        try {
          const { result } = await executeNaturalLanguageQuery(
            orm,
            sessionId,
            userText,
            this.env,
            userLogin,
            undefined,
            { scanRunStore: new SqlScanRunStore(this.ctx.storage.sql), profileStore: new SqlStrategyProfileStore(this.ctx.storage.sql), schedulingPort: this.nlqSchedulingPort() }
          );
          if (result && result.status !== "error") {
            if (Array.isArray(result.rows) && result.rows.length > 0) {
              deterministicSection = [
                "",
                "---",
                "### 📈 Deterministic Results (Executed without AI tokens):",
                `Found **${result.count || result.rows.length}** results matching your criteria:`,
                "",
                ...result.rows.slice(0, 12).map((row: any) => {
                  const sym = row.symbol || row.ticker || "";
                  const name = row.companyName || row.name || "";
                  const mcap = row.marketCap ? ` · MCap: ${formatMarketCap(Number(row.marketCap))}` : "";
                  const price = row.price !== undefined ? ` · Price: $${Number(row.price).toFixed(2)}` : "";
                  const change = row.changePct !== undefined ? ` (${row.changePct >= 0 ? "+" : ""}${Number(row.changePct).toFixed(2)}%)` : "";
                  return `- **${sym}** ${name ? `(${name})` : ""}${price}${change}${mcap}`;
                }),
              ].join("\n");
            } else if (result.summary) {
              deterministicSection = `\n\n---\n### 📈 Deterministic Result:\n${result.summary}`;
            }
          }
        } catch (fallbackQueryErr) {
          console.warn("[OrchestratorAgent] Deterministic fallback query error:", fallbackQueryErr);
        }
      }


      const fallbackText = [
        `⚠️ **[${aspect.code}] ${aspect.title}**`,
        "",
        `**Diagnosis:** ${aspect.message}`,
        "",
        "**What needs to be done to resolve this:**",
        ...aspect.resolutionSteps.map((step, idx) => `${idx + 1}. ${step}`),
        "",
        aspect.suggestedTab
          ? `👉 **Direct Navigation:** Go to the **${aspect.suggestedTabLabel || aspect.suggestedTab}** from the navigation bar to run scans and queries directly with direct exchange feeds.`
          : "",
        deterministicSection,
      ].filter(Boolean).join("\n");

      this.recordMessage("assistant", fallbackText, "orchestrator");

      // Return a compliant AI SDK v5 UI message stream response
      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: "text-start", id: "text-fallback-1" });
          writer.write({ type: "text-delta", id: "text-fallback-1", delta: fallbackText });
          writer.write({ type: "text-end", id: "text-fallback-1" });
        },
      });

      return createUIMessageStreamResponse({ stream });
    }

  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    this.ensureTables();

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
    const isImmediateEndpoint = /(?:^|\/)(?:api\/)?(?:clear|reset|memory|audit|chat-activity|screener\/report\.pdf|etrade\/screen|etrade\/options\/profiles|etrade\/options\/scans)(?:\/|$)/i.test(path);
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
    const existing = this.messages.findIndex((message: any) => message?.id === entry.id);
    const next = existing >= 0
      ? this.messages.map((message: any, index: number) => (index === existing ? entry : message))
      : [...this.messages, entry];
    await this.persistMessages(next as typeof this.messages);
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

    // Issue #277: list pending report-dispatch confirmations for the
    // Settings UI. Summaries only — payloads stay server-side until decided.
    if (path.endsWith("/trading/reports/pending") && request.method === "GET") {
      try {
        const sql = this.ensureTables();
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
            return {
              confirmationId: String(row.id),
              kind: String(row.kind),
              createdAt: String(row.created_at),
              detail:
                row.kind === "email"
                  ? `${payload.recipient || "?"} · ${payload.fileName || "?"}`
                  : `${payload.title || "Research report"} · ${(payload.sheets || []).length} sheets`,
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
      return Response.json({ enabled: this.getReportDispatchHitl() });
    }

    if (path.endsWith("/trading/settings/report-dispatch-hitl") && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
      if (!body || typeof body.enabled !== "boolean") {
        return Response.json({ error: "enabled (boolean) is required." }, { status: 400 });
      }
      this.setReportDispatchHitl(body.enabled);
      this.audit("report_dispatch_hitl.changed", "orchestrator", { enabled: body.enabled });
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
      const row = this.getReportConfirmation(confirmationId);
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
      if (!Number.isFinite(ageMs) || ageMs > OrchestratorAgent.REPORT_CONFIRMATION_TTL_MS) {
        this.decideReportConfirmation(confirmationId, "expired", null);
        this.audit("research_report.confirmation_expired", "trading", { confirmationId });
        return Response.json({ error: "Report confirmation expired.", confirmationId }, { status: 410 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      if (decision === "approved") {
        const payload = JSON.parse(String(row.payload_json)) as any;
        if (row.kind === "email") {
          const sent = await this.sendReportEmail(
            String(payload.recipient),
            String(payload.title),
            String(payload.fileName),
            String(payload.attachmentBase64),
            userLogin
          );
          if (!sent) {
            return Response.json({ error: "Email delivery is unavailable; check the configured email binding." }, { status: 503 });
          }
          this.decideReportConfirmation(confirmationId, "approved", userLogin);
          this.audit("research_report.emailed", "trading", {
            confirmationId,
            recipient: payload.recipient,
            fileName: payload.fileName,
            via: "hitl_confirmation",
          });
          return Response.json({ success: true, status: "dispatched", confirmationId });
        }
        const result = await this.sendReportWebhook(
          String(payload.title),
          String(payload.query || ""),
          payload.sheets,
          userLogin
        );
        if (!result.success) {
          const status = result.notConfigured ? 503 : 502;
          return Response.json({ error: result.error || `Webhook returned HTTP ${result.status}.` }, { status });
        }
        this.decideReportConfirmation(confirmationId, "approved", userLogin);
        this.audit("research_report.webhook_dispatched", "trading", {
          confirmationId,
          status: result.status,
          sheets: (payload.sheets || []).length,
          via: "hitl_confirmation",
        });
        return Response.json({ success: true, status: "dispatched", confirmationId });
      }
      this.decideReportConfirmation(confirmationId, "rejected", userLogin);
      this.audit("research_report.confirmation_rejected", "trading", { confirmationId, note });
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
      if (this.getReportDispatchHitl()) {
        // Issue #277: hold for human confirmation instead of sending.
        const confirmationId = this.createReportConfirmation(
          "email",
          JSON.stringify({ recipient, title, fileName, attachmentBase64 })
        );
        this.audit("research_report.pending_confirmation", "trading", { confirmationId, recipient, fileName });
        return Response.json({ success: true, status: "pending_confirmation", confirmationId });
      }
      const sent = await this.sendReportEmail(recipient, title, fileName, attachmentBase64, userLogin);
      if (!sent) return Response.json({ error: "Email delivery is unavailable; check the configured email binding." }, { status: 503 });
      this.audit("research_report.emailed", "trading", { recipient, fileName });
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
      if (this.getReportDispatchHitl()) {
        // Issue #277: hold for human confirmation instead of dispatching.
        const title = (typeof body.title === "string" ? body.title : "Research report").replace(/[\r\n]/g, " ").slice(0, 120);
        const confirmationId = this.createReportConfirmation(
          "webhook",
          JSON.stringify({ title, query: body.query || "", sheets: body.sheets })
        );
        this.audit("research_report.pending_confirmation", "trading", {
          confirmationId,
          sheets: body.sheets.length,
        });
        return Response.json({ success: true, status: "pending_confirmation", confirmationId });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const result = await this.sendReportWebhook(body.title || "", body.query || "", body.sheets, userLogin);
      if (!result.success) {
        const status = result.notConfigured ? 503 : 502;
        return Response.json({ error: result.error || `Webhook returned HTTP ${result.status}.` }, { status });
      }
      this.audit("research_report.webhook_dispatched", "trading", { status: result.status, sheets: body.sheets.length });
      return Response.json({ success: true, status: result.status });
    }

    // Model Context Protocol (MCP) Server Endpoint (JSON-RPC 2.0 & Discovery)
    if (path.endsWith("/mcp")) {
      const orm = this.getOrm();

      if (request.method === "GET") {
        return Response.json({
          server: MCP_SERVER_INFO,
          tools: MCP_TOOLS,
          resources: MCP_RESOURCES,
          prompts: MCP_PROMPTS,
          endpoints: {
            jsonrpc: "/api/mcp",
            protocol: "MCP JSON-RPC 2.0",
          },
        });
      }

      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as any;
          const response = await handleMCPRequest(body, {
            env: this.env,
            orm,
            sessionId,
            audit: (type, agent, payload) => this.audit(type, agent, payload),
            submitJob: (job) => this.submitAsyncJob(job),
            getJob: (jobId) => this.getAsyncJob(jobId),
            listJobs: () => this.listAsyncJobs().map(({ result: _result, ...job }) => job),
          });
          return Response.json(response);
        } catch (err: any) {
          return Response.json(
            { jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message || "Internal error" } },
            { status: 500 }
          );
        }
      }
    }

    // Natural Language Query (NLQ) endpoint
    if (path.endsWith("/nlq") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          query?: string;
          context?: string;
          validateWithLLM?: boolean;
        };
        const query = (body.query || "").trim();
        if (!query) {
          return Response.json({ error: "Query parameter is required" }, { status: 400 });
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const contextHeader = request.headers.get("x-nlq-context") || body.context;
        const userDid = getUserDid(sessionId);
        const orm = this.getOrm();
        const { plan, result } = await executeNaturalLanguageQuery(
          orm,
          sessionId,
          query,
          this.env,
          userLogin,
          userDid,
          { context: contextHeader, validateWithLLM: body.validateWithLLM, scanRunStore: new SqlScanRunStore(this.ctx.storage.sql), profileStore: new SqlStrategyProfileStore(this.ctx.storage.sql), schedulingPort: this.nlqSchedulingPort() }
        );
        this.audit("nlq.executed", "nlq", {
          query,
          domain: result.domain,
          operation: plan.operation,
          count: result.count,
        });

        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "NLQ query processing failed" }, { status: 500 });
      }
    }

    // Schema Introspection & Database Tables via ORM
    if (path.endsWith("/schema/tables") && request.method === "GET") {
      try {
        const orm = this.getOrm();
        const tables = orm.listTables();
        return Response.json({ count: tables.length, tables });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to inspect database tables" }, { status: 500 });
      }
    }

    // Direct Table Query Execution via ORM
    if (path.endsWith("/schema/query") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          table?: string;
          search?: string;
          limit?: number;
          offset?: number;
        };
        const table = body.table || "mas_categories";
        const orm = this.getOrm();
        const data = orm.getTableData(table, {
          search: body.search,
          limit: body.limit,
          offset: body.offset,
        });
        return Response.json(data);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to query table data" }, { status: 500 });
      }
    }

    // Referral Categories ORM Management API
    if (path.endsWith("/categories")) {
      const orm = this.getOrm();

      if (request.method === "GET") {
        try {
          const categories = orm.categories.findMany({ orderBy: "sort_order ASC" });
          return Response.json({ count: categories.length, categories });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch categories" }, { status: 500 });
        }
      }

      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as Partial<CategoryRecord> & { id?: string };
          const name = (body.name || "").trim();
          if (!name) {
            return Response.json({ error: "Category name is required" }, { status: 400 });
          }

          const now = new Date().toISOString();
          let category: CategoryRecord;

          if (body.id) {
            const existing = orm.categories.findById(body.id);
            if (!existing) {
              return Response.json({ error: "Category not found" }, { status: 404 });
            }
            const updated = orm.categories.update(body.id, {
              name: body.name || existing.name,
              slug: body.slug || (body.name ? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : existing.slug),
              description: body.description ?? existing.description,
              icon: body.icon || existing.icon,
              isActive: body.isActive !== undefined ? Boolean(body.isActive) : existing.isActive,
              sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : existing.sortOrder,
              updatedAt: now,
            });
            category = updated || existing;
            this.audit("category.updated", "orchestrator", { id: category.id, name: category.name });
          } else {
            const slug = (body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 32);
            const id = `cat_${slug.slice(0, 16)}_${crypto.randomUUID().slice(0, 4)}`;
            category = orm.categories.create({
              id,
              name,
              slug,
              description: body.description || `Category for ${name} partner links`,
              icon: body.icon || "🏷️",
              isActive: body.isActive !== undefined ? Boolean(body.isActive) : true,
              sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : (orm.categories.count() || 0) + 1,
              createdAt: now,
              updatedAt: now,
            });
            this.audit("category.created", "orchestrator", { id, name });
          }

          return Response.json({ success: true, category });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to save category" }, { status: 500 });
        }
      }

      if (request.method === "DELETE") {
        try {
          const id = url.searchParams.get("id");
          if (!id) {
            return Response.json({ error: "Category id is required" }, { status: 400 });
          }
          orm.categories.delete(id);
          this.audit("category.deleted", "orchestrator", { id });
          return Response.json({ success: true });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to delete category" }, { status: 500 });
        }
      }
    }

    // Revenue Management Summary API
    if (path.endsWith("/revenue") && request.method === "GET") {
      try {
        const orm = this.getOrm();
        const summary = orm.getRevenueSummary();
        return Response.json(summary);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to calculate revenue" }, { status: 500 });
      }
    }

    // External Ad Network Placements & Monetization API
    if (path.endsWith("/external-ads")) {
      const orm = this.getOrm();

      if (request.method === "GET") {
        try {
          const ads = orm.externalAds.findMany({ orderBy: "earnings DESC" });
          return Response.json({ count: ads.length, ads });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch external ads" }, { status: 500 });
        }
      }

      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as Partial<ExternalAdRecord> & { id?: string };
          const title = (body.title || "").trim();
          const targetUrl = (body.targetUrl || "").trim();
          if (!title || !targetUrl) {
            return Response.json({ error: "Title and targetUrl are required" }, { status: 400 });
          }

          const now = new Date().toISOString();
          let ad: ExternalAdRecord;

          if (body.id) {
            const existing = orm.externalAds.findById(body.id);
            if (!existing) {
              return Response.json({ error: "Ad not found" }, { status: 404 });
            }
            const updated = orm.externalAds.update(body.id, {
              title: body.title || existing.title,
              name: body.name || existing.name,
              network: body.network || existing.network,
              placement: body.placement || existing.placement,
              tagline: body.tagline || existing.tagline,
              ctaText: body.ctaText || existing.ctaText,
              targetUrl: body.targetUrl || existing.targetUrl,
              cpmRate: body.cpmRate !== undefined ? Number(body.cpmRate) : existing.cpmRate,
              cpcRate: body.cpcRate !== undefined ? Number(body.cpcRate) : existing.cpcRate,
              isActive: body.isActive !== undefined ? Boolean(body.isActive) : existing.isActive,
            });
            ad = updated || existing;
            this.audit("external_ad.updated", "orchestrator", { id: ad.id, title: ad.title });
          } else {
            const id = `ext_${body.network || "net"}_${crypto.randomUUID().slice(0, 6)}`;
            ad = orm.externalAds.create({
              id,
              name: body.name || title,
              network: body.network || "direct",
              placement: body.placement || "header_leaderboard",
              title,
              tagline: body.tagline || "",
              ctaText: body.ctaText || "Learn More →",
              targetUrl,
              bannerImageUrl: body.bannerImageUrl || "",
              cpmRate: Number(body.cpmRate) || 15.0,
              cpcRate: Number(body.cpcRate) || 1.25,
              impressions: 1,
              clicks: 0,
              earnings: (Number(body.cpmRate) || 15.0) / 1000,
              isActive: true,
              createdAt: now,
            });
            this.audit("external_ad.created", "orchestrator", { id, title });
          }

          return Response.json({ success: true, ad });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to save external ad" }, { status: 500 });
        }
      }
    }

    if (path.endsWith("/external-ads/impression") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        const id = body.id;
        if (id) {
          const orm = this.getOrm();
          const ad = orm.externalAds.findById(id);
          if (ad) {
            const newImpressions = ad.impressions + 1;
            const incremental = (ad.cpmRate || 15.0) / 1000;
            const newEarnings = Math.round((ad.earnings + incremental) * 1000) / 1000;
            orm.externalAds.update(id, {
              impressions: newImpressions,
              earnings: newEarnings,
            });
            return Response.json({ success: true, impressions: newImpressions, earnings: newEarnings });
          }
        }
        return Response.json({ success: false });
      } catch {
        return Response.json({ success: false });
      }
    }

    if (path.endsWith("/external-ads/click") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        const id = body.id;
        if (id) {
          const orm = this.getOrm();
          const ad = orm.externalAds.findById(id);
          if (ad) {
            const newClicks = ad.clicks + 1;
            const incremental = ad.cpcRate || 1.25;
            const newEarnings = Math.round((ad.earnings + incremental) * 100) / 100;
            orm.externalAds.update(id, {
              clicks: newClicks,
              earnings: newEarnings,
            });
            this.audit("external_ad.clicked", "orchestrator", { id, clicks: newClicks, earnings: newEarnings });
            return Response.json({ success: true, clicks: newClicks, earnings: newEarnings });
          }
        }
        return Response.json({ success: false });
      } catch {
        return Response.json({ success: false });
      }
    }

    // Audit logs endpoint
    if (path.endsWith("/audit") && request.method === "GET") {
      try {
        const limitParam = Number(url.searchParams.get("limit") || 50);
        const limit = Math.max(1, Math.min(100, limitParam));
        const events = Array.from(
          sql.exec(
            "SELECT id, type, agent, payload, created_at FROM mas_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
            sessionId,
            limit
          )
        ) as Array<{ id: string; type: string; agent: string; payload: string; created_at: string }>;

        const parsed = events.map((e) => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(e.payload);
          } catch {
            payload = { raw: e.payload };
          }
          return { ...e, payload };
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
        this.audit(type, agent, payload);
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
        const record = this.recordAudit(type, agent, JSON.parse(serialized));
        return Response.json(record, { status: 201 });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to record audit event" }, { status: 500 });
      }
    }

    // ---------------------------------------------------------------------
    // Autopilot control center (autopilot Phase 1): server-owned run state,
    // limits, kill switch, and policy verdicts.
    // ---------------------------------------------------------------------
    if (path.endsWith("/autopilot") && request.method === "GET") {
      try {
        const state = this.getAutopilotState();
        let recentVerdicts: Array<Record<string, unknown>> = [];
        try {
          const sql = this.ensureTables();
          recentVerdicts = Array.from(
            sql.exec(
              "SELECT id, symbol, action, quantity, notional, mode, dry_run, passed, execution_allowed, requires_approval, binding_rule, detail, signature, proposer_did, authorizer_did, created_at FROM mas_policy_verdicts ORDER BY created_at DESC LIMIT 25"
            )
          ) as Array<Record<string, unknown>>;
        } catch {
          recentVerdicts = [];
        }
        return Response.json({ ...state, engine: "riskPolicyEngine", recentVerdicts });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to read autopilot state" }, { status: 500 });
      }
    }

    if (path.endsWith("/autopilot/state") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        if (typeof body.running !== "boolean") {
          return Response.json({ error: "running (boolean) is required" }, { status: 400 });
        }
        const next = this.writeAutopilotState({ running: body.running });
        this.audit("autopilot.state_changed", "trading", {
          running: next.running,
          by: request.headers.get("x-user-login") || sessionId || "unknown",
        });
        return Response.json(next);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to update autopilot state" }, { status: 500 });
      }
    }

    if (path.endsWith("/autopilot/kill-switch") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const active = Boolean(body.active);
        const reason = active
          ? String(body.reason || "Emergency stop from the autopilot control center").slice(0, 200)
          : null;
        const next = this.writeAutopilotState({ killSwitch: active, killSwitchReason: reason });
        this.audit("autopilot.kill_switch", "trading", { active, reason });
        return Response.json(next);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to update kill switch" }, { status: 500 });
      }
    }

    if (path.endsWith("/autopilot/limits") && (request.method === "POST" || request.method === "PUT")) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const limits = normalizeAutopilotLimits(body?.limits ?? body);
        const next = this.writeAutopilotState({ limits });
        this.audit("autopilot.limits_updated", "trading", { limits });
        return Response.json(next);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to update policy limits" }, { status: 500 });
      }
    }

    if (path.endsWith("/autopilot/evaluate") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const symbol = String(body.symbol || "").trim().toUpperCase();
        const quantity = Number(body.quantity) || 0;
        if (!symbol || quantity <= 0) {
          return Response.json({ error: "symbol and a positive quantity are required" }, { status: 400 });
        }
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const limitPrice = body.limitPrice !== undefined ? Number(body.limitPrice) : undefined;
        // This endpoint is declared before the E*TRADE routes resolve the
        // environment header, so it resolves the same value locally.
        const envHeader = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
        const snapshotEnv: "TEST" | "PROD" | undefined = envHeader === "TEST" || envHeader === "PROD" ? envHeader : undefined;
        const { verdict, attestation } = await this.evaluateAndRecordAutopilotVerdict({
          userLogin,
          requestedEnv: snapshotEnv,
          sessionId,
          dryRun: body.dryRun !== false,
          intent: {
            symbol,
            action: String(body.action || "BUY").toUpperCase(),
            quantity,
            orderType: body.orderType || "MARKET",
            estimatedPrice: Number.isFinite(limitPrice as number) ? (limitPrice as number) : null,
            estimatedTotal: Number.isFinite(Number(body.estimatedTotal)) ? Number(body.estimatedTotal) : null,
          },
        });
        return Response.json({ verdict, attestation, requestedBy: String(body.requestedBy || userLogin) });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to evaluate policy" }, { status: 500 });
      }
    }

    // Persistent Memory facts endpoint
    if (path.endsWith("/memory")) {
      if (request.method === "GET") {
        try {
          const rawMemories = Array.from(
            sql.exec("SELECT key, value, updated_at FROM mas_memory ORDER BY updated_at DESC LIMIT 100")
          ) as Array<{ key: string; value: string; updated_at: string }>;
          const memories: MemoryRecord[] = rawMemories.map((m) => ({
            key: String(m.key),
            value: String(m.value),
            updatedAt: String(m.updated_at),
          }));
          return Response.json({ count: memories.length, memories });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch memories" }, { status: 500 });
        }
      }

      if (request.method === "DELETE") {
        try {
          const key = url.searchParams.get("key");
          if (key) {
            sql.exec("DELETE FROM mas_memory WHERE key = ?", key);
            this.audit("memory.deleted", "memory", { key });
          } else {
            sql.exec("DELETE FROM mas_memory");
            this.audit("memory.cleared", "memory", {});
          }
          return Response.json({ success: true });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to delete memory" }, { status: 500 });
        }
      }
    }

    // Clear active conversation transcript and reset session state
    if ((path.endsWith("/clear") || path.endsWith("/reset")) && (request.method === "POST" || request.method === "DELETE" || request.method === "GET")) {
      try {
        this.abortAllRequests("Session reset requested by user");
        this.resetTurnState();
        this.messages = [];
        await this.persistMessages([]);
        const purge = url.searchParams.get("purge") !== "false";
        if (purge) {
          sql.exec("DELETE FROM mas_messages WHERE session_id = ?", sessionId);
          this.audit("history.purged", "orchestrator", {});
        } else {
          this.audit("history.cleared", "orchestrator", {});
        }
        return Response.json({
          success: true,
          message: purge ? "All chat transcripts and session state purged from SQLite" : "Active chat cleared; historical analytics vault preserved in SQLite",
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to clear history" }, { status: 500 });
      }
    }

    // Referrals & Affiliate Links endpoint
    if (path.endsWith("/referrals")) {
      if (request.method === "GET") {
        try {
          const raw = Array.from(
            sql.exec("SELECT id, session_id, title, url, category, reward_text, clicks, signups, created_at FROM mas_referrals ORDER BY created_at DESC LIMIT 100")
          ) as any[];
          const referrals = raw.map((r) => ({
            id: String(r.id),
            userLogin: String(r.session_id),
            title: String(r.title),
            url: String(r.url),
            category: String(r.category),
            rewardText: String(r.reward_text),
            clicks: Number(r.clicks || 0),
            signups: Number(r.signups || 0),
            createdAt: String(r.created_at),
          }));
          return Response.json({ count: referrals.length, referrals });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch referrals" }, { status: 500 });
        }
      }

      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as {
            title?: string;
            url?: string;
            category?: string;
            rewardText?: string;
          };
          const title = (body.title || "").trim();
          const targetUrl = (body.url || "").trim();
          const category = (body.category || "AI & Dev Tools").trim();
          const rewardText = (body.rewardText || "Community referral reward").trim();

          if (!title || !targetUrl) {
            return Response.json({ error: "Title and Target URL are required" }, { status: 400 });
          }

          const id = `ref_${crypto.randomUUID().slice(0, 8)}`;
          const now = new Date().toISOString();
          sql.exec(
            "INSERT INTO mas_referrals (id, session_id, title, url, category, reward_text, clicks, signups, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
            id,
            sessionId,
            title,
            targetUrl,
            category,
            rewardText,
            now
          );
          this.audit("referral.created", "orchestrator", { id, title, targetUrl });
          return Response.json({
            success: true,
            referral: { id, userLogin: sessionId, title, url: targetUrl, category, rewardText, clicks: 0, signups: 0, createdAt: now },
          });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to save referral link" }, { status: 500 });
        }
      }

      if (request.method === "DELETE") {
        try {
          const id = url.searchParams.get("id");
          if (id) {
            sql.exec("DELETE FROM mas_referrals WHERE id = ?", id);
            this.audit("referral.deleted", "orchestrator", { id });
          }
          return Response.json({ success: true });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to delete referral" }, { status: 500 });
        }
      }
    }

    if (path.endsWith("/referrals/click") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        if (body.id) {
          sql.exec("UPDATE mas_referrals SET clicks = clicks + 1 WHERE id = ?", body.id);
        }
        return Response.json({ success: true });
      } catch {
        return Response.json({ success: false });
      }
    }

    // Sponsored Ads & Marketplace endpoint
    if (path.endsWith("/ads")) {
      if (request.method === "GET") {
        try {
          // Increment impressions on fetch
          sql.exec("UPDATE mas_ads SET impressions = impressions + 1");
          const raw = Array.from(
            sql.exec("SELECT id, title, tagline, sponsor, badge, url, cta_text, accent_color, impressions, clicks, created_at FROM mas_ads ORDER BY clicks DESC, impressions ASC LIMIT 20")
          ) as any[];
          const ads = raw.map((a) => ({
            id: String(a.id),
            title: String(a.title),
            tagline: String(a.tagline),
            sponsor: String(a.sponsor),
            badge: String(a.badge),
            url: String(a.url),
            ctaText: String(a.cta_text),
            accentColor: String(a.accent_color || "#6366f1"),
            impressions: Number(a.impressions || 0),
            clicks: Number(a.clicks || 0),
            createdAt: String(a.created_at),
          }));
          return Response.json({ count: ads.length, ads });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch ads" }, { status: 500 });
        }
      }

      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as {
            title?: string;
            tagline?: string;
            sponsor?: string;
            badge?: string;
            url?: string;
            ctaText?: string;
            accentColor?: string;
          };
          const title = (body.title || "").trim();
          const tagline = (body.tagline || "").trim();
          const sponsor = (body.sponsor || "Community Partner").trim();
          const badge = (body.badge || "PROMOTED").trim();
          const targetUrl = (body.url || "").trim();
          const ctaText = (body.ctaText || "Claim Deal →").trim();
          const accentColor = (body.accentColor || "#38bdf8").trim();

          if (!title || !targetUrl) {
            return Response.json({ error: "Title and Target URL are required" }, { status: 400 });
          }

          const id = `ad_${crypto.randomUUID().slice(0, 8)}`;
          const now = new Date().toISOString();
          sql.exec(
            "INSERT INTO mas_ads (id, title, tagline, sponsor, badge, url, cta_text, accent_color, impressions, clicks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)",
            id,
            title,
            tagline,
            sponsor,
            badge,
            targetUrl,
            ctaText,
            accentColor,
            now
          );
          this.audit("ad.submitted", "orchestrator", { id, title, sponsor });
          return Response.json({
            success: true,
            ad: { id, title, tagline, sponsor, badge, url: targetUrl, ctaText, accentColor, impressions: 1, clicks: 0, createdAt: now },
          });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to submit ad" }, { status: 500 });
        }
      }
    }

    if (path.endsWith("/ads/click") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        if (body.id) {
          sql.exec("UPDATE mas_ads SET clicks = clicks + 1 WHERE id = ?", body.id);
          this.audit("ad.clicked", "orchestrator", { id: body.id });
        }
        return Response.json({ success: true });
      } catch {
        return Response.json({ success: false });
      }
    }

    // ==========================================
    // Multi-Gateway Payments & DID Management API
    // ==========================================

    // Gateway status & DID registry
    if ((path.endsWith("/payments/gateways") || path.endsWith("/payments/status")) && request.method === "GET") {
      const paymentService = new PaymentGatewayService(this.env);
      const gateways = paymentService.getGatewayStatuses();
      return Response.json({
        gateways,
        agentDids: AGENT_DIDS,
        userDid: getUserDid(sessionId),
      });
    }

    // W3C DID Document resolver for agents
    if (path.endsWith("/payments/dids") && request.method === "GET") {
      const didParam = url.searchParams.get("did");
      if (didParam) {
        return Response.json(resolveAgentDidDocument(didParam));
      }
      const didDocs = Object.values(AGENT_DIDS).map((did) => resolveAgentDidDocument(did));
      return Response.json({
        count: didDocs.length,
        documents: didDocs,
      });
    }

    // Transaction ledger with DID provenance
    if (path.endsWith("/payments/transactions")) {
      if (request.method === "GET") {
        try {
          const raw = Array.from(
            sql.exec(
              "SELECT id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at FROM mas_transactions ORDER BY created_at DESC LIMIT 50"
            )
          ) as any[];

          const transactions = raw.map((t) => ({
            id: String(t.id),
            sessionId: String(t.session_id),
            action: String(t.action),
            amount: Number(t.amount || 0),
            currency: String(t.currency || "USD"),
            customer: String(t.customer),
            gateway: String(t.gateway || "stripe"),
            gatewayRef: String(t.gateway_ref || ""),
            status: String(t.status),
            checkoutUrl: String(t.checkout_url || ""),
            proposerDid: String(t.proposer_did || AGENT_DIDS.PAYMENTS),
            authorizerDid: t.authorizer_did ? String(t.authorizer_did) : undefined,
            proofSignature: String(t.proof_signature || ""),
            note: String(t.note || ""),
            createdAt: String(t.created_at),
            updatedAt: String(t.updated_at),
          }));

          const totalVolume = transactions
            .filter((t) => t.status === "completed" || t.status === "authorized")
            .reduce((sum, t) => sum + (t.action === "charge" ? t.amount : -t.amount), 0);

          const pendingCount = transactions.filter((t) => t.status === "awaiting_confirmation").length;
          const completedCount = transactions.filter((t) => t.status === "completed" || t.status === "authorized").length;

          return Response.json({
            count: transactions.length,
            transactions,
            summary: {
              totalVolume: Math.max(0, totalVolume),
              completedCount,
              pendingCount,
              verifiedDidCount: transactions.length,
            },
          });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transactions" }, { status: 500 });
        }
      }
    }

    // Create payment checkout / draft
    if (path.endsWith("/payments/create") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          amount?: number;
          currency?: string;
          customer?: string;
          action?: "charge" | "refund" | "invoice";
          gateway?: string;
          description?: string;
        };

        const amount = Number(body.amount) || 10;
        const currency = (body.currency || "USD").toUpperCase();
        const customer = (body.customer || "Enterprise Client").trim();
        const action = body.action || "charge";
        // Validate the gateway where caller input enters (issue #156): an
        // unsupported value is rejected with a 400 BEFORE any checkout is
        // attempted and BEFORE any transaction row is written. Normalization
        // matches the webhook verifier (#148), so " Stripe " stores "stripe".
        const gatewayInput =
          body.gateway == null || (typeof body.gateway === "string" && body.gateway.trim() === "")
            ? "stripe"
            : String(body.gateway);
        if (!isSupportedGateway(gatewayInput)) {
          return Response.json({
            success: false,
            error: `Unsupported payment gateway: "${gatewayInput}". Supported gateways: ${SUPPORTED_GATEWAYS.join(", ")}.`,
            code: "UNSUPPORTED_GATEWAY",
          }, { status: 400 });
        }
        const gateway = normalizeGateway(gatewayInput) as SupportedGateway;
        const description = (body.description || `AI Compute Tokens for ${customer}`).trim();

        const draftId = `pay_${crypto.randomUUID().slice(0, 8)}`;
        const userDid = getUserDid(sessionId);

        const paymentService = new PaymentGatewayService(this.env);
        const checkoutResult = await paymentService.createCheckout({
          draftId,
          amount,
          currency,
          customer,
          description,
          gateway,
          userLogin: sessionId,
        });

        if (!checkoutResult.success) {
          return Response.json({
            success: false,
            error: checkoutResult.message || `Failed to create checkout with ${gateway}`,
            code: "PAYMENT_GATEWAY_ERROR",
          }, { status: 400 });
        }

        const now = new Date().toISOString();
        const initialStatus = checkoutResult.checkoutUrl ? "pending_checkout" : "completed";
        sql.exec(
          "INSERT INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          draftId,
          sessionId,
          action,
          amount,
          currency,
          customer,
          gateway,
          checkoutResult.gatewayRef || "",
          initialStatus,
          checkoutResult.checkoutUrl,
          AGENT_DIDS.PAYMENTS,
          userDid,
          checkoutResult.didAttestation.signature,
          description,
          now,
          now
        );

        this.audit("payment.created", "payments", {
          draftId,
          amount,
          currency,
          customer,
          gateway,
          proposerDid: AGENT_DIDS.PAYMENTS,
          authorizerDid: userDid,
          proofSignature: checkoutResult.didAttestation.signature,
        });

        return Response.json({
          success: true,
          transaction: {
            id: draftId,
            sessionId,
            action,
            amount,
            currency,
            customer,
            gateway,
            gatewayRef: checkoutResult.gatewayRef,
            status: initialStatus,
            checkoutUrl: checkoutResult.checkoutUrl,
            proposerDid: AGENT_DIDS.PAYMENTS,
            authorizerDid: userDid,
            proofSignature: checkoutResult.didAttestation.signature,
            note: description,
            createdAt: now,
            updatedAt: now,
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to create payment" }, { status: 500 });
      }
    }

    // Authorize & Execute a pending payment draft (HITL)
    if (path.endsWith("/payments/confirm") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          draftId?: string;
          decision?: "approved" | "rejected";
          note?: string;
        };

        const draftId = (body.draftId || "").trim();
        const decision = body.decision || "approved";
        const note = (body.note || "").trim();

        if (!draftId) {
          return Response.json({ error: "draftId is required" }, { status: 400 });
        }

        const userDid = getUserDid(sessionId);
        const now = new Date().toISOString();

        if (decision === "approved") {
          // Retrieve draft from mas_transactions
          const rows = Array.from(sql.exec("SELECT * FROM mas_transactions WHERE id = ?", draftId)) as any[];
          const tx = rows[0];
          const paymentService = new PaymentGatewayService(this.env);

          let checkoutUrl = tx?.checkout_url || "";
          let gatewayRef = tx?.gateway_ref || "";

          if (tx && (tx.action === "charge" || tx.action === "invoice") && !checkoutUrl) {
            const res = await paymentService.createCheckout({
              draftId,
              amount: Number(tx.amount),
              currency: String(tx.currency || "USD"),
              customer: String(tx.customer),
              gateway: tx.gateway as SupportedGateway,
              userLogin: sessionId,
              description: tx.note || "Authorized payment intent",
            });
            checkoutUrl = res.checkoutUrl;
            gatewayRef = res.gatewayRef;
          } else if (tx && tx.action === "refund") {
            const res = await paymentService.executeRefund({
              transactionId: draftId,
              amount: Number(tx.amount),
              gateway: tx.gateway as SupportedGateway,
              gatewayRef: tx.gateway_ref,
              userLogin: sessionId,
              reason: note,
            });
            gatewayRef = res.refundId;
          }

          sql.exec(
            "UPDATE mas_transactions SET status = 'completed', gateway_ref = ?, checkout_url = ?, authorizer_did = ?, note = ?, updated_at = ? WHERE id = ?",
            gatewayRef,
            checkoutUrl,
            userDid,
            note || "Confirmed by human authorizer",
            now,
            draftId
          );

          this.audit("payment.confirmed", "payments", {
            draftId,
            authorizerDid: userDid,
            executorDid: AGENT_DIDS.ORCHESTRATOR,
            gatewayRef,
            checkoutUrl,
          });

          return Response.json({
            success: true,
            status: "completed",
            draftId,
            checkoutUrl,
            gatewayRef,
            authorizerDid: userDid,
          });
        } else {
          sql.exec(
            "UPDATE mas_transactions SET status = 'rejected', authorizer_did = ?, note = ?, updated_at = ? WHERE id = ?",
            userDid,
            note || "Rejected by reviewer",
            now,
            draftId
          );

          this.audit("payment.rejected", "payments", { draftId, authorizerDid: userDid });
          return Response.json({ success: true, status: "rejected", draftId });
        }
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to confirm payment draft" }, { status: 500 });
      }
    }

    // Real payment capture endpoint (PayPal & Stripe)
    if (path.endsWith("/payments/capture") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          orderId?: string;
          gateway?: SupportedGateway;
        };
        const orderId = (body.orderId || "").trim();
        const gateway = (body.gateway || "paypal") as SupportedGateway;
        if (!orderId) {
          return Response.json({ error: "orderId is required" }, { status: 400 });
        }
        const paymentService = new PaymentGatewayService(this.env);
        const result = await paymentService.capturePayment({
          gateway,
          orderId,
          userLogin: sessionId,
        });

        if (result.success) {
          const now = new Date().toISOString();
          sql.exec(
            "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ? OR gateway_ref = ?",
            now,
            orderId,
            orderId
          );
          this.audit("payment.captured", "payments", { orderId, gateway, captureId: result.captureId });
        }

        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to capture payment" }, { status: 500 });
      }
    }

    // Unified Payment Webhook listener (Stripe, PayPal, Lemon Squeezy with HMAC Verification)
    if (path.endsWith("/payments/webhook") && request.method === "POST") {
      try {
        const providerParam = url.searchParams.get("provider") || "stripe";
        const provider = normalizeGateway(providerParam) as SupportedGateway;

        // Defence in depth (issue #148): reject unsupported providers at
        // the route, before verification and before any state change. The
        // service's verifier independently default-denies them; a webhook
        // from an unverifiable provider must never settle a transaction.
        if (!isWebhookGateway(provider)) {
          return Response.json({ error: `Unsupported webhook provider: ${providerParam}` }, { status: 401 });
        }

        const rawBody = await request.text();
        const paymentService = new PaymentGatewayService(this.env);

        // Verify cryptographic webhook signature
        const verification = await paymentService.verifyWebhookSignature(provider, rawBody, request.headers);
        if (!verification.isValid) {
          return Response.json({ error: verification.reason || "Invalid webhook signature" }, { status: 401 });
        }

        let body: any = {};
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = {};
        }

        const now = new Date().toISOString();

        // Extract reference ID from Stripe / PayPal / Lemon Squeezy payload
        const draftId = body?.data?.object?.client_reference_id ||
          body?.resource?.purchase_units?.[0]?.reference_id ||
          body?.data?.attributes?.checkout_data?.custom?.draftId ||
          body?.draftId;

        if (draftId) {
          sql.exec(
            "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ?",
            now,
            draftId
          );
          this.audit("payment.settled_webhook", "payments", { draftId, provider, raw: body?.type || body?.event_type });
        }

        return Response.json({ received: true });
      } catch {
        return Response.json({ received: false }, { status: 400 });
      }
    }

    // ==========================================
    // Cloudflare Agentic Payments (x402 & MPP)
    // ==========================================

    // Agentic Wallet Status & Micropayment Metrics
    if ((path.endsWith("/payments/agentic/wallet") || path.includes("/payments/agentic/wallet")) && request.method === "GET") {
      try {
        const paymentService = new ETradeAgenticPaymentService(this.getOrm(), this.env, sessionId);
        const status = await paymentService.getWalletStatus();
        return Response.json(status);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to fetch wallet status" }, { status: 500 });
      }
    }

    // Agentic Auto-Approve Limit (HITL threshold)
    if (path.endsWith("/payments/agentic/auto-approve-limit") || path.includes("/payments/agentic/auto-approve-limit")) {
      const paymentService = new ETradeAgenticPaymentService(this.getOrm(), this.env, sessionId);
      if (request.method === "GET") {
        return Response.json({
          autoApproveLimitUSD: paymentService.getAutoApproveLimit(),
          network: this.env.X402_NETWORK || "base-sepolia",
        });
      }
      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as any;
          const limit = Number(body.limitUSD !== undefined ? body.limitUSD : body.limit);
          if (isNaN(limit) || limit < 0) {
            return Response.json({ error: "Invalid limitUSD. Must be non-negative number." }, { status: 400 });
          }
          paymentService.setAutoApproveLimit(limit);
          this.audit("agentic_payment.limit_updated", "payments", { limitUSD: limit });
          return Response.json({ success: true, autoApproveLimitUSD: limit });
        } catch (err: any) {
          return Response.json({ error: err.message || "Failed to update limit" }, { status: 500 });
        }
      }
    }

    // Paid Trading Service: Institutional Options & Greeks Screener ($0.05 USDC)
    if (path.includes("/premium/options-scan") && (request.method === "GET" || request.method === "POST")) {
      const paymentService = new ETradeAgenticPaymentService(this.getOrm(), this.env, sessionId);
      const tier = TRADING_PAID_SERVICES.OPTIONS_SCREENER;

      return paymentService.handleGatedEndpoint(
        request,
        tier.resource,
        tier.priceUSD,
        tier.description,
        async (receipt) => {
          let filter: any = {};
          if (request.method === "POST") {
            filter = (await request.json().catch(() => ({}))) as any;
          } else {
            filter = {
              underlyingSymbols: url.searchParams.get("symbol") ? [url.searchParams.get("symbol")!.toUpperCase().trim()] : undefined,
              maxUnderlyings: url.searchParams.get("maxUnderlyings") ? Number(url.searchParams.get("maxUnderlyings")) : undefined,
              contractType: url.searchParams.get("contractType") || "BOTH",
              minDelta: url.searchParams.get("minDelta") ? Number(url.searchParams.get("minDelta")) : undefined,
              maxDelta: url.searchParams.get("maxDelta") ? Number(url.searchParams.get("maxDelta")) : undefined,
              minVolume: url.searchParams.get("minVolume") ? Number(url.searchParams.get("minVolume")) : undefined,
              minOpenInterest: url.searchParams.get("minOpenInterest") ? Number(url.searchParams.get("minOpenInterest")) : undefined,
              maxSpreadPct: url.searchParams.get("maxSpreadPct") ? Number(url.searchParams.get("maxSpreadPct")) : undefined,
              maxQuoteAgeSeconds: url.searchParams.get("maxQuoteAgeSeconds") ? Number(url.searchParams.get("maxQuoteAgeSeconds")) : undefined,
              minDte: url.searchParams.get("minDte") ? Number(url.searchParams.get("minDte")) : undefined,
              maxDte: url.searchParams.get("maxDte") ? Number(url.searchParams.get("maxDte")) : undefined,
              limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
            };
          }
          const userLogin = request.headers.get("x-user-login") || sessionId || "premium_subscriber";
          const rawEnvHdr = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
          const reqEnvLocal = (rawEnvHdr === "TEST" || rawEnvHdr === "PROD") ? rawEnvHdr : undefined;
          const etrade = new ETradeService(this.getOrm(), this.env, userLogin, reqEnvLocal);
          const screener = new DynamicOptionsScreener(etrade.client);
          const result = await screener.screenOptions(filter);
          const failed = result.status === "error";
          return {
            success: !failed,
            service: tier.name,
            receipt,
            screenResult: result,
            ...(failed
              ? {
                  error:
                    result.validationError ||
                    result.fetchErrors?.[0]?.reason ||
                    "Options screen failed upstream; no data could be fetched.",
                }
              : {}),
          };
        }
      );
    }

    // Paid Trading Service: Autonomous Equity Research Report ($0.10 USDC)
    if (path.includes("/premium/market-research") && (request.method === "GET" || request.method === "POST")) {
      const paymentService = new ETradeAgenticPaymentService(this.getOrm(), this.env, sessionId);
      const tier = TRADING_PAID_SERVICES.MARKET_RESEARCH;

      return paymentService.handleGatedEndpoint(
        request,
        tier.resource,
        tier.priceUSD,
        tier.description,
        async (receipt) => {
          let symbol = "NVDA";
          if (request.method === "POST") {
            const body = (await request.json().catch(() => ({}))) as any;
            if (body.symbol) symbol = String(body.symbol).toUpperCase().trim();
          } else {
            const sym = url.searchParams.get("symbol");
            if (sym) symbol = sym.toUpperCase().trim();
          }

          const foss = new FossResearchService(this.env);
          const report = await foss.generateResearchReport(symbol);
          return {
            success: true,
            service: tier.name,
            receipt,
            report,
          };
        }
      );
    }

    // Paid Trading Service: Real-Time Quantitative Anomaly Signals ($0.02 USDC)
    if (path.includes("/premium/stock-signals") && (request.method === "GET" || request.method === "POST")) {
      const paymentService = new ETradeAgenticPaymentService(this.getOrm(), this.env, sessionId);
      const tier = TRADING_PAID_SERVICES.STOCK_SIGNALS;

      return paymentService.handleGatedEndpoint(
        request,
        tier.resource,
        tier.priceUSD,
        tier.description,
        async (receipt) => {
          let symbols = ["NVDA", "AAPL", "MSFT", "TSLA"];
          if (request.method === "POST") {
            const body = (await request.json().catch(() => ({}))) as any;
            if (Array.isArray(body.symbols) && body.symbols.length > 0) symbols = body.symbols;
          } else {
            const sym = url.searchParams.get("symbols") || url.searchParams.get("symbol");
            if (sym) symbols = sym.split(",").map(s => s.trim().toUpperCase());
          }

          const screener = new YFinanceMarketScreener();
          const screen = await screener.screenMarkets({ search: symbols.join(",") });
          const signals = screen.stocks.map(stock => ({
            symbol: stock.symbol,
            price: stock.price,
            changePercent: stock.changePercent,
            rsi: stock.rsi,
            volume: stock.volume,
            signalType: (stock.rsi && stock.rsi < 35) ? "OVERSOLD_BOUNCE" : (stock.rsi && stock.rsi > 70) ? "OVERBOUGHT_MOMENTUM" : "TREND_CONTINUATION",
            confidence: 0.88,
            timestamp: new Date().toISOString(),
          }));

          return {
            success: true,
            service: tier.name,
            receipt,
            count: signals.length,
            signals,
          };
        }
      );
    }

    // ==========================================
    // Environment & E*TRADE Trading APIs
    // ==========================================

    const rawEnvHeader = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
    const requestedEnv: "TEST" | "PROD" | undefined = (rawEnvHeader === "TEST" || rawEnvHeader === "PROD") ? rawEnvHeader : undefined;

    // Environment Switcher API (allows client to toggle between Sandbox TEST and Live PROD)
    if (path.endsWith("/environment/switch") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const requested = String(body.environment || "PROD").toUpperCase().trim();
        if (requested === "TEST" || requested === "PROD") {
          return Response.json({ success: true, environment: requested });
        }
        return Response.json({ error: "Invalid environment. Expected TEST or PROD." }, { status: 400 });
      } catch (err) {
        return Response.json({ error: "Failed to switch environment" }, { status: 500 });
      }
    }

    // Broker status & account metadata
    if (path.endsWith("/etrade/status") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const status = await etrade.getStatusAsync();
        return Response.json(status);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch broker status" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API Diagnostics
    if (path.endsWith("/etrade/diagnostics") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const envConfig = resolveEnvironmentConfig(this.env, requestedEnv);
        const valid = await getValidTokens(this.env, userLogin, requestedEnv);
        const client = new ETradeRestClient(this.env, userLogin, requestedEnv);

        let accounts: any[] = [];
        let balance: any = null;
        let lastError: string | null = null;

        if (valid) {
          accounts = await client.fetchAccounts();
          lastError = client.getLastError() || null;
          if (accounts.length > 0) {
            const key = accounts[0].accountKey || accounts[0].accountId;
            balance = await client.fetchBalance(key);
          }
        } else {
          lastError = client.getLastError() || `No active OAuth session in [${envConfig.name}] mode. Click 'Connect E*TRADE Account'.`;
        }

        return Response.json({
          status: accounts.length > 0 ? "healthy" : (valid ? "upstream_error" : "auth_required"),
          environment: envConfig.name,
          isLive: envConfig.isLive,
          apiUrl: envConfig.etrade.baseUrl,
          userLogin,
          credentials: {
            apiKeyConfigured: Boolean(envConfig.etrade.apiKey),
            apiKeyMasked: envConfig.etrade.apiKey ? `${envConfig.etrade.apiKey.slice(0, 4)}...${envConfig.etrade.apiKey.slice(-4)}` : "MISSING",
            apiSecretConfigured: Boolean(envConfig.etrade.apiSecret),
          },
          oauthToken: {
            present: Boolean(valid),
            storedAt: valid?.storedAt || null,
            environment: valid?.environment || envConfig.name,
            validUntilMidnightEt: "E*TRADE access tokens expire at midnight US Eastern Time",
          },
          upstreamAccounts: {
            count: accounts.length,
            accounts,
          },
          upstreamBalance: balance,
          lastError,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to run diagnostics" }, { status: 500 });
      }
    }

    // Broker Accounts List (Real E*TRADE REST / OAuth 1.0a)
    if (path.endsWith("/etrade/accounts") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const accounts = await etrade.fetchAccountsRemote();
        return Response.json({ count: accounts.length, accounts });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch accounts" }, { status: 500 });
      }
    }

    // Market Screener & Scanning — delegated to ScreenerAgent (#261).
    // One agent, E*TRADE-only market data, honest failure when unavailable.
    // (The Nasdaq-listings screenLive path is kept in the repo, unwired.)
    if (path.endsWith("/etrade/screen") && (request.method === "POST" || request.method === "GET")) {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const filters = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
        if (request.method === "GET") {
          if (url.searchParams.get("sector")) filters.sector = url.searchParams.get("sector");
          if (url.searchParams.get("maxRsi")) filters.maxRsi = Number(url.searchParams.get("maxRsi"));
          if (url.searchParams.get("minRsi")) filters.minRsi = Number(url.searchParams.get("minRsi"));
          if (url.searchParams.get("gainersOnly")) filters.gainersOnly = url.searchParams.get("gainersOnly") === "true";
          if (url.searchParams.get("losersOnly")) filters.losersOnly = url.searchParams.get("losersOnly") === "true";
          if (url.searchParams.get("universe")) filters.universe = url.searchParams.get("universe");
        }
        // Issue #270: universe selection; "ALL" auto-shards into parallel runs.
        // Issue #289: default to NASDAQ100 (deterministic top-100) instead of
        // TECH (fuzzy keyword match with unpredictable symbol count).
        const universe = (filters.universe as string) || "NASDAQ100";
        const agent = this.getScreenerAgent();
        if (universe === "ALL") {
          const shards = await agent.runSharded({ trigger: "manual", filters, userLogin });
          const failed = shards.filter((r) => !r.success);
          if (failed.length === shards.length) {
            return Response.json({ error: failed[0]?.error || "E*TRADE unavailable" }, { status: 502 });
          }
          this.audit("etrade.screened", "trading", {
            filterSummary: `ALL (sharded: ${shards.length} universes)`,
            count: shards.reduce((n, r) => n + r.allStocks.length, 0),
            success: true,
          });
          return Response.json({
            sharded: true,
            universes: shards.map((r) => ({
              universe: r.universe,
              totalScanned: r.totalScanned,
              matchedCount: r.matchedCount,
              opportunities: r.opportunities,
              stocks: r.allStocks,
              discoveryMessage: r.discoveryMessage,
              scannedAt: r.timestamp,
              success: r.success,
              error: r.error,
            })),
          });
        }
        const result = await agent.runScreen({
          trigger: "manual",
          filters,
          universe: universe as any,
          userLogin,
        });
        this.audit("etrade.screened", "trading", {
          filterSummary: result.discoveryMessage,
          count: result.allStocks.length,
          success: result.success,
        });
        if (!result.success) {
          return Response.json({ error: result.error || "E*TRADE unavailable" }, { status: 502 });
        }
        return Response.json({
          universe: result.universe,
          totalScanned: result.totalScanned,
          matchedCount: result.matchedCount,
          opportunities: result.opportunities,
          stocks: result.allStocks,
          discoveryMessage: result.discoveryMessage,
          scannedAt: result.timestamp,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to screen equities" }, { status: 500 });
      }
    }

    // Real-time equity quote (Real E*TRADE REST / OAuth 1.0a)
    if (path.endsWith("/etrade/quote") && request.method === "GET") {
      try {
        const rawSym = url.searchParams.get("symbol") || "NVDA";
        const symbol = rawSym.toUpperCase().trim() || "NVDA";
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const quote = await etrade.fetchQuoteRemote(symbol);
        return Response.json(quote, {
          headers: {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch quote" }, { status: 500 });
      }
    }

    // Order Proposal & Preview with DID Attestation (HITL)
    if (path.endsWith("/etrade/order/preview") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const symbol = (body.symbol || "").trim().toUpperCase();
        const quantity = Number(body.quantity) || 1;
        const rawAction = String(body.orderAction || body.action || "BUY").toUpperCase().trim();
        const validActions = ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"];
        const orderAction = (validActions.includes(rawAction) ? rawAction : "BUY") as "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
        const orderType = body.orderType || "MARKET";
        const limitPrice = body.limitPrice !== undefined ? Number(body.limitPrice) : undefined;
        const stopPrice = body.stopPrice !== undefined ? Number(body.stopPrice) : undefined;
        const optionLegs = Array.isArray(body.optionLegs) ? body.optionLegs : undefined;
        const inferredAssetClass = optionLegs?.some((leg: any) => leg.securityType === "OPTN") ? "options" : "equity";
        const rawAssetClass = body.assetClass === undefined ? inferredAssetClass : String(body.assetClass).toLowerCase();
        if (rawAssetClass !== "equity" && rawAssetClass !== "options") {
          return Response.json({ error: `Unsupported order asset class: ${rawAssetClass}.` }, { status: 400 });
        }
        const assetClass = rawAssetClass as "equity" | "options";
        if (assetClass === "options" && !optionLegs?.some((leg: any) => leg.securityType === "OPTN")) {
          return Response.json({ error: "Options orders require at least one complete option contract leg." }, { status: 400 });
        }
        if (assetClass === "equity" && optionLegs?.some((leg: any) => leg.securityType === "OPTN")) {
          return Response.json({ error: "Option contract legs must be routed as an options order." }, { status: 400 });
        }

        if (!symbol) {
          return Response.json({ error: "Order symbol is required" }, { status: 400 });
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const preview = await etrade.previewOrderRemote({
          assetClass,
          sessionId,
          symbol,
          orderAction,
          quantity,
          orderType,
          limitPrice,
          stopPrice,
          optionLegs,
          strategyNetDebit: body.strategyNetDebit !== undefined ? Number(body.strategyNetDebit) : undefined,
        });

        this.audit("etrade.order_previewed", "trading", {
          orderId: preview.orderId,
          symbol: preview.symbol,
          orderAction: preview.orderAction,
          quantity: preview.quantity,
          estimatedTotal: preview.estimatedTotal,
          proposerDid: preview.proposerDid,
        });

        // Autopilot policy envelope (autopilot Phase 1). Evaluated server-side
        // and recorded with a signed verdict. Paused ⇒ advisory (the human
        // authorizer still decides); running ⇒ hard gate, re-checked at execute.
        try {
          const evaluated = await this.evaluateAndRecordAutopilotVerdict({
            userLogin,
            requestedEnv,
            sessionId,
            draftId: preview.orderId,
            intent: {
              symbol: preview.symbol,
              action: preview.orderAction,
              quantity: preview.quantity,
              orderType: preview.orderType,
              estimatedPrice: typeof preview.estimatedPrice === "number" ? preview.estimatedPrice : null,
              estimatedTotal: typeof preview.estimatedTotal === "number" ? preview.estimatedTotal : null,
            },
          });
          (preview as any).policyVerdict = evaluated.verdict;
          if (!evaluated.verdict.executionAllowed) {
            return Response.json(
              {
                error: `Autopilot policy blocked this order: ${evaluated.verdict.detail}`,
                bindingRule: evaluated.verdict.bindingRule,
                policyVerdict: evaluated.verdict,
              },
              { status: 409 }
            );
          }
        } catch (policyErr) {
          console.warn("[OrchestratorAgent] Autopilot policy evaluation failed at preview:", policyErr);
          this.audit("autopilot.policy_check_failed", "trading", {
            stage: "preview",
            orderId: preview.orderId,
            error: policyErr instanceof Error ? policyErr.message : String(policyErr),
          });
          if (this.getAutopilotState().running) {
            return Response.json(
              { error: "Autopilot policy check could not be completed; refusing to preview while autopilot is running." },
              { status: 503 }
            );
          }
        }

        // Schedule a 15-minute expiration timer (900 seconds) for this draft
        try {
          const expSchedule = await this.schedule(900, "expireStaleOrderDraft", { orderId: preview.orderId, userLogin });
          if (expSchedule?.id) {
            preview.expirationScheduleId = expSchedule.id;
            preview.expiresAt = new Date(Date.now() + 900 * 1000).toISOString();
            this.getOrm().trades?.update(preview.orderId, {
              expirationScheduleId: expSchedule.id,
              updatedAt: new Date().toISOString(),
            });
          }
        } catch (schedErr) {
          console.warn("[OrchestratorAgent] Note: could not schedule expiration timer:", schedErr);
        }

        // Dispatch Pre-Trade Approval Ticket Block Kit card to Slack (Strict HITL Gate)
        try {
          const slackService = new ETradeSlackTradingService(this.env, this.getOrm(), sessionId);
          await slackService.sendPreTradeApprovalTicket({
            orderId: preview.orderId,
            symbol: preview.symbol,
            action: preview.orderAction as any,
            quantity: preview.quantity,
            orderType: preview.orderType as any,
            limitPrice: preview.limitPrice,
            estimatedPrice: preview.estimatedPrice,
            estimatedTotal: preview.estimatedTotal,
            proposerDid: preview.proposerDid,
            expiresAt: preview.expiresAt,
          });
        } catch (slackErr) {
          console.warn("[OrchestratorAgent] Note: could not dispatch Slack pre-trade ticket:", slackErr);
        }

        return Response.json(preview);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to preview trade order" }, { status: 500 });
      }
    }

    // Authorize & Execute Confirmed Order Draft (HITL Execution via OAuth 1.0a)
    if (path.endsWith("/etrade/order/execute") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const orderId = (body.orderId || body.draftId || "").trim();
        const decision = body.decision;

        if (!orderId) {
          return Response.json({ error: "orderId is required" }, { status: 400 });
        }

        if (decision !== "approved" && decision !== "rejected") {
          return Response.json({ error: "decision must be either 'approved' or 'rejected'" }, { status: 400 });
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const userDid = getUserDid(sessionId);

        // Strict HITL Gate: block autonomous agents
        if (userDid.startsWith("did:agent:")) {
          return Response.json({ error: "HITL Enforcement: Autonomous trade execution is strictly prohibited. Orders require verified human authorization." }, { status: 403 });
        }

        const existingRecord = this.getOrm().trades?.findById(orderId);
        if (!existingRecord) {
          return Response.json({ error: `Order draft '${orderId}' not found. All orders must be previewed and drafted prior to execution.` }, { status: 404 });
        }

        if (existingRecord.status !== "previewed") {
          return Response.json({ error: `Order draft '${orderId}' cannot be executed. Current status is '${existingRecord.status}'. Only 'previewed' drafts may be executed.` }, { status: 400 });
        }

        // Handle user rejection / cancellation immediately
        if (decision === "rejected") {
          if (existingRecord.expirationScheduleId) {
            try {
              await this.cancelSchedule(existingRecord.expirationScheduleId);
            } catch {
              // Ignore cancel error if already triggered
            }
          }
          if (this.getOrm().trades) {
            this.getOrm().trades.update(orderId, {
              status: "rejected",
              authorizerDid: userDid,
              updatedAt: new Date().toISOString(),
            });
          }
          return Response.json({
            success: true,
            orderId,
            status: "rejected",
            message: `Order draft '${orderId}' cancelled by user. No broker order submitted.`,
          });
        }

        // Strict Immutability Verification: Ensure submitted parameters strictly match the previewed draft
        const reqAction = (body.action || body.orderAction || "").toUpperCase().trim();
        if (reqAction && reqAction !== existingRecord.action.toUpperCase()) {
          return Response.json({
            error: `Order Action Mismatch: Previewed action is '${existingRecord.action}', but execution request specifies '${reqAction}'. Submission rejected. A fresh preview is required.`,
          }, { status: 422 });
        }

        const reqSymbol = (body.symbol || "").toUpperCase().trim();
        if (reqSymbol && reqSymbol !== existingRecord.symbol.toUpperCase()) {
          return Response.json({
            error: `Order Symbol Mismatch: Previewed symbol is '${existingRecord.symbol}', but execution request specifies '${reqSymbol}'. Submission rejected.`,
          }, { status: 422 });
        }

        if (body.quantity !== undefined && Number(body.quantity) !== Number(existingRecord.quantity)) {
          return Response.json({
            error: `Order Quantity Mismatch: Previewed quantity is ${existingRecord.quantity}, but execution request specifies ${body.quantity}. Submission rejected.`,
          }, { status: 422 });
        }

        const symbol = existingRecord.symbol.toUpperCase();
        const action = existingRecord.action as any;
        const quantity = Number(existingRecord.quantity);
        const orderType = existingRecord.orderType || "MARKET";
        const limitPrice = existingRecord.orderType === "LIMIT" ? existingRecord.price : undefined;
        let strategyOrder: any = undefined;
        if (existingRecord.previewNotes?.startsWith("{")) {
          try {
            const stored = JSON.parse(existingRecord.previewNotes);
            if (stored?.kind === "strategy-order-v1" && Array.isArray(stored.optionLegs)) strategyOrder = stored;
          } catch {
            // Legacy human-readable preview notes are not structured order payloads.
          }
        }

        // Autopilot policy envelope gate (autopilot Phase 1). Re-evaluated at
        // execution time because orders/day, drawdown, and exposure may have
        // moved since the draft was previewed.
        let executionVerdict: PolicyVerdict | null = null;
        try {
          const evaluated = await this.evaluateAndRecordAutopilotVerdict({
            userLogin,
            requestedEnv,
            sessionId,
            draftId: orderId,
            intent: {
              symbol,
              action,
              quantity,
              orderType,
              estimatedPrice: typeof existingRecord.price === "number" ? existingRecord.price : null,
              estimatedTotal: typeof existingRecord.totalValue === "number" ? existingRecord.totalValue : null,
            },
          });
          executionVerdict = evaluated.verdict;
          if (!evaluated.verdict.executionAllowed) {
            return Response.json(
              {
                error: `Autopilot policy blocked execution: ${evaluated.verdict.detail}`,
                bindingRule: evaluated.verdict.bindingRule,
                policyVerdict: evaluated.verdict,
              },
              { status: 409 }
            );
          }
        } catch (policyErr) {
          console.warn("[OrchestratorAgent] Autopilot policy evaluation failed at execute:", policyErr);
          this.audit("autopilot.policy_check_failed", "trading", {
            stage: "execute",
            orderId,
            error: policyErr instanceof Error ? policyErr.message : String(policyErr),
          });
          if (this.getAutopilotState().running) {
            return Response.json(
              { error: "Autopilot policy check could not be completed; refusing to execute while autopilot is running." },
              { status: 503 }
            );
          }
        }

        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        let result: any;

        if (this.env.ETRADE_CONSUMER_KEY || this.env.ETRADE_MCP_SERVER_URL || this.env.ET_API_KEY) {
          result = await etrade.placeOrderRemote({
            orderId,
            symbol,
            action,
            quantity,
            orderType,
            limitPrice,
            previewId: body.previewId && String(body.previewId).trim() !== ""
              ? String(body.previewId).trim()
              : existingRecord?.orderRef && String(existingRecord.orderRef).trim() !== ""
              ? String(existingRecord.orderRef).trim()
              : undefined,
            optionLegs: strategyOrder?.optionLegs,
            strategyNetDebit: strategyOrder?.strategyNetDebit,
            userLogin,
          });
          if (result.success && this.getOrm().trades) {
            this.getOrm().trades.update(orderId, {
              status: "executed",
              orderRef: result.executionId,
              authorizerDid: userDid,
              updatedAt: new Date().toISOString(),
            });
            this.incrementAutopilotOrdersToday();
          }
        } else {
          result = etrade.executeOrder(orderId, userDid, decision);
        }

        // Cancel the scheduled expiration timer since the order has been executed
        if (existingRecord.expirationScheduleId) {
          try {
            await this.cancelSchedule(existingRecord.expirationScheduleId);
          } catch {
            // Ignore cancel error if already triggered
          }
        }

        this.audit("etrade.order_executed", "trading", {
          orderId,
          decision,
          authorizerDid: userDid,
          status: result.status,
          executionId: result.executionId,
          policyVerdictId: executionVerdict?.verdictId ?? null,
        });

        // Automatically dispatch official transaction snap to Slack via ETradeBrowserService
        if (result.status === "executed" || result.success) {
          try {
            const browserService = new ETradeBrowserService(this.env);
            await browserService.sendTransactionSnapToSlack({
              transactionId: orderId,
              symbol,
              action,
              quantity,
              price: existingRecord.price || (typeof limitPrice === "number" ? limitPrice : 0),
              orderType,
              status: "EXECUTED",
              totalValue: existingRecord.totalValue || (quantity * (existingRecord.price || 0)),
              environment: (this.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
              timestamp: new Date().toISOString(),
              // This route is the HITL authorize/execute gate: execution
              // here means the session user submitted decision "approved"
              // for this draft (issue #120).
              humanApproved: decision === "approved",
            });
          } catch (snapErr) {
            console.warn("[OrchestratorAgent] Note: could not send transaction snap to Slack:", snapErr);
          }
        }

        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to execute trade order" }, { status: 500 });
      }
    }

    // Positions & Account Holdings (Real E*TRADE OAuth 1.0a)
    if (path.endsWith("/etrade/positions") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const holdings = await etrade.fetchPortfolioRemote(undefined, true);
        const lastError = etrade.getLastError();
        return Response.json({
          ...holdings,
          error: lastError && holdings.account.accountId === "unconnected" ? lastError : undefined,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch positions" }, { status: 500 });
      }
    }

    // Portfolio-level risk aggregation (issue #34, gap G1): aggregate Greeks,
    // SPY beta-weighted Delta, and total defined max loss from open positions.
    if (path.endsWith("/etrade/portfolio-risk") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const report = await computePortfolioRisk(etrade);
        return Response.json(report);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to compute portfolio risk" }, { status: 500 });
      }
    }

    // Post-trade evaluation (issue #34): current portfolio totals plus a
    // candidate's Greek contribution, without executing anything.
    if (path.endsWith("/etrade/portfolio-risk/evaluate") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { candidate?: CandidateGreekContribution };
        if (!body.candidate) {
          return Response.json({ error: "candidate Greek contribution is required" }, { status: 400 });
        }
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const { account, positions } = await etrade.fetchPortfolioRemote(undefined, true);
        const resolved = await resolvePositionsSnapshot(etrade, positions);
        const spyChain = await etrade.getOptionChains({ symbol: "SPY" }).catch(() => null);
        const report = aggregatePortfolioRisk(resolved, {
          nav: account.netAccountValue || account.totalAccountValue || 0,
          spyPrice: spyChain?.underlyingPrice ?? null,
          asOf: new Date().toISOString(),
        });
        return Response.json({ current: report, postTradeTotals: evaluatePostTradeTotals(report, body.candidate) });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to evaluate post-trade totals" }, { status: 500 });
      }
    }

    // Correlation & concentration assessment (issue #35, gap G2): pairwise
    // correlations among held names plus, for an optional candidate, flags
    // naming the correlated/concentrated positions it would duplicate.
    // Correlations are measured from live history, proxied by sector, or
    // reported unknown — never silently zero.
    if (path.endsWith("/etrade/portfolio-risk/correlation") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { candidateSymbol?: string };
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const report = await computePortfolioRisk(etrade);
        const concentration = await assessPortfolioConcentration(
          report,
          (a, b) => sharedCorrelationService.estimate(a, b),
          body.candidateSymbol,
        );
        return Response.json(concentration);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to assess concentration" }, { status: 500 });
      }
    }

    // Portfolio-aware position sizing (issue #36, gap G3): size a candidate
    // against the current book's risk budgets; the response names the
    // binding constraint.
    if (path.endsWith("/etrade/portfolio-risk/size") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { candidate?: SizingCandidate };
        if (!body.candidate?.symbol || !body.candidate?.perContract) {
          return Response.json({ error: "candidate with symbol and perContract contributions is required" }, { status: 400 });
        }
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const report = await computePortfolioRisk(etrade);
        return Response.json(sizeCandidateAgainstPortfolio(report, body.candidate));
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to size candidate" }, { status: 500 });
      }
    }

    // Hedge proposals (issue #54): DRAFT hedging proposals sized from the
    // portfolio aggregates — for the HITL order-preview flow only; this
    // endpoint never places or previews an order itself.
    // Think-harness guardrail verdicts (issue #67): the same evaluation the
    // agent/MCP tool runs (issue #37), exposed over HTTP for the UI. Inputs
    // resolve caller-provided -> live broker state -> unavailable, and the
    // harness fails closed (INPUTS_UNAVAILABLE) rather than inventing state.
    if (path.endsWith("/etrade/think/evaluate") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { symbol?: string; action?: "BUY" | "SELL"; quantity?: number; orderType?: "MARKET" | "LIMIT" | "STOP"; price?: number; accountBalanceUSD?: number };
        if (!body.symbol || (body.action !== "BUY" && body.action !== "SELL") || !body.quantity || body.quantity <= 0) {
          return Response.json({ error: "symbol, action (BUY|SELL) and a positive quantity are required" }, { status: 400 });
        }
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const harness = new ETradeThinkHarness(this.getOrm(), this.env);
        const result = await harness.evaluateTradeWithThinking({
          symbol: body.symbol.toUpperCase(),
          action: body.action,
          quantity: body.quantity,
          orderType: body.orderType || "MARKET",
          price: body.price,
          accountBalanceUSD: body.accountBalanceUSD,
          userLogin,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Think evaluation failed" }, { status: 500 });
      }
    }

    if (path.endsWith("/etrade/hedge/analyze") && request.method === "POST") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const analysis = await generateHedgeProposals(etrade);
        return Response.json(analysis);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to generate hedge proposals" }, { status: 500 });
      }
    }

    // Order History & Trade Audit Ledger
    if (path.endsWith("/etrade/orders") && request.method === "GET") {
      try {
        const orm = this.getOrm();
        const trades = orm.trades.findMany({ orderBy: "created_at DESC", limit: 50 });
        return Response.json({ count: trades.length, trades });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch order history" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Remote Orders on Exchange
    if (path.endsWith("/etrade/orders/remote") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const status = url.searchParams.get("status") || undefined;
        const marker = url.searchParams.get("marker") || undefined;
        const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
        const symbol = url.searchParams.get("symbol") || undefined;
        const orders = await etrade.fetchOrdersRemote(undefined, { status, marker, count, symbol });
        return Response.json({ count: orders.length, orders });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch exchange orders" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Cancel Order on Exchange
    if (path.endsWith("/etrade/orders/cancel") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const orderId = body.orderId;
        if (!orderId) {
          return Response.json({ error: "orderId is required" }, { status: 400 });
        }
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const result = await etrade.cancelOrderRemote(orderId);
        this.audit("etrade.order_cancelled", "trading", { orderId, success: result.success });
        return Response.json(result, { status: result.success ? 200 : 400 });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to cancel order" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Inbound Email Trading Agent
    if (path.endsWith("/trading/email/inbound") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || sessionId || "email_trader";
        const emailService = new ETradeEmailTradingService(this.env, this.getOrm(), userLogin);
        const result = await emailService.processInboundEmail(body);
        this.audit("trading.email_processed", "trading", { actionType: result.actionType, from: result.from, orderId: result.orderId });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to process inbound email" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Slack Event Handler
    if (path.endsWith("/trading/slack/event") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || sessionId || "slack_trader";
        const slackService = new ETradeSlackTradingService(this.env, this.getOrm(), userLogin);
        const result = await slackService.processSlackEvent(body);
        this.audit("trading.slack_event", "trading", { actionType: result.actionType, handled: result.handled });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to process slack event" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Slack Interactive Component Actions (Button Approvals)
    if (path.endsWith("/trading/slack/interaction") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || sessionId || "slack_trader";
        const slackService = new ETradeSlackTradingService(this.env, this.getOrm(), userLogin);
        const result = await slackService.processSlackInteraction(body);
        this.audit("trading.slack_interaction", "trading", { actionId: result.actionId, orderId: result.orderId, status: result.status });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to process slack interaction" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Slack Slash Commands (/trade, /quote, /screen, /options, /snap)
    if (path.endsWith("/trading/slack/command") && request.method === "POST") {
      try {
        const formData = await request.formData();
        const slackAgent = new SlackAgent(this.ctx, this.env);
        return slackAgent.handleSlashCommand(formData);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to process slash command" }, { status: 500 });
      }
    }

    // Cloudflare Browser Agent: Transaction Snapshot Dispatch via Webhook
    if ((path.endsWith("/trading/browser/transaction-snap") || path.endsWith("/browser/transaction-snap")) && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const tx: TransactionSnapData = body.transaction || body;
        const browserAgent = new BrowserAgent(this.ctx, this.env);
        const result = await browserAgent.sendTransactionSnapToSlack(tx, {
          webhookUrl: body.webhookUrl || this.env.SLACK_WEBHOOK_URL,
          channel: body.channel,
          caption: body.caption,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to generate transaction snap" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Voice Trading Turn
    if (path.endsWith("/trading/voice/turn") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || sessionId || "voice_trader";
        const voiceService = new ETradeVoiceTradingService(this.env, this.getOrm(), userLogin, this.nlqSchedulingPort());
        const result = await voiceService.processVoiceTurn({
          ...body,
          sessionId: userLogin,
          userLogin,
        });
        this.audit("trading.voice_turn", "trading", { actionType: result.actionType, orderId: result.orderId, success: result.success });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to process voice turn" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Voice Trading Welcome Greeting
    if (path.endsWith("/trading/voice/greeting") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId || "voice_trader";
      const voiceService = new ETradeVoiceTradingService(this.env, this.getOrm(), userLogin);
      return Response.json(voiceService.getWelcomeGreeting());
    }

    // Real E*TRADE REST API: Account Transactions
    if (path.endsWith("/etrade/transactions") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const startDate = url.searchParams.get("startDate") || undefined;
        const endDate = url.searchParams.get("endDate") || undefined;
        const sortOrder = (url.searchParams.get("sortOrder") as "ASC" | "DESC") || undefined;
        const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
        const transactions = await etrade.fetchTransactions(undefined, { startDate, endDate, sortOrder, count });
        return Response.json({ count: transactions.length, transactions });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transactions" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Transaction Details
    if (path.includes("/etrade/transactions/") && request.method === "GET") {
      try {
        const transactionId = path.split("/etrade/transactions/")[1].split("/")[0].split("?")[0];
        const storeId = url.searchParams.get("storeId") || undefined;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const details = await etrade.fetchTransactionDetails(transactionId, undefined, storeId);
        if (!details) {
          return Response.json({ error: "Transaction not found" }, { status: 404 });
        }
        return Response.json(details);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transaction details" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: User Alerts Inbox
    if (path.endsWith("/etrade/alerts") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const category = url.searchParams.get("category") || undefined;
        const status = (url.searchParams.get("status") as "READ" | "UNREAD" | "DELETED") || undefined;
        const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
        const alerts = await etrade.fetchAlerts({ category, status, count });
        return Response.json({ count: alerts.length, alerts });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch alerts" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Alert Details & Delete
    if (path.includes("/etrade/alerts/") && request.method === "GET") {
      try {
        const alertId = path.split("/etrade/alerts/")[1].split("/")[0].split("?")[0];
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const details = await etrade.fetchAlertDetails(alertId);
        if (!details) {
          return Response.json({ error: "Alert not found" }, { status: 404 });
        }
        return Response.json(details);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch alert details" }, { status: 500 });
      }
    }

    if (path.includes("/etrade/alerts/") && request.method === "DELETE") {
      try {
        const alertId = path.split("/etrade/alerts/")[1].split("/")[0].split("?")[0];
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const result = await etrade.deleteAlert(alertId);
        return Response.json(result, { status: result.success ? 200 : 400 });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete alert" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Product Lookup
    if (path.endsWith("/etrade/lookup") && request.method === "GET") {
      try {
        const search = url.searchParams.get("search") || url.searchParams.get("q") || "";
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const items = await etrade.lookupProduct(search);
        return Response.json({ count: items.length, items });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to lookup products" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Option Chains
    if (path.endsWith("/etrade/options/chains") && request.method === "GET") {
      try {
        const symbol = (url.searchParams.get("symbol") || "NVDA").toUpperCase().trim();
        const expiryYear = url.searchParams.get("expiryYear") ? Number(url.searchParams.get("expiryYear")) : undefined;
        const expiryMonth = url.searchParams.get("expiryMonth") ? Number(url.searchParams.get("expiryMonth")) : undefined;
        const expiryDay = url.searchParams.get("expiryDay") ? Number(url.searchParams.get("expiryDay")) : undefined;
        const strikePrice = url.searchParams.get("strikePrice") ? Number(url.searchParams.get("strikePrice")) : undefined;
        const noOfStrikes = url.searchParams.get("noOfStrikes") ? Number(url.searchParams.get("noOfStrikes")) : undefined;
        const chainType = (url.searchParams.get("chainType") as "CALL" | "PUT" | "CALLPUT") || undefined;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const chain = await etrade.getOptionChains({
          symbol,
          expiryYear,
          expiryMonth,
          expiryDay,
          strikePrice,
          noOfStrikes,
          chainType,
        });
        if (!chain) {
          // Issue #155: a null chain with a recorded client error is an
          // upstream failure (expired OAuth, missing credentials,
          // network), not an empty chain — surface it as a 502 naming
          // the cause instead of a fabricated 200 empty payload.
          const upstreamError = etrade.getLastError();
          if (upstreamError) {
            return Response.json({ error: upstreamError, symbol }, { status: 502 });
          }
        }
        return Response.json(chain || { symbol, underlyingPrice: 0, pairs: [] });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch option chains" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Option Expire Dates
    if (path.endsWith("/etrade/options/expire-dates") && request.method === "GET") {
      try {
        const symbol = (url.searchParams.get("symbol") || "NVDA").toUpperCase().trim();
        const expiryType = url.searchParams.get("expiryType") || undefined;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const dates = await etrade.getOptionExpireDates(symbol, expiryType);
        if (dates.length === 0) {
          // Issue #155: distinguish an upstream failure (client error
          // recorded) from a symbol that genuinely has no expirations —
          // only the genuine empty keeps the 200 empty payload.
          const upstreamError = etrade.getLastError();
          if (upstreamError) {
            return Response.json({ error: upstreamError, symbol }, { status: 502 });
          }
        }
        return Response.json({ count: dates.length, dates });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch option expire dates" }, { status: 500 });
      }
    }

    // Persisted opportunity scan runs (issue #27): scans executed with a
    // store attached (NLQ path + unified opportunities route) are
    // retrievable here with their full provenance, and two runs can be
    // diffed run-over-run. Declared in list → diff → by-id order: the
    // diff route must win over the by-id pattern below.
    if (path.endsWith("/etrade/options/scans") && request.method === "GET") {
      try {
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 25;
        const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;
        // Issue #103: history is scoped per user, like profiles —
        // runs the caller saved are theirs; legacy runs saved before
        // scoping (no user_login) remain visible to everyone.
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlScanRunStore(sql);
        const scans = await store.list({ limit, offset, userLogin });
        return Response.json({ count: scans.length, scans });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to list scan runs" }, { status: 500 });
      }
    }

    if (path.endsWith("/etrade/options/scans/diff") && request.method === "GET") {
      try {
        const fromId = url.searchParams.get("from") || "";
        const toId = url.searchParams.get("to") || "";
        if (!fromId || !toId) {
          return Response.json({ error: "from and to scan run ids are required" }, { status: 400 });
        }
        // Issue #103: both runs must be visible to the caller — an
        // invisible run produces the same 404 as a missing one, so a
        // diff can never leak another user's run (or its existence).
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlScanRunStore(sql);
        const from = await store.get(fromId, { userLogin });
        const to = await store.get(toId, { userLogin });
        if (!from || !to) {
          return Response.json({ error: "scan run not found" }, { status: 404 });
        }
        return Response.json({
          from: { id: from.id, generatedAt: from.generatedAt },
          to: { id: to.id, generatedAt: to.generatedAt },
          diff: diffScanRuns(from.result, to.result),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to diff scan runs" }, { status: 500 });
      }
    }

    const scanRunIdMatch = path.match(/\/etrade\/options\/scans\/([^/]+)$/);
    if (scanRunIdMatch && request.method === "GET") {
      try {
        // Issue #103: scoped like the list — another user's run is
        // indistinguishable from a pruned one (same 404).
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlScanRunStore(sql);
        const run = await store.get(decodeURIComponent(scanRunIdMatch[1]), { userLogin });
        if (!run) {
          return Response.json({ error: "scan run not found" }, { status: 404 });
        }
        return Response.json(run);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch scan run" }, { status: 500 });
      }
    }

    // IV history (issue #15): the daily collector's stored series,
    // read back as IV rank / percentile with honest coverage. A name
    // with no records is a state (observations 0, warmingUp true,
    // latest null), never a 404 — absence of history is exactly what
    // a warming-up system is supposed to report. Without ?symbol=,
    // returns the per-name coverage summary for every tracked name
    // (curated ∪ watchlists) plus any name that has records.
    if (path.endsWith("/etrade/options/iv-history") && request.method === "GET") {
      try {
        const store = new SqlIvHistoryStore(sql);
        const symbolParam = url.searchParams.get("symbol");
        if (symbolParam) {
          const entry = await getIvHistoryEntry(store, symbolParam);
          // ?series=true includes the full time series for charting.
          if (url.searchParams.get("series") === "true") {
            const series = await store.listSeries(symbolParam.toUpperCase(), { limit: 365 });
            return Response.json({
              ...entry,
              series: series.reverse().map((r) => ({
                date: r.date,
                atmIv: r.atmIv,
                spot: r.spot,
              })),
            });
          }
          return Response.json(entry);
        }
        let watchlistSymbols: string[] = [];
        try {
          watchlistSymbols = flattenWatchlistSymbols(this.getOrm().watchlists.findMany({}));
        } catch {
          // Watchlist read failure → curated universe only.
        }
        const tracked = resolveTrackedSymbols(
          getCuratedStockUniverse().map((s) => s.symbol),
          watchlistSymbols
        );
        const recorded = await store.listSymbols();
        const names = [...new Set([...tracked, ...recorded])].sort();
        const entries = [];
        for (const symbol of names) {
          entries.push(await getIvHistoryEntry(store, symbol));
        }
        return Response.json({ count: entries.length, names: entries });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch IV history" }, { status: 500 });
      }
    }

    // Saved strategy profiles (issue #28): named, versioned "my
    // strategy" objects, scoped per user. Scans and single-name actions
    // resolve them by name (NLQ) or id/name (unified body) and stamp
    // the applied profile into scan provenance. Validation is the
    // route's job (validateStrategyProfile); the store enforces only
    // per-user name uniqueness. The profiles UI panel is issue #84's
    // surface — these routes are the API it will consume.
    if (path.endsWith("/etrade/options/profiles") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlStrategyProfileStore(sql);
        const profiles = await store.list(userLogin);
        return Response.json({ count: profiles.length, profiles });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to list strategy profiles" }, { status: 500 });
      }
    }

    if (path.endsWith("/etrade/options/profiles") && request.method === "POST") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const { name, ...spec } = body;
        const profileName = typeof name === "string" ? name : "";
        const validationError = validateStrategyProfile(profileName, spec as StrategyProfileSpec);
        if (validationError) {
          return Response.json({ error: validationError }, { status: 400 });
        }
        const store = new SqlStrategyProfileStore(sql);
        try {
          const profile = await store.create(userLogin, profileName, spec as StrategyProfileSpec);
          return Response.json(profile, { status: 201 });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to create strategy profile" }, { status: 400 });
        }
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to create strategy profile" }, { status: 500 });
      }
    }

    const profileIdMatch = path.match(/\/etrade\/options\/profiles\/([^/]+)$/);
    if (profileIdMatch && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlStrategyProfileStore(sql);
        const profile = await store.get(userLogin, decodeURIComponent(profileIdMatch[1]));
        if (!profile) {
          return Response.json({ error: "profile not found" }, { status: 404 });
        }
        return Response.json(profile);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch strategy profile" }, { status: 500 });
      }
    }

    if (profileIdMatch && request.method === "PUT") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlStrategyProfileStore(sql);
        const existing = await store.get(userLogin, decodeURIComponent(profileIdMatch[1]));
        if (!existing) {
          return Response.json({ error: "profile not found" }, { status: 404 });
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const { name, ...spec } = body;
        // The body name wins when present; otherwise the profile keeps
        // its current name (validation runs against the effective one).
        const profileName = typeof name === "string" ? name : existing.name;
        const validationError = validateStrategyProfile(profileName, spec as StrategyProfileSpec);
        if (validationError) {
          return Response.json({ error: validationError }, { status: 400 });
        }
        try {
          const updated = await store.update(userLogin, existing.id, spec as StrategyProfileSpec, typeof name === "string" ? name : undefined);
          return Response.json(updated);
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to update strategy profile" }, { status: 400 });
        }
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to update strategy profile" }, { status: 500 });
      }
    }

    if (profileIdMatch && request.method === "DELETE") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const store = new SqlStrategyProfileStore(sql);
        const deleted = await store.delete(userLogin, decodeURIComponent(profileIdMatch[1]));
        if (!deleted) {
          return Response.json({ error: "profile not found" }, { status: 404 });
        }
        return Response.json({ deleted: true });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete strategy profile" }, { status: 500 });
      }
    }

    // ==========================================
    // Dynamic Options Screener Engine Endpoint
    // ==========================================
    if (path.endsWith("/trading/options/llm-ideas") && request.method === "POST") {
      const body = await request.json().catch(() => null) as { symbol?: unknown; question?: unknown; refresh?: unknown } | null;
      const symbol = typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
      const question = typeof body?.question === "string" ? body.question.trim() : "";
      const forceRefresh = body?.refresh === true;
      if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
        return Response.json({ error: "Provide a valid stock ticker symbol." }, { status: 400 });
      }
      if (!question || question.length > 4000) {
        return Response.json({ error: "Provide a natural-language question up to 4,000 characters." }, { status: 400 });
      }

      let retrievedExpirations: ETradeOptionExpireDate[] = [];
      const retrievedChains: ETradeOptionChain[] = [];
      let usedSyntheticChains = false;
      const orm = this.getOrm();
      const cached = !forceRefresh ? orm.getOptionsChain(symbol) : null;

      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(orm, this.env, userLogin, requestedEnv);

        if (cached && cached.expirations.length > 0 && cached.chains.length > 0) {
          retrievedExpirations = cached.expirations;
          for (const c of cached.chains) {
            retrievedChains.push(c);
          }
        } else {
          let expirations = await etrade.client.getOptionExpireDates(symbol);
          if (expirations.length === 0) {
            // Fall back to unscoped option chain request if expiration calendar endpoint was empty
            const fallbackChain = await etrade.client.getOptionChains({
              symbol,
              includeWeekly: true,
              chainType: "CALLPUT",
              includeRawResponse: true,
            }).catch(() => null);
            if (fallbackChain && fallbackChain.selectedExpiry && fallbackChain.pairs.length > 0) {
              expirations = [fallbackChain.selectedExpiry];
              retrievedChains.push(fallbackChain);
            }
          }

          if (expirations.length > 0 && retrievedChains.length === 0) {
            retrievedExpirations = expirations;

            // Target up to 18 most active expirations across near, mid, and long term to prevent unconstrained latency
            const targetExpirations = expirations.length > 18
              ? [...expirations.slice(0, 10), ...expirations.slice(10, 16), ...expirations.slice(-2)]
              : expirations;

            // Fetch option chains with concurrency chunking (4 parallel requests at a time)
            const chunkSize = 4;
            for (let i = 0; i < targetExpirations.length; i += chunkSize) {
              const chunk = targetExpirations.slice(i, i + chunkSize);
              const chunkChains = await Promise.all(
                chunk.map((expiry) =>
                  etrade.client.getOptionChains({
                    symbol,
                    expiryYear: expiry.year,
                    expiryMonth: expiry.month,
                    expiryDay: expiry.day,
                    includeWeekly: true,
                    chainType: "CALLPUT",
                    includeRawResponse: true,
                  })
                )
              );
              for (const chain of chunkChains) {
                if (chain) retrievedChains.push(chain);
              }
            }
          } else if (expirations.length > 0) {
            retrievedExpirations = expirations;
          }

          if (retrievedChains.length > 0) {
            // Persist into durable SQLite table (10-minute TTL)
            orm.setOptionsChain(symbol, retrievedExpirations, retrievedChains, 600);
          }
        }

        let contractCount = retrievedChains.reduce(
          (count, chain) => count + chain.pairs.reduce((pairCount, pair) => pairCount + Number(Boolean(pair.call)) + Number(Boolean(pair.put)), 0),
          0,
        );

        if (contractCount === 0) {
          const isTestEnv = requestedEnv === "TEST" || !etrade.client.getEnvConfig().isLive;
          if (isTestEnv) {
            usedSyntheticChains = true;
            const synthetic = generateSyntheticOptionChains(symbol);
            retrievedExpirations = synthetic.expirations;
            retrievedChains.length = 0;
            for (const sc of synthetic.chains) {
              retrievedChains.push(sc);
            }
            contractCount = retrievedChains.reduce(
              (count, chain) => count + chain.pairs.reduce((pairCount, pair) => pairCount + Number(Boolean(pair.call)) + Number(Boolean(pair.put)), 0),
              0,
            );
          } else {
            throw new Error(etrade.client.lastError || `E*TRADE returned no option contracts for ${symbol} in PROD environment; no LLM request was sent.`);
          }
        }

        if (contractCount === 0) {
          throw new Error(`E*TRADE returned no option contracts for ${symbol}; no LLM request was sent.`);
        }

        const rawData = {
          symbol,
          question,
          // Provenance (issue #29): synthetic chains are TEST-only and must never be
          // indistinguishable from live E*TRADE chains downstream.
          dataSource: usedSyntheticChains ? "synthetic option chains (TEST environment)" : "E*TRADE option chains",
          expirations: retrievedExpirations,
          optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
        };
        // Issue #47 (follow-up to #29): this endpoint no longer runs the
        // llm_ideas map-reduce (horizon groups over raw chains, existence-only
        // verification, no risk constraints). Following the compare pattern —
        // and the unified service's llm_ideas disposition in slice 4 — the
        // quant pipeline runs first and the LLM evaluates its verified
        // candidates, never overwriting the quant ranking. The response keeps
        // the panel's shape: a single "pipeline" group carries the evaluation
        // so rendering, exports, and provenance badges keep working.
        const spot = retrievedChains.find((chain) => Number.isFinite(chain.underlyingPrice) && chain.underlyingPrice > 0)?.underlyingPrice ?? 100;
        const questionLower = question.toLowerCase();
        const thesis: StrategyRequest["thesis"] = /bear|downside|\bshort\b/.test(questionLower)
          ? "bearish"
          : /range|sideways|neutral|income|theta/.test(questionLower)
            ? "range_bound"
            : /volatil|big move|large move|breakout/.test(questionLower)
              ? "large_move"
              : "bullish";
        const strategyRequest: StrategyRequest = {
          symbol,
          thesis,
          targetPrice: Math.round(spot * (thesis === "bullish" ? 1.05 : thesis === "bearish" ? 0.95 : 1) * 100) / 100,
          targetDate: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
          expectedIvDirection: "unchanged",
          maxPlannedLoss: 100000,
          minRewardRisk: 0,
          allowedStrategies: ["all"],
        };
        const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));
        const pipelineResult = await pipeline.run(strategyRequest, { riskProfile: "balanced" });
        const topRanked = pipelineResult.ranked.slice(0, 10);
        const candidates = topRanked.map((r) => r.candidate);
        let llmJudgment: Awaited<ReturnType<typeof rankCandidatesWithLlm>> | null = null;
        let llmError: string | null = null;
        if (candidates.length > 0) {
          try {
            llmJudgment = await rankCandidatesWithLlm(this.env, strategyRequest, "balanced", pipelineResult.snapshot.contracts, candidates);
          } catch (err) {
            llmError = err instanceof Error ? err.message : "LLM evaluation failed.";
          }
        }
        const llmStatus = llmJudgment ? "complete" as const : "error" as const;
        const llmModel = llmJudgment?.model || this.env.AI_MODEL || DEFAULT_AI_MODEL;
        const llmErrorText = llmError ?? "The quant pipeline produced no candidates for this symbol.";
        const rationaleByCandidate = new Map((llmJudgment?.ranked ?? []).map((judgment) => [judgment.candidateId, judgment.rationale]));
        const answer = llmJudgment
          ? llmJudgment.ranked.slice(0, 3).map((judgment, idx) => {
              const candidate = candidates.find((c) => c.id === judgment.candidateId);
              return `${idx + 1}. ${candidate ? candidate.label : judgment.candidateId} — ${judgment.rationale}`;
            }).join("\n")
          : llmErrorText;
        const candidateContractSymbols = [...new Set(candidates.flatMap((c) => c.legs.map((leg) => leg.symbol)))];
        const groupResults = [{
          id: "pipeline",
          label: "Quant pipeline candidates",
          status: llmStatus,
          model: llmModel,
          answer,
          error: llmStatus === "error" ? llmErrorText : undefined,
          contractSymbols: candidateContractSymbols,
          contractWarnings: [] as string[],
          contractDetails: [] as unknown[],
          expirationCount: retrievedExpirations.length,
          contractCount,
          sentContractCount: candidates.length,
          estimatedInputTokens: 0,
          inputTruncated: false,
        }];
        const finalAnalysis = {
          status: llmStatus,
          model: llmModel,
          answer: llmStatus === "complete" ? answer : undefined,
          error: llmStatus === "error" ? llmErrorText : undefined,
          rankings: topRanked.map((r, idx) => ({
            rank: idx + 1,
            groupId: "pipeline",
            strategy: r.candidate.label,
            rationale: rationaleByCandidate.get(r.candidate.id) ?? "",
          })),
          systemPrompt: "",
          userPrompt: question,
          isFallback: false,
        };
        const llmInputExport = {
          id: "pipeline",
          label: "Quant pipeline candidates",
          symbol,
          question,
          expirations: retrievedExpirations,
          optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
          systemPrompt: "Quant pipeline candidate evaluation (issue #47): the LLM evaluates verified candidates; it does not generate strategies.",
          userPrompt: question,
          selection: { contractCount, candidateCount: candidates.length },
          groupInputs: [] as unknown[],
          finalRanking: { systemPrompt: "", userPrompt: question },
        };
        const dataCoverage = {
          expirationCount: retrievedExpirations.length,
          chainCount: retrievedChains.length,
          contractCount,
          sentContractCount: contractCount,
          estimatedInputTokens: 0,
          inputTruncated: false,
          cached: Boolean(cached),
          fetchedAt: cached?.fetchedAt || Date.now(),
        };
        return Response.json({
          mode: "llm_evaluation_of_quant_candidates",
          isSynthetic: usedSyntheticChains,
          notice: usedSyntheticChains
            ? "Synthetic option chains preview (TEST environment). Not verified live market data."
            : "Quant-verified candidates evaluated by the LLM (compare pattern, issue #47); the quant pipeline's ranking stands.",
          llm: {
            status: llmStatus,
            model: llmModel,
            answer: llmStatus === "complete" ? answer : undefined,
            error: llmStatus === "error" ? llmErrorText : undefined,
            contractSymbols: candidateContractSymbols,
          },
          quant: {
            ranked: topRanked,
            scoreWeights: pipelineResult.strategies.scoreWeights,
            candidateCount: candidates.length,
          },
          groups: groupResults,
          finalAnalysis,
          llmInput: llmInputExport,
          retrievedData: rawData,
          dataCoverage,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : "Failed to retrieve complete E*TRADE option data.";
        const failedContractCount = retrievedChains.reduce(
          (count, chain) => count + chain.pairs.reduce((pairCount, pair) => pairCount + Number(Boolean(pair.call)) + Number(Boolean(pair.put)), 0),
          0,
        );
        const fallbackLlmInput = retrievedChains.length > 0 ? {
          id: "all",
          label: "All Expirations",
          symbol,
          question,
          expirations: retrievedExpirations,
          optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
          systemPrompt: "Normalized options contract dataset",
          userPrompt: question,
          selection: {
            contractsAvailable: failedContractCount,
            contractsIncluded: failedContractCount,
            truncated: false,
          },
        } : undefined;
        return Response.json({
          error,
          mode: "llm_evaluation_of_quant_candidates",
          llm: { status: "error", model: this.env.AI_MODEL || DEFAULT_AI_MODEL, error },
          llmInput: fallbackLlmInput,
          retrievedData: {
            symbol,
            question,
            dataSource: usedSyntheticChains ? "synthetic option chains (TEST environment)" : "E*TRADE option chains",
            expirations: retrievedExpirations,
            optionChains: retrievedChains.map((chain) => chain.raw ?? chain),
          },
          dataCoverage: {
            expirationCount: retrievedExpirations.length,
            chainCount: retrievedChains.length,
            contractCount: failedContractCount,
            sentContractCount: 0,
            estimatedInputTokens: 0,
            inputTruncated: false,
          },
        }, { status: 502 });
      }
    }

    if (path.endsWith("/trading/options/compare") && request.method === "POST") {
      const body = await request.json().catch(() => null) as (Partial<StrategyRequest> & {
        riskProfile?: RiskProfile;
        alternatives?: number;
      }) | null;
      const validationError = validateStrategyRequest(body);
      if (validationError || !body) {
        return Response.json({ error: validationError || "Invalid strategy request." }, { status: 400 });
      }
      if (body.riskProfile !== undefined && !["conservative", "balanced", "aggressive"].includes(body.riskProfile)) {
        return Response.json({ error: "riskProfile must be conservative, balanced, or aggressive." }, { status: 400 });
      }

      try {
        const strategyRequest = body as StrategyRequest;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));
        const result = await pipeline.run(strategyRequest, {
          riskProfile: body.riskProfile,
          alternatives: body.alternatives,
        });
        const poolByType = new Map<string, { type: string; label: string; generated: number; bestScore: number }>();
        for (const c of result.strategies.candidates) {
          const e = poolByType.get(c.type) || { type: c.type, label: c.label, generated: 0, bestScore: 0 };
          e.generated += 1;
          e.bestScore = Math.max(e.bestScore, c.score);
          poolByType.set(c.type, e);
        }
        const common = {
          llmInput: describeLlmInput(strategyRequest, body.riskProfile || "balanced", result.snapshot.contracts, result.ranked.slice(0, 20).map((ranked) => ranked.candidate)),
          quantStrategyPool: [...poolByType.values()],
          screen: result.snapshot.screen,
          contracts: result.snapshot.contracts,
          contractRejections: result.snapshot.rejections,
        };

        if (path.endsWith("/trading/options/compare")) {
          const candidates = result.ranked.slice(0, 20);
          try {
            const llm = await rankCandidatesWithLlm(
              this.env,
              strategyRequest,
              body.riskProfile || "balanced",
              result.snapshot.contracts,
              candidates.map((ranked) => ranked.candidate),
            );
            return Response.json({
              mode: "same_candidate_ranking",
              quant: {
                ranked: candidates,
                scoreWeights: result.strategies.scoreWeights,
                candidateCount: candidates.length,
              },
              llm: { status: "complete", ...llm },
              ...common,
            });
          } catch (err) {
            return Response.json({
              mode: "same_candidate_ranking",
              quant: {
                ranked: candidates,
                scoreWeights: result.strategies.scoreWeights,
                candidateCount: candidates.length,
              },
              llm: {
                status: "error",
                model: this.env.AI_MODEL || DEFAULT_AI_MODEL,
                error: err instanceof Error ? err.message : "LLM ranking failed.",
              },
              ...common,
            });
          }
        }

      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options candidate generation failed." }, { status: 500 });
      }
    }

    if (path.endsWith("/trading/options/recommend") && request.method === "POST") {
      const body = await request.json().catch(() => null) as Partial<StrategyRequest> | null;
      const validationError = validateStrategyRequest(body);
      if (validationError) {
        return Response.json({ error: validationError }, { status: 400 });
      }

      try {
        const strategyRequest = body as StrategyRequest;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const screener = new DynamicOptionsScreener(etrade.client);
        const screened = await screener.screenOptions({
          underlyingSymbols: [strategyRequest.symbol.toUpperCase().trim()],
          contractType: "BOTH",
          minDte: strategyRequest.minDte,
          maxDte: strategyRequest.maxDte,
          minVolume: strategyRequest.minVolume,
          minOpenInterest: strategyRequest.minOpenInterest,
          maxSpreadPct: strategyRequest.maxSpreadPct,
          maxQuoteAgeSeconds: strategyRequest.maxQuoteAgeSeconds,
          limit: strategyRequest.contractLimit,
        });
        const recommendations = recommendOptionStrategies(screened.contracts, strategyRequest, strategyRequest.candidateLimit);
        return Response.json({
          ...recommendations,
          contracts: screened.contracts,
          screen: {
            scannedAt: screened.scannedAt,
            underlyingsScanned: screened.totalUnderlyingsScanned,
            contractsEvaluated: screened.totalContractsEvaluated,
            contractsMatched: screened.matchedCount,
            quoteQuality: screened.quoteQuality,
            fetchErrors: screened.fetchErrors,
            warnings: screened.warnings,
            validationError: screened.validationError,
            status: screened.status,
          },
          contractRejections: (screened.rejections || []).slice(0, 50),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options recommendation failed" }, { status: 400 });
      }
    }

    // Unified Options Strategy Catalog (Single source of truth: 74 registered strategies & 114 aliases)
    if (path.endsWith("/trading/options/catalog") && request.method === "GET") {
      const list = defaultRegistry.list().map((s) => ({
        id: s.id,
        name: s.label,
        category: s.category,
        description: s.description,
        aliases: s.aliases,
        theses: s.theses,
        usesStock: s.usesStock,
        multiExpiry: s.multiExpiry,
      }));
      return Response.json({
        success: true,
        count: list.length,
        total: list.length,
        strategies: list,
        aliases: REQUESTED_STRATEGY_NAMES,
        demoCalibratedChainsEnabled: isDemoCalibratedChainsEnabled(),
      });
    }

    // Strategy screener (capability 2) and best-trade picker (capability 3) over the options data agent (capability 1)
    // Issue #275: strategy catalog with direction tags (GET).
    if (path.endsWith("/trading/options/catalog") && request.method === "GET") {
      try {
        const strategies = defaultRegistry.list().map((s) => ({
          id: s.id,
          label: s.label,
          category: s.category,
          description: s.description,
          theses: s.theses ?? [],
          aliases: s.aliases ?? [],
        }));
        return Response.json({ count: strategies.length, strategies });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to load catalog" }, { status: 500 });
      }
    }

    if ((path.endsWith("/trading/options/strategies") || path.endsWith("/trading/options/best-trade")) && request.method === "POST") {
      const body = await request.json().catch(() => null) as (Partial<StrategyRequest> & {
        strategyFilter?: StrategyScreenFilter;
        riskProfile?: RiskProfile;
        alternatives?: number;
      }) | null;
      const validationError = validateStrategyRequest(body);
      if (validationError || !body) {
        return Response.json({ error: validationError }, { status: 400 });
      }
      if (body.riskProfile !== undefined && !["conservative", "balanced", "aggressive"].includes(body.riskProfile)) {
        return Response.json({ error: "riskProfile must be conservative, balanced, or aggressive." }, { status: 400 });
      }
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));
        const result = await pipeline.run(body as StrategyRequest, {
          strategyFilter: body.strategyFilter,
          riskProfile: body.riskProfile,
          alternatives: body.alternatives,
        });
        const common = {
          screen: result.snapshot.screen,
          contracts: result.snapshot.contracts,
          contractRejections: result.snapshot.rejections,
          dataSource: result.snapshot.dataSource,
          snapshotError: result.snapshot.validationError,
        };
        if (path.endsWith("/best-trade")) {
          return Response.json({ bestTrade: result.bestTrade, evaluations: result.strategies.evaluations, nameLedger: result.strategies.nameLedger, ...common });
        }
        return Response.json({
          status: result.ranked.length > 0 ? "ranked_candidates" : "no_candidates",
          ranked: result.ranked,
          riskReports: result.riskReports,
          screenedOut: result.screenedOut.slice(0, 50),
          excluded: result.strategies.excluded,
          ...common,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options strategy pipeline failed" }, { status: 400 });
      }
    }

    if (path.endsWith("/trading/options/screen") && (request.method === "POST" || request.method === "GET")) {
      try {
        let filter: any = {};
        if (request.method === "POST") {
          filter = (await request.json().catch(() => ({}))) as any;
        } else {
          // Parse GET query params
          filter = {
            sector: url.searchParams.get("sector") || undefined,
            contractType: url.searchParams.get("contractType") || undefined,
            minDelta: url.searchParams.get("minDelta") ? Number(url.searchParams.get("minDelta")) : undefined,
            maxDelta: url.searchParams.get("maxDelta") ? Number(url.searchParams.get("maxDelta")) : undefined,
            minGamma: url.searchParams.get("minGamma") ? Number(url.searchParams.get("minGamma")) : undefined,
            maxGamma: url.searchParams.get("maxGamma") ? Number(url.searchParams.get("maxGamma")) : undefined,
            minTheta: url.searchParams.get("minTheta") ? Number(url.searchParams.get("minTheta")) : undefined,
            maxTheta: url.searchParams.get("maxTheta") ? Number(url.searchParams.get("maxTheta")) : undefined,
            minImpliedVolatility: url.searchParams.get("minIv") ? Number(url.searchParams.get("minIv")) : undefined,
            maxImpliedVolatility: url.searchParams.get("maxIv") ? Number(url.searchParams.get("maxIv")) : undefined,
            minVolume: url.searchParams.get("minVolume") ? Number(url.searchParams.get("minVolume")) : undefined,
            minOpenInterest: url.searchParams.get("minOi") ? Number(url.searchParams.get("minOi")) : undefined,
            maxSpreadPct: url.searchParams.get("maxSpreadPct") ? Number(url.searchParams.get("maxSpreadPct")) : undefined,
            maxQuoteAgeSeconds: url.searchParams.get("maxQuoteAgeSeconds") ? Number(url.searchParams.get("maxQuoteAgeSeconds")) : undefined,
            minDte: url.searchParams.get("minDte") ? Number(url.searchParams.get("minDte")) : undefined,
            maxDte: url.searchParams.get("maxDte") ? Number(url.searchParams.get("maxDte")) : undefined,
            moneyness: url.searchParams.get("moneyness") || undefined,
            underlyingSymbols: url.searchParams.get("symbols") ? url.searchParams.get("symbols")!.split(",").map((s) => s.trim()) : undefined,
            maxUnderlyings: url.searchParams.get("maxUnderlyings") ? Number(url.searchParams.get("maxUnderlyings")) : undefined,
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          };
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const screener = new DynamicOptionsScreener(etrade.client);
        let result = await screener.screenOptions(filter);

        // Demo-mode fallback (issue #65): generated chains may substitute for an
        // empty live screen ONLY in dev/demo deployments with the gate enabled,
        // and the result is stamped dataSource "calibrated-demo". Production is
        // live-only: an empty live screen returns empty, with its fetch errors.
        if (result.contracts.length === 0 && isDemoCalibratedChainsEnabled() && filter.underlyingSymbols && filter.underlyingSymbols.length > 0 && filter.underlyingSymbols[0] !== "BROKEN") {
          const fallbackChains = buildCalibratedOptionChains(filter.underlyingSymbols, filter.minDte ?? 0, filter.maxDte ?? 90);
          if (fallbackChains.length > 0) {
            const chainItems = fallbackChains.map((c) => ({ symbol: c.symbol, chain: c }));
            const fallbackResult = screener.evaluateChains(chainItems, filter, filter.underlyingSymbols.length, {
              warnings: ["Calibrated demo chains — generated data for development/demo, not live market data."],
            });
            if (fallbackResult.contracts.length > 0) {
              fallbackResult.dataSource = "calibrated-demo";
              result = fallbackResult;
            }
          }
        }
        if (result.dataSource === undefined) result.dataSource = "live";

        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options screening failed" }, { status: 500 });
      }
    }

    // Omnichannel Unified Options Intelligence Endpoint
    if (path.endsWith("/trading/options/unified") && (request.method === "POST" || request.method === "GET")) {
      try {
        let reqData: any = {};
        if (request.method === "POST") {
          reqData = (await request.json().catch(() => ({}))) as any;
        } else {
          reqData = {
            action: url.searchParams.get("action") || "screen",
            symbol: url.searchParams.get("symbol") || undefined,
            symbols: url.searchParams.get("symbols") ? url.searchParams.get("symbols")!.split(",").map((s) => s.trim()) : undefined,
            thesis: url.searchParams.get("thesis") || undefined,
            targetPrice: url.searchParams.get("targetPrice") ? Number(url.searchParams.get("targetPrice")) : undefined,
            riskProfile: url.searchParams.get("riskProfile") || undefined,
            channel: url.searchParams.get("channel") || "ui",
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          };
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const service = new UnifiedOptionsService(this.env, userLogin, requestedEnv, this.getOrm(), new SqlScanRunStore(this.ctx.storage.sql), new SqlStrategyProfileStore(this.ctx.storage.sql));
        const result = await service.execute(reqData);

        const channel = reqData.channel || "ui";
        if (channel === "slack") {
          return Response.json(result.toSlack());
        }
        if (channel === "email") {
          return Response.json({ html: result.toEmailHtml(), text: result.toEmailText(), summary: result.summary });
        }
        if (channel === "voice") {
          return Response.json(result.toVoice());
        }
        if (channel === "webhook") {
          return Response.json(result.toWebhook());
        }
        if (channel === "mcp") {
          return Response.json(result.toMcp());
        }
        return Response.json(result.toUi());
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Unified options query failed" }, { status: 500 });
      }
    }

    // Dynamic ETAPI Options Configuration & Tuning Endpoint
    if (path.endsWith("/trading/options/config") && (request.method === "POST" || request.method === "GET")) {
      try {
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as any;
          if (body.reset) {
            setRuntimeEtapiConfigOverrides(null);
          } else if (body.overrides) {
            setRuntimeEtapiConfigOverrides(body.overrides);
          }
          return Response.json({
            success: true,
            environment: requestedEnv,
            config: getEtapiConfig(this.env, requestedEnv),
            message: body.reset ? "Reset configuration to environment defaults" : "Runtime configuration overrides applied",
          });
        }
        return Response.json({
          success: true,
          environment: requestedEnv,
          config: getEtapiConfig(this.env, requestedEnv),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to access options configuration" }, { status: 500 });
      }
    }

    // ==========================================
    // E*TRADE Watchlist Endpoints & Persistence
    // ==========================================

    // List Watchlists (E*TRADE REST + Durable SQLite)
    if (path.endsWith("/etrade/watchlists") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const watchlists = await etrade.getWatchlists();
        return Response.json({ count: watchlists.length, watchlists });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to retrieve watchlists" }, { status: 500 });
      }
    }

    // Get Watchlist Details
    if (path.endsWith("/etrade/watchlist/details") && request.method === "GET") {
      try {
        const id = url.searchParams.get("id") || url.searchParams.get("name") || "";
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const details = await etrade.getWatchlistDetails(id);
        if (!details) {
          return Response.json({ error: `Watchlist '${id}' not found` }, { status: 404 });
        }
        return Response.json(details);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to get watchlist details" }, { status: 500 });
      }
    }

    // Create Watchlist
    if (path.endsWith("/etrade/watchlist/create") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const name = (body.name || "Default Watchlist").trim();
        const symbols = Array.isArray(body.symbols) ? body.symbols : [];
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const res = await etrade.createWatchlist({ name, symbols });
        return Response.json(res);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to create watchlist" }, { status: 500 });
      }
    }

    // Save Screen Results directly as Watchlist
    if (path.endsWith("/etrade/watchlist/save-screen") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const name = (body.name || "Screener Results").trim();
        const symbols = Array.isArray(body.symbols) ? body.symbols : [];
        const items = body.items || [];
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const res = await etrade.saveScanAsWatchlist(name, symbols, items);
        return Response.json(res);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to save screen as watchlist" }, { status: 500 });
      }
    }

    // Delete Watchlist
    if (path.endsWith("/etrade/watchlist/delete") && (request.method === "DELETE" || request.method === "POST")) {
      try {
        const id = url.searchParams.get("id") || (await request.json().catch(() => ({})) as any)?.id;
        if (!id) return Response.json({ error: "Missing watchlist id" }, { status: 400 });
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const deleted = await etrade.deleteWatchlist(id);
        return Response.json({ success: deleted, deletedId: id });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete watchlist" }, { status: 500 });
      }
    }

    // ==========================================
    // Alpaca Trading API v2 Endpoints
    // ==========================================

    // Place Alpaca Live / Paper Order
    if (path.endsWith("/trading/alpaca/order") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const symbol = (body.symbol || "").trim();
        const qty = Number(body.qty) || 1;
        const side = (body.side || "buy").toLowerCase() as "buy" | "sell";
        const type = body.type || "market";
        const limit_price = body.limit_price !== undefined ? Number(body.limit_price) : undefined;
        const time_in_force = body.time_in_force || "day";

        if (!symbol) {
          return Response.json({ error: "Stock symbol is required" }, { status: 400 });
        }

        const foss = new FossResearchService(this.env);
        const orderResult = await foss.placeAlpacaOrder({
          symbol,
          qty,
          side,
          type,
          limit_price,
          time_in_force,
        });

        this.audit("alpaca.order_placed", "trading", { symbol, qty, side, status: orderResult.status });
        return Response.json(orderResult);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to place Alpaca order" }, { status: 500 });
      }
    }

    // Get Alpaca Account & Buying Power
    if (path.endsWith("/trading/alpaca/account") && request.method === "GET") {
      try {
        const foss = new FossResearchService(this.env);
        const account = await foss.getAlpacaAccount();
        return Response.json(account);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to fetch Alpaca account" }, { status: 500 });
      }
    }

    // Get Alpaca Open Positions
    if (path.endsWith("/trading/alpaca/positions") && request.method === "GET") {
      try {
        const foss = new FossResearchService(this.env);
        const positions = await foss.getAlpacaPositions();
        return Response.json(positions);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to fetch Alpaca positions" }, { status: 500 });
      }
    }

    // Get Alpaca Orders List
    if (path.endsWith("/trading/alpaca/orders") && request.method === "GET") {
      try {
        const status = (url.searchParams.get("status") || "open") as any;
        const foss = new FossResearchService(this.env);
        const orders = await foss.getAlpacaOrders(status);
        return Response.json(orders);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to fetch Alpaca orders" }, { status: 500 });
      }
    }

    // ==========================================
    // FOSS Market Research & Quoting APIs (yfinance & Alpaca)
    // ==========================================

    // Real-time quote (Yahoo Finance, Alpaca, or Hybrid)
    if (path.endsWith("/foss/quote") && request.method === "GET") {
      try {
        const symbol = url.searchParams.get("symbol") || "NVDA";
        const provider = (url.searchParams.get("provider") || "hybrid") as any;
        const foss = new FossResearchService(this.env);
        const quote = await foss.getQuote(symbol, provider);
        return Response.json(quote);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch FOSS quote" }, { status: 500 });
      }
    }

    // Company fundamentals & valuation metrics (yfinance)
    if (path.endsWith("/foss/fundamentals") && request.method === "GET") {
      try {
        const symbol = url.searchParams.get("symbol") || "NVDA";
        const foss = new FossResearchService(this.env);
        const fundamentals = await foss.getFundamentals(symbol);
        return Response.json(fundamentals);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch fundamentals" }, { status: 500 });
      }
    }

    // Historical OHLCV bars (yfinance / Alpaca)
    if (path.endsWith("/foss/bars") && request.method === "GET") {
      try {
        const symbol = url.searchParams.get("symbol") || "NVDA";
        const timeframe = url.searchParams.get("timeframe") || "1D";
        const limit = Number(url.searchParams.get("limit") || "30");
        const provider = (url.searchParams.get("provider") || "yfinance") as "yfinance" | "alpaca" | "hybrid";
        const foss = new FossResearchService(this.env);
        const bars = await foss.getHistoricalBars(symbol, timeframe, limit, provider);
        // Issue #117: `source` is stamped from the bars' actual provenance —
        // a provider API name only when the bars were really fetched live;
        // generated/static fallback bars are labelled as such, and the
        // provenance rides in the response alongside the per-bar fields.
        const provenance = bars[0]?.provenance ?? "generated";
        return Response.json({
          symbol: symbol.toUpperCase(),
          provider,
          timeframe,
          count: bars.length,
          bars,
          provenance,
          source: fossBarsSourceLabel(provider, provenance),
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch historical bars" }, { status: 500 });
      }
    }

    // Comprehensive equity research report with Agent DID stamp
    if (path.endsWith("/foss/research") && request.method === "GET") {
      try {
        const symbol = url.searchParams.get("symbol") || "NVDA";
        const foss = new FossResearchService(this.env);
        const report = await foss.generateResearchReport(symbol);
        this.audit("foss.research_generated", "research", { symbol, rating: report.analystRating, did: report.agentAttestation.did, provenance: report.provenance });
        return Response.json(report);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to generate research report" }, { status: 500 });
      }
    }

    // Alpaca real-time market snapshot & NBBO spread
    if (path.endsWith("/foss/snapshot") && request.method === "GET") {
      try {
        const symbol = url.searchParams.get("symbol") || "NVDA";
        const foss = new FossResearchService(this.env);
        const snapshot = await foss.getAlpacaSnapshot(symbol);
        this.audit("alpaca.snapshot_queried", "trading", {
          symbol,
          price: snapshot.latestTrade?.price,
          bid: snapshot.latestQuote?.bidPrice,
          ask: snapshot.latestQuote?.askPrice,
          assetClass: snapshot.assetClass,
        });
        return Response.json(snapshot);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca market snapshot" }, { status: 500 });
      }
    }

    // Alpaca Trading v2: Account Status & Balance with Agentic Tracing
    if (path.endsWith("/foss/alpaca/account") && request.method === "GET") {
      try {
        const foss = new FossResearchService(this.env);
        const result = await foss.getAlpacaAccount();
        this.audit("alpaca.account_queried", "trading", {
          success: result.success,
          accountId: result.account?.id,
          buyingPower: result.account?.buying_power,
          portfolioValue: result.account?.portfolio_value,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca account" }, { status: 500 });
      }
    }

    // Alpaca Trading v2: Portfolio Positions with Agentic Tracing
    if (path.endsWith("/foss/alpaca/positions") && request.method === "GET") {
      try {
        const foss = new FossResearchService(this.env);
        const result = await foss.getAlpacaPositions();
        this.audit("alpaca.positions_queried", "trading", {
          success: result.success,
          count: result.positions?.length || 0,
          symbols: result.positions?.map((p: any) => p.symbol) || [],
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca positions" }, { status: 500 });
      }
    }

    // Alpaca Trading v2: Order History Ledger with Agentic Tracing
    if (path.endsWith("/foss/alpaca/orders") && request.method === "GET") {
      try {
        const status = (url.searchParams.get("status") || "open") as "open" | "closed" | "all";
        const foss = new FossResearchService(this.env);
        const result = await foss.getAlpacaOrders(status);
        this.audit("alpaca.orders_queried", "trading", {
          status,
          count: result.orders?.length || 0,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca orders" }, { status: 500 });
      }
    }

    // Alpaca Trading v2: Place Order with Agent DID Attestation & Agentic Tracing
    if (path.endsWith("/foss/alpaca/order") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const symbol = (body.symbol || "").toUpperCase().trim();
        const qty = Number(body.qty || body.quantity || 1);
        const side = (body.side || body.orderAction || "buy").toLowerCase() as "buy" | "sell";
        const type = (body.type || body.orderType || "market").toLowerCase() as any;
        const limit_price = body.limit_price || body.limitPrice ? Number(body.limit_price || body.limitPrice) : undefined;
        const time_in_force = body.time_in_force || "day";

        if (!symbol) {
          return Response.json({ error: "Symbol is required" }, { status: 400 });
        }

        const foss = new FossResearchService(this.env);
        const result = await foss.placeAlpacaOrder({
          symbol,
          qty,
          side,
          type,
          limit_price,
          time_in_force,
        });

        this.audit("alpaca.order_placed", "trading", {
          symbol,
          qty,
          side,
          type,
          limitPrice: limit_price,
          orderId: result.orderId,
          status: result.status,
          success: result.success,
        });

        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to place Alpaca order" }, { status: 500 });
      }
    }

    // Multi-ticker valuation comparison
    if (path.endsWith("/foss/compare") && (request.method === "POST" || request.method === "GET")) {
      try {
        let symbols = ["NVDA", "AAPL", "MSFT"];
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as any;
          if (Array.isArray(body.symbols) && body.symbols.length > 0) {
            symbols = body.symbols;
          }
        } else {
          const symParam = url.searchParams.get("symbols");
          if (symParam) symbols = symParam.split(",").map(s => s.trim());
        }
        const foss = new FossResearchService(this.env);
        const comparison = await foss.compareStocks(symbols);
        return Response.json({ count: comparison.length, comparison });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to compare stocks" }, { status: 500 });
      }
    }

    // FOSS provider statuses (Yahoo Finance + Alpaca)
    if (path.endsWith("/foss/providers") && request.method === "GET") {
      try {
        const foss = new FossResearchService(this.env);
        const statuses = foss.getProviderStatuses();
        return Response.json({ providers: statuses });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch FOSS providers" }, { status: 500 });
      }
    }

    // Dedicated Yahoo Finance (FOSS) Market Screener
    if ((path.endsWith("/foss/screen") || path.endsWith("/yfinance/screen")) && (request.method === "POST" || request.method === "GET")) {
      try {
        const filters = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
        if (request.method === "GET") {
          if (url.searchParams.get("sector")) filters.sector = url.searchParams.get("sector");
          if (url.searchParams.get("search")) filters.search = url.searchParams.get("search");
          if (url.searchParams.get("maxRsi")) filters.maxRsi = Number(url.searchParams.get("maxRsi"));
          if (url.searchParams.get("minRsi")) filters.minRsi = Number(url.searchParams.get("minRsi"));
          if (url.searchParams.get("maxPeRatio")) filters.maxPeRatio = Number(url.searchParams.get("maxPeRatio"));
          if (url.searchParams.get("gainersOnly")) filters.gainersOnly = url.searchParams.get("gainersOnly") === "true";
          if (url.searchParams.get("losersOnly")) filters.losersOnly = url.searchParams.get("losersOnly") === "true";
        }
        const screener = new YFinanceMarketScreener();
        const results = await screener.screenMarkets(filters);
        this.audit("foss.screener.executed", "research", { filterSummary: results.filterSummary, count: results.stocks.length });
        return Response.json({
          ...results,
          results: results.stocks,
          stocks: results.stocks,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to run Yahoo Finance screener" }, { status: 500 });
      }
    }

    // ==========================================
    // Cloudflare Agents Task Scheduling Management APIs
    // ==========================================

    // List all schedules (supports ?type=cron|interval|delayed|scheduled)
    // Issue #212/#261: latest screener runs (GET /api/screener/latest).
    // Served by ScreenerAgent — one agent owns all screening results.
    // Note: server.ts strips the /api prefix before forwarding, so the DO
    // sees /screener/latest.
    if (path.endsWith("/screener/latest") && request.method === "GET") {
      try {
        const agent = this.getScreenerAgent();
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
        const pdf = await this.getScreenerAgent().getLatestPdf();
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

    if ((path.endsWith("/schedules") || path.endsWith("/api/schedules") || path === "/schedules" || path === "/api/schedules") && request.method === "GET") {
      try {
        // Issue #108: the typed listSchedules() is called directly. The
        // old fallback chain (listSchedules → scheduler.list → deprecated
        // getSchedules → 200 with an empty list) is deleted: it masked a
        // broken scheduling binding as "you have no schedules" (audit
        // finding F14). A failure now surfaces as the 500 below.
        const typeParam = url.searchParams.get("type");
        const schedules = await this.listSchedules(
          typeParam ? { type: typeParam as ScheduleCriteria["type"] } : undefined
        );
        return Response.json({
          count: schedules.length,
          schedules,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list schedules", schedules: [] }, { status: 500 });
      }
    }

    // Cancel a schedule by ID (POST /api/schedules/cancel or DELETE /api/schedules/:id)
    if (
      ((path.endsWith("/schedules/cancel") || path.includes("/schedules/cancel/")) && request.method === "POST") ||
      (path.includes("/schedules/") && request.method === "DELETE")
    ) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const scheduleId =
          body.scheduleId ||
          body.id ||
          url.searchParams.get("id") ||
          path.split("/schedules/cancel/")[1] ||
          path.split("/schedules/")[1] ||
          "";

        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        const cancelled = await this.cancelSchedule(scheduleId);
        this.audit("schedule.cancelled", "orchestrator", { scheduleId, success: cancelled });
        return Response.json({ scheduleId, cancelled });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to cancel schedule" }, { status: 500 });
      }
    }

    // Get specific schedule by ID (GET /api/schedules/:id)
    if (path.includes("/schedules/") && request.method === "GET") {
      try {
        const scheduleId = path.split("/schedules/").pop() || "";
        const schedule = await this.getScheduleById(scheduleId);
        if (!schedule) {
          return Response.json({ error: `Schedule '${scheduleId}' not found` }, { status: 404 });
        }
        return Response.json(schedule);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to get schedule" }, { status: 500 });
      }
    }

    // Create a schedule (delayed, scheduled, cron, or interval)
    if ((path.endsWith("/schedules/create") || (path.endsWith("/schedules") && request.method === "POST"))) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const { scheduleType, callback, payload, delayInSeconds, intervalSeconds, cron, date } = body;

        if (!callback) {
          return Response.json({ error: "Callback method name is required" }, { status: 400 });
        }

        // Callback allow-list (#111): this public route may only arm the
        // user-creatable callbacks in CREATABLE_SCHEDULE_CALLBACKS.
        // Anything else — including internal-only callbacks such as
        // executeAsyncJob and expireStaleOrderDraft — is rejected, and no
        // schedule is created.
        if (!(CREATABLE_SCHEDULE_CALLBACKS as readonly string[]).includes(callback)) {
          return Response.json(
            {
              success: false,
              error: `Callback '${callback}' is not allowed: POST /api/schedules/create only accepts ${CREATABLE_SCHEDULE_CALLBACKS.join(", ")}`,
            },
            { status: 400 }
          );
        }

        // No fabricated success (#111): this route never invents a
        // schedule id or reports success for a schedule that does not
        // exist. Issue #108: the calls below use the typed Agents SDK
        // API directly — schedule/scheduleEvery are typed members of
        // the Agent base class, so the old missing-method guard is
        // gone; if a typed call throws, the catch below returns the
        // same honest 503 {success:false} shape.
        let schedule: Schedule<unknown> | undefined;
        if (scheduleType === "interval" && intervalSeconds) {
          schedule = await this.scheduleEvery(Number(intervalSeconds), callback, payload);
        } else if (scheduleType === "cron" && cron) {
          schedule = await this.schedule(cron, callback, payload, { idempotent: body.idempotent !== false });
        } else if (scheduleType === "scheduled" && date) {
          schedule = await this.schedule(new Date(date), callback, payload);
        } else if (delayInSeconds !== undefined) {
          schedule = await this.schedule(Number(delayInSeconds), callback, payload);
        } else {
          return Response.json(
            { error: "Invalid schedule parameters: provide intervalSeconds, cron, date, or delayInSeconds" },
            { status: 400 }
          );
        }

        this.audit("schedule.created", "orchestrator", { scheduleId: schedule?.id, callback, scheduleType });
        return Response.json({ success: true, schedule });
      } catch (err: any) {
        // A throwing SDK scheduling call created nothing, so it gets the
        // honest 503 {success:false, error} shape (#111), worded as what
        // it is — scheduling was unavailable and no schedule was created
        // — never a success response and never a fabricated id.
        return Response.json(
          { success: false, error: `Scheduling unavailable: ${err.message || "Failed to create schedule"}` },
          { status: 503 }
        );
      }
    }

    // Trigger autonomous market screen immediately on demand
    if (path.endsWith("/schedules/trigger-screen") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        await this.autonomousMarketScreen(body);
        return Response.json({ success: true, message: "Autonomous market screen triggered" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger market screen" }, { status: 500 });
      }
    }

    // Trigger E*TRADE token renewal immediately on demand
    if (path.endsWith("/schedules/trigger-renew") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        await this.autoRenewETradeTokens(body);
        return Response.json({ success: true, message: "E*TRADE token renewal triggered" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger token renewal" }, { status: 500 });
      }
    }

    // Trigger autonomous options analysis immediately on demand
    if (path.endsWith("/schedules/trigger-options-analysis") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const service = new ScheduledTasksService(this.env, this.getOrm(), this.sessionKey(), new SqlScanRunStore(this.ctx.storage.sql));
        const result = await service.autonomousOptionsAnalysis(body);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger options analysis" }, { status: 500 });
      }
    }

    // List persisted reports (issue #309). Queries mas_reports (populated by #278, #308).
    // Supports ?q=search query and ?source=screener|options_scanner|iv_collection
    if ((path.endsWith("/reports") || path === "/reports" || path === "/api/reports") && request.method === "GET") {
      try {
        const { searchScheduledReports, ensureScheduledReportsTable, SCHEDULED_REPORTS_TABLE } = await import("../services/scheduledReports");
        const query = url.searchParams.get("q") || "";
        const sourceFilter = url.searchParams.get("source") || undefined;
        const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100));

        ensureScheduledReportsTable(this.ctx.storage.sql);

        let reports: any[];
        if (query.trim()) {
          // Search with query
          reports = searchScheduledReports(this.ctx.storage.sql, query, limit);
        } else {
          // List all, newest first
          // Note: mas_reports has no report_url column (see #307 R2 discussion).
          // The PDF URL is constructed from the runId via /api/screener/report.pdf
          const sql = this.ctx.storage.sql;
          let sqlQuery = `SELECT id, run_id as runId, title, source, summary, created_at as createdAt FROM ${SCHEDULED_REPORTS_TABLE}`;
          const params: unknown[] = [];
          if (sourceFilter) {
            sqlQuery += ` WHERE source = ?`;
            params.push(sourceFilter);
          }
          sqlQuery += ` ORDER BY created_at DESC LIMIT ?`;
          params.push(limit);
          reports = Array.from(sql.exec(sqlQuery, ...params)) as any[];
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

    // Nightly mas_messages retention pass (issue #255, part of #143).
    // The Worker's scheduled() handler fires this at the 0 4 * * * cron.
    if (path.endsWith("/schedules/trigger-retention") && request.method === "POST") {
      try {
        const result = runStorageRetention(this.getOrm(), {
          retentionDays: this.env.MAS_MESSAGES_RETENTION_DAYS,
        });
        return Response.json({ success: true, ...result });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to run storage retention" }, { status: 500 });
      }
    }

    // Trigger the daily IV history collection immediately on demand
    // (issue #15) — same per-name outcomes the scheduled run produces;
    // idempotent per (symbol, day), so a manual rerun is safe.
    if (path.endsWith("/schedules/trigger-iv-collection") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const service = new ScheduledTasksService(
          this.env,
          this.getOrm(),
          this.sessionKey(),
          new SqlScanRunStore(this.ctx.storage.sql),
          new SqlIvHistoryStore(this.ctx.storage.sql)
        );
        const result = await service.collectDailyIvHistory(body);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger IV collection" }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }
}
