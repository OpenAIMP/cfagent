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
import { postFilesToSlack } from "../services/slackFiles";
import type { IvHistoryStore } from "../trading";
// Issue #278: durable scheduled-run reports for the AI Search agent.
import { getCuratedStockUniverse } from "../config/curatedStockUniverse";
import {
  getCfpayConfig,
  cfpayPostToSlack,
  cfpaySendEmail,
} from "./cfpayA2A";
import { ETradeSlackTradingService } from "../trading";
import { ETradeEmailTradingService } from "../trading";
import { ETradeWebhookService } from "./tradingWebhooks";
import { ScreenerEventBus } from "../events/screenerEvents";
import { registerScreenerPublishers } from "../events/screenerPublishers";

export interface AutonomousOptionsAnalysisOptions {
  symbols?: string[];
  /** Universe to scan (resolves to symbols via listings; overrides symbols). */
  universe?: string;
  thesis?: OptionThesis;
  targetDate?: string;
  allowedStrategies?: OptionStrategyType[];
  riskProfile?: "conservative" | "balanced" | "aggressive";
  pushToSlack?: boolean;
  slackChannel?: string;
  emailTo?: string;
  webhookUrl?: string;
  environment?: string;
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
  private getScreenerAgent(): import("../agents/screener-agent").ScreenerAgent {
    const id = (this.env as any).SCREENER_AGENT.idFromName("default");
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
  } = {}): Promise<ScheduledTaskResult<{
    totalScanned: number;
    matchedCount: number;
    opportunities: OpportunityStock[];
    allStocks: ScannedStock[];
    sector?: string;
    universe?: string;
  }>> {
    const timestamp = new Date().toISOString();

    try {
      // Issue #261/#270: delegate screening to ScreenerAgent (E*TRADE-only).
      const result = await this.getScreenerAgent().runScreen({
        trigger: "scheduled",
        sector: options.sector || "Technology",
        universe: (options.universe as any) || "TECH",
        maxItems: options.maxItems,
        userLogin: this.userLogin,
      });

      if (!result.success) {
        throw new Error(result.error || "E*TRADE unavailable");
      }

      // Audit every run (not just ones with hits) so "Recent autonomous
      // actions" shows the full history, including quiet runs.
      this.audit("screener.run_completed", {
        sector: options.sector || "ALL",
        universe: result.universe,
        totalScanned: result.totalScanned,
        matchedCount: result.matchedCount,
        opportunityCount: result.opportunities.length,
        symbols: result.opportunities.map(s => s.symbol),
      });
      if (result.opportunities.length > 0) {
        this.audit("screener.opportunities_detected", {
          sector: options.sector || "ALL",
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
        sector: options.sector || "ALL",
        totalScanned: result.totalScanned,
        matchedCount: result.matchedCount,
        opportunities: result.opportunities,
      });

      return {
        success: true,
        taskType: "market_screen",
        data: {
          totalScanned: result.totalScanned,
          matchedCount: result.matchedCount,
          opportunities: result.opportunities,
          allStocks: result.allStocks,
          sector: options.sector,
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
  }>> {
    const timestamp = new Date().toISOString();
    // Resolve universe to symbols if specified; otherwise use explicit
    // symbols or default to NASDAQ100 universe (issue #296).
    // The old 4-symbol hardcoded default (AAPL, NVDA, SPY, MSFT) was too
    // narrow for a scheduled scanner.
    let symbols: string[];
    const effectiveUniverse = options.universe || (options.symbols && options.symbols.length > 0 ? null : "NASDAQ100");
    if (effectiveUniverse) {
      const { fetchAllUsStockListings } = await import("../services/nasdaqListings");
      const { resolveUniverse, UNIVERSES } = await import("../trading");
      const listings = await fetchAllUsStockListings();
      const universeDef = UNIVERSES[effectiveUniverse as keyof typeof UNIVERSES];
      const resolved = resolveUniverse(effectiveUniverse as any, listings);
      const maxSymbols = universeDef?.defaultMaxSymbols ?? 50;
      symbols = resolved.slice(0, maxSymbols).map((l) => l.symbol);
    } else {
      symbols = options.symbols!;
    }
    const targetThesis = options.thesis || "bullish";

    try {
      const unifiedService = new UnifiedOptionsService(
        this.env,
        this.userLogin,
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
        userLogin: this.userLogin,
        overrideEnv: options.environment,
      });

      const notifications: { slack?: boolean; email?: boolean; webhook?: boolean } = {};

      // 1. Push to Slack if requested or if SLACK_BOT_TOKEN is present
      // Issue #303: Try cfpay via A2A first, fall back to local.
      if (options.pushToSlack || this.env.SLACK_BOT_TOKEN) {
        const cfpay = getCfpayConfig(this.env);
        const slackChannel = options.slackChannel || (this.env as any).SCREENER_SLACK_CHANNEL;
        let slackOk = false;
        if (cfpay) {
          try {
            const slackPayload = response.toSlack();
            const text = typeof slackPayload === 'string' ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
            const r = await cfpayPostToSlack(cfpay, text, slackChannel);
            slackOk = r.ok;
            if (!r.ok) {
              console.warn("[ScheduledTasksService] cfpay Slack failed, falling back to local:", r.error);
            }
          } catch (err) {
            console.warn("[ScheduledTasksService] cfpay Slack error:", err);
          }
        }
        if (!slackOk) {
          try {
            const slackService = new ETradeSlackTradingService(this.env, this.orm, this.userLogin);
            const slackPayload = response.toSlack();
            if (options.slackChannel) {
              slackPayload.channel = options.slackChannel;
            }
            notifications.slack = await slackService.postSlackMessage(slackPayload);
          } catch (slackErr) {
            console.warn("[ScheduledTasksService] Slack notification error:", slackErr);
            notifications.slack = false;
          }
        } else {
          notifications.slack = true;
        }

        // Issue #350: Attach options PDF report to Slack via A2A (preferred solution).
        // Reuses cfpay's Slack agent via A2A instead of local upload.
        try {
          const { generateOptionsPdf, optionsPdfFileName } = await import("../trading");
          const { getCfpayConfig, cfpayPostFileToSlack } = await import("../services/cfpayA2A");
          const pdfBytes = await generateOptionsPdf(response.data);
          const fileName = optionsPdfFileName(response.data);
          // Convert Uint8Array to base64
          let binary = "";
          const chunk = 8192;
          for (let i = 0; i < pdfBytes.length; i += chunk) {
            binary += String.fromCharCode(...pdfBytes.subarray(i, i + chunk));
          }
          const base64 = btoa(binary);
          
          // Issue #361: Store options PDF to KV (reuse stock pattern).
          // Key: options:pdf:{filename}, value: { base64, fileName }
          // Mirrors stock's screener:pdf:{filename} in DO storage.
          try {
            const kvKey = `options:pdf:${fileName}`;
            await this.env.SESSIONS.put(kvKey, JSON.stringify({ base64, fileName }));
            // Also update latest pointer for the download endpoint
            await this.env.SESSIONS.put("options:pdf:latest", JSON.stringify({ base64, fileName, kvKey }));
          } catch (kvErr) {
            console.warn("[ScheduledTasksService] Options PDF KV storage failed:", kvErr instanceof Error ? kvErr.message : String(kvErr));
          }
          
          const cfpayCfg = getCfpayConfig(this.env);
          if (cfpayCfg) {
            const r = await cfpayPostFileToSlack(cfpayCfg, {
              channel: slackChannel,
              filename: fileName,
              contentB64: base64,
              title: `Options Scanner Report — ${targetThesis} ${timestamp.slice(0, 10)}`,
              initial_comment: `📄 Options scan PDF — ${response.data.matchedCount || 0} contracts matched`,
            });
            if (!r.ok) {
              console.warn("[ScheduledTasksService] cfpay PDF upload failed:", r.error);
            }
          }
        } catch (pdfErr) {
          console.warn("[ScheduledTasksService] Options PDF upload failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
        }
      }

      // 2. Push Email if recipient is specified
      // Issue #303: Try cfpay via A2A first, fall back to local.
      if (options.emailTo) {
        const cfpay = getCfpayConfig(this.env);
        let emailOk = false;
        if (cfpay) {
          try {
            const r = await cfpaySendEmail(
              cfpay,
              options.emailTo,
              `📊 E*TRADE Scheduled Options Intelligence [${targetThesis.toUpperCase()}] - ${symbols.join(", ")}`,
              response.toEmailText()
            );
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
              response.toEmailText()
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
          const webhookPayload = response.toWebhook();
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
