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
import type { DatabaseORM } from "../orm";
import { renewETradeAccessToken, getStoredTokens } from "../security/etradeOAuth";
import { DynamicMarketScreener } from "../trading/screener";

export class ScheduledTasksService {
  constructor(
    private env: Env,
    private orm?: DatabaseORM,
    private userLogin: string = "default_trader"
  ) {}

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
   * Runs an autonomous market screen using DynamicMarketScreener and flags standout opportunities
   */
  async autonomousMarketScreen(options: {
    sector?: string;
    maxItems?: number;
  } = {}): Promise<ScheduledTaskResult<{
    totalScanned: number;
    matchedCount: number;
    opportunities: ScreenedStockItem[];
    sector?: string;
  }>> {
    const timestamp = new Date().toISOString();
    const screener = new DynamicMarketScreener();

    try {
      const screenResult = await screener.screenStocks({
        sector: options.sector,
      });

      const max = options.maxItems || 5;
      const standoutOpportunities = screenResult.stocks
        .filter(s => s.signal === "OVERSOLD_BOUNCE" || s.signal === "BULLISH_MOMENTUM" || s.momentumScore >= 60)
        .slice(0, max);

      if (standoutOpportunities.length > 0) {
        this.audit("screener.opportunities_detected", {
          sector: options.sector || "ALL",
          count: standoutOpportunities.length,
          symbols: standoutOpportunities.map(s => s.symbol),
        });
      }

      return {
        success: true,
        taskType: "market_screen",
        data: {
          totalScanned: screenResult.totalScanned,
          matchedCount: screenResult.matchedCount,
          opportunities: standoutOpportunities,
          sector: options.sector,
        },
        timestamp,
      };
    } catch (err: any) {
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
   * Dispatches a scheduled user reminder and logs it to audit and messages
   */
  async dispatchReminder(
    reminderId: string,
    message: string
  ): Promise<ScheduledTaskResult<{
    reminderId: string;
    message: string;
    dispatchedAt: string;
  }>> {
    const timestamp = new Date().toISOString();

    this.audit("reminder.dispatched", {
      reminderId,
      message,
      userLogin: this.userLogin,
      dispatchedAt: timestamp,
    });

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
      } catch {
        // Non-critical message record error
      }
    }

    return {
      success: true,
      taskType: "reminder",
      data: {
        reminderId,
        message,
        dispatchedAt: timestamp,
      },
      timestamp,
    };
  }
}
