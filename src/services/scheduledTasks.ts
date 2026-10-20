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
  type OptionThesis,
  type OptionStrategyType,
} from "../trading";
import type { ScanRunStore } from "../trading";
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
    private ivHistoryStore?: IvHistoryStore
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
