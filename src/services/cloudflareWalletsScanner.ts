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
 * 5. An audit event is written to mas_events with the tx details.
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
import { DynamicOptionsScreener } from "../trading/optionsScreener";
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
          .default("NVDA")
          .describe("Underlying ticker (e.g. NVDA, AAPL, TSLA)"),
        contractType: z
          .enum(["CALL", "PUT", "BOTH"])
          .optional()
          .default("CALL")
          .describe("Option contract type"),
        minDelta: z.number().min(0).max(1).optional().describe("Minimum absolute delta"),
        maxDelta: z.number().min(0).max(1).optional().describe("Maximum absolute delta"),
        minOpenInterest: z.number().optional().describe("Minimum open interest"),
        maxDTE: z.number().optional().describe("Maximum days-to-expiry"),
      },
      { readOnlyHint: true, title: "Options Screener (Pay-Per-Use via Cloudflare Wallets)" },
      async ({ underlying, contractType, minDelta, maxDelta, minOpenInterest, maxDTE }) => {
        const screener = new DynamicOptionsScreener();
        const result = await screener.screenOptionsSync({
          underlyingSymbols: [underlying ?? "NVDA"],
          contractType: contractType ?? "CALL",
          minDelta,
          maxDelta,
          minOpenInterest,
          maxDte: maxDTE,
        });

        this.persistAudit(underlying ?? "NVDA", result.matchedCount);

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
                  underlying: underlying ?? "NVDA",
                  matchedCount: result.matchedCount,
                  contracts: result.contracts,
                  scannedAt: new Date().toISOString(),
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
                supportedUnderlyings: ["NVDA", "AAPL", "TSLA", "MSFT", "AMD", "SPY", "QQQ"],
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
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private persistAudit(underlying: string, matchedCount: number): void {
    try {
      const orm = new DatabaseORM(this.ctx.storage as any);
      orm.events.create({
        id: `evt_scan_${crypto.randomUUID().slice(0, 8)}`,
        sessionId: "cf_wallet_scanner",
        type: "CF_WALLET_SCANNER_PAID",
        agent: "payments",
        payload: {
          underlying,
          matchedCount,
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
