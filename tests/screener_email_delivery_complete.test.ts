import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateScreenerPdf, screenerPdfFileName } from "../src/trading/screenerReportPdf";
import { generateOptionsPdf, optionsPdfFileName } from "../src/trading/optionsReportPdf";
import { publishScreenerCompleted, publishScreenerFailed } from "../src/events/screenerPublishers";
import type { ScreenerRunResult } from "../src/agents/screener-agent";
import type { ScreenerCompletedEvent, ScreenerFailedEvent } from "../src/events/screenerEvents";
import { PDFDocument } from "pdf-lib";

vi.mock("agents", () => ({
  Agent: class {},
}));

const mockCfpaySendEmailWithAttachments = vi.fn(async () => ({ ok: true, messageId: "msg_123" }));
const mockCfpaySendEmail = vi.fn(async () => ({ ok: true, messageId: "msg_456" }));
const mockCfpayPostToSlack = vi.fn(async () => ({ ok: true }));

vi.mock("../src/services/cfpayA2A", () => ({
  getCfpayConfig: vi.fn((env: any) => (env?.CFPAY_A2A_TOKEN ? { token: env.CFPAY_A2A_TOKEN } : null)),
  cfpaySendEmailWithAttachments: (...args: any[]) => mockCfpaySendEmailWithAttachments(...args),
  cfpaySendEmail: (...args: any[]) => mockCfpaySendEmail(...args),
  cfpayPostToSlack: (...args: any[]) => mockCfpayPostToSlack(...args),
  cfpayPostFileToSlack: vi.fn(async () => ({ ok: true })),
}));

describe("Complete Screener Reports and Omnichannel Delivery (UI, Slack, Email via A2A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Full Stock Screener Report PDF (All Screened Symbols + Yahoo Technicals + Criteria)", () => {
    it("generates a multi-page PDF covering all 100 scanned symbols with Yahoo RSI/MACD/gaps and active criteria", async () => {
      // Simulate the exact run the user reported: 100 stocks in NASDAQ100 scanned, 0 matched standout criteria
      const allStocks = Array.from({ length: 100 }, (_, i) => ({
        symbol: `SYM${i + 1}`,
        companyName: `Company ${i + 1} Inc`,
        lastPrice: 100 + i * 2.5,
        changePercent: (i % 2 === 0 ? 1 : -1) * (0.5 + (i % 5)),
        source: "E*TRADE",
        rsi14: 45 + (i % 30),
        momentumScore: 40 + (i % 40),
        indicators: {
          sentiment: i % 2 === 0 ? "bullish" : "bearish",
          directional: false,
          rangeZone: "neutral",
          valueZone: "fair",
          screenScore: 50 + (i % 20),
          intradayPosition: 0.5,
          rangePosition: 0.5,
          summary: "Neutral trading",
        },
        factorGrades: {
          value: "B",
          momentum: "C+",
          growth: null,
          profitability: null,
          revisions: null,
          quantRating: i % 2 === 0 ? "Hold" : "Sell",
          valueScore: 60,
          momentumScore: 55,
          compositeScore: 58,
          gradedFactors: ["value", "momentum"],
        },
        technicals: {
          rsi14: 45 + (i % 30),
          macdLine: 1.2,
          macdSignalLine: 1.0,
          macdHistogram: (i % 2 === 0 ? 0.2 : -0.3),
          macdSignal: i % 2 === 0 ? "bullish" : "bearish",
          gapPercent: (i % 3 === 0 ? 0.8 : -0.5),
          gapDirection: (i % 3 === 0 ? ("up" as const) : ("down" as const)),
          historyBars: 60,
          historySource: "yahoo",
        },
      }));

      const mockRun: ScreenerRunResult = {
        timestamp: "2026-10-21T12:00:00.000Z",
        trigger: "scheduled",
        universe: "NASDAQ100",
        sector: "ALL",
        success: true,
        totalScanned: 100,
        expectedCount: 100,
        matchedCount: 0,
        opportunities: [], // 0 standout matches
        allStocks,
        filterSummary: "Universe: NASDAQ100, Sector: ALL, Day Chg >= 0%, Momentum >= 60, Quant Rating Buy/Strong Buy",
        discoveryMessage: "100 candidate quotes received from E*TRADE live feed",
        rejections: [
          { symbol: "SYM1", reason: "Momentum score 40 below 60" },
          { symbol: "SYM2", reason: "Negative day change (-1.5%)" },
          { symbol: "SYM3", reason: "Momentum score 42 below 60" },
        ],
      };

      const pdfBytes = await generateScreenerPdf(mockRun);
      expect(pdfBytes).toBeInstanceOf(Uint8Array);
      expect(pdfBytes.length).toBeGreaterThan(1000);

      // Verify the generated PDF can be loaded and has multiple pages to fit 100 stocks
      const loadedDoc = await PDFDocument.load(pdfBytes);
      const pageCount = loadedDoc.getPageCount();
      expect(pageCount).toBeGreaterThanOrEqual(2); // 100 rows span across pages

      const fileName = screenerPdfFileName(mockRun);
      expect(fileName).toContain("market-screen_nasdaq100_scheduled");
    });
  });

  describe("2. Options Screener PDF with Active Criteria and Greeks", () => {
    it("generates an options report PDF detailing criteria, underlyings, and greeks", async () => {
      const mockOptionsResult = {
        scanned: 10,
        withTrades: 8,
        totalUnderlyingsScanned: 10,
        totalContractsEvaluated: 45,
        matchedCount: 2,
        thesis: "bullish",
        riskProfile: "balanced",
        filterSummary: "Delta >= 0.30, IV < 60%, Max DTE 45",
        opportunities: [
          {
            symbol: "NVDA",
            underlyingPrice: 220.5,
            gateBucket: "fit",
            pick: {
              strategyName: "Bull Call Spread",
              description: "Long 215C / Short 235C (45 DTE)",
              reasoning: "High implied move with favorable risk-reward ratio",
            },
          },
        ],
        timestamp: "2026-10-21T12:00:00.000Z",
      };

      const pdfBytes = await generateOptionsPdf(mockOptionsResult);
      expect(pdfBytes).toBeInstanceOf(Uint8Array);
      const loadedDoc = await PDFDocument.load(pdfBytes);
      expect(loadedDoc.getPageCount()).toBeGreaterThanOrEqual(1);

      const fileName = optionsPdfFileName(mockOptionsResult);
      expect(fileName).toContain("options-scan_options_adhoc");
    });
  });

  describe("3. Email Channel Delivery via cfpay A2A", () => {
    it("dispatches completed screen via cfpay A2A email with attached PDF when emailTo is specified", async () => {
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x31, 0x2e, 0x34]); // %PDF-1.4
      const mockAgent = {
        getPdfByKey: async (k: string) => (k === "pdf_run_100" ? { bytes: pdfBytes, fileName: "nasdaq100-report.pdf" } : null),
      };

      const deps = {
        env: {
          CFPAY_A2A_TOKEN: "cfpay_secret_token_abc",
          SCREENER_AGENT: {
            idFromName: () => ({ name: "screener:trader1" }),
            get: () => mockAgent,
          },
        },
        userLogin: "trader1",
      };

      const event: ScreenerCompletedEvent = {
        type: "screener.completed",
        timestamp: "2026-10-21T12:00:00.000Z",
        universe: "NASDAQ100",
        sector: "ALL",
        trigger: "scheduled",
        totalScanned: 100,
        matchedCount: 0,
        expectedCount: 100,
        pdfKey: "pdf_run_100",
        pdfStatus: "generated",
        opportunities: [],
        filterSummary: "Universe: NASDAQ100, Sector: ALL, Positive Day Change, Momentum >= 60",
        emailTo: "portfolio-manager@firm.com",
        rejections: [
          { symbol: "SYM1", reason: "Momentum score below 60" },
        ],
      };

      await publishScreenerCompleted(deps as any, event);

      // Verify email was dispatched via cfpay A2A with attachment
      expect(mockCfpaySendEmailWithAttachments).toHaveBeenCalledTimes(1);
      const call = mockCfpaySendEmailWithAttachments.mock.calls[0];
      const payload = call[1];
      expect(payload.to).toBe("portfolio-manager@firm.com");
      expect(payload.subject).toContain("Market Screen [NASDAQ100]");
      expect(payload.body).toContain("NASDAQ100");
      expect(payload.body).toContain("Criteria: Universe: NASDAQ100, Sector: ALL");
      expect(payload.body).toContain("No standout opportunities met the screening criteria.");
      expect(payload.attachments).toHaveLength(1);
      expect(payload.attachments[0].filename).toBe("nasdaq100-report.pdf");
      expect(payload.attachments[0].contentType).toBe("application/pdf");
    });

    it("dispatches failed screen alert via cfpay A2A email when emailTo is specified", async () => {
      const deps = {
        env: {
          CFPAY_A2A_TOKEN: "cfpay_secret_token_abc",
        },
        userLogin: "trader1",
      };

      const event: ScreenerFailedEvent = {
        type: "screener.failed",
        timestamp: "2026-10-21T12:00:00.000Z",
        universe: "NASDAQ100",
        sector: "ALL",
        trigger: "scheduled",
        error: "E*TRADE Session Expired",
        emailTo: "alerts@firm.com",
      };

      await publishScreenerFailed(deps as any, event);

      expect(mockCfpaySendEmail).toHaveBeenCalledTimes(1);
      const call = mockCfpaySendEmail.mock.calls[0];
      expect(call[1]).toBe("alerts@firm.com");
      expect(call[2]).toContain("Market Screen FAILED — NASDAQ100");
      expect(call[3]).toContain("E*TRADE Session Expired");
    });
  });
});
