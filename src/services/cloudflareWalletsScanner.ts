/**
 * Cloudflare Wallets - Native x402 Pay-Per-Use Options Scanner MCP Server
 *
 * Implements the Cloudflare Wallets / x402 paidTool pattern:
 * https://blog.cloudflare.com/wallets/
 * https://developers.cloudflare.com/agents/tools/payments/x402/charge-for-mcp-tools/
 *
 * How it works:
 * 1. An MCP client (Claude Desktop, Cursor, VS Code) calls `screen_options`.
 * 2. withX402 intercepts the call and returns HTTP 402 + PAYMENT-REQUIRED header
 *    containing price ($0.05 USDC), recipient wallet, and network.
 * 3. The client auto-pays via its Cloudflare Wallet and retries with PAYMENT-SIGNATURE.
 * 4. withX402 verifies payment via x402.org facilitator then invokes the handler.
 * 5. The handler queues the shared async options capability and returns its job ID.
 *
 * Environment variables (wrangler.jsonc vars / secrets):
 *   CF_WALLET_RECIPIENT   - 0x... USDC recipient (your Cloudflare Wallet address)
 *   CF_WALLET_NETWORK     - "base-sepolia" (testing) | "base" (production)
 *   CF_WALLET_FACILITATOR - https://x402.org/facilitator (default)
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withX402, type X402Config } from "agents/x402";
import { z } from "zod";
import type { Env } from "../types";
import { DatabaseORM } from "../orm";
import { AGENT_DIDS } from "../agents/did";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCANNER_PRICE_USD = 0.05; // $0.05 USDC per scan

// ---------------------------------------------------------------------------
// Durable Object: OptionsScannerMCP
// ---------------------------------------------------------------------------

export class OptionsScannerMCP extends McpAgent<Env> {
  private get x402Config(): X402Config {
    return {
      network: (this.env?.CF_WALLET_NETWORK ?? "base-sepolia") as string,
      recipient: (this.env?.CF_WALLET_RECIPIENT ??
        "0x0000000000000000000000000000000000000000") as `0x${string}`,
      facilitator: {
        url: this.env?.CF_WALLET_FACILITATOR ?? "https://x402.org/facilitator",
      },
    };
  }

  server = withX402(
    new McpServer({ name: "cfagent-options-scanner", version: "1.0.0" }),
    // Config is resolved lazily via getter so env is available by init time.
    // We pass a stable proxy that reads from the getter on each access.
    new Proxy({} as X402Config, {
      get: (_t, prop: keyof X402Config) => this.x402Config[prop],
    }),
  );

  async init() {
    // ------------------------------------------------------------------
    // PAID TOOL: screen_options  ($0.05 USDC per call via Cloudflare Wallets)
    // ------------------------------------------------------------------
    this.server.paidTool(
      "screen_options",
      "Institutional options screener with Delta, Gamma, Theta, IV percentile, " +
        "volume, and open-interest flow analysis. " +
        `$${SCANNER_PRICE_USD.toFixed(2)} USDC per call via Cloudflare Wallets (x402).`,
      SCANNER_PRICE_USD,
      {
        underlying: z
          .string()
          .optional()
          .describe("Optional underlying ticker; omit to dynamically discover current U.S. stock listings"),
        maxUnderlyings: z.number().int().positive().optional().describe("Maximum underlying symbols for a broad scan"),
        contractType: z
          .enum(["CALL", "PUT", "BOTH"])
          .optional()
          .describe("Option contract type; omitted screens calls and puts"),
        minDelta: z.number().min(0).max(1).optional().describe("Minimum absolute delta"),
        maxDelta: z.number().min(0).max(1).optional().describe("Maximum absolute delta"),
        minOpenInterest: z.number().optional().describe("Minimum open interest"),
        maxDTE: z.number().optional().describe("Maximum days-to-expiry"),
        minDTE: z.number().optional().describe("Minimum days-to-expiry"),
        minVolume: z.number().int().nonnegative().optional().describe("Minimum daily contract volume"),
        maxSpreadPct: z.number().nonnegative().optional().describe("Maximum bid/ask spread as percent of midpoint"),
        maxQuoteAgeSeconds: z.number().nonnegative().optional().describe("Quote-age freshness reference; stale rows remain labeled, not excluded"),
        limit: z.number().int().positive().optional().describe("Maximum contracts to return"),
      },
      { readOnlyHint: true, title: "Options Screener (Pay-Per-Use via Cloudflare Wallets)" },
      async ({ underlying, maxUnderlyings, contractType, minDelta, maxDelta, minOpenInterest, maxDTE, minDTE, minVolume, maxSpreadPct, maxQuoteAgeSeconds, limit }) => {
        const input = {
          underlyingSymbols: underlying ? [underlying.toUpperCase().trim()] : undefined,
          maxUnderlyings,
          contractType,
          minDelta,
          maxDelta,
          minDte: minDTE,
          maxDte: maxDTE,
          minOpenInterest,
          minVolume,
          maxSpreadPct,
          maxQuoteAgeSeconds,
          limit,
        };
        const queued = await this.forwardToOrchestrator(
          "/api/trading/options/screen",
          "POST",
          input,
          "default_trader",
        ) as { jobId: string; status: "queued"; statusUrl: string };
        if (!queued.jobId || queued.status !== "queued") {
          throw new Error("Paid screening request was not accepted as a background job.");
        }

        const normalizedUnderlying = underlying?.toUpperCase().trim() || "all_exchange_listings";
        this.persistAudit(normalizedUnderlying, undefined, queued.jobId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  pricePaid: `$${SCANNER_PRICE_USD.toFixed(2)} USDC`,
                  paymentProtocol: "x402 / Cloudflare Wallets",
                  network: this.env?.CF_WALLET_NETWORK ?? "base-sepolia",
                  proposerDid: AGENT_DIDS.PAYMENTS,
                  underlying: normalizedUnderlying,
                  jobId: queued.jobId,
                  status: queued.status,
                  statusTool: "get_scan_job",
                  message: "Payment was accepted and the scan is running asynchronously. Retrieve the result with get_scan_job.",
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    // ------------------------------------------------------------------
    // FREE TOOL: scanner_status  (no payment required)
    // ------------------------------------------------------------------
    this.server.tool(
      "scanner_status",
      "Check options scanner availability, pricing, and wallet config.",
      {},
      async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "available",
                tool: "screen_options",
                pricePerCall: `$${SCANNER_PRICE_USD.toFixed(2)} USDC`,
                paymentProtocol: "x402 (Cloudflare Wallets)",
                network: this.env?.CF_WALLET_NETWORK ?? "base-sepolia",
                recipient: this.env?.CF_WALLET_RECIPIENT ?? "(not configured - set CF_WALLET_RECIPIENT)",
                underlyingDiscovery: "Dynamic current Nasdaq, NYSE, and AMEX stock listings; specify an explicit maximum for broad scans.",
                supportedContractTypes: ["CALL", "PUT", "BOTH"],
                agentDid: AGENT_DIDS.PAYMENTS,
                docs: "https://developers.cloudflare.com/agents/tools/payments/x402/charge-for-mcp-tools/",
              },
              null,
              2,
            ),
          },
        ],
      }),
    );

    this.server.tool(
      "get_scan_job",
      "Get the status or completed result of a paid asynchronous options scan.",
      { jobId: z.string().uuid().describe("Job ID returned by screen_options") },
      async ({ jobId }) => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify(await this.forwardToOrchestrator(`/api/jobs/${jobId}`, "GET"), null, 2),
        }],
      }),
    );

    this.server.tool(
      "list_scan_jobs",
      "List recent paid options scans submitted by this scanner session.",
      {},
      async () => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify(await this.forwardToOrchestrator("/api/jobs?limit=30", "GET"), null, 2),
        }],
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async forwardToOrchestrator(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
    userLogin = "default_trader",
  ): Promise<unknown> {
    const id = this.env.SEARCH_AGENT.idFromName(this.ctx.id.toString());
    const headers = new Headers({ "x-user-login": userLogin });
    if (body) headers.set("Content-Type", "application/json");
    const response = await this.env.SEARCH_AGENT.get(id).fetch(
      new Request(new URL(path, "https://agent.internal"), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    const data = await response.json() as { error?: string };
    if (!response.ok) {
      throw new Error(data.error || `Async options service returned HTTP ${response.status}.`);
    }
    return data;
  }

  private persistAudit(underlying: string, matchedCount?: number, jobId?: string): void {
    try {
      const orm = new DatabaseORM(this.ctx.storage as any);
      orm.events.create({
        id: `evt_scan_${crypto.randomUUID().slice(0, 8)}`,
        sessionId: "cf_wallet_scanner",
        type: "CF_WALLET_SCANNER_PAID",
        agent: "payments",
        payload: {
          underlying,
          matchedCount: matchedCount ?? null,
          jobId,
          pricePaid: SCANNER_PRICE_USD,
          protocol: "x402",
          proposerDid: AGENT_DIDS.PAYMENTS,
        },
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Non-critical - don't block the tool response
    }
  }
}
