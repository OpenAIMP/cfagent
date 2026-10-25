/**
 * Issue #1195 (#1173 R3b): the options XLSX generator.
 * Pins: the workbook parses with both tabs; the contracts tab has
 * one row per contract with greeks/IV carried; the summary tab
 * records counts + data source + warnings; an empty result still
 * produces a valid workbook (never throws).
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import {
  generateOptionsXlsx,
  optionsXlsxFileName,
  parseOptionsXlsx,
} from "../src/trading/optionsReportXlsx";
import type { OptionScreenResult } from "../src/types";

function fixture(contracts: OptionScreenResult["contracts"]): OptionScreenResult {
  return {
    totalUnderlyingsScanned: 3,
    totalContractsEvaluated: 120,
    matchedCount: contracts.length,
    totalMatches: contracts.length,
    rejectionCount: 118,
    filterApplied: {} as OptionScreenResult["filterApplied"],
    filterSummary: "DTE 7-45 · delta 0.2-0.6",
    contracts,
    scannedAt: "2026-10-23T09:05:29Z",
    dataSource: "live",
    quoteQuality: { staleContractsReturned: 1, unknownFreshnessContracts: 0 },
    status: "matches_found",
    warnings: ["One underlying returned a stale chain."],
  };
}

const contract = {
  symbol: "AAPL  261024C00250000",
  underlyingSymbol: "AAPL",
  underlyingPrice: 248.1,
  daysToExpiration: 21,
  expirationDate: "2026-11-13",
  moneyness: "OTM" as const,
  strikeDistancePct: 0.8,
  spreadPct: 2.1,
  optionType: "CALL",
  strikePrice: 250,
  bid: 3.1,
  ask: 3.3,
  volume: 5400,
  openInterest: 21000,
  volumeOiRatio: 0.26,
  impliedVolatility: 0.284,
  delta: 0.42,
  gamma: 0.03,
  theta: -0.05,
  vega: 0.12,
  quoteFreshness: "FRESH" as const,
  technicalSignal: "bullish",
  highlightReason: "Unusual volume",
} as unknown as OptionScreenResult["contracts"][number];

function sheetRows(wb: XLSX.WorkBook, name: string): Array<Record<string, unknown>> {
  const ws = wb.Sheets[name];
  expect(ws, `sheet ${name}`).toBeDefined();
  return XLSX.utils.sheet_to_json(ws) as Array<Record<string, unknown>>;
}

describe("generateOptionsXlsx", () => {
  it("produces both tabs with one row per contract and greeks carried", () => {
    const bytes = generateOptionsXlsx(fixture([contract, contract]));
    const wb = parseOptionsXlsx(bytes);
    expect(wb.SheetNames).toEqual(["Screened Contracts", "Run Summary & Methodology"]);
    const rows = sheetRows(wb, "Screened Contracts");
    expect(rows).toHaveLength(2);
    expect(rows[0]["Underlying"]).toBe("AAPL");
    expect(rows[0]["Strike"]).toBe(250);
    expect(rows[0]["IV %"]).toBe(28.4);
    expect(rows[0]["Delta"]).toBe(0.42);
    expect(rows[0]["Highlight"]).toBe("Unusual volume");
  });

  it("the summary tab records counts, data source, and warnings", () => {
    const wb = parseOptionsXlsx(generateOptionsXlsx(fixture([contract])));
    const rows = sheetRows(wb, "Run Summary & Methodology");
    const byField = new Map(rows.map((r) => [String(r["Field"]), String(r["Value"])]));
    expect(byField.get("Underlyings scanned")).toBe("3");
    expect(byField.get("Contracts evaluated")).toBe("120");
    expect(byField.get("Contracts matched")).toBe("1");
    expect(byField.get("Data source")).toBe("live");
    expect(byField.get("Warning 1")).toContain("stale chain");
    expect(byField.get("Methodology")).toContain("E*TRADE");
  });

  it("an empty result still yields a valid workbook", () => {
    const wb = parseOptionsXlsx(generateOptionsXlsx(fixture([])));
    expect(wb.SheetNames).toHaveLength(2);
    const rows = sheetRows(wb, "Screened Contracts");
    expect(rows).toHaveLength(1);
    expect(String(rows[0]["Underlying"])).toContain("no contracts");
  });

  it("file name is dated from scannedAt", () => {
    expect(optionsXlsxFileName({ scannedAt: "2026-10-23T09:05:29Z" })).toBe("options-report-2026-10-23.xlsx");
  });
});
