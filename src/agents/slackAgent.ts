/**
 * Cloudflare Slack Trading Agent
 *
 * Implements an independent Cloudflare Agent based on:
 * https://developers.cloudflare.com/agents/examples/slack-agent/
 *
 * Primary Capabilities:
 * - Independent Agent lifecycle with conversational thread state in SQLite.
 * - Native Slack Events API webhook listener (app_mention, message.im).
 * - Interactive Block Kit cards with Human-in-the-Loop (HITL) approval buttons.
 * - Full Slash Commands router (/trade, /quote, /screen, /options, /portfolio, /snap, /help).
 * - Seamless agent-to-agent collaboration with the independent Browser Agent:
 *   automatically triggers transaction snaps posted into Slack via Webhooks.
 */

import { AIChatAgent } from "@cloudflare/ai-chat";
import type {
  Env,
  SlackEventResult,
  SlackInteractionResult,
  SlackBlockKitPayload,
  TransactionSnapData,
} from "../types";
import { DatabaseORM } from "../orm";
import { ETradeService } from "../services/etrade";
import { executeNaturalLanguageQuery } from "./nlq";
import { AGENT_DIDS } from "./did";
import { ETradeSlackTradingService, verifySlackSignature } from "../trading/slack/agent";
import { BrowserAgent } from "./browserAgent";

export class SlackAgent extends AIChatAgent<Env> {
  private slackService?: ETradeSlackTradingService;
  private browserAgent?: BrowserAgent;

  sessionKey(): string {
    return this.ctx?.id ? this.ctx.id.toString() : "slack_agent_master";
  }

  private getSlackService(orm?: DatabaseORM): ETradeSlackTradingService {
    if (!this.slackService) {
      this.slackService = new ETradeSlackTradingService(
        this.env,
        orm,
        this.sessionKey() || "slack_agent_master"
      );
    }
    return this.slackService;
  }

  private getBrowserAgent(): BrowserAgent {
    if (!this.browserAgent) {
      this.browserAgent = new BrowserAgent(this.ctx, this.env);
    }
    return this.browserAgent;
  }

  private getOrm(): DatabaseORM {
    return new DatabaseORM(this.ctx.storage.sql);
  }

  /**
   * Dispatches a transaction snapshot to Slack by coordinating with the Browser Agent
   */
  async dispatchTransactionSnap(
    tx: TransactionSnapData,
    options: { webhookUrl?: string; channel?: string; caption?: string } = {}
  ) {
    const browser = this.getBrowserAgent();
    return browser.sendTransactionSnapToSlack(tx, {
      webhookUrl: options.webhookUrl || this.env.SLACK_WEBHOOK_URL,
      channel: options.channel,
      caption: options.caption,
    });
  }

  /**
   * Handles incoming Slack Slash Commands:
   * /trade, /quote, /screen, /options, /portfolio, /snap, /help
   */
  async handleSlashCommand(formData: FormData): Promise<Response> {
    const command = (formData.get("command") as string || "").trim().toLowerCase();
    const text = (formData.get("text") as string || "").trim();
    const channelId = formData.get("channel_id") as string || "";
    const userId = formData.get("user_id") as string || "unknown_user";
    const responseUrl = formData.get("response_url") as string || "";

    const orm = this.getOrm();
    const service = this.getSlackService(orm);

    // 1. /snap [symbol or orderId]
    if (command === "/snap" || command.endsWith("/snap")) {
      const target = text.toUpperCase() || "SPY";
      const isOrderId = target.startsWith("ORD_") || target.startsWith("TRD_");

      if (isOrderId && orm.trades) {
        const trade = orm.trades.findById(target.toLowerCase()) || orm.trades.findById(target);
        if (trade) {
          const snapData: TransactionSnapData = {
            transactionId: trade.id,
            symbol: trade.symbol,
            action: trade.action,
            quantity: trade.quantity,
            price: trade.price,
            orderType: trade.orderType,
            status: trade.status,
            totalValue: trade.totalValue,
            environment: this.env.ETRADE_ENVIRONMENT || "sandbox",
            timestamp: trade.updatedAt || trade.createdAt,
          };

          const snapRes = await this.dispatchTransactionSnap(snapData, {
            channel: channelId,
            caption: `Snapshot for order ${trade.id} requested by <@${userId}> via /snap`,
          });

          return Response.json({
            response_type: "in_channel",
            text: `📸 Transaction snapshot generated for ${trade.symbol} (${trade.id}): ${snapRes.success ? "Posted to Slack" : snapRes.error}`,
          });
        }
      }

      // Default: Chart / market snapshot for symbol
      const browser = this.getBrowserAgent();
      const chartUrl = `https://finance.yahoo.com/quote/${target}`;
      const snapRes = await browser.capturePageSnapshot(chartUrl, {
        channel: channelId,
        caption: `Market chart snapshot for ${target} requested by <@${userId}> via /snap`,
      });

      return Response.json({
        response_type: "in_channel",
        text: `📸 Browser Agent snapshot captured for ${target}: ${snapRes.success ? "Delivered to Slack" : snapRes.error}`,
      });
    }

    // 2. /quote [symbol]
    if (command === "/quote" || command.endsWith("/quote")) {
      const symbol = text.toUpperCase() || "NVDA";
      const { result } = await executeNaturalLanguageQuery(
        orm,
        this.sessionKey() || "slack_agent",
        `quote ${symbol}`,
        this.env,
        this.sessionKey() || "slack_agent",
        `did:user:slack:${userId}`
      );

      const q = result.rows?.[0] || {};
      const payload: SlackBlockKitPayload = {
        channel: channelId,
        text: `Quote for ${symbol}: ${q.lastPrice || "N/A"} (${q.change || "N/A"})`,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: `📈 E*TRADE Quote: ${symbol}`, emoji: true },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Last Price:*\n*${q.lastPrice || "$0.00"}*` },
              { type: "mrkdwn", text: `*24h Change:*\n${q.change || "0.00%"}` },
              { type: "mrkdwn", text: `*Bid / Ask:*\n${q.bidAsk || "N/A"}` },
              { type: "mrkdwn", text: `*Volume:*\n${q.volume || "N/A"}` },
            ],
          },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `Requested by <@${userId}> • Attested by Slack Agent (\`${AGENT_DIDS.TRADING}\`)` },
            ],
          },
        ],
      };

      return Response.json(payload);
    }

    // 3. /trade [action] [qty] [symbol] [type] [price]
    if (command === "/trade" || command.endsWith("/trade")) {
      const prompt = `preview ${text || "buy 1 NVDA"}`;
      const { result } = await executeNaturalLanguageQuery(
        orm,
        this.sessionKey() || "slack_agent",
        prompt,
        this.env,
        this.sessionKey() || "slack_agent",
        `did:user:slack:${userId}`
      );

      const row = result.rows?.[0] || {};
      const orderId = String(row.orderId || `ord_${Date.now()}`);
      const action = String(row.action || "BUY").toUpperCase();
      const symbol = String(row.symbol || "EQUITY").toUpperCase();
      const qty = row.quantity || 1;
      const total = row.estimatedTotal || "$0.00";

      const payload: SlackBlockKitPayload = {
        channel: channelId,
        text: `⚠️ Action Required: Authorize E*TRADE Order Preview: ${action} ${qty} ${symbol} (${total})`,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: `⚠️ Order Preview Ticket: ${action} ${symbol}`, emoji: true },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Symbol:*\n*${symbol}*` },
              { type: "mrkdwn", text: `*Action:*\n*${action}*` },
              { type: "mrkdwn", text: `*Quantity:*\n${qty}` },
              { type: "mrkdwn", text: `*Estimated Total:*\n*${total}*` },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "✓ Approve & Submit", emoji: true },
                style: "primary",
                value: orderId,
                action_id: "approve_trade",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "✕ Reject Draft", emoji: true },
                style: "danger",
                value: orderId,
                action_id: "reject_trade",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "📸 Snap Receipt", emoji: true },
                value: orderId,
                action_id: "snap_trade",
              },
            ],
          },
        ],
      };

      return Response.json(payload);
    }

    // 4. /portfolio
    if (command === "/portfolio" || command.endsWith("/portfolio")) {
      const { result } = await executeNaturalLanguageQuery(
        orm,
        this.sessionKey() || "slack_agent",
        "show portfolio",
        this.env,
        this.sessionKey() || "slack_agent",
        `did:user:slack:${userId}`
      );

      return Response.json({
        response_type: "ephemeral",
        text: `💼 Portfolio Summary: ${result.summary || "Retrieved account balances and positions."}`,
      });
    }

    // 5. /options [symbol] [thesis]
    if (command === "/options" || command.endsWith("/options")) {
      const parts = text.split(/\s+/);
      const symbol = (parts[0] || "SPY").toUpperCase();
      const thesis = parts[1] || "bullish";
      const { result } = await executeNaturalLanguageQuery(
        orm,
        this.sessionKey() || "slack_agent",
        `options ${symbol} ${thesis}`,
        this.env,
        this.sessionKey() || "slack_agent",
        `did:user:slack:${userId}`
      );

      return Response.json({
        response_type: "in_channel",
        text: `📊 Options Intelligence for ${symbol} (${thesis}): ${result.summary}`,
      });
    }

    // Default /help
    return Response.json({
      response_type: "ephemeral",
      text: "🤖 *E*TRADE Slack Trading Agent Commands:*\n" +
        "• `/trade buy 10 NVDA limit 130.00` - Create interactive order preview with HITL approval buttons\n" +
        "• `/quote AAPL` - Live market quote card\n" +
        "• `/snap SPY` or `/snap ORD_123` - Command Browser Agent to take visual snapshot & deliver to Slack\n" +
        "• `/options NVDA bullish` - AI options strategy recommendation\n" +
        "• `/portfolio` - Account balances and open positions\n" +
        "• `@ETradeAgent <question>` - Conversational analysis in channel thread",
    });
  }

  /**
   * Handles interactive Block Kit component clicks ([Approve], [Reject], [Snap])
   */
  async handleInteraction(payload: any): Promise<Response> {
    const action = payload.actions?.[0];
    if (!action) return new Response("No action found", { status: 400 });

    const actionId = action.action_id;
    const orderId = action.value || action.selected_option?.value;
    const userId = payload.user?.id || "unknown";
    const channelId = payload.channel?.id;
    const orm = this.getOrm();
    const service = this.getSlackService(orm);

    // Case 1: Snap Trade
    if (actionId === "snap_trade" || actionId === "etrade_snap_order") {
      const trade = orm.trades?.findById(orderId);
      if (trade) {
        const snapData: TransactionSnapData = {
          transactionId: trade.id,
          symbol: trade.symbol,
          action: trade.action,
          quantity: trade.quantity,
          price: trade.price,
          orderType: trade.orderType,
          status: trade.status,
          totalValue: trade.totalValue,
          environment: this.env.ETRADE_ENVIRONMENT || "sandbox",
          timestamp: trade.updatedAt || trade.createdAt,
        };
        const snapRes = await this.dispatchTransactionSnap(snapData, {
          channel: channelId,
          caption: `Snapshot for ${trade.symbol} (${trade.id}) triggered by <@${userId}>`,
        });

        return Response.json({
          response_type: "ephemeral",
          text: `📸 Transaction snapshot generated: ${snapRes.success ? "Posted to Slack!" : snapRes.error}`,
        });
      }

      return Response.json({
        response_type: "ephemeral",
        text: `⚠️ Order ${orderId} not found in database ledger to generate snapshot.`,
      });
    }

    // Case 2: Approve Trade
    if (actionId === "approve_trade" || actionId === "etrade_approve_order") {
      action.action_id = "etrade_approve_order";
      const interactionResult = await service.processSlackInteraction(payload);
      if (interactionResult.success && orderId && orm.trades) {
        const trade = orm.trades.findById(orderId);
        if (trade) {
          // Trigger Browser Agent to post official transaction snap!
          const snapData: TransactionSnapData = {
            transactionId: trade.id,
            symbol: trade.symbol,
            action: trade.action,
            quantity: trade.quantity,
            price: trade.price,
            orderType: trade.orderType,
            status: "executed",
            totalValue: trade.totalValue,
            environment: this.env.ETRADE_ENVIRONMENT || "sandbox",
            timestamp: new Date().toISOString(),
          };

          // Fire and log snap delivery
          this.dispatchTransactionSnap(snapData, {
            channel: channelId,
            caption: `Official execution confirmation snap for ${trade.symbol} (${trade.id})`,
          }).catch(console.warn);
        }
      }

      return Response.json({
        response_type: "in_channel",
        replace_original: true,
        text: interactionResult.message,
        blocks: interactionResult.replacementBlocks,
      });
    }

    // Case 3: Reject Trade
    if (actionId === "reject_trade" || actionId === "etrade_cancel_order") {
      action.action_id = "etrade_cancel_order";
      const interactionResult = await service.processSlackInteraction(payload);
      return Response.json({
        response_type: "in_channel",
        replace_original: true,
        text: interactionResult.message,
        blocks: interactionResult.replacementBlocks,
      });
    }

    const fallbackResult = await service.processSlackInteraction(payload);
    return Response.json(fallbackResult);
  }

  /**
   * Primary HTTP Request Router for the Slack Agent
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-slack-signature, x-slack-request-timestamp",
        },
      });
    }

    // Health check
    if (path.endsWith("/health") || path === "/") {
      return Response.json({
        agent: "SlackAgent",
        status: "active",
        did: AGENT_DIDS.TRADING || "did:agent:openaimp:trading",
        capabilities: ["events_api", "slash_commands", "interactive_buttons", "browser_agent_snaps"],
        timestamp: new Date().toISOString(),
      });
    }

    // Verify Slack signature if secret is configured
    if (this.env.SLACK_SIGNING_SECRET) {
      const ts = request.headers.get("x-slack-request-timestamp");
      const sig = request.headers.get("x-slack-signature");
      if (request.method === "POST" && ts && sig) {
        const clonedReq = request.clone();
        const rawBody = await clonedReq.text();
        const isValid = await verifySlackSignature(this.env.SLACK_SIGNING_SECRET, ts, rawBody, sig);
        if (!isValid) {
          return new Response("Invalid Slack signature", { status: 401 });
        }
      }
    }

    // 1. Slash Commands (/commands or /slack/commands)
    if (path.endsWith("/commands") || path.endsWith("/slash")) {
      const formData = await request.formData();
      return this.handleSlashCommand(formData);
    }

    // 2. Interactive Components (/interactions or /slack/interactions)
    if (path.endsWith("/interactions")) {
      const rawBody = await request.text();
      const params = new URLSearchParams(rawBody);
      const payloadRaw = params.get("payload");
      if (!payloadRaw) return new Response("Missing payload parameter", { status: 400 });
      const payload = JSON.parse(payloadRaw);
      return this.handleInteraction(payload);
    }

    // 3. Events API (/events or /slack/events)
    if (path.endsWith("/events") || path.endsWith("/slack")) {
      const body = (await request.json().catch(() => ({}))) as any;
      if (body.type === "url_verification") {
        return Response.json({ challenge: body.challenge });
      }

      const orm = this.getOrm();
      const service = this.getSlackService(orm);
      const eventResult = await service.processSlackEvent(body);
      return Response.json(eventResult);
    }

    // 4. Manual Transaction Snap Trigger (/transaction-snap)
    if (path.endsWith("/transaction-snap") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const tx: TransactionSnapData = body.transaction || body;
        const result = await this.dispatchTransactionSnap(tx, {
          webhookUrl: body.webhookUrl,
          channel: body.channel,
          caption: body.caption,
        });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    return Response.json({ error: `Not Found: ${path}` }, { status: 404 });
  }
}
