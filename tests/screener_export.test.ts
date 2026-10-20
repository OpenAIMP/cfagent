/**
 * Issue #125 (PR-B) / #126: result-set serializers for a market screen
 * run (src/client/screenerExport.ts). The UI offered only the PDF
 * report; these pins cover the CSV/JSON result-set exports:
 *  - the standout CSV columns mirror the ScreenerResultsView standouts
 *    table, and the all-stocks CSV mirrors its all-screened table;
 *  - RFC 4180 escaping (commas / quotes / newlines in company names);
 *  - a partial run's #462 qualification is visible in the file
 *    (metadata comment lines in CSV, the marker itself in JSON);
 *  - an empty standout set still yields metadata + header;
 *  - filenames identify the run (UTC stamp + sector scope + set), so
 *    downloads from different runs never collide.
 */
import { describe, it, expect } from "vitest";
import {
  csvEscape,
  screenAllStocksCsv,
  screenExportFilename,
  screenRunJson,
  screenStandoutsCsv,
} from "../src/client/screenerExport";
import type { ScreenerResultData } from "../src/client/ScreenerResultsView";

const RUN: ScreenerResultData = {
  timestamp: "2026-10-20T13:55:00.000Z",
  trigger: "scheduled",
  sector: "Technology",
  success: true,
  totalScanned: 100,
  matchedCount: 12,
  opportunities: [
    {
      symbol: "NVDA",
      companyName: "NVIDIA Corporation",
      signal: "bullish",
      momentumScore: 91,
      lastPrice: 187.5,
      changePercent: 2.34,
      indicators: {
        sentiment: "very_bullish",
        directional: true,
        rangeZone: "overbought",
        valueZone: "fair",
        screenScore: 88,
        intradayPosition: 0.9,
        rangePosition: 0.8,
        summary: "strong",
      },
      factorGrades: {
        value: "B",
        momentum: "A",
        growth: null,
        profitability: null,
        revisions: null,
        quantRating: "Strong Buy",
        valueScore: 61,
        momentumScore: 93,
        compositeScore: 84,
        gradedFactors: ["value", "momentum"],
      },
      technicals: {
        rsi14: 62,
        macdLine: 1.1,
        macdSignalLine: 0.9,
        macdHistogram: 0.2,
        macdSignal: "bullish",
        gapPercent: 1.25,
        gapDirection: "up",
        historyBars: 40,
        historySource: "yahoo",
      },
    },
    {
      // No indicator enrichments at all — every metric cell must be empty.
      symbol: "PLTR",
      companyName: "Palantir Technologies",
      signal: "bullish",
      momentumScore: 88,
      lastPrice: 160,
      changePercent: -1.05,
    },
  ],
  allStocks: [
    {
      symbol: "NVDA",
      companyName: "NVIDIA Corporation",
      signal: "bullish",
      momentumScore: 91,
      lastPrice: 187.5,
      changePercent: 2.34,
      rsi14: 62,
      source: "E*TRADE live",
      technicals: {
        rsi14: 62,
        macdLine: 1.1,
        macdSignalLine: 0.9,
        macdHistogram: 0.2,
        macdSignal: "bullish",
        gapPercent: 1.25,
        gapDirection: "up",
        historyBars: 40,
        historySource: "yahoo",
      },
    },
    {
      symbol: "XYZ",
      companyName: "XYZ Holdings",
      signal: "neutral",
      momentumScore: 40,
      lastPrice: 12.5,
      changePercent: 0,
      rsi14: null,
      source: "E*TRADE live",
    },
  ],
};

const PARTIAL_RUN: ScreenerResultData = {
  ...RUN,
  timestamp: "2026-10-20T13:50:00.000Z",
  totalScanned: 47,
  matchedCount: 5,
  partial: {
    quotedCount: 47,
    requestedCount: 100,
    failedSymbols: ["XYZ"],
    failureReasons: { other: 53 },
  },
};

const QUIET_RUN: ScreenerResultData = {
  ...RUN,
  timestamp: "2026-10-20T13:40:00.000Z",
  matchedCount: 0,
  opportunities: [],
  allStocks: [],
};

describe("csvEscape (#125 PR-B)", () => {
  it("passes plain values through and empties null/undefined", () => {
    expect(csvEscape("NVDA")).toBe("NVDA");
    expect(csvEscape(187.5)).toBe("187.5");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  it("quotes fields carrying commas, quotes, or newlines and doubles quotes", () => {
    expect(csvEscape('Acme, Inc')).toBe('"Acme, Inc"');
    expect(csvEscape('Say "Holdings" Co')).toBe('"Say ""Holdings"" Co"');
    expect(csvEscape("Line1\nLine2")).toBe('"Line1\nLine2"');
  });
});

describe("screenStandoutsCsv (#125 PR-B)", () => {
  it("mirrors the view's standout columns and values", () => {
    const lines = screenStandoutsCsv(RUN).split("\r\n");
    const header = lines.find((l) => l.startsWith("symbol,"));
    expect(header).toBe(
      "symbol,company,sentiment,screenScore,quantRating,valueGrade,momentumGrade,lastPrice,changePercent,gapPercent,rangeZone,valueZone",
    );
    const rowIdx = lines.indexOf(header!);
    expect(lines[rowIdx + 1]).toBe(
      "NVDA,NVIDIA Corporation,very_bullish,88,Strong Buy,B,A,187.5,2.34,1.25,overbought,fair",
    );
    // Unenriched rows export empty metric cells, never invented values.
    expect(lines[rowIdx + 2]).toBe("PLTR,Palantir Technologies,,,,,,160,-1.05,,,");
  });

  it("escapes company names carrying commas and quotes", () => {
    const tricky: ScreenerResultData = {
      ...RUN,
      opportunities: [
        { ...RUN.opportunities[0], companyName: 'Acme, "Global"\nHoldings' },
      ],
    };
    const csv = screenStandoutsCsv(tricky);
    expect(csv).toContain('"Acme, ""Global""\nHoldings"');
  });

  it("carries run metadata as leading comment lines, with no sector claim for ALL", () => {
    const lines = screenStandoutsCsv(RUN).split("\r\n");
    expect(lines[0]).toBe("# cfagent market screen results — standouts");
    expect(lines[1]).toContain("# run: 2026-10-20T13:55:00.000Z");
    expect(lines[1]).toContain("trigger: scheduled");
    expect(lines[1]).toContain("sector: Technology");
    expect(lines[2]).toBe("# scanned: 100 · matched: 12 · standouts: 2");

    const allSector = screenStandoutsCsv({ ...RUN, sector: "ALL" });
    expect(allSector.split("\r\n")[1]).not.toContain("sector:");
  });

  it("an empty standout set yields metadata + header and no data rows", () => {
    const csv = screenStandoutsCsv(QUIET_RUN);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain("standouts: 0");
    expect(lines[3]).toContain("symbol,company,sentiment");
  });

  it("a partial run's qualification is visible in the CSV metadata", () => {
    const csv = screenStandoutsCsv(PARTIAL_RUN);
    const partialLine = csv.split("\r\n").find((l) => l.startsWith("# PARTIAL RUN:"));
    expect(partialLine).toBeDefined();
    expect(partialLine).toContain("47 of 100 symbols quoted");
    expect(partialLine).toContain("other=53");
    expect(partialLine).toContain("quoted subset only");
    // Clean runs carry no partial line.
    expect(screenStandoutsCsv(RUN)).not.toContain("PARTIAL RUN");
  });
});

describe("screenAllStocksCsv (#125 PR-B)", () => {
  it("mirrors the view's all-screened columns, incl. RSI/MACD/source", () => {
    const lines = screenAllStocksCsv(RUN).split("\r\n");
    const header = lines.find((l) => l.startsWith("symbol,"));
    expect(header).toBe(
      "symbol,company,lastPrice,changePercent,gapPercent,sentiment,screenScore,quantRating,valueGrade,momentumGrade,momentumScore,rangeZone,valueZone,rsi14,macdHistogram,source",
    );
    const rowIdx = lines.indexOf(header!);
    // The fixture's NVDA scanned row carries technicals but no indicator
    // enrichment — those cells are empty, the measured fields are not.
    expect(lines[rowIdx + 1]).toBe(
      "NVDA,NVIDIA Corporation,187.5,2.34,1.25,,,,,,91,,,62,0.2,E*TRADE live",
    );
    // rsi14 null exports as an empty cell, never a faked number.
    expect(lines[rowIdx + 2]).toBe("XYZ,XYZ Holdings,12.5,0,,,,,,,40,,,,,E*TRADE live");
    expect(lines[0]).toBe("# cfagent market screen results — all screened symbols");
  });

  it("a run without allStocks yields metadata + header only", () => {
    const { allStocks: _dropped, ...noStocks } = RUN;
    const lines = screenAllStocksCsv(noStocks).trimEnd().split("\r\n");
    expect(lines).toHaveLength(4);
  });
});

describe("screenRunJson (#125 PR-B)", () => {
  it("round-trips the full run object exactly as stored", () => {
    expect(JSON.parse(screenRunJson(RUN))).toEqual(RUN);
  });

  it("preserves the partial qualification marker", () => {
    const parsed = JSON.parse(screenRunJson(PARTIAL_RUN));
    expect(parsed.partial).toEqual(PARTIAL_RUN.partial);
  });
});

describe("screenExportFilename (#125 PR-B)", () => {
  it("identifies the run: UTC date-time stamp + sector scope + set", () => {
    expect(screenExportFilename(RUN, "standouts")).toBe("screen-20261020-135500-technology-standouts.csv");
    expect(screenExportFilename(RUN, "all-stocks")).toBe("screen-20261020-135500-technology-all-stocks.csv");
    expect(screenExportFilename(RUN, "run-json")).toBe("screen-20261020-135500-technology.json");
  });

  it("makes no scope claim when no sector was selected", () => {
    expect(screenExportFilename({ ...RUN, sector: "ALL" }, "standouts")).toBe(
      "screen-20261020-135500-standouts.csv",
    );
  });

  it("differs across runs and across sets of the same run", () => {
    const names = new Set([
      screenExportFilename(RUN, "standouts"),
      screenExportFilename(RUN, "all-stocks"),
      screenExportFilename(RUN, "run-json"),
      screenExportFilename(PARTIAL_RUN, "standouts"),
      screenExportFilename(QUIET_RUN, "standouts"),
    ]);
    expect(names.size).toBe(5);
  });
});
