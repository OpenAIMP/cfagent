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
    return this.getService().sendTransactionSnapToSlack(tx, options);
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
  generateTransactionReceiptSvgBase64(tx: TransactionSnapData): string {
    return this.getService().generateTransactionReceiptSvgBase64(tx);
  }
}
