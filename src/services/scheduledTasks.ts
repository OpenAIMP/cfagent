/**
 * Cloudflare Agents Task Scheduling Service
 *
 * Implements:
 * - Automated E*TRADE OAuth 1.0a access token proactive renewal (daily before midnight ET).
 * - Autonomous periodic market screening & technical opportunity detection.
 * - HITL Order Draft Expiration timer (auto-expiring stale unconfirmed orders after 15m).
 * - Persistent scheduled task reminders with SQLite auditing.
 */

import type { Env, ScheduledTaskResult, TradeRecord, ScreenedStockItem } from "../types";
import { DatabaseORM } from "../orm";
import { renewETradeAccessToken, getStoredTokens } from "../security/etradeOAuth";
import { DynamicMarketScreener } from "../trading";
import {
  type ScannedStock,
  type OpportunityStock,
} from "../trading";
import { ETradeService } from "./etrade";
import {
  UnifiedOptionsService,
  OptionsAgentPipeline,
  validateStrategyRequest,
  validateNoViewRequest,
  NO_VIEW_EXPECTED_IV_DIRECTION,
  deriveDiscoveryRequest,
  toProfileRef,
  MAX_SAVED_REQUESTS_PER_RUN,
  type NoViewStrategyRequest,
  type OptionThesis,
  type OptionStrategyType,
  type StrategyRequest,
} from "../trading";
import { getOpportunityScannerConfig } from "../config/etapiConfig";
import { tagOpportunitiesWithDirection } from "../trading";
import type { ScanRunStore } from "../trading";
import type {
  DiscoveryConstraintSet,
  DiscoveryRunStatus,
  DiscoveryRunStore,
  DiscoverySymbolOutcome,
  StrategyProfileStore,
} from "../trading";
import { DynamicOptionsScreener } from "../trading";
import { OptionsDataAgent } from "../trading";
import { collectIvHistory, flattenWatchlistSymbols, type IvCollectionReport } from "../trading";
import { generateOptionsPdf, optionsPdfFileName } from "../trading";
import type { IvHistoryStore } from "../trading";
// Issue #278: durable scheduled-run reports for the AI Search agent.
import { getCuratedStockUniverse } from "../config/curatedStockUniverse";
import {
  getCfpayConfig,
  cfpaySendEmail,
  cfpaySendEmailWithAttachments,
} from "./cfpayA2A";
import { ETradeEmailTradingService } from "../trading";
import { ETradeWebhookService } from "./tradingWebhooks";
import { ScreenerEventBus } from "../events/screenerEvents";
import { registerScreenerPublishers } from "../events/screenerPublishers";
import { deliverScreenerToSlackA2A } from "./screenerSlackDelivery";

export interface AutonomousOptionsAnalysisOptions {
  symbols?: string[];
  /** Universe to scan (resolves to symbols via listings; overrides symbols). */
  universe?: string;
  /** Maximum number of live universe listings to analyze; zero means all. */
  maxItems?: number;
  thesis?: OptionThesis;
  targetDate?: string;
  allowedStrategies?: OptionStrategyType[];
  riskProfile?: "conservative" | "balanced" | "aggressive";
  pushToSlack?: boolean;
  slackChannel?: string;
  emailTo?: string;
  webhookUrl?: string;
  environment?: string;
  trigger?: "manual" | "scheduled";
  userLogin?: string;
}

export interface AutonomousStrategyDiscoveryOptions {
  /** Complete saved StrategyRequests, captured from the discovery
   *  panel and re-run verbatim (issue #126 decision — the system
   *  never derives a target or invents a view for a schedule). */
  requests?: StrategyRequest[];
  /** Input model discriminator (issue #533). Absent or "saved-request"
   *  is the #126 model above; "profile-derived" arms the fields
   *  below instead; "no-view" (issue #534) arms constraintSets —
   *  the service branches on it. The three shapes are mutually
   *  exclusive: a payload mixing them fails pre-execution. */
  inputModel?: "saved-request" | "profile-derived" | "no-view";
  /** Profile-derived model: the explicit symbol set (exactly one of
   *  symbols / watchlistName). */
  symbols?: string[];
  /** Profile-derived model: a watchlist name resolved at fire time
   *  against the schedule owner's stored watchlists. */
  watchlistName?: string;
  /** Profile-derived model: the Strategy Profile id, resolved at
   *  fire time under the schedule owner's identity. */
  profileId?: string;
  /** No-view model (issue #534): constraint sets — one symbol each,
   *  constraints only. No thesis, target, or IV direction exists on
   *  the type; validateNoViewRequest rejects smuggled view fields. */
  constraintSets?: NoViewStrategyRequest[];
  environment?: string;
  trigger?: "manual" | "scheduled";
  userLogin?: string;
  /** The arming schedule's id, when the caller knows it (recorded as
   *  run provenance; the SDK callback path supplies none). */
  scheduleId?: string;
}

/**
 * Failure contract for scheduled jobs (issue #112 — deliberate; do not
 * "fix" by throwing):
 *
 * These methods NEVER throw to their scheduler caller. A failure is
 * returned as a terminal `{ success: false, error }` result and is
 * surfaced by the service itself — an audit event plus, for user-facing
 * jobs, a session message — and by the OrchestratorAgent callback's
 * broadcast. The Cloudflare Agents SDK retries a THROWING callback by
 * default ({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 3000 }), but
 * that platform retry is deliberately NOT used here: a broker/data
 * failure will not heal within 100ms–3s, and a blind retry could
 * duplicate notifications after a partial success. The async-job
 * plumbing makes the same choice explicitly, passing
 * `retry: { maxAttempts: 1 }` on its schedule() calls. A failed
 * scheduled run stays failed — visible in the audit log, the session,
 * and the broadcast — until its next scheduled fire or a manual
 * trigger.
 */
export class ScheduledTasksService {
  constructor(
    private env: Env,
    private orm?: DatabaseORM,
    private userLogin: string = "default_trader",
    private scanRunStore?: ScanRunStore,
    private ivHistoryStore?: IvHistoryStore,
    private discoveryRunStore?: DiscoveryRunStore,
    private strategyProfileStore?: StrategyProfileStore
  ) {}

  /**
   * ScreenerAgent stub (issue #261) — one agent owns all screening.
   */
  private getScreenerAgent(userLogin = this.userLogin): import("../agents/screener-agent").ScreenerAgent {
    const id = (this.env as any).SCREENER_AGENT.idFromName(
      userLogin === "default_trader" ? "default" : `screener:${userLogin}`
    );
    return (this.env as any).SCREENER_AGENT.get(id);
  }

  /**
   * Helper to append an audit event into mas_events if ORM is available
   */
  private audit(type: string, payload: Record<string, unknown>): void {
    if (!this.orm?.events) return;
    try {
      this.orm.events.create({
        id: crypto.randomUUID(),
        sessionId: this.userLogin,
        type,
        agent: "orchestrator",
        payload,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Non-critical audit insertion error
    }
  }

  /**
   * Issue #210: publish a screener event to the bus, registering the
   * Slack/email/webhook subscribers on first use. Never throws.
   */
  private screenerBus?: ScreenerEventBus;
  private async publishScreenerEvent(
    event: import("../events/screenerEvents").ScreenerEvent
  ): Promise<void> {
    try {
      if (!this.screenerBus) {
        this.screenerBus = new ScreenerEventBus();
        registerScreenerPublishers(this.screenerBus, {
          env: this.env,
          orm: this.orm,
          userLogin: this.userLogin,
        });
      }
      await this.screenerBus.publish(event);
    } catch (err) {
      console.warn(
        "[ScheduledTasksService] screener event publish failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * Proactively renews E*TRADE OAuth 1.0a access tokens before midnight ET expiry
   */
  async autoRenewETradeTokens(
    targetUser?: string,
    targetEnv?: string
  ): Promise<ScheduledTaskResult<{ renewed: boolean; userLogin: string; expiresAt?: string; message?: string }>> {
    const timestamp = new Date().toISOString();
    const user = targetUser || this.userLogin;

    try {
      const storedTokens = await getStoredTokens(this.env, user, targetEnv);
      if (!storedTokens) {
        return {
          success: true,
          taskType: "etrade_token_renewal",
          data: {
            renewed: false,
            userLogin: user,
            message: `No active E*TRADE tokens found in storage for user [${user}].`,
          },
          timestamp,
        };
      }

      const renewed = await renewETradeAccessToken(this.env, user, targetEnv);
      if (!renewed) {
        this.audit("etrade.token_auto_renew_failed", {
          userLogin: user,
          environment: targetEnv || "default",
          reason: "Upstream renewal rejected or token already expired past midnight ET",
        });

        return {
          success: false,
          taskType: "etrade_token_renewal",
          error: `E*TRADE access token renewal rejected or expired for user [${user}].`,
          timestamp,
        };
      }

      this.audit("etrade.token_auto_renewed", {
        userLogin: user,
        environment: renewed.environment,
        storedAt: renewed.storedAt,
      });

      return {
        success: true,
        taskType: "etrade_token_renewal",
        data: {
          renewed: true,
          userLogin: user,
          expiresAt: renewed.storedAt,
          message: `E*TRADE access token renewed successfully for [${user}].`,
        },
        timestamp,
      };
    } catch (err: any) {
      this.audit("etrade.token_auto_renew_error", {
        userLogin: user,
        error: err.message,
      });

      return {
        success: false,
        taskType: "etrade_token_renewal",
        error: err.message || "Failed to renew E*TRADE access token",
        timestamp,
      };
    }
  }

  /**
   * Runs an autonomous market screen via ScreenerAgent (#261).
   * One agent owns all screening; E*TRADE-only data with honest failure.
   */
  async autonomousMarketScreen(options: {
    sector?: string;
    universe?: string;
    maxItems?: number;
    userLogin?: string;
    environment?: "TEST" | "PROD";
    trigger?: "manual" | "scheduled";
  } = {}): Promise<ScheduledTaskResult<{
    totalScanned: number;
    matchedCount: number;
    opportunities: OpportunityStock[];
    allStocks: ScannedStock[];
    sector?: string;
    universe?: string;
    expectedCount?: number;
    pdfKey?: string;
  }>> {
    const timestamp = new Date().toISOString();

    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        throw new Error("No authenticated E*TRADE account is associated with this scheduled screen. Open the schedules panel while signed in and run it again.");
      }
      // Issue #261/#270: delegate screening to ScreenerAgent (E*TRADE-only).
      // Issue #421: pass the sector through unset when none was chosen —
      // ScreenerAgent labels unselected runs "ALL" instead of inventing one.
      const result = await this.getScreenerAgent(userLogin).runScreen({
        trigger: options.trigger || "scheduled",
        sector: options.sector,
        universe: (options.universe as any) || "TECH",
        maxSymbols: options.maxItems,
        userLogin,
        environment: options.environment,
      });

      if (result.skippedDuplicate) {
        return { success: true, taskType: "market_screen", skipped: true, timestamp } as any;
      }

      if (!result.success) {
        throw new Error(result.error || "E*TRADE unavailable");
      }

      // Audit every run (not just ones with hits) so "Recent autonomous
      // actions" shows the full history, including quiet runs.
      this.audit("screener.run_completed", {
        sector: result.sector,
        universe: result.universe,
        totalScanned: result.totalScanned,
        matchedCount: result.matchedCount,
        opportunityCount: result.opportunities.length,
        symbols: result.opportunities.map(s => s.symbol),
      });
      if (result.opportunities.length > 0) {
        this.audit("screener.opportunities_detected", {
          sector: result.sector,
          universe: result.universe,
          count: result.opportunities.length,
          symbols: result.opportunities.map(s => s.symbol),
        });
      }

      // Issue #210: publish to the event bus so Slack/email/webhook
      // subscribers can harvest the results.
      await this.publishScreenerEvent({
        type: "screener.completed",
        timestamp,
        universe: result.universe,
        trigger: options.trigger || "scheduled",
        expectedCount: result.expectedCount,
        pdfKey: result.pdfKey,
        deliveryId: `${options.trigger || "scheduled"}:${result.universe}:${timestamp.slice(0, 16)}`,
        sector: result.sector || options.sector || "ALL",
        totalScanned: result.totalScanned,
        matchedCount: result.matchedCount,
        opportunities: result.opportunities,
        ...(result.partial
          ? {
              partial: {
                quotedCount: result.partial.quotedCount,
                requestedCount: result.partial.requestedCount,
                failedSymbols: result.partial.failedSymbols,
                failureReasons: result.partial.failureReasons,
              },
            }
          : {}),
      });

      return {
        success: true,
        taskType: "market_screen",
        data: {
          totalScanned: result.totalScanned,
          matchedCount: result.matchedCount,
          opportunities: result.opportunities,
          allStocks: result.allStocks,
          sector: result.sector,
          universe: result.universe,
          expectedCount: result.expectedCount,
          pdfKey: result.pdfKey,
        },
        timestamp,
      };
    } catch (err: any) {
      // Failure surfacing (issue #112): screen failures used to vanish —
      // no audit event, no session message — unlike options analysis.
      // Audit and surface them symmetrically.
      this.audit("screener.screen_failed", {
        sector: options.sector || "ALL",
        error: err.message,
      });

      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Market Screen failed for sector ${options.sector || "ALL"}: ${err.message || "Market screener execution error"}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }

      // Issue #210: publish the failure so subscribers can notify.
      await this.publishScreenerEvent({
        type: "screener.failed",
        timestamp,
        universe: options.universe || "TECH",
        trigger: options.trigger || "scheduled",
        deliveryId: `${options.trigger || "scheduled"}:${options.universe || "TECH"}:${timestamp.slice(0, 16)}`,
        sector: options.sector || "ALL",
        error: err.message || "Market screener execution error",
      });

      return {
        success: false,
        taskType: "market_screen",
        error: err.message || "Market screener execution error",
        timestamp,
      };
    }
  }

  /**
   * Automatically expires a previewed order draft after timeout (15-minute HITL window)
   */
  async expireStaleOrderDraft(
    orderId: string
  ): Promise<ScheduledTaskResult<{
    orderId: string;
    expired: boolean;
    previousStatus: string;
    trade?: TradeRecord;
  }>> {
    const timestamp = new Date().toISOString();

    if (!this.orm?.trades) {
      return {
        success: false,
        taskType: "order_expiration",
        error: "Database ORM not initialized",
        timestamp,
      };
    }

    const trade = this.orm.trades.findById(orderId);
    if (!trade) {
      return {
        success: false,
        taskType: "order_expiration",
        error: `Order draft '${orderId}' not found.`,
        timestamp,
      };
    }

    // Only expire if still in 'previewed' status (not executed, rejected, or cancelled)
    if (trade.status === "previewed") {
      const notes = `${trade.previewNotes || ""} [Auto-expired: 15-minute HITL window elapsed without human authorization]`.trim();
      this.orm.trades.update(orderId, {
        status: "expired",
        updatedAt: timestamp,
        previewNotes: notes,
      });

      this.audit("order.auto_expired", {
        orderId,
        symbol: trade.symbol,
        quantity: trade.quantity,
        totalValue: trade.totalValue,
        previousStatus: "previewed",
        expiredAt: timestamp,
      });

      return {
        success: true,
        taskType: "order_expiration",
        data: {
          orderId,
          expired: true,
          previousStatus: "previewed",
          trade: { ...trade, status: "expired", previewNotes: notes, updatedAt: timestamp },
        },
        timestamp,
      };
    }

    // Order was already resolved (approved, rejected, cancelled, etc.)
    return {
      success: true,
      taskType: "order_expiration",
      data: {
        orderId,
        expired: false,
        previousStatus: trade.status,
        trade,
      },
      timestamp,
    };
  }

  /**
   * Dispatches a scheduled user reminder: records it in the user's chat
   * history (the delivery channel) and audits the outcome.
   *
   * Issue #123 (F19): the result reflects what actually happened per
   * channel. The chat-message insert IS the delivery — if it fails (or
   * no message store is available), the dispatch FAILED: the failure is
   * audited as `reminder.dispatch_failed` (the #112 failure contract)
   * and returned as `{ success: false, error }`, never swallowed into a
   * success claim. `reminder.dispatched` is audited only when the
   * reminder was actually recorded.
   */
  async dispatchReminder(
    reminderId: string,
    message: string
  ): Promise<ScheduledTaskResult<{
    reminderId: string;
    message: string;
    dispatchedAt: string;
    channels: { audit: boolean; chatMessage: boolean };
    messageError?: string;
  }>> {
    const timestamp = new Date().toISOString();

    let chatMessageRecorded = false;
    let messageError: string | undefined;
    if (this.orm?.messages) {
      try {
        this.orm.messages.create({
          id: crypto.randomUUID(),
          sessionId: this.userLogin,
          role: "assistant",
          content: `⏰ Scheduled Reminder [${reminderId}]: ${message}`,
          agent: "orchestrator",
          createdAt: timestamp,
        });
        chatMessageRecorded = true;
      } catch (err: any) {
        messageError = err?.message || "Failed to record reminder message";
      }
    } else {
      messageError = "No message store available to record the reminder";
    }

    // The audit channel claim reflects whether an audit store is actually
    // attached (this.audit no-ops without one, as everywhere in this service).
    const auditAvailable = Boolean(this.orm?.events);

    if (!chatMessageRecorded) {
      this.audit("reminder.dispatch_failed", {
        reminderId,
        message,
        userLogin: this.userLogin,
        error: messageError,
        attemptedAt: timestamp,
      });
      return {
        success: false,
        taskType: "reminder",
        error: `Reminder could not be delivered to chat history: ${messageError}`,
        data: {
          reminderId,
          message,
          dispatchedAt: timestamp,
          channels: { audit: auditAvailable, chatMessage: false },
          messageError,
        },
        timestamp,
      };
    }

    this.audit("reminder.dispatched", {
      reminderId,
      message,
      userLogin: this.userLogin,
      dispatchedAt: timestamp,
      channels: { audit: auditAvailable, chatMessage: true },
    });

    return {
      success: true,
      taskType: "reminder",
      data: {
        reminderId,
        message,
        dispatchedAt: timestamp,
        channels: { audit: auditAvailable, chatMessage: true },
      },
      timestamp,
    };
  }

  /**
   * Autonomous Options Intelligence & Cross-Symbol Opportunity Analysis
   * Can be triggered on-demand or executed on a Cloudflare Agents schedule (cron or interval)
   * Dispatches push notifications to Slack, Email, and Webhook upon completion
   */
  async autonomousOptionsAnalysis(
    options: AutonomousOptionsAnalysisOptions = {}
  ): Promise<ScheduledTaskResult<{
    totalScanned: number;
    withTrades: number;
    symbols: string[];
    summary: string;
    notifications: {
      slack?: boolean;
      email?: boolean;
      webhook?: boolean;
    };
    opportunities?: any[];
    reportUrl?: string;
  }>> {
    const timestamp = new Date().toISOString();
    let symbols: string[] = [];
    const targetThesis = options.thesis || "bullish";
    const shouldNotifySlack = options.pushToSlack === true ||
      (options.pushToSlack === undefined && Boolean(this.env.SLACK_BOT_TOKEN || getCfpayConfig(this.env)));

    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        throw new Error("No authenticated E*TRADE account is associated with this options screen. Sign in and run it again.");
      }
      if (options.trigger === "scheduled") {
        const jobKey = `options:${options.universe || (options.symbols || []).join(",")}:${targetThesis}:${options.maxItems ?? "all"}`;
        const claimed = await this.getScreenerAgent(userLogin).claimScheduledExecution(jobKey, options.environment);
        if (!claimed) return { success: true, taskType: "options_analysis", skipped: true, timestamp } as any;
      }
      // Resolve universe to symbols inside the failure boundary so listings
      // and E*TRADE errors reach the scheduled failure notification path.
      const effectiveUniverse = options.universe || (options.symbols && options.symbols.length > 0 ? null : "NASDAQ100");
      if (effectiveUniverse) {
        const { fetchAllUsStockListings } = await import("../services/nasdaqListings");
        const { resolveUniverse, UNIVERSES } = await import("../trading");
        const listings = await fetchAllUsStockListings();
        const universeDef = UNIVERSES[effectiveUniverse as keyof typeof UNIVERSES];
        const resolved = resolveUniverse(effectiveUniverse as any, listings);
        const maxSymbols = options.maxItems ?? universeDef?.defaultMaxSymbols ?? 50;
        symbols = (maxSymbols > 0 ? resolved.slice(0, maxSymbols) : resolved).map((l) => l.symbol);
      } else {
        const requested = options.symbols || [];
        symbols = options.maxItems && options.maxItems > 0 ? requested.slice(0, options.maxItems) : requested;
      }
      if (symbols.length === 0) {
        throw new Error(`No live symbols resolved for the options universe${effectiveUniverse ? ` ${effectiveUniverse}` : ""}; no static list was substituted.`);
      }

      const unifiedService = new UnifiedOptionsService(
        this.env,
        userLogin,
        options.environment,
        this.orm,
        this.scanRunStore
      );

      const response = await unifiedService.execute({
        action: "opportunities",
        symbols,
        thesis: targetThesis,
        targetDate: options.targetDate,
        riskProfile: options.riskProfile || "balanced",
        allowedStrategies: options.allowedStrategies,
        channel: "ui",
        userLogin,
        overrideEnv: options.environment,
      });
      if (!response.success) throw new Error(response.summary || "Scheduled options scan failed");
      const scanData = response.data as any;
      const scannedCount = Number(scanData?.scanned ?? 0);
      const coverageErrors = Number(scanData?.coverage?.errors ?? 0);
      const truncatedCount = Number(scanData?.truncatedSymbols ?? scanData?.coverage?.truncated ?? 0);
      if (scannedCount !== symbols.length || coverageErrors > 0 || truncatedCount > 0) {
        throw new Error(
          `Incomplete options universe: ${scannedCount} of ${symbols.length} underlyings scanned, ` +
          `${coverageErrors} quote/chain failures, ${truncatedCount} truncated. No partial report published.`
        );
      }

      // Issue #275: tag each opportunity with its strategy's direction
      // tags (the catalog theses) before the PDF, the canonical report
      // and the channel payloads are built from this data — every
      // published copy carries the tags.
      if (Array.isArray(scanData?.opportunities)) {
        scanData.opportunities = tagOpportunitiesWithDirection(scanData.opportunities);
      }

      const notifications: { slack?: boolean; email?: boolean; webhook?: boolean } = {};
      let optionsPdf: Uint8Array | undefined;
      let optionsPdfFile: string | undefined;
      let optionsPdfKey: string | undefined;
      try {
        optionsPdf = await generateOptionsPdf(response.data);
        optionsPdfFile = optionsPdfFileName(response.data);
        let binary = "";
        for (let i = 0; i < optionsPdf.length; i += 8192) binary += String.fromCharCode(...optionsPdf.subarray(i, i + 8192));
        optionsPdfKey = await this.getScreenerAgent(userLogin).storeOptionsPdf(btoa(binary), optionsPdfFile);
      } catch (pdfErr) {
        console.warn("[ScheduledTasksService] Options PDF generation/storage failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
      }
      const reportUrl = optionsPdfKey
        ? `${this.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/options/report.pdf?key=${encodeURIComponent(optionsPdfKey)}`
        : undefined;

      // Store the searchable report once before any channel delivery. The
      // PDF remains in ScreenerAgent storage; mas_reports keeps its key/URL
      // and the complete structured scan payload for AI Search.
      const generationId = `options_scanner:${timestamp}:${targetThesis}`;
      const canonical = this.orm?.storeCanonicalReport({
        runId: generationId,
        generationId,
        title: `Options scanner — ${targetThesis} (${timestamp.slice(0, 10)})`,
        source: "options_scanner",
        summary: response.summary,
        body: {
          generatedAt: timestamp,
          thesis: targetThesis,
          symbols,
          totalScanned: response.data?.scanned ?? symbols.length,
          withTrades: response.data?.withTrades ?? 0,
          opportunities: response.data?.opportunities ?? [],
          pdfKey: optionsPdfKey,
          reportUrl,
          report: typeof response.toWebhook === "function" ? response.toWebhook() : response.data,
        },
        createdAt: timestamp,
      });

      // One A2A file operation creates one Slack notification with the
      // summary attached, avoiding the old text-plus-file duplicate pair.
      if (shouldNotifySlack) {
        const slackChannel = options.slackChannel || (this.env as any).SCREENER_SLACK_CHANNEL || (this.env as any).SLACK_CHANNEL;
        const slackPayload = response.toSlack();
        const text = typeof slackPayload === "string" ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
        try {
          const delivery = await deliverScreenerToSlackA2A(this.env, {
            text,
            channel: slackChannel,
            ...(optionsPdf && optionsPdfFile ? { pdf: {
              bytes: optionsPdf,
              fileName: optionsPdfFile,
              title: `Options Scanner Report — ${targetThesis} ${timestamp.slice(0, 10)}`,
              comment: `📄 Options scan PDF — ${response.data.matchedCount || 0} contracts matched${reportUrl ? `\n${reportUrl}` : ""}\n\n${text}`,
            } } : {}),
          });
          notifications.slack = delivery.ok;
          if (!delivery.ok) console.warn("[ScheduledTasksService] Slack A2A PDF delivery failed:", delivery.error);
        } catch (pdfErr) {
          console.warn("[ScheduledTasksService] Options Slack delivery failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
          const delivery = await deliverScreenerToSlackA2A(this.env, { text, channel: slackChannel });
          notifications.slack = delivery.ok;
          if (!delivery.ok) console.warn("[ScheduledTasksService] Slack A2A notification failed:", delivery.error);
        }
      }

      // 2. Push Email if recipient is specified
      // Issue #303: Try cfpay via A2A first, fall back to local.
      if (options.emailTo) {
        const cfpay = getCfpayConfig(this.env);
        let emailOk = false;
        if (cfpay) {
          try {
            const subject = `📊 E*TRADE Scheduled Options Intelligence [${targetThesis.toUpperCase()}] - ${symbols.join(", ")}`;
            const body = `${response.toEmailText()}${reportUrl ? `\n\nPDF report: ${reportUrl}` : ""}`;
            let r;
            if (optionsPdf && optionsPdfFile) {
              let binary = "";
              for (let i = 0; i < optionsPdf.length; i += 8192) binary += String.fromCharCode(...optionsPdf.subarray(i, i + 8192));
              r = await cfpaySendEmailWithAttachments(cfpay, {
                to: options.emailTo,
                subject,
                body,
                attachments: [{ filename: optionsPdfFile, contentB64: btoa(binary), contentType: "application/pdf" }],
              });
            } else {
              r = await cfpaySendEmail(cfpay, options.emailTo, subject, body);
            }
            emailOk = r.ok;
            if (!r.ok) {
              console.warn("[ScheduledTasksService] cfpay Email failed, falling back to local:", r.error);
            }
          } catch (err) {
            console.warn("[ScheduledTasksService] cfpay Email error:", err);
          }
        }
        if (!emailOk) {
          try {
            const emailService = new ETradeEmailTradingService(this.env, this.orm, this.userLogin);
            notifications.email = await emailService.sendOutboundEmail(
              options.emailTo,
              `📊 E*TRADE Scheduled Options Intelligence [${targetThesis.toUpperCase()}] - ${symbols.join(", ")}`,
              response.toEmailHtml(),
              `${response.toEmailText()}${reportUrl ? `\n\nPDF report: ${reportUrl}` : ""}`,
              optionsPdf && optionsPdfFile ? {
                fileName: optionsPdfFile,
                contentType: "application/pdf",
                contentBase64: (() => { let b = ""; for (let i = 0; i < optionsPdf!.length; i += 8192) b += String.fromCharCode(...optionsPdf!.subarray(i, i + 8192)); return btoa(b); })(),
              } : undefined
            );
          } catch (emailErr) {
            console.warn("[ScheduledTasksService] Email notification error:", emailErr);
            notifications.email = false;
          }
        } else {
          notifications.email = true;
        }
      }

      // 3. Push Webhook if target URL is specified or default configured
      const targetWebhookUrl = options.webhookUrl || this.env.OUTBOUND_WEBHOOK_URL;
      if (targetWebhookUrl) {
        try {
          const webhookService = new ETradeWebhookService(this.orm, this.env, this.userLogin);
          const webhookPayload = { ...response.toWebhook(), reportUrl };
          const whResult = await webhookService.dispatchOutboundWebhook(
            "options.scheduled_analysis",
            webhookPayload,
            targetWebhookUrl
          );
          notifications.webhook = whResult.success;
          if (!whResult.success) {
            // e.g. no OUTBOUND_WEBHOOK_SECRET configured (issue #123/F20):
            // the flag above already reports false; log the reason too.
            console.warn("[ScheduledTasksService] Webhook notification not sent:", whResult.error || `HTTP ${whResult.status}`);
          }
        } catch (webhookErr) {
          console.warn("[ScheduledTasksService] Webhook notification error:", webhookErr);
          notifications.webhook = false;
        }
      }

      this.audit("options.scheduled_analysis_completed", {
        symbols,
        thesis: targetThesis,
        scanned: response.data?.scanned ?? symbols.length,
        withTrades: response.data?.withTrades ?? 0,
        notifications,
        reportId: canonical?.reportId,
      });

      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `🎯 Scheduled Options Intelligence: ${response.summary}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }

      return {
        success: true,
        taskType: "options_analysis" as any,
        data: {
          totalScanned: response.data?.scanned ?? symbols.length,
          withTrades: response.data?.withTrades ?? 0,
          symbols,
          summary: response.summary,
          notifications,
          opportunities: response.data?.opportunities,
          reportUrl,
        },
        timestamp,
      };
    } catch (err: any) {
      this.audit("options.scheduled_analysis_failed", {
        symbols,
        thesis: targetThesis,
        error: err.message,
      });

      // Failure surfacing (issue #112): mirror the success path's
      // session message so a failed run is visible in the conversation,
      // not only in the audit log.
      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Options Intelligence failed for ${symbols.join(", ")}: ${err.message || "Scheduled options analysis failed"}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }

      if (shouldNotifySlack) {
        const failure = await deliverScreenerToSlackA2A(this.env, {
          channel: options.slackChannel,
          text: `⚠️ Scheduled Options Screen FAILED — ${options.universe || symbols.join(", ") || "NASDAQ100"} (${targetThesis})\nError: ${err.message || "Scheduled options analysis failed"}\n_Time: ${timestamp}_`,
        });
        if (!failure.ok) console.warn("[ScheduledTasksService] Slack A2A failure notification failed:", failure.error);
      }

      return {
        success: false,
        taskType: "options_analysis" as any,
        error: err.message || "Scheduled options analysis failed",
        timestamp,
      };
    }
  }

  /**
   * Scheduled strategy discovery (issue #126, PR-E): re-runs SAVED
   * StrategyRequests — captured whole from the discovery panel — against
   * live chains through the same OptionsAgentPipeline the interactive
   * route uses, and persists one run record per execution
   * (SqlDiscoveryRunStore) with per-symbol outcomes.
   *
   * The input model is deliberate (user decision on #126): the payload
   * carries complete requests and this task re-runs them verbatim. It
   * never derives a target price, a thesis, or any other part of a view
   * the user did not configure.
   *
   * Honesty contract (mirrors the scanner's, per #112): a failure to
   * resolve the owner/environment, a missing store, or an invalid
   * payload fails the task with audit + session message and persists
   * NOTHING. Once execution starts, exactly one run record is
   * persisted: "completed" when every request produced a result,
   * "partial" when some did and some failed (the failures are named on
   * the record), and "failed" when none did — an all-failed run takes
   * the failure path (audit + session message + { success: false })
   * and its record exists for diagnosis, never as a success.
   */
  async autonomousStrategyDiscovery(
    options: AutonomousStrategyDiscoveryOptions = {}
  ): Promise<ScheduledTaskResult<{
    runId: string;
    status: DiscoveryRunStatus;
    requestCount: number;
    completedCount: number;
    failedCount: number;
    symbols: string[];
    failures: Array<{ symbol: string; error: string }>;
    abstained?: Array<{ symbol: string; reason: string }>;
  }>> {
    const timestamp = new Date().toISOString();
    // Issue #534: the no-view input model has its own validation +
    // ranking flow. A payload carrying constraintSets under any other
    // (or no) discriminator routes here too, so the shape is judged
    // — and rejected as mixed — instead of being silently ignored by
    // a sibling model.
    if (options.inputModel === "no-view" || options.constraintSets !== undefined) {
      return this.autonomousStrategyDiscoveryNoView(options, timestamp);
    }
    // Issue #533: the profile-derived input model has its own
    // resolution + derivation flow; the saved-request path below is
    // untouched for every other payload.
    if (options.inputModel === "profile-derived") {
      return this.autonomousStrategyDiscoveryDerived(options, timestamp);
    }
    const requests = options.requests ?? [];
    const symbols = requests.map((r) => (typeof r?.symbol === "string" ? r.symbol.toUpperCase().trim() : "?"));

    const fail = (error: string, runId?: string, status?: DiscoveryRunStatus, failures: Array<{ symbol: string; error: string }> = []) => {
      this.audit("options.strategy_discovery_failed", {
        symbols,
        trigger: options.trigger || "scheduled",
        ...(runId ? { runId } : {}),
        error,
      });
      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Strategy Discovery failed for ${symbols.join(", ") || "no saved requests"}: ${error}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: false,
        taskType: "strategy_discovery" as any,
        error,
        ...(runId
          ? {
              data: {
                runId,
                status: status as DiscoveryRunStatus,
                requestCount: requests.length,
                completedCount: requests.length - failures.length,
                failedCount: failures.length,
                symbols,
                failures,
              },
            }
          : {}),
        timestamp,
      } as ScheduledTaskResult<{
        runId: string;
        status: DiscoveryRunStatus;
        requestCount: number;
        completedCount: number;
        failedCount: number;
        symbols: string[];
        failures: Array<{ symbol: string; error: string }>;
        abstained?: Array<{ symbol: string; reason: string }>;
      }>;
    };

    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        return fail("No authenticated E*TRADE account is associated with this scheduled discovery. Open the schedules panel while signed in and run it again.");
      }
      if (!this.discoveryRunStore) {
        return fail("Discovery run store not configured for this service instance");
      }
      if (!Array.isArray(requests) || requests.length === 0) {
        return fail("Scheduled discovery requires at least one saved strategy request; none was supplied. Capture a view in the discovery panel and schedule it — no view is invented for a schedule.");
      }
      if (requests.length > MAX_SAVED_REQUESTS_PER_RUN) {
        return fail(`Scheduled discovery is capped at ${MAX_SAVED_REQUESTS_PER_RUN} saved requests per run; ${requests.length} were supplied.`);
      }
      for (let i = 0; i < requests.length; i++) {
        const validationError = validateStrategyRequest(requests[i]);
        if (validationError) {
          return fail(`Saved discovery request ${i + 1} of ${requests.length} (${symbols[i]}) is invalid: ${validationError}`);
        }
      }

      // One client/pipeline for the whole execution — the same
      // construction the interactive strategies route uses, under the
      // schedule owner's identity and environment (#447/#461).
      const etrade = new ETradeService(
        this.orm || new DatabaseORM({ exec: () => [] }),
        this.env,
        userLogin,
        options.environment
      );
      const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));

      const outcomes: DiscoverySymbolOutcome[] = [];
      for (const request of requests) {
        outcomes.push(await this.runDiscoveryRequest(pipeline, etrade, request));
      }

      const failures = outcomes
        .filter((o) => o.status === "failed")
        .map((o) => ({ symbol: o.symbol, error: o.error || "unknown failure" }));
      const status: DiscoveryRunStatus =
        failures.length === 0 ? "completed" : failures.length === outcomes.length ? "failed" : "partial";

      const run = await this.discoveryRunStore.save({
        createdAt: timestamp,
        trigger: options.trigger === "manual" ? "manual-trigger" : "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
        userLogin,
        inputModel: "saved-request",
        requests,
        outcomes,
        status,
      });

      if (status === "failed") {
        return fail(
          `Every saved discovery request failed (${failures.map((f) => `${f.symbol}: ${f.error}`).join("; ")})`,
          run.id,
          status,
          failures
        );
      }

      this.audit("options.strategy_discovery_completed", {
        runId: run.id,
        status,
        symbols,
        requestCount: requests.length,
        completedCount: requests.length - failures.length,
        failedCount: failures.length,
        trigger: options.trigger || "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      });

      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content:
              status === "completed"
                ? `🔭 Scheduled Strategy Discovery completed for ${symbols.join(", ")}: all ${requests.length} saved requests produced results.`
                : `🔭 Scheduled Strategy Discovery partially completed for ${symbols.join(", ")}: ${requests.length - failures.length} of ${requests.length} requests produced results; failed: ${failures.map((f) => `${f.symbol} (${f.error})`).join("; ")}.`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }

      return {
        success: true,
        taskType: "strategy_discovery" as any,
        data: {
          runId: run.id,
          status,
          requestCount: requests.length,
          completedCount: requests.length - failures.length,
          failedCount: failures.length,
          symbols,
          failures,
        },
        timestamp,
      };
    } catch (err: any) {
      return fail(err?.message || "Scheduled strategy discovery failed");
    }
  }

  /**
   * Runs ONE constructed discovery request through the pipeline and
   * shapes its outcome. Shared verbatim by the saved-request path
   * (issue #126) and the profile-derived path (issue #533) — the two
   * input models differ in where requests come from, never in how a
   * request is executed or judged.
   */
  private async runDiscoveryRequest(
    pipeline: OptionsAgentPipeline,
    etrade: ETradeService,
    request: StrategyRequest
  ): Promise<DiscoverySymbolOutcome> {
    const symbol = request.symbol.toUpperCase().trim();
    try {
      const result = await pipeline.run(request);
      const snapshot = result.snapshot;
      // A snapshot that never loaded its chain is a failure, not
      // an empty success: the screen records why (validation
      // error, per-symbol fetch errors, or the client's recorded
      // upstream cause). Zero contracts with NO failure signal is
      // a genuine no-candidates outcome and completes honestly.
      const fetchReasons = (snapshot.screen.fetchErrors ?? [])
        .filter((e) => e.symbol === symbol)
        .map((e) => e.reason);
      let failure: string | undefined;
      if (snapshot.validationError) {
        failure = snapshot.validationError;
      } else if (snapshot.contracts.length === 0 && fetchReasons.length > 0) {
        failure = fetchReasons.join("; ");
      } else if (snapshot.contracts.length === 0) {
        failure = etrade.getLastError() || undefined;
      }
      if (failure) {
        return { symbol, status: "failed", request, error: failure };
      }
      return {
        symbol,
        status: "completed",
        request,
        ranked: result.ranked,
        riskReports: result.riskReports,
        screenedOut: result.screenedOut.slice(0, 50),
        excluded: result.strategies.excluded,
        bestTrade: result.bestTrade,
        snapshot: {
          dataSource: snapshot.dataSource,
          screen: snapshot.screen,
          ...(snapshot.validationError ? { validationError: snapshot.validationError } : {}),
        },
      };
    } catch (err: any) {
      return {
        symbol,
        status: "failed",
        request,
        error: err?.message || "Strategy discovery pipeline failed",
      };
    }
  }

  /**
   * Issue #533 (D4): resolves a watchlist NAME to its symbols from
   * the owner's stored watchlists — no E*TRADE round-trip, so
   * watchlist edits between arming and firing are honoured. The name
   * match is trimmed and case-insensitive. Returns null when no
   * stored watchlist matches (or the ORM is unavailable); the caller
   * fails honestly and persists nothing.
   */
  private resolveWatchlistSymbols(name: string, userLogin: string): string[] | null {
    if (!this.orm?.watchlists) return null;
    try {
      const rows = this.orm.watchlists.findMany({ where: { userLogin } }) as Array<{
        name?: string;
        symbolsJson?: string | null;
      }>;
      const key = name.trim().toLowerCase();
      const match = rows.find(
        (row) => typeof row?.name === "string" && row.name.trim().toLowerCase() === key
      );
      if (!match) return null;
      const seen = new Set<string>();
      const symbols: string[] = [];
      for (const raw of flattenWatchlistSymbols([match])) {
        const symbol = typeof raw === "string" ? raw.toUpperCase().trim() : "";
        if (symbol && !seen.has(symbol)) {
          seen.add(symbol);
          symbols.push(symbol);
        }
      }
      return symbols;
    } catch {
      return null;
    }
  }

  /**
   * The profile-derived discovery fire (issue #533). The schedule
   * armed a symbol set (explicit, or a watchlist name resolved at
   * fire time) plus a Strategy Profile id; the profile is resolved
   * NOW, so edits and deletions since arming are honoured as honest
   * outcomes. Each symbol's target is derived from its own live
   * chain under the profile (see derivation module), the constructed
   * request runs through the unchanged pipeline, and the run persists
   * stamped "profile-derived" with the profile reference and the full
   * derivation per symbol. A symbol that cannot be derived honestly
   * ABSTAINS — reason on the record, no request, no target — and an
   * all-abstained fire persists as a FAILED run on the #112 failure
   * path. Resolution failures before execution (identity, stores,
   * profile, symbol set) persist NOTHING, the saved-path precedent.
   */
  private async autonomousStrategyDiscoveryDerived(
    options: AutonomousStrategyDiscoveryOptions,
    timestamp: string
  ): Promise<ScheduledTaskResult<{
    runId: string;
    status: DiscoveryRunStatus;
    requestCount: number;
    completedCount: number;
    failedCount: number;
    symbols: string[];
    failures: Array<{ symbol: string; error: string }>;
    abstained?: Array<{ symbol: string; reason: string }>;
  }>> {
    let attemptedSymbols: string[] = Array.isArray(options.symbols)
      ? options.symbols
          .map((s) => (typeof s === "string" ? s.toUpperCase().trim() : ""))
          .filter((s) => s.length > 0)
      : [];

    const fail = (
      error: string,
      runId?: string,
      status?: DiscoveryRunStatus,
      failures: Array<{ symbol: string; error: string }> = [],
      abstentions: Array<{ symbol: string; reason: string }> = [],
      constructedCount = 0
    ) => {
      this.audit("options.strategy_discovery_failed", {
        symbols: attemptedSymbols,
        inputModel: "profile-derived",
        trigger: options.trigger || "scheduled",
        ...(runId ? { runId } : {}),
        ...(abstentions.length > 0 ? { abstained: abstentions } : {}),
        error,
      });
      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Strategy Discovery failed for ${attemptedSymbols.join(", ") || "no symbols"}: ${error}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: false,
        taskType: "strategy_discovery" as any,
        error,
        ...(runId ? {
          data: {
            runId,
            status: status ?? "failed",
            requestCount: constructedCount,
            completedCount: constructedCount - failures.length,
            failedCount: failures.length,
            symbols: attemptedSymbols,
            failures,
            abstained: abstentions,
          },
        } : {}),
        timestamp,
      } as ScheduledTaskResult<{
        runId: string;
        status: DiscoveryRunStatus;
        requestCount: number;
        completedCount: number;
        failedCount: number;
        symbols: string[];
        failures: Array<{ symbol: string; error: string }>;
        abstained?: Array<{ symbol: string; reason: string }>;
      }>;
    };

    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        return fail(
          "No authenticated E*TRADE account is associated with this scheduled discovery. Open the schedules panel while signed in and run it again."
        );
      }
      if (!this.discoveryRunStore) {
        return fail("Discovery run store not configured for this service instance");
      }
      if (!this.strategyProfileStore) {
        return fail("Strategy profile store not configured for this service instance");
      }
      const profileId = typeof options.profileId === "string" ? options.profileId.trim() : "";
      if (!profileId) {
        return fail(
          "Profile-derived discovery requires a profileId; none was supplied. The schedule must name the Strategy Profile its targets are derived under."
        );
      }
      const profile = await this.strategyProfileStore.get(userLogin, profileId);
      if (!profile) {
        // Deleted (or never existed) since arming: an honest failure
        // naming the profile — never a silently substituted view.
        return fail(
          `Strategy profile ${profileId} was not found for this account. It may have been deleted after the schedule was armed; no run was recorded.`
        );
      }

      const hasSymbols = options.symbols !== undefined;
      const hasWatchlist = options.watchlistName !== undefined;
      if (hasSymbols === hasWatchlist) {
        return fail(
          "Profile-derived discovery requires exactly one symbol source: payload.symbols or payload.watchlistName."
        );
      }
      let symbols: string[];
      if (hasSymbols) {
        if (!Array.isArray(options.symbols)) {
          return fail("Profile-derived discovery requires exactly one symbol source: payload.symbols or payload.watchlistName.");
        }
        const seen = new Set<string>();
        symbols = [];
        for (const raw of options.symbols) {
          const symbol = typeof raw === "string" ? raw.toUpperCase().trim() : "";
          if (symbol && !seen.has(symbol)) {
            seen.add(symbol);
            symbols.push(symbol);
          }
        }
      } else {
        const name = typeof options.watchlistName === "string" ? options.watchlistName : "";
        const resolved = name.trim() ? this.resolveWatchlistSymbols(name, userLogin) : null;
        if (!resolved) {
          return fail(
            `Watchlist "${options.watchlistName}" was not found among this account's stored watchlists; no run was recorded.`
          );
        }
        symbols = resolved;
      }
      attemptedSymbols = symbols;
      if (symbols.length === 0) {
        return fail(
          "Profile-derived discovery resolved to no symbols; there is nothing to derive. No run was recorded."
        );
      }
      if (symbols.length > MAX_SAVED_REQUESTS_PER_RUN) {
        return fail(
          `Scheduled discovery is capped at ${MAX_SAVED_REQUESTS_PER_RUN} symbols per run; ${symbols.length} were resolved.`
        );
      }

      const etrade = new ETradeService(this.env);
      const pipeline = new OptionsAgentPipeline(
        new DynamicOptionsScreener(etrade.client)
      );
      const emMultiples = getOpportunityScannerConfig().targetEmMultiples;

      const outcomes: DiscoverySymbolOutcome[] = [];
      const constructed: StrategyRequest[] = [];
      for (const symbol of symbols) {
        let derivationSnapshot: Awaited<ReturnType<typeof pipeline.data.loadSnapshot>>;
        try {
          derivationSnapshot = await pipeline.data.loadSnapshot({
            symbol,
            minDte: profile.minDte,
            maxDte: profile.maxDte,
          });
        } catch (err: any) {
          // The derivation input itself failed to load: an
          // abstention (the symbol was never derived), not a
          // pipeline failure.
          outcomes.push({
            symbol,
            status: "abstained",
            error: err?.message || "Chain snapshot failed to load",
          });
          continue;
        }
        const derived = deriveDiscoveryRequest({
          symbol,
          snapshot: derivationSnapshot,
          profile,
          emMultiples,
          now: new Date(timestamp),
        });
        if (!derived.derived) {
          outcomes.push({
            symbol,
            status: "abstained",
            error: derived.reason,
            ...(derived.derivation ? { derivation: derived.derivation } : {}),
          });
          continue;
        }
        constructed.push(derived.request);
        const outcome = await this.runDiscoveryRequest(pipeline, etrade, derived.request);
        outcomes.push({ ...outcome, derivation: derived.derivation });
      }

      const failures = outcomes
        .filter((o) => o.status === "failed")
        .map((o) => ({ symbol: o.symbol, error: o.error || "unknown failure" }));
      const abstentions = outcomes
        .filter((o) => o.status === "abstained")
        .map((o) => ({ symbol: o.symbol, reason: o.error || "abstained" }));
      const completedCount = outcomes.filter((o) => o.status === "completed").length;
      const status: DiscoveryRunStatus =
        outcomes.length > 0 && completedCount === outcomes.length
          ? "completed"
          : completedCount === 0
            ? "failed"
            : "partial";

      const profileRef = toProfileRef(profile);
      // The run is persisted BEFORE the status is judged — an
      // all-abstained/failed fire's record is exactly what makes the
      // honesty inspectable (and the run id joins the failure data).
      const run = await this.discoveryRunStore.save({
        createdAt: timestamp,
        trigger: options.trigger === "manual" ? "manual-trigger" : "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
        userLogin,
        inputModel: "profile-derived",
        profileRef,
        requests: constructed,
        outcomes,
        status,
      });

      if (status === "failed") {
        const parts = [
          ...failures.map((f) => `${f.symbol}: ${f.error}`),
          ...abstentions.map((a) => `${a.symbol}: abstained (${a.reason})`),
        ];
        return fail(
          `No derived discovery request produced a result (${parts.join("; ")})`,
          run.id,
          status,
          failures,
          abstentions,
          constructed.length
        );
      }

      this.audit("options.strategy_discovery_completed", {
        runId: run.id,
        status,
        symbols,
        inputModel: "profile-derived",
        profileRef,
        requestCount: constructed.length,
        completedCount,
        failedCount: failures.length,
        abstained: abstentions,
        trigger: options.trigger || "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      });

      if (this.orm?.messages) {
        try {
          const failureNote = failures.length > 0
            ? `; failed: ${failures.map((f) => `${f.symbol} (${f.error})`).join("; ")}`
            : "";
          const abstainNote = abstentions.length > 0
            ? `; abstained: ${abstentions.map((a) => `${a.symbol} (${a.reason})`).join("; ")}`
            : "";
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content:
              status === "completed"
                ? `🔭 Scheduled Strategy Discovery (profile-derived) completed for ${symbols.join(", ")}: all ${constructed.length} derived requests produced results.`
                : `🔭 Scheduled Strategy Discovery (profile-derived) partially completed for ${symbols.join(", ")}: ${completedCount} of ${constructed.length} derived requests produced results${failureNote}${abstainNote}.`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: true,
        taskType: "strategy_discovery" as any,
        data: {
          runId: run.id,
          status,
          requestCount: constructed.length,
          completedCount,
          failedCount: failures.length,
          symbols: attemptedSymbols,
          failures,
          abstained: abstentions,
        },
        timestamp,
      };
    } catch (err: any) {
      return fail(err?.message || "Scheduled strategy discovery failed");
    }
  }

  /**
   * The no-view discovery fire (issue #534). The schedule armed
   * constraint sets — a symbol plus constraints per set, with NO
   * thesis and NO target anywhere — and each symbol's live chain is
   * ranked once by the target-free score model (no-view-v1). Nothing
   * in this path constructs, derives, or defaults a StrategyRequest:
   * the question is "which structures does this symbol's chain
   * support best under these constraints", and where the honest
   * answer is "none" the symbol ABSTAINS — a completed outcome with
   * the gate reasons recorded and a no_trade pick — rather than
   * failing or crowning a best-of-garbage. Status semantics mirror
   * the sibling models with the plan's one deliberate difference:
   * all-failed takes the #112 failure path, an all-abstained fire is
   * a COMPLETED run (an honest "nothing qualifies"), and any other
   * mix is partial. Shape/validation failures before execution
   * (identity, store, mixed or empty payload, an invalid or
   * view-smuggling constraint set) persist NOTHING.
   */
  private async autonomousStrategyDiscoveryNoView(
    options: AutonomousStrategyDiscoveryOptions,
    timestamp: string
  ): Promise<ScheduledTaskResult<{
    runId: string;
    status: DiscoveryRunStatus;
    requestCount: number;
    completedCount: number;
    failedCount: number;
    symbols: string[];
    failures: Array<{ symbol: string; error: string }>;
    abstained?: Array<{ symbol: string; reason: string }>;
  }>> {
    const constraintSets = Array.isArray(options.constraintSets) ? options.constraintSets : [];
    const symbols = constraintSets.map((s) =>
      typeof s?.symbol === "string" ? s.symbol.toUpperCase().trim() : "?"
    );

    const fail = (
      error: string,
      runId?: string,
      status?: DiscoveryRunStatus,
      failures: Array<{ symbol: string; error: string }> = [],
      abstentions: Array<{ symbol: string; reason: string }> = []
    ) => {
      this.audit("options.strategy_discovery_failed", {
        symbols,
        inputModel: "no-view",
        trigger: options.trigger || "scheduled",
        ...(runId ? { runId } : {}),
        ...(abstentions.length > 0 ? { abstained: abstentions } : {}),
        error,
      });
      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content: `⚠️ Scheduled Strategy Discovery (no-view) failed for ${symbols.join(", ") || "no constraint sets"}: ${error}`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: false,
        taskType: "strategy_discovery" as any,
        error,
        ...(runId ? {
          data: {
            runId,
            status: status ?? "failed",
            requestCount: constraintSets.length,
            completedCount: constraintSets.length - failures.length - abstentions.length,
            failedCount: failures.length,
            symbols,
            failures,
            abstained: abstentions,
          },
        } : {}),
        timestamp,
      } as ScheduledTaskResult<{
        runId: string;
        status: DiscoveryRunStatus;
        requestCount: number;
        completedCount: number;
        failedCount: number;
        symbols: string[];
        failures: Array<{ symbol: string; error: string }>;
        abstained?: Array<{ symbol: string; reason: string }>;
      }>;
    };

    try {
      const userLogin = options.userLogin || this.userLogin;
      if (!userLogin) {
        return fail(
          "No authenticated E*TRADE account is associated with this scheduled discovery. Open the schedules panel while signed in and run it again."
        );
      }
      if (!this.discoveryRunStore) {
        return fail("Discovery run store not configured for this service instance");
      }
      if (options.inputModel !== "no-view") {
        return fail(
          `No-view constraint sets require inputModel "no-view"; this payload carries ${options.inputModel ? `"${options.inputModel}"` : "no inputModel"}. The discovery input models are mutually exclusive — no run was recorded.`
        );
      }
      if (
        options.requests !== undefined ||
        options.symbols !== undefined ||
        options.watchlistName !== undefined ||
        options.profileId !== undefined
      ) {
        return fail(
          "No-view discovery payloads carry constraintSets only — requests, symbols, watchlistName and profileId belong to the other discovery input models. Mixed payload shapes are rejected, never partially honoured; no run was recorded."
        );
      }
      if (!Array.isArray(options.constraintSets) || options.constraintSets.length === 0) {
        return fail(
          "No-view discovery requires at least one constraint set in payload.constraintSets; none was supplied. A constraint set names a symbol and its constraints only — no view is invented for a schedule."
        );
      }
      if (options.constraintSets.length > MAX_SAVED_REQUESTS_PER_RUN) {
        return fail(
          `Scheduled discovery is capped at ${MAX_SAVED_REQUESTS_PER_RUN} symbols per run; ${options.constraintSets.length} constraint sets were supplied.`
        );
      }
      // Every set is validated BEFORE any chain loads: an invalid
      // set — including one smuggling a thesis/target past the type
      // (validateNoViewRequest rejects view fields outright) — fails
      // the whole payload pre-execution, the saved-path precedent.
      for (let i = 0; i < options.constraintSets.length; i++) {
        const validationError = validateNoViewRequest(
          options.constraintSets[i] as Parameters<typeof validateNoViewRequest>[0]
        );
        if (validationError) {
          return fail(
            `No-view constraint set ${i + 1} of ${options.constraintSets.length} (${symbols[i]}) is invalid: ${validationError}`
          );
        }
      }

      // One client/pipeline for the whole execution — the saved
      // path's construction, under the schedule owner's identity and
      // environment (#447/#461).
      const etrade = new ETradeService(
        this.orm || new DatabaseORM({ exec: () => [] }),
        this.env,
        userLogin,
        options.environment
      );
      const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));

      const outcomes: DiscoverySymbolOutcome[] = [];
      for (const constraintSet of options.constraintSets) {
        outcomes.push(await this.runNoViewDiscoveryRequest(pipeline, etrade, constraintSet));
      }

      const failures = outcomes
        .filter((o) => o.status === "failed")
        .map((o) => ({ symbol: o.symbol, error: o.error || "unknown failure" }));
      const abstentions = outcomes
        .filter((o) => o.abstained === true)
        .map((o) => ({
          symbol: o.symbol,
          reason:
            o.excluded && o.excluded.length > 0
              ? o.excluded.map((e) => `${e.reason} (${e.count})`).join("; ")
              : "No structure cleared the stated constraints",
        }));
      const completedCount = outcomes.filter(
        (o) => o.status === "completed" && o.abstained !== true
      ).length;
      const status: DiscoveryRunStatus =
        failures.length === outcomes.length
          ? "failed"
          : completedCount === outcomes.length
            ? "completed"
            : completedCount === 0 && failures.length === 0
              ? "completed"
              : "partial";

      // The run is persisted BEFORE the status is judged — an
      // all-failed fire's record is exactly what makes the failure
      // diagnosable (and the run id joins the failure data).
      const run = await this.discoveryRunStore.save({
        createdAt: timestamp,
        trigger: options.trigger === "manual" ? "manual-trigger" : "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
        userLogin,
        inputModel: "no-view",
        requests: [],
        constraintSets: outcomes.flatMap((o) => (o.constraintSet ? [o.constraintSet] : [])),
        outcomes,
        status,
      });

      if (status === "failed") {
        const parts = [
          ...failures.map((f) => `${f.symbol}: ${f.error}`),
          ...abstentions.map((a) => `${a.symbol}: abstained (${a.reason})`),
        ];
        return fail(
          `No no-view discovery symbol produced a result (${parts.join("; ")})`,
          run.id,
          status,
          failures,
          abstentions
        );
      }

      this.audit("options.strategy_discovery_completed", {
        runId: run.id,
        status,
        symbols,
        inputModel: "no-view",
        requestCount: constraintSets.length,
        completedCount,
        failedCount: failures.length,
        abstained: abstentions,
        trigger: options.trigger || "scheduled",
        ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      });

      if (this.orm?.messages) {
        try {
          const failureNote = failures.length > 0
            ? `; failed: ${failures.map((f) => `${f.symbol} (${f.error})`).join("; ")}`
            : "";
          const abstainNote = abstentions.length > 0
            ? `; abstained: ${abstentions.map((a) => `${a.symbol} (${a.reason})`).join("; ")}`
            : "";
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content:
              status === "completed" && abstentions.length === 0
                ? `🔭 Scheduled Strategy Discovery (no-view) completed for ${symbols.join(", ")}: all ${constraintSets.length} constraint sets produced ranked structures under their constraints. No view was supplied, derived, or assumed.`
                : status === "completed"
                  ? `🔭 Scheduled Strategy Discovery (no-view) completed for ${symbols.join(", ")}: no structure qualified under the stated constraints — every symbol abstained${abstainNote}. No pick was manufactured.`
                  : `🔭 Scheduled Strategy Discovery (no-view) partially completed for ${symbols.join(", ")}: ${completedCount} of ${constraintSets.length} constraint sets produced ranked structures${failureNote}${abstainNote}.`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }
      return {
        success: true,
        taskType: "strategy_discovery" as any,
        data: {
          runId: run.id,
          status,
          requestCount: constraintSets.length,
          completedCount,
          failedCount: failures.length,
          symbols,
          failures,
          abstained: abstentions,
        },
        timestamp,
      };
    } catch (err: any) {
      return fail(err?.message || "Scheduled strategy discovery failed");
    }
  }

  /**
   * Runs ONE no-view constraint set (issue #534) and shapes its
   * outcome: the symbol's snapshot loads through the same data agent
   * the sibling models use, chain failure is judged exactly as in
   * runDiscoveryRequest, and qualifying structures are ranked by the
   * target-free model. A loaded chain with zero qualifying
   * structures is a completed ABSTENTION — flagged, gate reasons in
   * `excluded`, empty ranked set, no_trade pick — never a failure
   * and never a manufactured pick.
   */
  private async runNoViewDiscoveryRequest(
    pipeline: OptionsAgentPipeline,
    etrade: ETradeService,
    constraintSet: NoViewStrategyRequest
  ): Promise<DiscoverySymbolOutcome> {
    const symbol = constraintSet.symbol.toUpperCase().trim();
    const record: DiscoveryConstraintSet = {
      source: "no-view",
      request: constraintSet,
      expectedIvDirection: NO_VIEW_EXPECTED_IV_DIRECTION,
    };
    try {
      const snapshot = await pipeline.data.loadSnapshot(constraintSet);
      // A snapshot that never loaded its chain is a failure, not an
      // abstention: the screen records why (validation error,
      // per-symbol fetch errors, or the client's recorded upstream
      // cause). Zero contracts with NO failure signal means the
      // chain loaded empty — the gates then abstain honestly below.
      const fetchReasons = (snapshot.screen.fetchErrors ?? [])
        .filter((e) => e.symbol === symbol)
        .map((e) => e.reason);
      let failure: string | undefined;
      if (snapshot.validationError) {
        failure = snapshot.validationError;
      } else if (snapshot.contracts.length === 0 && fetchReasons.length > 0) {
        failure = fetchReasons.join("; ");
      } else if (snapshot.contracts.length === 0) {
        failure = etrade.getLastError() || undefined;
      }
      if (failure) {
        return { symbol, status: "failed", constraintSet: record, error: failure };
      }
      const strategies = pipeline.risk.buildNoViewStrategies(snapshot.contracts, constraintSet);
      const ranked = pipeline.recommender.rankNoView(
        strategies.candidates,
        constraintSet,
        constraintSet.riskProfile ?? "balanced"
      );
      const limit = constraintSet.candidateLimit ?? ranked.length;
      const bestTrade = pipeline.recommender.pickBestNoViewTrade(strategies.candidates, constraintSet);
      const snapshotBlock = {
        dataSource: snapshot.dataSource,
        screen: snapshot.screen,
        ...(snapshot.validationError ? { validationError: snapshot.validationError } : {}),
      };
      if (strategies.candidates.length === 0) {
        return {
          symbol,
          status: "completed",
          abstained: true,
          constraintSet: record,
          rankedNoView: [],
          excluded: strategies.excluded,
          bestNoViewTrade: bestTrade,
          snapshot: snapshotBlock,
        };
      }
      return {
        symbol,
        status: "completed",
        constraintSet: record,
        rankedNoView: ranked.slice(0, limit),
        excluded: strategies.excluded,
        bestNoViewTrade: bestTrade,
        snapshot: snapshotBlock,
      };
    } catch (err: any) {
      return {
        symbol,
        status: "failed",
        constraintSet: record,
        error: err?.message || "Strategy discovery pipeline failed",
      };
    }
  }

  /**
   * Daily ATM IV collection (issue #15): one IV-history record per
   * tracked name (curated universe ∪ all watchlist symbols), derived
   * from the live chain through the scanner's own data path
   * (OptionsDataAgent over the DynamicOptionsScreener — broker chains
   * only). Idempotent per (symbol, day): rerunning the task the same
   * day records nothing twice. A name whose chain fails gets NO
   * record and is named in the report's failed outcomes — history is
   * never fabricated to fill a gap. Runs under this service's
   * userLogin identity, like its sibling tasks.
   *
   * `options.symbols`, when given, replaces the tracked set (on-demand
   * / diagnostic runs); the daily schedule passes nothing.
   */
  async collectDailyIvHistory(
    options: { symbols?: string[]; environment?: string } = {}
  ): Promise<ScheduledTaskResult<IvCollectionReport & { trackedCount: number }>> {
    const timestamp = new Date().toISOString();

    if (!this.ivHistoryStore) {
      return {
        success: false,
        taskType: "options.iv_collection",
        error: "IV history store not configured for this service instance",
        timestamp,
      };
    }

    try {
      // The same E*TRADE client construction the unified options
      // service uses, so collection reads chains under the same
      // identity/environment as every other options path.
      const etrade = new ETradeService(
        this.orm || new DatabaseORM({ exec: () => [] }),
        this.env,
        this.userLogin,
        options.environment
      );
      const dataAgent = new OptionsDataAgent(new DynamicOptionsScreener(etrade.client));

      const fetchChain = async (symbol: string) => {
        const snapshot = await dataAgent.loadSnapshot({ symbol });
        const fetchReasons = (snapshot.screen.fetchErrors ?? [])
          .filter((e) => e.symbol === symbol)
          .map((e) => e.reason);
        const error =
          snapshot.validationError ??
          (fetchReasons.length ? fetchReasons.join("; ") : undefined);
        return { contracts: snapshot.contracts, ...(error ? { error } : {}) };
      };

      const curatedSymbols = options.symbols ?? getCuratedStockUniverse().map((s) => s.symbol);
      const watchlistSymbols = options.symbols ? [] : this.flattenWatchlistSymbols();

      const report = await collectIvHistory({
        store: this.ivHistoryStore,
        fetchChain,
        curatedSymbols,
        watchlistSymbols,
      });

      this.audit("options.iv_collection_completed", {
        date: report.date,
        tracked: report.outcomes.length,
        recorded: report.recorded,
        alreadyRecorded: report.alreadyRecorded,
        failed: report.failed,
        failedSymbols: report.outcomes.filter((o) => o.status === "failed").map((o) => o.symbol),
      });

      if (this.orm?.messages) {
        try {
          this.orm.messages.create({
            id: crypto.randomUUID(),
            sessionId: this.userLogin,
            role: "assistant",
            content:
              `📈 Daily IV collection [${report.date}]: ${report.recorded} recorded, ` +
              `${report.alreadyRecorded} already recorded, ${report.failed} failed ` +
              `across ${report.outcomes.length} tracked names.`,
            agent: "orchestrator",
            createdAt: timestamp,
          });
        } catch {
          // Non-critical message record error
        }
      }

      // Issue #278: persist the scheduled run's report durably
      // (mas_reports) so the AI Search agent can surface it later.
      // Issue #308: through the single generate→store seam — one
      // canonical row per generation (generationId = run id).
      if (this.orm?.storeCanonicalReport) {
        try {
          this.orm.storeCanonicalReport({
            runId: `iv_collection:${report.date}`,
            generationId: `iv_collection:${report.date}`,
            title: `Daily IV collection — ${report.date}`,
            source: "iv_collection",
            summary: `📈 Daily IV collection [${report.date}]: ${report.recorded} recorded, ${report.alreadyRecorded} already recorded, ${report.failed} failed across ${report.outcomes.length} tracked names.`,
            body: { ...report, trackedCount: report.outcomes.length },
            createdAt: timestamp,
          });
        } catch {
          // Non-critical report persistence error
        }
      }

      return {
        success: true,
        taskType: "options.iv_collection",
        data: { ...report, trackedCount: report.outcomes.length },
        timestamp,
      };
    } catch (err: any) {
      this.audit("options.iv_collection_failed", {
        error: err.message,
      });

      return {
        success: false,
        taskType: "options.iv_collection",
        error: err.message || "Daily IV collection failed",
        timestamp,
      };
    }
  }

  /** All symbols across all stored watchlists (symbolsJson arrays);
   *  a watchlist read failure degrades to the curated universe only. */
  private flattenWatchlistSymbols(): string[] {
    if (!this.orm?.watchlists) return [];
    try {
      return flattenWatchlistSymbols(this.orm.watchlists.findMany({}));
    } catch {
      return [];
    }
  }
}
