/**
 * Cloudflare Slack Trading Agent for E*TRADE
 * Repurposed from Cloudflare Agents Slack SDK pattern:
 * https://developers.cloudflare.com/agents/examples/slack-agent/
 *
 * Implements:
 * - Slack Event Webhooks (app_mention, message.im, url_verification)
 * - HMAC-SHA256 signature verification with replay protection
 * - Slack Block Kit interactive message cards (Quotes, Screener, Portfolio, Trade Previews)
 * - Interactive Button approvals ([✓ Approve & Submit] and [✕ Cancel Draft])
 * - Multi-tenant OAuth installation & token management
 */

import type {
  Env,
  SlackEventResult,
  SlackInteractionResult,
  SlackBlockKitPayload,
  PreTradeApprovalDraft,
} from "../../types";
import { DatabaseORM } from "../../orm";
import { ETradeService } from "../../services/etrade";
import { executeNaturalLanguageQuery } from "../../agents/nlq";
import { AGENT_DIDS } from "../../agents/did";
import { ETradeEmailTradingService } from "../email/agent";
import { ETradeWebhookService } from "../../services/tradingWebhooks";
import { ETradeBrowserService } from "../../services/browserAgent";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

export { timingSafeEqual, verifySlackSignature } from "../../security/webhookSecurity";

export class ETradeSlackTradingService {
  constructor(
    private env: Env,
    private orm?: DatabaseORM,
    private sessionId: string = "slack_agent_session"
  ) {}

  /**
   * Process inbound Slack Events API payload (URL verification or event_callback)
   */
  async processSlackEvent(payload: any): Promise<SlackEventResult> {
    const timestamp = new Date().toISOString();

    // 1. URL Verification Handshake
    if (payload.type === "url_verification") {
      return {
        handled: true,
        actionType: "challenge",
        challenge: payload.challenge,
        timestamp,
      };
    }

    // 2. Event Callbacks (app_mention or message.im)
    if (payload.type === "event_callback" && payload.event) {
      const event = payload.event;

      // Ignore bot messages and updates to prevent recursion
      if (event.bot_id || event.subtype) {
        return {
          handled: false,
          actionType: "ignored",
          timestamp,
        };
      }

      const rawText = (event.text || "").replace(/<@[^>]+>/g, "").trim();
      const emailMatch = rawText.match(/\bemail(?:\s+(?:the\s+)?(?:results?|response))?\s+(?:to\s+)?<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i);
      const emailTo = typeof event.email_to === "string" ? event.email_to.trim() : emailMatch?.[1];
      const queryText = emailMatch ? rawText.replace(emailMatch[0], "").trim() : rawText;
      const channel = event.channel;
      const threadTs = event.thread_ts || event.ts;

      const orm = this.orm || new DatabaseORM({ exec: () => [] });
      const user = event.user || "unknown";
      const authorizerDid = `did:user:slack:${user}`;

      // 2a. Direct Conversational Pre-Trade Approval: "approve <orderId>" or "authorize <orderId>"
      const approveMatch = rawText.match(/^(?:approve|authorize|confirm|execute)\s+([a-zA-Z0-9_\-]+)$/i);
      if (approveMatch) {
        const targetOrderId = approveMatch[1].trim();
        const targetTrade = orm.trades?.findById(targetOrderId.toLowerCase()) || orm.trades?.findById(targetOrderId);

        if (!targetTrade) {
          const notFoundPayload: SlackBlockKitPayload = {
            channel,
            thread_ts: threadTs,
            text: `⚠️ Order draft \`${targetOrderId}\` not found in database ledger.`,
          };
          await this.postSlackMessage(notFoundPayload);
          return {
            handled: true,
            actionType: "rejection",
            orderId: targetOrderId,
            response: notFoundPayload,
            timestamp,
          };
        }

        if (targetTrade.status !== "previewed") {
          const statusPayload: SlackBlockKitPayload = {
            channel,
            thread_ts: threadTs,
            text: `ℹ️ Order \`${targetOrderId}\` is already in *${targetTrade.status.toUpperCase()}* status. Execution skipped.`,
          };
          await this.postSlackMessage(statusPayload);
          return {
            handled: true,
            actionType: "rejection",
            orderId: targetOrderId,
            response: statusPayload,
            timestamp,
          };
        }

        const tradingService = new ETradeService(orm, this.env, this.sessionId);
        let execRes: any;
        try {
          execRes = tradingService.executeOrder(targetTrade.id, authorizerDid, "approved");
        } catch {
          execRes = await tradingService.placeOrderRemote({
            orderId: targetTrade.id,
            symbol: targetTrade.symbol,
            action: targetTrade.action,
            quantity: targetTrade.quantity,
            orderType: targetTrade.orderType,
            limitPrice: targetTrade.price,
            userLogin: this.sessionId,
          });
          if (orm.trades) {
            orm.trades.update(targetTrade.id, {
              status: execRes.success ? "executed" : "rejected",
              authorizerDid,
              orderRef: execRes.executionId || execRes.brokerOrderRef,
              updatedAt: timestamp,
            });
          }
        }

        const isSuccess = execRes?.success ?? false;
        const execId = execRes?.executionId || execRes?.brokerOrderRef || `et_exec_${Date.now()}`;

        const executedPayload: SlackBlockKitPayload = {
          channel,
          thread_ts: threadTs,
          text: isSuccess
            ? `✅ Order \`${targetOrderId}\` APPROVED & EXECUTED on E*TRADE by <@${user}> (Ref: \`${execId}\`)`
            : `❌ Execution failed for order \`${targetOrderId}\`: ${execRes?.message || "Failed"}`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: isSuccess ? "✅ ORDER EXECUTED ON E*TRADE" : "❌ E*TRADE EXECUTION FAILED",
                emoji: true,
              },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Action:*\n${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}` },
                { type: "mrkdwn", text: `*Broker Order ID:*\n\`${execId}\`` },
                { type: "mrkdwn", text: `*Execution Total:*\n$${Number(targetTrade.totalValue || 0).toFixed(2)} USD` },
                { type: "mrkdwn", text: `*Authorizer:*\n<@${user}>` },
              ],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Status: *${isSuccess ? "EXECUTED" : "REJECTED"}* • Stamped with Trading Agent DID (\`${AGENT_DIDS.TRADING}\`) • ${timestamp}`,
                },
              ],
            },
          ],
        };

        await this.postSlackMessage(executedPayload);

        // Auto-dispatch visual snap receipt
        if (isSuccess) {
          try {
            const browserService = new ETradeBrowserService(this.env);
            await browserService.sendTransactionSnapToSlack({
              transactionId: targetTrade.id,
              symbol: targetTrade.symbol,
              action: targetTrade.action,
              quantity: targetTrade.quantity,
              price: targetTrade.price,
              orderType: targetTrade.orderType,
              status: "EXECUTED",
              totalValue: targetTrade.totalValue,
              environment: (this.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
              timestamp,
            }, { channel });
          } catch (snapErr) {
            console.warn("[ETradeSlackAgent] Could not deliver snap receipt:", snapErr);
          }
        }

        return {
          handled: true,
          actionType: "approval",
          orderId: targetOrderId,
          response: executedPayload,
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          timestamp,
        };
      }

      // 2b. Direct Conversational Pre-Trade Cancellation: "cancel <orderId>" or "reject <orderId>"
      const cancelMatch = rawText.match(/^(?:cancel|reject|abort|dismiss)\s+([a-zA-Z0-9_\-]+)$/i);
      if (cancelMatch) {
        const targetOrderId = cancelMatch[1].trim();
        if (orm.trades) {
          orm.trades.update(targetOrderId, { status: "rejected", updatedAt: timestamp, authorizerDid });
        }

        const cancelPayload: SlackBlockKitPayload = {
          channel,
          thread_ts: threadTs,
          text: `❌ Order draft \`${targetOrderId}\` was CANCELLED by <@${user}>. No broker order submitted.`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "❌ ORDER DRAFT CANCELLED", emoji: true },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Order draft \`${targetOrderId}\` was cancelled by <@${user}>. No capital was moved and no order was routed to E*TRADE.`,
              },
            },
            {
              type: "context",
              elements: [
                { type: "mrkdwn", text: `Status: *CANCELLED* • Authorizer: \`${authorizerDid}\` • ${timestamp}` },
              ],
            },
          ],
        };

        await this.postSlackMessage(cancelPayload);

        return {
          handled: true,
          actionType: "rejection",
          orderId: targetOrderId,
          response: cancelPayload,
          proposerDid: AGENT_DIDS.TRADING,
          authorizerDid,
          timestamp,
        };
      }

      // 2c. Direct Conversational Snap: "snap <target>"
      const snapMatch = rawText.match(/^snap\s+([a-zA-Z0-9_\-]+)$/i);
      if (snapMatch) {
        const target = snapMatch[1].trim();
        const browserService = new ETradeBrowserService(this.env);
        const trade = orm.trades?.findById(target.toLowerCase()) || orm.trades?.findById(target);

        if (trade) {
          const snapRes = await browserService.sendTransactionSnapToSlack({
            transactionId: trade.id,
            symbol: trade.symbol,
            action: trade.action,
            quantity: trade.quantity,
            price: trade.price,
            orderType: trade.orderType,
            status: trade.status,
            totalValue: trade.totalValue,
            environment: (this.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
            timestamp: trade.updatedAt || trade.createdAt,
          }, { channel });

          const snapMsg: SlackBlockKitPayload = {
            channel,
            thread_ts: threadTs,
            text: `📸 Transaction snapshot generated for ${trade.symbol} (${trade.id}): ${snapRes.success ? "Delivered to Slack" : snapRes.error}`,
          };
          await this.postSlackMessage(snapMsg);
          return {
            handled: true,
            actionType: "snap",
            orderId: trade.id,
            response: snapMsg,
            timestamp,
          };
        } else {
          const snapRes = await browserService.captureAndSendToSlack(`https://finance.yahoo.com/quote/${target.toUpperCase()}`, {
            channel,
            caption: `Market chart snapshot for ${target.toUpperCase()} requested by <@${user}>`,
          });
          const snapMsg: SlackBlockKitPayload = {
            channel,
            thread_ts: threadTs,
            text: `📸 Browser Agent snapshot captured for ${target.toUpperCase()}: ${snapRes.success ? "Delivered to Slack" : snapRes.error}`,
          };
          await this.postSlackMessage(snapMsg);
          return {
            handled: true,
            actionType: "snap",
            response: snapMsg,
            timestamp,
          };
        }
      }

      const { plan, result: nlqRes } = await executeNaturalLanguageQuery(
        orm,
        this.sessionId,
        queryText,
        this.env,
        this.sessionId,
        `did:user:slack:${event.user || "unknown"}`,
      );

      const domain = plan.domain;
      const action = plan.tradingData?.action || "query";
      const rowText = nlqRes.rows.slice(0, 50).map((row) => JSON.stringify(row)).join("\n");
      const responseText = [nlqRes.summary || "NLQ request processed.", rowText].filter(Boolean).join("\n\n");
      const responseHtml = `<h2>NLQ research response</h2><p>${escapeHtml(nlqRes.summary || "NLQ request processed.")}</p>` +
        (nlqRes.rows.length > 0
          ? `<pre style="white-space:pre-wrap">${escapeHtml(nlqRes.rows.slice(0, 50).map((row) => JSON.stringify(row, null, 2)).join("\n\n"))}</pre>`
          : "");
      const deliveryAllowed = !["preview_order", "execute_order"].includes(action) &&
        !["create", "update", "delete"].includes(plan.operation);
      const emailRequested = Boolean(emailTo) || /\bemail\b/i.test(rawText);
      let emailStatus = emailRequested ? "not sent (add `email results to you@example.com`)" : "not requested";
      if (deliveryAllowed && emailTo) {
        if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(emailTo)) {
          emailStatus = "failed (invalid recipient)";
        } else {
          const emailAgent = new ETradeEmailTradingService(this.env, orm, this.sessionId);
          emailStatus = await emailAgent.sendOutboundEmail(
            emailTo,
            "NLQ response",
            responseHtml,
            responseText,
          ) ? `sent to ${emailTo}` : `failed for ${emailTo}`;
        }
      }
      const webhook = new ETradeWebhookService(this.orm, this.env, this.sessionId);
      const webhookResult: { success: boolean; error?: string; status?: number } =
        deliveryAllowed && this.env.OUTBOUND_WEBHOOK_URL && this.env.OUTBOUND_WEBHOOK_SECRET
        ? await webhook.dispatchOutboundWebhook("nlq.response", {
          query: queryText,
          domain: nlqRes.domain,
          action,
          result: {
            count: nlqRes.count,
            status: nlqRes.status,
            summary: nlqRes.summary,
            rows: nlqRes.rows.slice(0, 50),
            executedAt: nlqRes.executedAt,
          },
          source: "slack",
          channel,
          user: event.user,
        })
        : { success: false, error: deliveryAllowed ? "Outbound webhook is not configured." : "Not sent for a state-changing action." };
      const deliveryStatus = `Email: ${emailStatus}. Signed webhook: ${webhookResult.success ? "sent" : webhookResult.error || `HTTP ${webhookResult.status}`}.`;

      let blockKitMessage: SlackBlockKitPayload;

      // Case A: Quote
      if (domain === "trading" && action === "quote") {
        const q = nlqRes.rows?.[0] || {};
        blockKitMessage = {
          channel,
          thread_ts: threadTs,
          text: `E*TRADE Quote for ${q.symbol}: ${q.lastPrice} (${q.change})`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `📈 E*TRADE Quote: ${q.symbol} - ${q.company || ""}`,
                emoji: true,
              },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Last Price:*\n*${q.lastPrice || "$0.00"}*` },
                { type: "mrkdwn", text: `*24h Change:*\n${q.change || "0.00%"}` },
                { type: "mrkdwn", text: `*Bid / Ask:*\n${q.bidAsk || "N/A"}` },
                { type: "mrkdwn", text: `*Volume:*\n${q.volume || "N/A"}` },
                { type: "mrkdwn", text: `*52-Week Range:*\n${q.range52Week || "N/A"}` },
                { type: "mrkdwn", text: `*Market Cap:*\n${q.marketCap || "N/A"}` },
              ],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `🛡️ Attested by Trading Agent DID (\`${AGENT_DIDS.TRADING}\`) • Direct E*TRADE Live REST API Feed`,
                },
              ],
            },
          ],
        };

        await this.postSlackMessage(blockKitMessage, deliveryStatus);

        return {
          handled: true,
          actionType: "quote",
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case B: Screener
      if (domain === "trading" && action === "screen") {
        const stocks = nlqRes.rows || [];
        const topStocks = stocks.slice(0, 5);

        const stockFields = topStocks.flatMap((s: any) => [
          { type: "mrkdwn", text: `*${s.symbol}* (${s.exchange || "N/A"})\n${s.price} (${s.change})` },
          { type: "mrkdwn", text: `*Market cap:* ${s.marketCap || "N/A"}` },
        ]);

        blockKitMessage = {
          channel,
          thread_ts: threadTs,
              text: `Live Stock Listings: ${stocks.length} equities matched`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `🔍 Live Stock Listings: ${stocks.length} Stocks Matched`,
                emoji: true,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${nlqRes.summary}`,
              },
            },
            {
              type: "section",
              fields: stockFields.length > 0 ? stockFields : [{ type: "mrkdwn", text: "No equities matched criteria." }],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `💡 Tip: To preview an order, type \`@ETradeAgent preview buy 10 NVDA limit 125.00\``,
                },
              ],
            },
          ],
        };

        await this.postSlackMessage(blockKitMessage, deliveryStatus);

        return {
          handled: true,
          actionType: "screener",
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case C: Order Preview Ticket with Interactive Approval Buttons (Strict HITL)
      if (domain === "trading" && action === "preview_order") {
        const row: Record<string, any> = (nlqRes.rows?.[0] || {}) as any;
        const orderId: string = String(row.orderId || `ord_${Date.now()}`);
        const actionStr: string = String(row.action || "BUY");
        const symbol: string = String(row.symbol || "EQUITY");
        const qty: number = Number(row.quantity) || 1;
        const total: string = String(row.estimatedTotal || "$0.00");
        const price: string = String(row.estimatedPrice || "$0.00");

        blockKitMessage = {
          channel,
          thread_ts: threadTs,
          text: `⚠️ ACTION REQUIRED: Authorize E*TRADE Order Preview: ${actionStr} ${qty} ${symbol} (${total})`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `🛡️ E*TRADE Order Preview (HITL Approval Required)`,
                emoji: true,
              },
            },
            {
              type: "section",
              fields: [
                { type: "mrkdwn", text: `*Order Action:*\n*${actionStr}*` },
                { type: "mrkdwn", text: `*Symbol:*\n*${symbol}*` },
                { type: "mrkdwn", text: `*Quantity:*\n${qty} shares` },
                { type: "mrkdwn", text: `*Est. Price:*\n${price}` },
                { type: "mrkdwn", text: `*Online Commission:*\n$0.00 USD` },
                { type: "mrkdwn", text: `*Total Value:*\n*${total}*` },
              ],
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Agentic HITL Safety Guarantee:*\nNo capital has been moved. An order is held in draft status in the SQLite ledger until you explicitly authorize execution.`,
              },
            },
            {
              type: "actions",
              block_id: "etrade_order_actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "✓ Approve & Submit", emoji: true },
                  style: "primary",
                  action_id: "etrade_approve_order",
                  value: orderId,
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "✕ Cancel Draft", emoji: true },
                  style: "danger",
                  action_id: "etrade_cancel_order",
                  value: orderId,
                },
              ],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Draft ID: \`${orderId}\` • Trading Agent DID: \`${AGENT_DIDS.TRADING}\` • Reply \`approve ${orderId}\` or click to authorize.`,
                },
              ],
            },
          ],
        };

        await this.postSlackMessage(blockKitMessage, deliveryStatus);

        return {
          handled: true,
          actionType: "preview",
          orderId,
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Case D: Portfolio & Balances
      if (domain === "trading" && action === "positions") {
        blockKitMessage = {
          channel,
          thread_ts: threadTs,
          text: `E*TRADE Portfolio & Balance: ${nlqRes.summary}`,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `💼 E*TRADE Brokerage Account Overview`,
                emoji: true,
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `${nlqRes.summary}`,
              },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Reconciled against live E*TRADE REST API • Stamped with Trading Agent DID`,
                },
              ],
            },
          ],
        };

        await this.postSlackMessage(blockKitMessage, deliveryStatus);

        return {
          handled: true,
          actionType: "portfolio",
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      if (domain === "research") {
        const rows: Array<Record<string, unknown>> = nlqRes.rows || [];
        const details = rows.slice(0, 5).map((row) => {
          const label = String(row.symbol || row.company || row.companyName || "Research result");
          const fields = Object.entries(row)
            .filter(([key]) => !["symbol", "company", "companyName"].includes(key))
            .slice(0, 6)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(" · ");
          return `• *${label}*${fields ? ` — ${fields}` : ""}`;
        }).join("\n");
        const reportText = `${nlqRes.summary || "Market research completed."}${details ? `\n\n${details}` : ""}`;
        blockKitMessage = {
          channel,
          thread_ts: threadTs,
          text: reportText.slice(0, 3000),
          blocks: [
            { type: "header", text: { type: "plain_text", text: "Market Research Results", emoji: true } },
            { type: "section", text: { type: "mrkdwn", text: reportText.slice(0, 2900) } },
          ],
        };
        await this.postSlackMessage(blockKitMessage, deliveryStatus);
        return {
          handled: true,
          actionType: "general",
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      if (domain === "trading" && ["options_screen", "options_strategies", "options_best_trade", "options_opportunities"].includes(action)) {
        const rows: Array<Record<string, unknown>> = nlqRes.rows || [];
        const details = rows.slice(0, 5).map((row, index) => {
          const label = String(row.label || row.strategy || row.contractSymbol || row.symbol || `Result ${index + 1}`);
          const score = row.score ?? row.compositeScore;
          const reason = row.reason || row.summary || row.status;
          return `• *${label}*${score !== undefined ? ` — score ${score}` : ""}${reason ? `\n  ${String(reason).slice(0, 250)}` : ""}`;
        }).join("\n");
        const reportText = `${nlqRes.summary || "Options research completed."}${details ? `\n\n${details}` : ""}\n\nResearch only — no orders were placed.`;
        blockKitMessage = {
          channel,
          thread_ts: threadTs,
          text: reportText.slice(0, 3000),
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: "Options Research Results", emoji: true },
            },
            {
              type: "section",
              text: { type: "mrkdwn", text: reportText.slice(0, 2900) },
            },
          ],
        };
        await this.postSlackMessage(blockKitMessage, deliveryStatus);
        return {
          handled: true,
          actionType: "options_research",
          response: blockKitMessage,
          proposerDid: AGENT_DIDS.TRADING,
          timestamp,
        };
      }

      // Default Response
      blockKitMessage = {
        channel,
        thread_ts: threadTs,
        text: nlqRes.summary || "E*TRADE Trading Assistant ready.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: nlqRes.summary || "Hello! Ask about quotes (e.g. `quote NVDA`), screening (`screen oversold tech`), or portfolio (`show positions`).",
            },
          },
        ],
      };

      await this.postSlackMessage(blockKitMessage, deliveryStatus);

      return {
        handled: true,
        actionType: "general",
        response: blockKitMessage,
        proposerDid: AGENT_DIDS.TRADING,
        timestamp,
      };
    }

    return {
      handled: false,
      actionType: "ignored",
      timestamp,
    };
  }

  /**
   * Process interactive Slack component actions (Button Clicks: Approve / Cancel)
   */
  async processSlackInteraction(payload: any): Promise<SlackInteractionResult> {
    const timestamp = new Date().toISOString();
    const action = payload.actions?.[0];
    if (!action) {
      return {
        success: false,
        actionId: "unknown",
        status: "error",
        message: "No action found in payload",
        timestamp,
      };
    }

    const actionId = action.action_id;
    const orderId = action.value;
    const user = payload.user || { id: "unknown", username: "user" };
    const authorizerDid = `did:user:slack:${user.id}`;
    const tradingService = new ETradeService(this.orm, this.env, this.sessionId);

    // 1. Approve & Execute Order on E*TRADE
    if (actionId === "etrade_approve_order") {
      let targetTrade: any = null;
      if (this.orm?.trades) {
        targetTrade = this.orm.trades.findById(orderId);
      }

      if (!targetTrade) {
        return {
          success: false,
          actionId,
          orderId,
          status: "error",
          message: `Order ${orderId} not found in database ledger.`,
          timestamp,
        };
      }

      // Human-in-the-Loop Check: Ensure order is in previewed status
      if (targetTrade.status !== "previewed") {
        return {
          success: false,
          actionId,
          orderId,
          status: "error",
          message: `Order ${orderId} is already in ${targetTrade.status.toUpperCase()} status.`,
          timestamp,
        };
      }

      // Dispatch live execution to E*TRADE REST API with HITL verification
      let execRes: any;
      try {
        execRes = tradingService.executeOrder(targetTrade.id, authorizerDid, "approved");
      } catch {
        execRes = await tradingService.placeOrderRemote({
          orderId: targetTrade.id,
          symbol: targetTrade.symbol,
          action: targetTrade.action,
          quantity: targetTrade.quantity,
          orderType: targetTrade.orderType,
          limitPrice: targetTrade.price,
          userLogin: this.sessionId,
        });
        if (this.orm?.trades) {
          this.orm.trades.update(targetTrade.id, {
            status: execRes.success ? "executed" : "rejected",
            authorizerDid,
            orderRef: execRes.executionId || execRes.brokerOrderRef,
            updatedAt: timestamp,
          });
        }
      }

      const isSuccess = execRes.success;
      const execId = execRes.executionId || execRes.brokerOrderRef || `et_order_${Date.now()}`;

      const replacementBlocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: isSuccess ? "✅ ORDER EXECUTED ON E*TRADE" : "❌ E*TRADE EXECUTION FAILED",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Action:*\n${targetTrade.action} ${targetTrade.quantity} ${targetTrade.symbol}` },
            { type: "mrkdwn", text: `*Broker Order ID:*\n\`${execId}\`` },
            { type: "mrkdwn", text: `*Execution Total:*\n$${targetTrade.totalValue.toFixed(2)} USD` },
            { type: "mrkdwn", text: `*Authorizer:*\n<@${user.id}>` },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Status: *${isSuccess ? "EXECUTED" : "REJECTED"}* • Stamped with Trading Agent DID (\`${AGENT_DIDS.TRADING}\`) • ${timestamp}`,
            },
          ],
        },
      ];

      // Auto-dispatch visual snap receipt to Slack on successful execution
      if (isSuccess) {
        try {
          const browserService = new ETradeBrowserService(this.env);
          await browserService.sendTransactionSnapToSlack({
            transactionId: targetTrade.id,
            symbol: targetTrade.symbol,
            action: targetTrade.action,
            quantity: targetTrade.quantity,
            price: targetTrade.price,
            orderType: targetTrade.orderType,
            status: "EXECUTED",
            totalValue: targetTrade.totalValue,
            environment: (this.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
            timestamp,
          }, { channel: payload.channel?.id });
        } catch (snapErr) {
          console.warn("[ETradeSlackAgent] Could not deliver snap receipt:", snapErr);
        }
      }

      // Update message in Slack if response_url is available
      if (payload.response_url) {
        await this.postResponseUrl(payload.response_url, {
          text: isSuccess ? `✅ Order ${orderId} executed on E*TRADE` : `❌ Execution failed for order ${orderId}`,
          blocks: replacementBlocks,
          replace_original: true,
        });
      }

      return {
        success: isSuccess,
        actionId,
        orderId,
        status: isSuccess ? "executed" : "error",
        message: isSuccess ? `Order successfully routed to E*TRADE (Ref: ${execId})` : (execRes.message || "Failed"),
        replacementBlocks,
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid,
        timestamp,
      };
    }

    // Snap Trade Button Action
    if (actionId === "snap_trade" || actionId === "etrade_snap_order") {
      let targetTrade: any = null;
      if (this.orm?.trades && orderId) {
        targetTrade = this.orm.trades.findById(orderId);
      }
      if (targetTrade) {
        const browserService = new ETradeBrowserService(this.env);
        const snapRes = await browserService.sendTransactionSnapToSlack({
          transactionId: targetTrade.id,
          symbol: targetTrade.symbol,
          action: targetTrade.action,
          quantity: targetTrade.quantity,
          price: targetTrade.price,
          orderType: targetTrade.orderType,
          status: targetTrade.status,
          totalValue: targetTrade.totalValue,
          environment: (this.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
          timestamp: targetTrade.updatedAt || targetTrade.createdAt,
        }, { channel: payload.channel?.id });

        return {
          success: snapRes.success,
          actionId,
          orderId,
          status: "executed",
          message: snapRes.success ? `Snapshot for ${targetTrade.symbol} delivered to Slack!` : (snapRes.error || "Failed"),
          timestamp,
        };
      }
    }

    // 2. Cancel Draft Order
    if (actionId === "etrade_cancel_order") {
      if (this.orm?.trades && orderId) {
        this.orm.trades.update(orderId, { status: "rejected", updatedAt: timestamp });
      }

      const replacementBlocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "❌ ORDER DRAFT CANCELLED",
            emoji: true,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Order draft \`${orderId}\` was cancelled by <@${user.id}>. No capital was moved and no order was routed to E*TRADE.`,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Status: *CANCELLED* • Authorizer: \`${authorizerDid}\` • ${timestamp}`,
            },
          ],
        },
      ];

      if (payload.response_url) {
        await this.postResponseUrl(payload.response_url, {
          text: `❌ Order ${orderId} cancelled`,
          blocks: replacementBlocks,
          replace_original: true,
        });
      }

      return {
        success: true,
        actionId,
        orderId,
        status: "rejected",
        message: `Order draft ${orderId} cancelled by user`,
        replacementBlocks,
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid,
        timestamp,
      };
    }

    // 3. Approve & Preview Options Strategy Order from Scheduled or Omnichannel Alert
    if (actionId === "etrade_approve_options_order" || actionId === "etrade_preview_options") {
      let optData: any = {};
      try {
        optData = JSON.parse(orderId || "{}");
      } catch {
        optData = { symbol: orderId, strategy: "Options Strategy" };
      }
      const sym = optData.symbol || "OPTIONS";
      const strat = optData.strategy || "Strategy";
      const legsCount = Array.isArray(optData.legs) ? optData.legs.length : 1;

      // Create an order draft in SQLite if ORM is available
      const draftId = `opt_${sym}_${Date.now()}`;
      if (this.orm?.trades) {
        try {
          this.orm.trades.create({
            id: draftId,
            sessionId: this.sessionId,
            symbol: sym,
            action: (optData.action || "BUY").toUpperCase(),
            quantity: 1,
            price: 0,
            orderType: "LIMIT",
            status: "previewed",
            proposerDid: AGENT_DIDS.TRADING,
            authorizerDid,
            proofSignature: `sig_slack_opt_${draftId}`,
            totalValue: optData.maxLoss || 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        } catch {
          // Non-critical trade creation
        }
      }

      const replacementBlocks = [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "✅ OPTIONS ORDER PREVIEW APPROVED & QUEUED",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Underlying Symbol:*\n*${sym}*` },
            { type: "mrkdwn", text: `*Strategy:*\n*${strat}*` },
            { type: "mrkdwn", text: `*Legs:*\n${legsCount} option leg(s)` },
            { type: "mrkdwn", text: `*Draft ID:*\n\`${draftId}\`` },
            { type: "mrkdwn", text: `*Authorizer:*\n<@${user.id}>` },
            { type: "mrkdwn", text: `*Status:*\n*QUEUED FOR E*TRADE ROUTING*` },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Draft ID: \`${draftId}\` • Trading Agent DID: \`${AGENT_DIDS.TRADING}\` • ${timestamp}`,
            },
          ],
        },
      ];

      if (payload.response_url) {
        await this.postResponseUrl(payload.response_url, {
          text: `✅ Options strategy order preview for ${sym} (${strat}) approved by <@${user.id}>`,
          blocks: replacementBlocks,
          replace_original: true,
        });
      }

      return {
        success: true,
        actionId,
        orderId: draftId,
        status: "executed",
        message: `Options order draft ${draftId} for ${sym} approved by user`,
        replacementBlocks,
        proposerDid: AGENT_DIDS.TRADING,
        authorizerDid,
        timestamp,
      };
    }

    // 4. Dismiss Options Alert
    if (actionId === "etrade_dismiss_options_alert") {
      const replacementBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `ℹ️ Options alert for *${orderId || "symbol"}* dismissed by <@${user.id}>.`,
          },
        },
      ];

      if (payload.response_url) {
        await this.postResponseUrl(payload.response_url, {
          text: `Options alert dismissed`,
          blocks: replacementBlocks,
          replace_original: true,
        });
      }

      return {
        success: true,
        actionId,
        status: "rejected",
        message: "Options alert dismissed",
        replacementBlocks,
        timestamp,
      };
    }

    return {
      success: false,
      actionId,
      orderId,
      status: "error",
      message: `Unknown action_id: ${actionId}`,
      timestamp,
    };
  }

  /**
   * Dispatches a Pre-Trade Approval Ticket Block Kit card to Slack (Strict HITL Gate)
   * Before executing any trade, a message must be sent to Slack and approved.
   */
  async sendPreTradeApprovalTicket(
    draft: PreTradeApprovalDraft,
    options: { channel?: string; threadTs?: string; webhookUrl?: string } = {}
  ): Promise<{ success: boolean; payload: SlackBlockKitPayload; orderId: string }> {
    const orderId = draft.orderId;
    const actionStr = (draft.action || "BUY").toUpperCase();
    const symbol = (draft.symbol || "EQUITY").toUpperCase();
    const qty = Number(draft.quantity) || 1;
    const orderType = draft.orderType || "MARKET";
    const priceStr = typeof draft.estimatedPrice === "number"
      ? `$${draft.estimatedPrice.toFixed(2)}`
      : String(draft.estimatedPrice || (draft.limitPrice ? `$${draft.limitPrice.toFixed(2)}` : "Market"));
    const totalStr = typeof draft.estimatedTotal === "number"
      ? `$${draft.estimatedTotal.toFixed(2)}`
      : String(draft.estimatedTotal || "$0.00");
    const proposerDid = draft.proposerDid || AGENT_DIDS.TRADING;
    const channel = options.channel || draft.channel;

    const payload: SlackBlockKitPayload = {
      channel,
      thread_ts: options.threadTs,
      text: `⚠️ ACTION REQUIRED: Authorize E*TRADE Order Preview: ${actionStr} ${qty} ${symbol} (${totalStr})`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `🛡️ Pre-Trade Authorization Required: ${actionStr} ${symbol}`,
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Order Action:*\n*${actionStr}*` },
            { type: "mrkdwn", text: `*Symbol:*\n*${symbol}*` },
            { type: "mrkdwn", text: `*Quantity:*\n${qty} shares` },
            { type: "mrkdwn", text: `*Est. Price:*\n${priceStr}` },
            { type: "mrkdwn", text: `*Order Type:*\n${orderType}` },
            { type: "mrkdwn", text: `*Total Value:*\n*${totalStr}*` },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Agentic HITL Safety Guarantee:*\nAutonomous trade execution is strictly blocked. No capital has been moved. An order draft is held in the SQLite ledger (\`${orderId}\`). Before executing this trade, human authorization in Slack is required.`,
          },
        },
        {
          type: "actions",
          block_id: "etrade_order_actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "✓ Approve & Submit", emoji: true },
              style: "primary",
              action_id: "etrade_approve_order",
              value: orderId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "✕ Cancel Draft", emoji: true },
              style: "danger",
              action_id: "etrade_cancel_order",
              value: orderId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "📸 Snap Receipt", emoji: true },
              action_id: "snap_trade",
              value: orderId,
            },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Draft ID: \`${orderId}\` • Proposer DID: \`${proposerDid}\` • Reply \`approve ${orderId}\` or click to authorize.`,
            },
          ],
        },
      ],
    };

    const delivered = await this.postSlackMessage(payload);
    return {
      success: delivered,
      payload,
      orderId,
    };
  }

  /**
   * Post message to Slack using Webhook and/or chat.postMessage API (Dual Delivery)
   * Patterned after cfpay & Cloudflare Agents Slack integration
   */
  async postSlackMessage(payload: SlackBlockKitPayload, deliveryStatus?: string): Promise<boolean> {
    if (deliveryStatus) {
      payload.text = `${payload.text}\n\n${deliveryStatus}`;
      payload.blocks = [
        ...(payload.blocks || []),
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: deliveryStatus }],
        },
      ];
    }
    const token = this.env.SLACK_BOT_TOKEN;
    const webhookUrl = this.env.SLACK_WEBHOOK_URL;

    if (!token && !webhookUrl) {
      // In local or test mode, message is returned in result
      return false;
    }

    let delivered = false;

    // 1. Deliver to incoming Webhook if configured
    if (webhookUrl) {
      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          delivered = true;
        }
      } catch (err) {
        console.warn("[ETradeSlackAgent] webhook delivery failed:", err);
      }
    }

    // 2. Deliver via Bot API chat.postMessage if token is configured
    if (token) {
      try {
        const res = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          delivered = true;
        }
      } catch (err) {
        console.warn("[ETradeSlackAgent] chat.postMessage failed:", err);
      }
    }

    return delivered;
  }

  /**
   * Replace or update an interactive message via Slack response_url
   */
  async postResponseUrl(responseUrl: string, payload: SlackBlockKitPayload): Promise<boolean> {
    try {
      const res = await fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch (err) {
      console.warn("[ETradeSlackAgent] postResponseUrl failed:", err);
      return false;
    }
  }

  /**
   * Generate Slack OAuth installation URL
   */
  static getInstallUrl(clientId: string, redirectUri: string): string {
    const scopes = [
      "chat:write",
      "chat:write.public",
      "channels:history",
      "app_mentions:read",
      "im:write",
      "im:history",
    ].join(",");

    return `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(
      clientId
    )}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  /**
   * Exchange Slack OAuth code for bot access token
   */
  static async exchangeOAuthCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string
  ): Promise<{ accessToken: string; teamId: string; teamName: string; botUserId: string }> {
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const json = (await res.json()) as any;
    if (!json.ok) {
      throw new Error(`Slack OAuth exchange failed: ${json.error || "Unknown error"}`);
    }

    return {
      accessToken: json.access_token,
      teamId: json.team?.id,
      teamName: json.team?.name,
      botUserId: json.bot_user_id,
    };
  }
}
