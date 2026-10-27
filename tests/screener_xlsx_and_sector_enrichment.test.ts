import { describe, expect, it } from "vitest";
import { generateScreenerXlsx, parseScreenerXlsx } from "../src/trading/screenerReportXlsx";
import { DynamicMarketScreener, resolveStockSector } from "../src/trading/screener";
import type { ScreenedStockItem } from "../src/types";
import type { ScreenerRunResult } from "../src/agents/screener-agent";
import * as XLSX from "@e965/xlsx";

describe("Screener XLSX Report Generator", () => {
  const sampleResult: ScreenerRunResult = {
    timestamp: "2026-10-21T14:30:00.000Z",
    trigger: "manual",
    universe: "NASDAQ100",
    sector: "Technology",
    success: true,
    totalScanned: 2,
    expectedCount: 2,
    matchedCount: 2,
    opportunities: [
      {
        symbol: "NVDA",
        companyName: "NVIDIA Corporation",
        signal: "BULLISH_MOMENTUM",
        momentumScore: 88,
        lastPrice: 218.69,
        changePercent: 1.85,
        rsi14: 62.4,
        source: "E*TRADE live",
        indicators: {
          sentiment: "bullish",
          screenScore: 82,
        } as any,
        factorGrades: {
          quantRating: "Strong Buy",
          value: "B",
          momentum: "A+",
        } as any,
        technicals: {
          symbol: "NVDA",
          gapPercent: 1.2,
          gapDirection: "up",
          rsi14: 62.4,
          macdHistogram: 0.85,
          barsUsed: 60,
          source: "Yahoo Finance",
        } as any,
      },
    ],
    allStocks: [
      {
        symbol: "NVDA",
        companyName: "NVIDIA Corporation",
        lastPrice: 218.69,
        changePercent: 1.85,
        signal: "BULLISH_MOMENTUM",
        momentumScore: 88,
        rsi14: 62.4,
        source: "E*TRADE live",
        peRatio: 42.5,
        sector: "Technology",
        indicators: {
          sentiment: "bullish",
          screenScore: 82,
        } as any,
        factorGrades: {
          quantRating: "Strong Buy",
          value: "B",
          momentum: "A+",
        } as any,
        technicals: {
          symbol: "NVDA",
          gapPercent: 1.2,
          gapDirection: "up",
          rsi14: 62.4,
          macdHistogram: 0.85,
          barsUsed: 60,
          source: "Yahoo Finance",
        } as any,
      },
      {
        symbol: "AAPL",
        companyName: "Apple Inc.",
        lastPrice: 232.10,
        changePercent: -0.45,
        signal: "RANGE_BOUND",
        momentumScore: 55,
        rsi14: 48.2,
        source: "E*TRADE live",
        peRatio: 31.0,
        sector: "Technology",
        indicators: {
          sentiment: "neutral",
          screenScore: 64,
        } as any,
        factorGrades: {
          quantRating: "Hold",
          value: "C+",
          momentum: "B",
        } as any,
        technicals: {
          symbol: "AAPL",
          gapPercent: -0.2,
          gapDirection: "down",
          rsi14: 48.2,
          macdHistogram: -0.15,
          barsUsed: 60,
          source: "Yahoo Finance",
        } as any,
      },
    ],
    discoveryMessage: "Scanned 2 NASDAQ100 stocks, 2 matched.",
  };

  it("generates a valid XLSX binary with two tabs (Screened Stocks and Formulas)", () => {
    const bytes = generateScreenerXlsx(sampleResult);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(500);

    const wb = XLSX.read(bytes, { type: "array" });
    expect(wb.SheetNames).toContain("Screened Stocks");
    expect(wb.SheetNames).toContain("Formulas & Methodology");

    const stockSheet = wb.Sheets["Screened Stocks"];
    const rows = XLSX.utils.sheet_to_json(stockSheet) as any[];
    expect(rows.length).toBe(2);
    expect(rows[0]["Symbol"]).toBe("NVDA");
    expect(rows[0]["Price"]).toBe(218.69);
    expect(rows[0]["Quant Rating"]).toBe("Strong Buy");
    expect(rows[0]["Value Grade"]).toBe("B");
    expect(rows[0]["Momentum Grade"]).toBe("A+");
    expect(rows[0]["Score"]).toBe(82);

    const formulaSheet = wb.Sheets["Formulas & Methodology"];
    const formulas = XLSX.utils.sheet_to_json(formulaSheet) as any[];
    expect(formulas.length).toBeGreaterThan(10);
    const colNames = formulas.map((f) => f["Column Name"]);
    expect(colNames).toContain("Price");
    expect(colNames).toContain("Gap%");
    expect(colNames).toContain("RSI-14");
    expect(colNames).toContain("MACD Histogram");
    expect(colNames).toContain("Score");
  });
});

describe("Sector Resolution and Enrichment", () => {
  it("resolves Technology/Semiconductors for known tech symbols even if raw sector is Equities or undefined", () => {
    expect(resolveStockSector("NVDA", "NVIDIA Corporation", "Equities")).toBe("Semiconductors");
    expect(resolveStockSector("AAPL", "Apple Inc.", undefined)).toBe("Technology");
    expect(resolveStockSector("MSFT", "Microsoft Corp", "")).toBe("Technology");
  });

  it("infers sector from company name when not in curated universe", () => {
    expect(resolveStockSector("CUSTOM", "Cyber Semiconductor Technologies Corp", "Equities")).toBe("Semiconductors");
    expect(resolveStockSector("HEAL", "Global BioTherapeutics Pharma", "Equities")).toBe("Healthcare");
    expect(resolveStockSector("BANK", "First Horizon Bancorp Capital", "Equities")).toBe("Financial");
  });

  it("preserves explicit non-Equities sector", () => {
    expect(resolveStockSector("XYZ", "XYZ Corp", "Energy")).toBe("Energy");
  });
});

function makeItem950(overrides: Partial<ScreenedStockItem> = {}): ScreenedStockItem {
  return {
    symbol: "TEST",
    companyName: "Test Co",
    lastPrice: 100,
    price: 100,
    change: 1,
    changePercent: 1,
    bid: 99,
    ask: 101,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    timestamp: "2026-10-26T00:00:00.000Z",
    macdSignal: "MACD unavailable from listing feed",
    signal: "RANGE_BOUND",
    technicalSignal: "RSI neutral",
    momentumScore: 50,
    highlightReason: "Test Co market listing",
    ...overrides,
  } as ScreenedStockItem;
}

describe("Sector filter with missing sector data (#950)", () => {
  it("resolveStockSector returns undefined when sector is unresolvable, never the fake Equities", () => {
    expect(resolveStockSector("ZZQ", "Zzq Widgets LLC", undefined)).toBeUndefined();
    expect(resolveStockSector("ZZQ", "Zzq Widgets LLC", "Equities")).toBeUndefined();
  });

  it("sector filter passes stocks with no sector data instead of rejecting them", () => {
    const items = [
      makeItem950({ symbol: "ZZQ", companyName: "Zzq Widgets LLC", sector: undefined }),
      makeItem950({ symbol: "HEALX", companyName: "Healx Corp", sector: "Healthcare" }),
      makeItem950({ symbol: "TECHX", companyName: "Techx Corp", sector: "Technology" }),
    ];
    const result = new DynamicMarketScreener(items).screenStocks({ sector: "Technology" } as never);
    const passed = result.stocks.map((s) => s.symbol);
    expect(passed).toContain("ZZQ");
    expect(passed).toContain("TECHX");
    expect(passed).not.toContain("HEALX");
    expect(result.ledger.rejections.find((r) => r.symbol === "ZZQ")).toBeUndefined();
    expect(result.ledger.rejections.find((r) => r.symbol === "HEALX")?.reason).toMatch(/does not match requested/);
  });
});
