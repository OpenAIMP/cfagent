import { describe, it, expect, vi } from "vitest";
import { generateOptionsPdf, optionsPdfFileName } from "../src/trading/optionsReportPdf";
import { generateScreenerPdf, screenerPdfFileName } from "../src/trading/screenerReportPdf";
import { getPdfAsset } from "../src/agents/report-asset-agent";
import { deliverScreenerToSlackA2A } from "../src/services/screenerSlackDelivery";
import { handleScreenerResearchRoutes } from "../src/agents/routes/screenerResearch";
import type { OptionScreenResult, ScreenerRunResult } from "../src/types";

vi.mock("agents", () => ({
  Agent: class {},
}));

// #1958: ReportAssetAgent now extends PortThink, whose @cloudflare/think
// base needs workerd schemes the node vitest harness cannot load. Stub
// the base (same idiom as the "agents" mock above); this file's
// assertions are about the PDF pipeline, not the Think runtime.
vi.mock("@cloudflare/think", () => ({
  Think: class {},
}));

vi.mock("../src/services/cfpayA2A", () => ({
  getCfpayConfig: vi.fn((env: any) => (env?.CFPAY_A2A_TOKEN ? { token: env.CFPAY_A2A_TOKEN } : null)),
  cfpayPostFileToSlack: vi.fn(async (_config, params) => ({
    ok: true,
    file: { id: "F123", name: params.filename, title: params.title },
  })),
  cfpayPostToSlack: vi.fn(async () => ({ ok: true })),
}));

describe("Generate / Store / Serve / Deliver: Options & Stock Screener PDF Pipeline", () => {
  describe("1. Generate: optionsReportPdf", () => {
    it("generates a valid PDF for contract screens (OptionScreenResult)", async () => {
      const mockResult: OptionScreenResult = {
        totalUnderlyingsScanned: 2,
        totalContractsEvaluated: 10,
        matchedCount: 1,
        filterApplied: { underlyingSymbols: ["NVDA", "AAPL"] },
        filterSummary: "delta >= 0.30",
        contracts: [
          {
            symbol: "NVDA_261023C200",
            underlyingSymbol: "NVDA",
            expirationDate: "2026-10-23",
            strikePrice: 200,
            optionType: "CALL",
            delta: 0.45,
            impliedVolatility: 0.35,
            bid: 12.5,
            ask: 13.0,
          },
        ],
        scannedAt: "2026-10-21T06:00:00.000Z",
        status: "matches_found",
      };

      const bytes = await generateOptionsPdf(mockResult);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(100);
      // Valid PDF magic bytes: %PDF
      expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    });

    it("generates a valid PDF for opportunities scans (OpportunityScanResult shape)", async () => {
      const mockOppResult = {
        scanned: 5,
        withTrades: 3,
        opportunities: [
          {
            symbol: "NVDA",
            underlyingPrice: 217.23,
            targetPrice: 235.0,
            targetSource: "resistance",
            targetEmUnits: 1.2,
            score: 85,
            gateBucket: "fit",
            gateReasons: [],
            pick: {
              symbol: "NVDA",
              strategyType: "BULL_CALL_SPREAD",
              strategyName: "Bull Call Spread",
              description: "Long 215C / Short 235C",
              reasoning: "Strong momentum with defined risk",
            },
          },
        ],
        skipped: [],
        truncatedSymbols: 0,
        assumptions: [],
        mode: "per_name_best",
        generatedAt: "2026-10-21T06:00:00.000Z",
      };

      const bytes = await generateOptionsPdf(mockOppResult);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(100);
      expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    });

    it("optionsPdfFileName handles missing scannedAt safely", () => {
      const nameFromTimestamp = optionsPdfFileName({ timestamp: "2026-10-21T07:00:00.000Z", universe: "nasdaq100" });
      expect(nameFromTimestamp).toContain("options-scan_nasdaq100");
      expect(nameFromTimestamp).toContain("2026-10-21T07-00-00Z");

      const nameFromGeneratedAt = optionsPdfFileName({ generatedAt: "2026-10-21T08:00:00.000Z" });
      expect(nameFromGeneratedAt).toContain("2026-10-21T08-00-00Z");

      const nameEmpty = optionsPdfFileName({});
      expect(nameEmpty).toMatch(/^options-scan_options_adhoc_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_adhoc\.pdf$/);
    });
  });

  describe("2. Generate: screenerReportPdf", () => {
    it("generates a valid PDF for stock screener results", async () => {
      const mockResult: ScreenerRunResult = {
        timestamp: "2026-10-21T06:00:00.000Z",
        universe: "NASDAQ100",
        sector: "TECH",
        success: true,
        totalScanned: 100,
        expectedCount: 100,
        matchedCount: 2,
        opportunities: [
          {
            symbol: "NVDA",
            companyName: "NVIDIA Corp",
            lastPrice: 217.23,
            changePercent: 3.5,
            signal: "BULLISH_MOMENTUM",
            momentumScore: 82,
            indicators: {
              sentiment: "bullish",
              directional: true,
              rangeZone: "breakout",
              valueZone: "neutral",
              screenScore: 88,
              summary: "Strong breakout",
            },
            factorGrades: {
              value: "B",
              momentum: "A+",
              growth: "A",
              profitability: "A+",
              revisions: "A",
              quantRating: "Strong Buy",
              gradedFactors: [],
            },
            technicals: {
              rsi14: 64,
              macdLine: 2.5,
              macdSignal: "bullish",
              macdHistogram: 0.8,
              macdCrossing: "bullish",
            },
          },
        ],
        allStocks: [],
        discoveryMessage: "Found 2 opportunities",
      };

      const bytes = await generateScreenerPdf(mockResult);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(100);
      expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);

      const fileName = screenerPdfFileName(mockResult);
      expect(fileName).toContain("market-screen_nasdaq100");
    });
  });

  describe("3. Store: ReportAssetAgent and getPdfAsset", () => {
    it("getPdfAsset returns null safely when binding is missing", async () => {
      const res = await getPdfAsset({}, "trader1", "some-key");
      expect(res).toBeNull();
    });

    it("getPdfAsset retrieves stored asset when binding is present", async () => {
      const mockBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      const mockAgent = {
        getAsset: vi.fn(async (key: string) =>
          key === "report:pdf:options:123" ? { bytes: mockBytes, fileName: "test.pdf" } : null
        ),
      };
      const env = {
        REPORT_ASSET_AGENT: {
          idFromName: vi.fn(() => ({ name: "assets:trader1" })),
          get: vi.fn(() => mockAgent),
        },
      };

      const asset = await getPdfAsset(env, "trader1", "report:pdf:options:123");
      expect(asset).not.toBeNull();
      expect(asset?.fileName).toBe("test.pdf");
      expect(asset?.bytes).toEqual(mockBytes);
      expect(mockAgent.getAsset).toHaveBeenCalledWith("report:pdf:options:123");
    });
  });

  describe("4. Serve: UI Download Endpoints (/api/screener/report.pdf & /api/options/report.pdf)", () => {
    it("serves screener PDF report with correct headers and status 200", async () => {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01, 0x02]);
      const mockScreenerAgent = {
        getPdfByKey: vi.fn(async (key: string) =>
          key === "key-stock-1" ? { bytes: pdfBytes, fileName: "screener-report.pdf" } : null
        ),
      };

      const ctx: any = {
        getScreenerAgent: vi.fn(() => mockScreenerAgent),
        getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
      };

      const req = new Request("https://agent.openaimp.com/api/screener/report.pdf?key=key-stock-1", {
        method: "GET",
        headers: { "x-user-login": "alice" },
      });
      const url = new URL(req.url);

      const res = (await handleScreenerResearchRoutes(req, url, "/api/screener/report.pdf", "s1", ctx)) as Response;
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Content-Disposition")).toContain('attachment; filename="screener-report.pdf"');
      expect(res.headers.get("Content-Length")).toBe(String(pdfBytes.length));

      const body = new Uint8Array(await res.arrayBuffer());
      expect(body).toEqual(pdfBytes);
    });

    it("serves options PDF report with correct headers and status 200", async () => {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x99]);
      const mockScreenerAgent = {
        getOptionsPdfByKey: vi.fn(async (key: string) =>
          key === "key-opt-1" ? { bytes: pdfBytes, fileName: "options-scan.pdf" } : null
        ),
      };

      const ctx: any = {
        getScreenerAgent: vi.fn(() => mockScreenerAgent),
        getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
      };

      const req = new Request("https://agent.openaimp.com/api/options/report.pdf?key=key-opt-1", {
        method: "GET",
        headers: { "x-user-login": "alice" },
      });
      const url = new URL(req.url);

      const res = (await handleScreenerResearchRoutes(req, url, "/api/options/report.pdf", "s1", ctx)) as Response;
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Content-Disposition")).toContain('attachment; filename="options-scan.pdf"');
      expect(res.headers.get("Content-Length")).toBe(String(pdfBytes.length));
    });

    it("returns 404 when key is not found", async () => {
      const mockScreenerAgent = {
        getOptionsPdfByKey: vi.fn(async () => null),
      };

      const ctx: any = {
        getScreenerAgent: vi.fn(() => mockScreenerAgent),
        getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
      };

      const req = new Request("https://agent.openaimp.com/api/options/report.pdf?key=non-existent", {
        method: "GET",
      });
      const url = new URL(req.url);

      const res = (await handleScreenerResearchRoutes(req, url, "/api/options/report.pdf", "s1", ctx)) as Response;
      expect(res.status).toBe(404);
    });
  });

  describe("5. Deliver: Slack A2A delivery with PDF attachment", () => {
    it("delivers PDF over A2A to Slack channel with file attachment", async () => {
      const env = {
        CFPAY_A2A_TOKEN: "mock-a2a-token",
        SCREENER_SLACK_CHANNEL: "C123SCREENER",
      };
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x01, 0x02]);

      const deliveryResult = await deliverScreenerToSlackA2A(env, {
        text: "Options screener completed",
        channel: "C123SCREENER",
        pdf: {
          bytes: pdfBytes,
          fileName: "options-scan.pdf",
          title: "Options Scanner Report",
          comment: "Options screener report PDF",
        },
      });

      expect(deliveryResult.ok).toBe(true);
      const { cfpayPostFileToSlack } = await import("../src/services/cfpayA2A");
      expect(cfpayPostFileToSlack).toHaveBeenCalledWith(
        expect.objectContaining({ token: "mock-a2a-token" }),
        expect.objectContaining({
          channel: "C123SCREENER",
          filename: "options-scan.pdf",
          title: "Options Scanner Report",
        })
      );
    });
  });
});
