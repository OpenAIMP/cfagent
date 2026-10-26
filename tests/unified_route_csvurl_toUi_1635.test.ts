/**
 * Issue #1635: unified-route default UI response omits csvUrl (toUi path).
 *
 * In `src/agents/routes/etradeOptionsScreen.ts`, the webhook path (line 503)
 * returns `{ ...result.toWebhook(), reportUrl, xlsxUrl, csvUrl }`, but the
 * default path (line 508) returns `{ ...result.toUi(), reportUrl, xlsxUrl }`
 * — no `csvUrl`, so a UI client on the default path cannot discover the
 * unified CSV download, even though the CSV itself is generated correctly
 * (see #1587).
 *
 * This test was written FIRST (TDD red): it drives an opportunities-shaped
 * input through the live route with a stub screener agent that runs the REAL
 * CSV generator on the captured input, and asserts the default-path response
 * carries `csvUrl` (+ `csvKey`) pointing at the generated CSV. Pre-fix it
 * fails (csvUrl undefined); post-fix it passes. The webhook path is pinned
 * as unchanged.
 *
 * Scope pins in this file:
 * - Default (toUi) path: response carries csvUrl + csvKey for the CSV the
 *   route just generated, and xlsxUrl is still present.
 * - Webhook path unchanged: response still carries csvUrl + xlsxUrl.
 * - CSV generation itself unchanged: verified by the change set (no
 *   generator files touched) and by #1587's pins, not re-proven here.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { executeUnifiedOptions } from "../src/agents/routes/etradeOptionsScreen";
import { UnifiedOptionsService } from "../src/trading";
import type { OpportunityScanResult } from "../src/trading/options/opportunityScanner";
import { generateOptionsCsv } from "../src/trading/screenerReportCsv";

function miniScan(): OpportunityScanResult {
  const leg = (symbol: string, strike: number) => ({
    symbol,
    optionType: "CALL",
    side: "BUY",
    quantity: 1,
    strike,
    expirationDate: "2026-11-13",
    daysToExpiration: 21,
    entryPrice: 3.2,
    bid: 3.1,
    ask: 3.3,
    impliedVolatility: 0.284,
    delta: 0.42,
    gamma: 0.03,
    theta: -0.05,
    vega: 0.12,
    openInterest: 21000,
    volume: 5400,
    spreadPct: 2.1,
    quoteTimestamp: "2026-10-24T09:05:00Z",
    quoteFreshness: "FRESH",
    multiplier: 100,
  });
  return {
    scanned: 2,
    withTrades: 2,
    opportunities: [
      {
        symbol: "AAPL",
        underlyingPrice: 248.1,
        targetPrice: 260,
        targetSource: "model",
        targetEmUnits: 0.6,
        pick: {
          status: "recommended",
          riskProfile: "balanced",
          confidence: "HIGH",
          best: { candidate: { legs: [leg("AAPL  261024C00250000", 250)] } },
        },
      },
      {
        symbol: "MSFT",
        underlyingPrice: 510.0,
        targetPrice: 530,
        targetSource: "model",
        targetEmUnits: 0.5,
        pick: {
          status: "recommended",
          riskProfile: "balanced",
          confidence: "HIGH",
          best: { candidate: { legs: [leg("MSFT  261024C00510000", 510)] } },
        },
      },
    ],
    coverage: { considered: 2, scanned: 2, evaluated: 2, withTrades: 2 },
    generatedAt: "2026-10-24T09:05:29Z",
  } as unknown as OpportunityScanResult;
}

describe("unified-route default UI response csvUrl (#1635)", () => {
  let capturedCsvText: string | undefined;

  const fakeAgent = {
    generateAndStoreOptionsXlsx: async () => ({ key: "xlsx-key", fileName: "options.xlsx" }),
    getOptionsXlsxByKey: async () => undefined,
    generateAndStoreOptionsCsv: async (input: any) => {
      capturedCsvText = generateOptionsCsv(input);
      return { key: "csv-key", fileName: "options.csv" };
    },
    getOptionsCsvByKey: async (key: string) =>
      key === "csv-key" && capturedCsvText
        ? { bytes: new TextEncoder().encode(capturedCsvText) }
        : undefined,
  };

  const ctxStub = () => ({
    env: {},
    requestedEnv: undefined,
    getOrm: () => ({ storeCanonicalReport: () => {} }),
    agentCtx: { storage: { sql: {} } },
    getScreenerAgent: () => fakeAgent,
  });

  afterEach(() => {
    vi.restoreAllMocks();
    capturedCsvText = undefined;
  });

  async function runUnified(reqData: Record<string, unknown>) {
    vi.spyOn(UnifiedOptionsService.prototype, "execute").mockResolvedValue({
      success: true,
      data: miniScan(),
      summary: "2 opportunities",
      toSlack: () => "slack",
      toUi: () => ({ ok: true }),
      toWebhook: () => ({ ok: true }),
    } as any);
    const request = new Request("http://localhost/api/options/unified", {
      headers: { "x-user-login": "tester" },
    });
    return executeUnifiedOptions({
      request,
      sessionId: "sess-1635",
      ctx: ctxStub() as any,
      reqData: { action: "opportunities", pushToSlack: false, thesis: "BULLISH", ...reqData },
    });
  }

  it("default (toUi) path carries csvUrl + csvKey for the generated CSV", async () => {
    const response = await runUnified({});
    expect(response.status).toBe(200);
    const body: any = await response.json();
    // xlsxUrl was already present on the default path; it must stay.
    expect(body.xlsxUrl).toBe("/api/options/report.xlsx?key=xlsx-key");
    // The defect: pre-fix both of these are undefined.
    expect(body.csvUrl).toBe("/api/options/report.csv?key=csv-key");
    expect(body.csvKey).toBe("csv-key");
    // The URL must resolve to the CSV the route just generated.
    const stored = await fakeAgent.getOptionsCsvByKey(body.csvKey);
    expect(stored).toBeDefined();
    const text = new TextDecoder().decode(stored!.bytes);
    expect(text).toContain("AAPL");
  });

  it("webhook path still carries csvUrl + xlsxUrl (unchanged)", async () => {
    const response = await runUnified({ channel: "webhook" });
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.xlsxUrl).toBe("/api/options/report.xlsx?key=xlsx-key");
    expect(body.csvUrl).toBe("/api/options/report.csv?key=csv-key");
  });
});
