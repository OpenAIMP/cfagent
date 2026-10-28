/**
 * Issue #2088: the whole PDF is Letter landscape, and the builder
 * honors the template section config.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  generateScreenerPdf,
  formatReportTimestamp,
} from "../src/trading/screenerReportPdf";

function mockRun(): any {
  const row = (symbol: string, gapDirection: string, score: number) => ({
    symbol,
    companyName: `${symbol} Corporation`,
    sector: "Technology",
    lastPrice: 100,
    changePercent: 1.0,
    technicals: { gapPercent: 1.5, gapDirection, rsi14: 50, macdHistogram: 0.2 },
    indicators: { sentiment: "bullish", screenScore: score },
    factorGrades: { quantRating: "Buy", value: "A", momentum: "B" },
    peRatio: 20,
    signal: "BULLISH_MOMENTUM",
    source: "E*TRADE live",
  });
  return {
    universe: "NASDAQ100",
    sector: "ALL",
    trigger: "manual",
    timestamp: "2026-10-28T07:50:04.014Z",
    success: true,
    totalScanned: 2,
    matchedCount: 2,
    opportunities: [row("AAA", "up", 80)],
    allStocks: [row("AAA", "up", 80), row("BBB", "down", 40)],
  };
}

describe("landscape", () => {
  it("renders every page Letter landscape (792 x 612)", async () => {
    const bytes = await generateScreenerPdf(mockRun());
    const doc = await PDFDocument.load(bytes);
    const pages = doc.getPages();
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const { width, height } = page.getSize();
      expect(width).toBe(792);
      expect(height).toBe(612);
    }
  });

  it("honors a section config without throwing", async () => {
    const bytes = await generateScreenerPdf(mockRun(), {
      sections: { gapUps: 1, gapDowns: 1, standouts: 1, allSymbols: 1 },
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPages().length).toBeGreaterThan(0);
  });
});

describe("timestamp", () => {
  it("renders ET plus UTC", () => {
    expect(formatReportTimestamp("2026-10-28T07:50:04.014Z")).toBe(
      "Oct 28, 2026, 03:50 EDT (07:50 UTC)"
    );
  });

  it("falls back to the raw value when unparseable", () => {
    expect(formatReportTimestamp("not-a-date")).toBe("not-a-date");
  });
});
