/**
 * Issue #2162: the unified strategy/AI actions return and record the
 * strategy report artifacts.
 *
 * Pins (TDD red first — the response links are new):
 *  - a successful strategy action stores PDF/XLSX/CSV through the shared
 *    strategy report generator (the fake agent returns the keys the real
 *    ScreenerAgent would return);
 *  - the canonical `options_strategy` row carries all three keys + statuses;
 *  - the UI/webhook responses carry reportUrl / xlsxUrl / csvUrl / csvKey,
 *    so the panel can open the report it just generated;
 *  - a failed PDF key stays absent from the response instead of becoming a
 *    broken link (the #1278 failure contract).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeUnifiedOptions } from "../src/agents/routes/etradeOptionsScreen";
import { UnifiedOptionsService } from "../src/trading";
import type { StrategyReportInput } from "../src/trading/strategyReport";

const keys = {
  pdfKey: "options:pdf:strategy:abc12345",
  pdfStatus: "generated" as const,
  xlsxKey: "options:xlsx:strategy:abc12345",
  xlsxStatus: "generated" as const,
  csvKey: "options:csv:strategy:abc12345",
  csvStatus: "generated" as const,
};

function candidate(id: string, type: string) {
  return {
    id,
    type,
    label: type === "long_call" ? "Long Call" : "Bull Put Spread",
    symbol: "NVDA",
    expirationDate: "2026-11-20",
    legs: [{ symbol: "NVDA  261120C00180000", optionType: "CALL", side: "BUY", quantity: 1, strike: 180, expirationDate: "2026-11-20", entryPrice: 5.25 }],
    netDebit: 5.25,
    maxProfit: 475,
    maxProfitUnbounded: false,
    maxLoss: 525,
    breakevens: [185.25],
    targetRewardRisk: 0.9,
    modelImpliedProbabilityOfProfit: 0.61,
  };
}

describe("unified strategy action artifacts (#2162)", () => {
  let capturedInput: StrategyReportInput | undefined;
  let capturedReport: Record<string, any> | undefined;
  let capturedOutcome: Record<string, any> | undefined;

  const fakeAgent = {
    generateAndStoreStrategyReport: async (input: StrategyReportInput) => {
      capturedInput = input;
      return keys;
    },
  };

  const ctxStub = () => ({
    env: {},
    requestedEnv: undefined,
    getOrm: () => ({
      storeCanonicalReport: (input: Record<string, any>) => {
        capturedReport = input;
        return { reportId: "rep-strategy", created: true };
      },
    }),
    agentCtx: { storage: { sql: {} } },
    getScreenerAgent: () => fakeAgent,
  });

  afterEach(() => {
    vi.restoreAllMocks();
    capturedInput = undefined;
    capturedReport = undefined;
    capturedOutcome = undefined;
  });

  async function runStrategy(reqData: Record<string, unknown> = {}) {
    vi.spyOn(UnifiedOptionsService.prototype, "execute").mockResolvedValue({
      success: true,
      data: {
        ranked: [
          { candidate: candidate("c-1", "long_call"), rank: 1, compositeScore: 88 },
          { candidate: candidate("c-2", "bull_put_spread"), rank: 2, compositeScore: 81 },
        ],
      },
      summary: "2 ranked strategies for NVDA.",
      toSlack: () => "slack",
      toUi: () => ({ ok: true }),
      toWebhook: () => ({ ok: true }),
      toEmailHtml: () => "<p>ok</p>",
      toEmailText: () => "ok",
      toVoice: () => "ok",
      toMcp: () => ({ ok: true }),
    } as any);
    const request = new Request("http://localhost/api/options/unified", {
      headers: { "x-user-login": "tester" },
    });
    return executeUnifiedOptions({
      request,
      sessionId: "sess-2162",
      ctx: ctxStub() as any,
      reqData: { action: "strategies", symbol: "NVDA", pushToSlack: false, ...reqData },
    });
  }

  it("generates the report from the strategy payload and records its keys", async () => {
    const response = await runStrategy();
    expect(response.status).toBe(200);

    expect(capturedInput?.action).toBe("strategies");
    expect(capturedInput?.symbol).toBe("NVDA");
    expect(capturedInput?.ranked).toHaveLength(2);

    expect(capturedReport).toMatchObject({
      source: "options_strategy",
      userLogin: "tester",
      body: {
        action: "strategies",
        symbol: "NVDA",
        withTrades: 2,
        ...keys,
      },
    });
  });

  it("returns the download links on the default UI response", async () => {
    const response = await runStrategy();
    const body: any = await response.json();
    expect(body.reportUrl).toBe("/api/options/report.pdf?key=options%3Apdf%3Astrategy%3Aabc12345");
    expect(body.xlsxUrl).toBe("/api/options/report.xlsx?key=options%3Axlsx%3Astrategy%3Aabc12345");
    expect(body.csvKey).toBe("options:csv:strategy:abc12345");
    expect(body.csvUrl).toBe("/api/options/report.csv?key=options%3Acsv%3Astrategy%3Aabc12345");
  });

  it("returns the same links on the webhook channel", async () => {
    const response = await runStrategy({ channel: "webhook" });
    const body: any = await response.json();
    expect(body.reportUrl).toBe("/api/options/report.pdf?key=options%3Apdf%3Astrategy%3Aabc12345");
    expect(body.xlsxUrl).toBe("/api/options/report.xlsx?key=options%3Axlsx%3Astrategy%3Aabc12345");
    expect(body.csvUrl).toBe("/api/options/report.csv?key=options%3Acsv%3Astrategy%3Aabc12345");
  });

  it("leaves a failed PDF out of the links instead of returning a broken URL", async () => {
    const failingAgent = {
      generateAndStoreStrategyReport: async () => ({
        pdfStatus: "failed" as const,
        pdfError: "r2 unavailable",
        xlsxKey: "options:xlsx:strategy:def",
        xlsxStatus: "generated" as const,
        csvKey: "options:csv:strategy:def",
        csvStatus: "generated" as const,
      }),
    };
    vi.spyOn(UnifiedOptionsService.prototype, "execute").mockResolvedValue({
      success: true,
      data: { ranked: [{ candidate: candidate("c-1", "long_call"), rank: 1, compositeScore: 88 }] },
      summary: "1 ranked strategy for NVDA.",
      toSlack: () => "slack",
      toUi: () => ({ ok: true }),
      toWebhook: () => ({ ok: true }),
    } as any);
    const ctx = { ...ctxStub(), getScreenerAgent: () => failingAgent };
    const response = await executeUnifiedOptions({
      request: new Request("http://localhost/api/options/unified", { headers: { "x-user-login": "tester" } }),
      sessionId: "sess-2162b",
      ctx: ctx as any,
      reqData: { action: "strategies", symbol: "NVDA", pushToSlack: false },
    });
    const body: any = await response.json();
    expect(body.reportUrl).toBeUndefined();
    expect(body.xlsxUrl).toBe("/api/options/report.xlsx?key=options%3Axlsx%3Astrategy%3Adef");
    expect(body.csvUrl).toBe("/api/options/report.csv?key=options%3Acsv%3Astrategy%3Adef");
  });
});
