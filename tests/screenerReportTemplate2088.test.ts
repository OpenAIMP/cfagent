/**
 * Issue #2088: full-fidelity PDF report template.
 *
 * Pins (TDD red first):
 *  - one 16-column projection, in XLSX/CSV column order, with the
 *    CSV/XLSX value mapping and fallbacks (sector Unknown, P/E
 *    blank, signal "-", source default) — no third mapping;
 *  - one sort: screenScore desc, symbol asc tiebreak, null scores last;
 *  - sections as filter + limit over one sorted list (gap up, gap
 *    down, standouts, all symbols), with shown/total counts;
 *  - section config: defaults gapUps 8 / gapDowns 8 / standouts all /
 *    allSymbols all, env overrides, "all" = unlimited, invalid = default;
 *  - Formulas & Methodology appendix rows mirror the XLSX tab-2
 *    fields in tab order;
 *  - cell wrapping never truncates: wrapped lines rejoin to the
 *    input, and every line fits its column width.
 */
import { describe, it, expect } from "vitest";
import {
  SCREENER_PDF_COLUMNS,
  projectScreenerPdfRow,
  sortScreenerPdfRows,
  buildScreenerPdfSections,
  resolveScreenerPdfSectionConfig,
  projectFormulaAppendixRows,
  wrapCellText,
  type ScreenerPdfRowInput,
} from "../src/trading/screenerReportTemplate";

function stock(over: Partial<ScreenerPdfRowInput> = {}): ScreenerPdfRowInput {
  return {
    symbol: "NVDA",
    companyName: "NVIDIA Corporation",
    sector: "Technology",
    lastPrice: 217.94,
    changePercent: 0.9,
    technicals: { gapPercent: 1.1, gapDirection: "up", rsi14: 46.3, macdHistogram: -0.5 },
    indicators: { sentiment: "bullish", screenScore: 61 },
    factorGrades: { quantRating: "Hold", value: "B-", momentum: "C+" },
    peRatio: 42.7,
    signal: "BULLISH_MOMENTUM",
    source: "E*TRADE live",
    ...over,
  } as ScreenerPdfRowInput;
}

describe("projection", () => {
  it("has 16 columns in XLSX/CSV order", () => {
    expect(SCREENER_PDF_COLUMNS.map((c) => c.header)).toEqual([
      "Symbol",
      "Company",
      "Sector",
      "Price",
      "Chg%",
      "Gap%",
      "Sentiment",
      "Quant",
      "Val",
      "Mom",
      "RSI",
      "MACD",
      "Score",
      "P/E",
      "Signal",
      "Source",
    ]);
    expect(SCREENER_PDF_COLUMNS.reduce((sum, c) => sum + c.w, 0)).toBe(720);
  });

  it("projects every field with the CSV/XLSX fallbacks", () => {
    const cells = projectScreenerPdfRow(stock());
    expect(cells).toEqual([
      "NVDA",
      "NVIDIA Corporation",
      "Technology",
      "$217.94",
      "+0.9%",
      "+1.1%",
      "bullish",
      "Hold",
      "B-",
      "C+",
      "46.3",
      "-0.5",
      "61",
      "42.7",
      "BULLISH_MOMENTUM",
      "E*TRADE live",
    ]);
  });

  it("applies the fallbacks: sector Unknown, P/E blank, signal dash, source default", () => {
    const cells = projectScreenerPdfRow(
      stock({ sector: undefined, peRatio: undefined, signal: undefined, source: undefined })
    );
    expect(cells[2]).toBe("Unknown");
    expect(cells[13]).toBe("-");
    expect(cells[14]).toBe("-");
    expect(cells[15]).toBe("E*TRADE live");
  });

  it("never slices a long company name or sentiment", () => {
    const cells = projectScreenerPdfRow(
      stock({
        companyName: "International Business Machines Corporation",
        indicators: { sentiment: "very_bearish", screenScore: 40 },
      })
    );
    expect(cells[1]).toBe("International Business Machines Corporation");
    expect(cells[6]).toBe("very bearish");
  });
});

describe("sort", () => {
  it("sorts screenScore desc, symbol asc on ties, null scores last", () => {
    const rows = sortScreenerPdfRows([
      stock({ symbol: "ZZZZ", indicators: { sentiment: "neutral", screenScore: 61 } }),
      stock({ symbol: "AAAA", indicators: { sentiment: "neutral", screenScore: 61 } }),
      stock({ symbol: "MMMM", indicators: { sentiment: "neutral", screenScore: 90 } }),
      stock({ symbol: "NNNN", indicators: { sentiment: "neutral", screenScore: null } }),
    ]);
    expect(rows.map((r) => r.symbol)).toEqual(["MMMM", "AAAA", "ZZZZ", "NNNN"]);
  });
});

describe("sections", () => {
  function result() {
    return {
      allStocks: [
        stock({ symbol: "UP1", technicals: { gapPercent: 3.1, gapDirection: "up", rsi14: 50, macdHistogram: 0.2 }, indicators: { sentiment: "bullish", screenScore: 70 } }),
        stock({ symbol: "UP2", technicals: { gapPercent: 1.2, gapDirection: "up", rsi14: 55, macdHistogram: 0.1 }, indicators: { sentiment: "bullish", screenScore: 80 } }),
        stock({ symbol: "DN1", technicals: { gapPercent: -1.7, gapDirection: "down", rsi14: 40, macdHistogram: -0.3 }, indicators: { sentiment: "bearish", screenScore: 30 } }),
        stock({ symbol: "FLAT", technicals: { gapPercent: null, gapDirection: null, rsi14: 45, macdHistogram: 0 }, indicators: { sentiment: "neutral", screenScore: 50 } }),
      ],
      opportunities: [
        stock({ symbol: "UP2", technicals: { gapPercent: 1.2, gapDirection: "up", rsi14: 55, macdHistogram: 0.1 }, indicators: { sentiment: "bullish", screenScore: 80 } }),
      ],
    };
  }

  it("splits gaps by direction with separate caps (no combined crowding)", () => {
    const sections = buildScreenerPdfSections(result() as any, { gapUps: 1, gapDowns: 1, standouts: null, allSymbols: null });
    const up = sections.find((s) => s.key === "gapUp")!;
    const down = sections.find((s) => s.key === "gapDown")!;
    expect(up.rows.map((r) => r[0])).toEqual(["UP2"]);
    expect(up.shown).toBe(1);
    expect(up.total).toBe(2);
    expect(down.rows.map((r) => r[0])).toEqual(["DN1"]);
  });

  it("sorts every section by score and keeps standouts selection unchanged", () => {
    const sections = buildScreenerPdfSections(result() as any, { gapUps: null, gapDowns: null, standouts: null, allSymbols: null });
    const all = sections.find((s) => s.key === "allSymbols")!;
    expect(all.rows.map((r) => r[0])).toEqual(["UP2", "UP1", "FLAT", "DN1"]);
    const st = sections.find((s) => s.key === "standouts")!;
    expect(st.rows.map((r) => r[0])).toEqual(["UP2"]);
  });

  it("falls back to opportunities when allStocks is empty (CSV/XLSX rule)", () => {
    const sections = buildScreenerPdfSections({ allStocks: [], opportunities: [stock()] } as any, {
      gapUps: null, gapDowns: null, standouts: null, allSymbols: null,
    });
    expect(sections.find((s) => s.key === "allSymbols")!.rows).toHaveLength(1);
  });
});

describe("config", () => {
  it("defaults to gapUps 8, gapDowns 8, standouts all, allSymbols all", () => {
    expect(resolveScreenerPdfSectionConfig({})).toEqual({
      gapUps: 8, gapDowns: 8, standouts: null, allSymbols: null,
    });
  });

  it("applies env overrides; 'all' means unlimited; invalid means default", () => {
    expect(
      resolveScreenerPdfSectionConfig({
        SCREENER_PDF_GAP_UPS: "3",
        SCREENER_PDF_GAP_DOWNS: "all",
        SCREENER_PDF_STANDOUTS: "5",
        SCREENER_PDF_ALL_SYMBOLS: "bogus",
      })
    ).toEqual({ gapUps: 3, gapDowns: null, standouts: 5, allSymbols: null });
  });
});

describe("appendix", () => {
  it("mirrors the XLSX Formulas & Methodology tab fields in order", () => {
    const rows = projectFormulaAppendixRows([
      { columnName: "Score", fieldKey: "screenScore", provenance: "Computed", formula: "50 + ...", description: "Composite" },
    ] as any);
    expect(rows).toEqual([["Score", "screenScore", "Computed", "50 + ...", "Composite"]]);
  });
});

describe("wrapping", () => {
  it("wraps without truncating: lines rejoin to the input and fit the width", () => {
    const lines = wrapCellText("International Business Machines Corporation", 60, (t: string) => t.length * 4);
    expect(lines.join(" ")).toBe("International Business Machines Corporation");
    for (const line of lines) expect(line.length * 4).toBeLessThanOrEqual(60);
    expect(lines.length).toBeGreaterThan(1);
  });
});
