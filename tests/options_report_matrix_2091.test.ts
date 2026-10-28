import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import { generateOptionsPdf } from "../src/trading/optionsReportPdf";
import {
  adaptOpportunityScanToOptionScreenResult,
  generateOptionsXlsx,
  parseOptionsXlsx,
} from "../src/trading/optionsReportXlsx";
import { generateOptionsCsv } from "../src/trading/screenerReportCsv";
import type { ScanMatrixRow } from "../src/trading/options/opportunityScanner";

const expiryDate = "2026-11-27";

function cell(strategyType: string, passed: number, bestComposite: number | null): ScanMatrixRow["cells"][number] {
  return {
    strategyType,
    best: bestComposite === null ? null : {
      candidateId: `${strategyType}-1`, label: strategyType, compositeScore: bestComposite,
      score: 70, expirationDate: expiryDate, legs: [], netDebit: 1, maxLoss: 100,
      maxProfit: 200, maxProfitUnbounded: false, targetRewardRisk: 2, probabilityOfProfit: 0.6,
    },
    evaluatedCount: passed + 1,
    passedCount: passed,
    rejectedCount: 1,
    rejectionReasons: {},
  };
}

function matrixRow(symbol: string, cells: ScanMatrixRow["cells"]): ScanMatrixRow {
  return {
    symbol, verdict: "pass", targetPrice: 100, targetSource: "test",
    targetEmUnits: 1, cells, gateBucket: "fit", gateReasons: [],
  };
}

function scanFixture(): Record<string, unknown> {
  const matrix = [
    matrixRow("NVDA", [cell("long_call", 2, 88), cell("long_put", 0, null)]),
    matrixRow("AAPL", [cell("long_call", 1, 71)]),
  ];
  return {
    scanned: 2,
    withTrades: 2,
    opportunities: [
      { symbol: "NVDA", underlyingPrice: 100, gateBucket: "fit", score: 88, pick: { best: { candidate: { type: "long_call", label: "Long Call", legs: [], score: 88 } } } },
    ],
    matrix,
    typeRollup: [
      {
        strategyType: "long_call", symbolsEvaluated: 2, symbolsPassed: 2,
        evaluatedCount: 3, passedCount: 3, rejectedCount: 1, rejectionReasons: {},
        bestOverall: { symbol: "NVDA", candidateId: "x", label: "Long Call", compositeScore: 88, score: 70, expirationDate: expiryDate, legs: [], netDebit: 1, maxLoss: 100, maxProfit: 200, maxProfitUnbounded: false, targetRewardRisk: 2, probabilityOfProfit: 0.6 },
      },
      {
        strategyType: "long_put", symbolsEvaluated: 1, symbolsPassed: 0,
        evaluatedCount: 1, passedCount: 0, rejectedCount: 1, rejectionReasons: {},
        bestOverall: null,
      },
    ],
    strategyCoverage: {
      scope: "all",
      evaluatedStrategyIds: ["long_call"],
      notEvaluated: [{ id: "leaps_call", label: "LEAPS Call", reason: "requires expiries beyond the fetched chain (catalog horizon 550 DTE > fetched 45 DTE)" }],
    },
    fetchedMaxDte: 45,
    generatedAt: "2026-10-28T12:00:00.000Z",
    thesis: "bullish",
    coverage: { considered: 2, scanned: 2, evaluated: 2, errors: 0, withTrades: 2, eventCalendar: { covered: 2, total: 2, coveragePct: 100 } },
    requestSnapshot: { template: { thesis: "bullish" } },
  };
}

function sheetRows(wb: XLSX.WorkBook, name: string): unknown[][] {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }) as unknown[][];
}

describe("Options report matrix sections (#2091)", () => {
  it("adapter carries matrix, rollup, and coverage through to the report result", () => {
    const adapted = adaptOpportunityScanToOptionScreenResult(scanFixture() as never);
    const anyAdapted = adapted as unknown as Record<string, unknown>;
    expect(Array.isArray(anyAdapted.matrix)).toBe(true);
    expect((anyAdapted.matrix as unknown[]).length).toBe(2);
    expect(Array.isArray(anyAdapted.typeRollup)).toBe(true);
    expect((anyAdapted.typeRollup as unknown[]).length).toBe(2);
    expect(anyAdapted.strategyCoverage).toBeDefined();
    expect(anyAdapted.fetchedMaxDte).toBe(45);
  });

  it("XLSX gains Strategies-by-Name and Names-by-Strategy tabs with full rows", () => {
    const adapted = adaptOpportunityScanToOptionScreenResult(scanFixture() as never);
    const bytes = generateOptionsXlsx(adapted);
    const wb = parseOptionsXlsx(bytes);
    expect(wb.SheetNames).toContain("Strategies by Name");
    expect(wb.SheetNames).toContain("Names by Strategy");
    const byName = sheetRows(wb, "Strategies by Name");
    expect(byName.length).toBeGreaterThan(1);
    expect(byName.flat().map(String).join(" ")).toMatch(/NVDA/);
    expect(byName.flat().map(String).join(" ")).toMatch(/long_call/);
    const byStrategy = sheetRows(wb, "Names by Strategy");
    expect(byStrategy.length).toBeGreaterThan(1);
    expect(byStrategy.flat().map(String).join(" ")).toMatch(/long_put/);
  });

  it("PDF with matrix data is a valid, larger document than without it", async () => {
    const withMatrix = await generateOptionsPdf(scanFixture() as never);
    const withoutMatrix = await generateOptionsPdf({
      totalUnderlyingsScanned: 2, totalContractsEvaluated: 10, matchedCount: 1,
      filterApplied: {}, filterSummary: "test", contracts: [], scannedAt: "2026-10-28T12:00:00.000Z",
      status: "matches_found",
    } as never);
    expect(Array.from(withMatrix.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(withMatrix.length).toBeGreaterThan(withoutMatrix.length);
  });

  it("CSV stays the contracts table (matrix views live in PDF + XLSX)", () => {
    const adapted = adaptOpportunityScanToOptionScreenResult(scanFixture() as never);
    const csv = generateOptionsCsv(adapted);
    expect(csv).not.toMatch(/Strategies by Name|Names by Strategy/);
  });
});
