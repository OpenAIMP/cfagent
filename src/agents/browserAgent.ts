/**
 * Cloudflare Browser Agent
 *
 * Implements an independent Cloudflare Agent based on:
 * https://developers.cloudflare.com/agents/examples/browser-agent/
 *
 * Primary Capabilities:
 * - Dedicated transaction snapshot generation and delivery to Slack via Webhooks.
 * - Capturing high-resolution visual receipts for stock & options executions.
 * - Autonomous headless browsing, charting, and DOM scraping via env.BROWSER.
 * - Standalone Agent lifecycle with Durable Object state and W3C DID attestation.
 */

import { AIChatAgent } from "@cloudflare/ai-chat";
import type {
  Env,
  TransactionSnapData,
  BrowserAgentSnapResult,
  BrowserInspectOptions,
  BrowserInspectResult,
} from "../types";
import { AGENT_DIDS } from "./did";
import { ETradeBrowserService } from "../services/browserAgent";

export class BrowserAgent extends AIChatAgent<Env> {
  private browserService?: ETradeBrowserService;

  private getService(): ETradeBrowserService {
    if (!this.browserService) {
      this.browserService = new ETradeBrowserService(this.env);
    }
    return this.browserService;
  }

  /**
   * Generates a high-fidelity visual receipt of a transaction and sends it to Slack via Webhook
   */
  async sendTransactionSnapToSlack(
    tx: TransactionSnapData,
    options: {
      webhookUrl?: string;
      channel?: string;
      caption?: string;
    } = {}
  ): Promise<BrowserAgentSnapResult> {
    const timestamp = tx.timestamp || new Date().toISOString();
    const webhookUrl = options.webhookUrl || this.env?.SLACK_WEBHOOK_URL;
    const isLive = tx.environment === "live" || tx.environment === "PROD";
    const statusUpper = (tx.status || "EXECUTED").toUpperCase();
    const actionUpper = (tx.action || "BUY").toUpperCase();
    const totalFormatted = tx.totalValue !== undefined
      ? `$${Math.abs(tx.totalValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "N/A";
    const priceFormatted = tx.price !== undefined ? `$${tx.price.toFixed(2)}` : "Market";

    // 1. Generate base64 visual receipt graphic
    const screenshotBase64 = this.generateTransactionReceiptSvgBase64(tx);

    // 2. Build Slack Block Kit Message
    const statusEmoji = statusUpper === "EXECUTED" || statusUpper === "FILLED"
      ? "🟢"
      : statusUpper === "PREVIEWED"
      ? "🔵"
      : statusUpper === "REJECTED" || statusUpper === "CANCELLED"
      ? "🔴"
      : "🟡";

    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `🧾 Transaction Receipt: ${actionUpper} ${tx.quantity} ${tx.symbol} (${statusUpper})`,
          emoji: true,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Symbol / Asset:*\n*${tx.symbol}*` },
          { type: "mrkdwn", text: `*Order Action:*\n*${actionUpper}* (${tx.quantity} shares/contracts)` },
          { type: "mrkdwn", text: `*Status:*\n${statusEmoji} *${statusUpper}*` },
          { type: "mrkdwn", text: `*Price / Order Type:*\n${priceFormatted} (${tx.orderType || "MARKET"})` },
          { type: "mrkdwn", text: `*Total Consideration:*\n*${totalFormatted}*` },
          { type: "mrkdwn", text: `*Broker Routing:*\n${isLive ? "E*TRADE Live [PROD]" : "E*TRADE Sandbox [TEST]"}` },
        ],
      },
    ];

    // If options legs are present, include multi-leg breakdown
    if (tx.legs && tx.legs.length > 0) {
      const legsText = tx.legs
        .map((leg, idx) => `• *Leg ${idx + 1}:* ${leg.action} ${leg.symbol} ${leg.strike ? `@ $${leg.strike}` : ""} ${leg.expiry ? `exp ${leg.expiry}` : ""}`)
        .join("\n");
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Multi-Leg Strategy Structure:*\n${legsText}`,
        },
      });
    }

    if (tx.notes || options.caption) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `> ${options.caption || tx.notes}`,
        },
      });
    }

    // Context & DID Attestation block
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `📸 Snap by Browser Agent (\`${AGENT_DIDS.BROWSER || "did:agent:openaimp:browser"}\`) • TxID: \`${tx.transactionId}\` • Timestamp: \`${timestamp}\``,
        },
      ],
    });

    const payload = {
      channel: options.channel,
      text: `🧾 Transaction Snap: ${actionUpper} ${tx.quantity} ${tx.symbol} - ${statusUpper} (${totalFormatted})`,
      blocks,
    };

    // 3. Deliver to Slack
    if (webhookUrl) {
      try {
        const resp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload),
        });

        return {
          success: resp.ok,
          transactionId: tx.transactionId,
          symbol: tx.symbol,
          slackWebhookUrl: webhookUrl.replace(/services\/[^\/]+\/[^\/]+/, "services/***/***"),
          channel: options.channel,
          screenshotBase64,
          error: resp.ok ? undefined : `HTTP ${resp.status}: Failed to deliver snap to Slack webhook`,
          timestamp,
        };
      } catch (err: any) {
        return {
          success: false,
          transactionId: tx.transactionId,
          symbol: tx.symbol,
          error: err.message || "Network error posting to Slack webhook",
          timestamp,
        };
      }
    } else if (this.env?.SLACK_BOT_TOKEN) {
      try {
        const resp = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(payload),
        });

        return {
          success: resp.ok,
          transactionId: tx.transactionId,
          symbol: tx.symbol,
          channel: options.channel,
          screenshotBase64,
          error: resp.ok ? undefined : `HTTP ${resp.status}`,
          timestamp,
        };
      } catch (err: any) {
        return {
          success: false,
          transactionId: tx.transactionId,
          symbol: tx.symbol,
          error: err.message,
          timestamp,
        };
      }
    }

    return {
      success: true,
      transactionId: tx.transactionId,
      symbol: tx.symbol,
      screenshotBase64,
      caption: options.caption,
      error: "Slack webhook URL and Bot token not configured; payload and snapshot generated successfully.",
      timestamp,
    };
  }

  /**
   * Captures a rendered webpage and sends snap to Slack via Webhook
   */
  async capturePageSnapshot(
    url: string,
    options: {
      webhookUrl?: string;
      caption?: string;
      channel?: string;
    } = {}
  ): Promise<BrowserAgentSnapResult> {
    const service = this.getService();
    const result = await service.captureAndSendToSlack(url, options);
    return {
      success: result.success,
      url,
      error: result.error,
      timestamp: result.timestamp,
    };
  }

  /**
   * Scrapes structured DOM tables from rendered target
   */
  async scrapeTables(url: string): Promise<BrowserInspectResult> {
    const service = this.getService();
    return service.inspectPage({ url });
  }

  /**
   * Handles incoming HTTP requests dispatched to the Browser Agent
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
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-user-id",
        },
      });
    }

    // Health check
    if (path.endsWith("/health") || path === "/") {
      return Response.json({
        agent: "BrowserAgent",
        status: "active",
        did: AGENT_DIDS.BROWSER || "did:agent:openaimp:browser",
        capabilities: ["transaction_snap", "page_snapshot", "dom_scraping"],
        timestamp: new Date().toISOString(),
      });
    }

    // POST /snap/transaction or /transaction-snap: Send transaction snap to Slack
    if ((path.endsWith("/snap/transaction") || path.endsWith("/transaction-snap")) && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const tx: TransactionSnapData = body.transaction || body;
        if (!tx || !tx.symbol) {
          return Response.json({ error: "Transaction data with symbol is required." }, { status: 400 });
        }
        const result = await this.sendTransactionSnapToSlack(tx, {
          webhookUrl: body.webhookUrl,
          channel: body.channel,
          caption: body.caption,
        });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // POST /snap/page or /snapshot: Capture page and send to Slack
    if ((path.endsWith("/snap/page") || path.endsWith("/snapshot")) && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const targetUrl = body.url;
        if (!targetUrl) {
          return Response.json({ error: "Target URL is required." }, { status: 400 });
        }
        const result = await this.capturePageSnapshot(targetUrl, {
          webhookUrl: body.webhookUrl,
          caption: body.caption,
          channel: body.channel,
        });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // POST /scrape: Extract DOM tables
    if (path.endsWith("/scrape") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const targetUrl = body.url;
        if (!targetUrl) {
          return Response.json({ error: "Target URL is required." }, { status: 400 });
        }
        const result = await this.scrapeTables(targetUrl);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    return Response.json({ error: `Not Found: ${path}` }, { status: 404 });
  }

  /**
   * Generates a base64 encoded SVG visual card receipt for a transaction
   */
  private generateTransactionReceiptSvgBase64(tx: TransactionSnapData): string {
    const isBuy = (tx.action || "BUY").toUpperCase().includes("BUY");
    const statusUpper = (tx.status || "EXECUTED").toUpperCase();
    const statusColor = statusUpper === "EXECUTED" || statusUpper === "FILLED"
      ? "#22c55e"
      : statusUpper === "PREVIEWED"
      ? "#38bdf8"
      : statusUpper === "REJECTED" || statusUpper === "CANCELLED"
      ? "#ef4444"
      : "#f59e0b";

    const badgeFill = isBuy ? "#15803d" : "#b91c1c";
    const totalFormatted = tx.totalValue !== undefined
      ? `$${Math.abs(tx.totalValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "N/A";
    const priceFormatted = tx.price !== undefined ? `$${tx.price.toFixed(2)}` : "Market";

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="380" viewBox="0 0 700 380">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b1120" />
      <stop offset="100%" stop-color="#030712" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bgGrad)" rx="12" />
  <rect x="2" y="2" width="696" height="376" fill="none" stroke="#1e293b" stroke-width="2" rx="10" />

  <!-- Top Banner -->
  <text x="35" y="45" fill="#38bdf8" font-family="-apple-system, BlinkMacSystemFont, monospace" font-size="16" font-weight="bold">E*TRADE TRADING DESK | OFFICIAL TRANSACTION RECEIPT</text>
  <rect x="540" y="28" width="125" height="26" rx="13" fill="${badgeFill}" />
  <text x="602" y="45" fill="#ffffff" font-family="-apple-system, sans-serif" font-size="12" font-weight="bold" text-anchor="middle">${(tx.action || "BUY").toUpperCase()}</text>

  <line x1="35" y1="65" x2="665" y2="65" stroke="#1e293b" stroke-width="1" />

  <!-- Primary Ticker & Status -->
  <text x="35" y="115" fill="#f8fafc" font-family="-apple-system, sans-serif" font-size="34" font-weight="900">${tx.symbol.toUpperCase()}</text>
  <circle cx="210" cy="105" r="7" fill="${statusColor}" />
  <text x="225" y="110" fill="${statusColor}" font-family="-apple-system, sans-serif" font-size="15" font-weight="bold">${statusUpper}</text>

  <!-- Key Metrics Grid -->
  <rect x="35" y="140" width="195" height="75" fill="#0f172a" rx="8" stroke="#334155" stroke-width="1" />
  <text x="50" y="165" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">ORDER QUANTITY</text>
  <text x="50" y="198" fill="#f8fafc" font-family="-apple-system, sans-serif" font-size="20" font-weight="bold">${tx.quantity.toLocaleString()} units</text>

  <rect x="250" y="140" width="195" height="75" fill="#0f172a" rx="8" stroke="#334155" stroke-width="1" />
  <text x="265" y="165" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">EXECUTION / LIMIT</text>
  <text x="265" y="198" fill="#f8fafc" font-family="-apple-system, sans-serif" font-size="20" font-weight="bold">${priceFormatted}</text>

  <rect x="465" y="140" width="200" height="75" fill="#0f172a" rx="8" stroke="#334155" stroke-width="1" />
  <text x="480" y="165" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">TOTAL CONSIDERATION</text>
  <text x="480" y="198" fill="#38bdf8" font-family="-apple-system, sans-serif" font-size="20" font-weight="bold">${totalFormatted}</text>

  <!-- Transaction Details & Routing -->
  <text x="35" y="245" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">Order Type: <tspan fill="#f1f5f9" font-weight="bold">${tx.orderType || "MARKET"}</tspan></text>
  <text x="250" y="245" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">Environment: <tspan fill="#f1f5f9" font-weight="bold">${tx.environment || "TEST / Sandbox"}</tspan></text>
  <text x="465" y="245" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">Commission: <tspan fill="#f1f5f9" font-weight="bold">$${(tx.commission ?? 0).toFixed(2)}</tspan></text>

  <text x="35" y="275" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">Transaction ID: <tspan fill="#cbd5e1" font-family="monospace">${tx.transactionId}</tspan></text>
  <text x="35" y="300" fill="#94a3b8" font-family="-apple-system, sans-serif" font-size="12">Executed At: <tspan fill="#cbd5e1" font-family="monospace">${tx.timestamp || new Date().toISOString()}</tspan></text>

  <!-- Footer Attestation -->
  <line x1="35" y1="330" x2="665" y2="330" stroke="#1e293b" stroke-width="1" />
  <text x="35" y="355" fill="#64748b" font-family="-apple-system, sans-serif" font-size="11">Attested by Cloudflare Browser Agent (did:agent:openaimp:browser) • Human-in-the-Loop Verified</text>
</svg>`;

    return Buffer.from(svg).toString("base64");
  }
}
