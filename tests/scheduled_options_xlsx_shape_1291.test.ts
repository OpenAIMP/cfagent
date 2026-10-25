/**
 * Issue #1291 (R3b follow-up): the scheduled path feeds the options
 * workbook generator an OpportunityScanResult, but generateOptionsXlsx
 * reads the OptionScreenResult shape — so scheduled workbooks rendered
 * "(no contracts matched)" and empty summary fields on good runs.
 *
 * Pins: the scheduled-seam adapter maps opportunity rows to populated
 * contracts-tab rows + summary counts (coverage/scanned/generatedAt),
 * status from withTrades, and the R6 partial qualification as the
 * Coverage row; a manual-shaped result passes through unchanged.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";
import {
  adaptOpportunityScanToOptionScreenResult,
  generateOptionsXlsx,
  optionsXlsxFileName,
  parseOptionsXlsx,
} from "../src/trading/optionsReportXlsx";
import type { OpportunityScanResult } from "../src/trading/options/opportunityScanner";
import type { OptionScreenResult } from "../src/types";

function leg(over: Record<string, unknown> = {}) {
  return {
    symbol: "AAPL  261024C00250000",
    optionType: "CALL",
    side: "BUY",
    quantity: 1,
    strike: 250,
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
    ...over,
  };
}

function scheduledScan(): OpportunityScanResult {
  return {
    scanned: 4,
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
          best: {
            candidate: {
              id: "bull-call-spread",
              rank: 1,
              type: "BULL_CALL_SPREAD",
              label: "Bull Call Spread",
              symbol: "AAPL",
              underlyingPrice: 248.1,
              expirationDate: "2026-11-13",
              dataFreshness: "FRESH",
              legs: [leg()],
              netDebit: 3.2,
              estimatedFees: 1.3,
              maxProfit: 680,
              maxProfitUnbounded: false,
              maxLoss: 320,
              breakevens: [253.2],
              targetPnl: 680,
              targetRewardRisk: 2.1,
              modelImpliedProbabilityOfProfit: 0.55,
              netGreeks: { delta: 0.42, gamma: 0.03, theta: -0.05, vega: 0.12 },
              liquidityScore: 90,
              score: 87,
              scoreBreakdown: {},
              payoffCurve: [],
              scenarios: [],
              explanations: [],
              warnings: [],
              assumptions: [],
            },
            rank: 1,
            compositeScore: 87,
            components: {},
          },
          alternatives: [],
          rationale: [],
          blockers: [],
          humanApprovalRequired: true,
          disclaimer: "",
        },
        score: 87,
        gateBucket: "fit",
        gateReasons: [],
      },
      {
        symbol: "MSFT",
        underlyingPrice: 510.4,
        targetPrice: 530,
        targetSource: "model",
        targetEmUnits: 0.5,
        pick: {
          status: "recommended",
          riskProfile: "balanced",
          confidence: "MEDIUM",
          best: {
            candidate: {
              id: "bull-put-spread",
              rank: 1,
              type: "BULL_PUT_SPREAD",
              label: "Bull Put Spread",
              symbol: "MSFT",
              underlyingPrice: 510.4,
              expirationDate: "2026-11-13",
              dataFreshness: "FRESH",
              legs: [
                leg({
                  symbol: "MSFT  261024P00500000",
                  optionType: "PUT",
                  strike: 500,
                  bid: 2.1,
                  ask: 2.3,
                  entryPrice: 2.2,
                  impliedVolatility: 0.24,
                  delta: -0.3,
                }),
              ],
              netDebit: 2.2,
              estimatedFees: 1.3,
              maxProfit: 780,
              maxProfitUnbounded: false,
              maxLoss: 220,
              breakevens: [497.8],
              targetPnl: 780,
              targetRewardRisk: 3.5,
              modelImpliedProbabilityOfProfit: 0.6,
              netGreeks: { delta: -0.3, gamma: 0.02, theta: -0.04, vega: 0.1 },
              liquidityScore: 88,
              score: 82,
              scoreBreakdown: {},
              payoffCurve: [],
              scenarios: [],
              explanations: [],
              warnings: [],
              assumptions: [],
            },
            rank: 1,
            compositeScore: 82,
            components: {},
          },
          alternatives: [],
          rationale: [],
          blockers: [],
          humanApprovalRequired: true,
          disclaimer: "",
        },
        score: 82,
        gateBucket: "borderline",
        gateReasons: ["confidence"],
      },
      {
        // No best pick: no contract row for this name.
        symbol: "NVDA",
        underlyingPrice: 180.2,
        targetPrice: 190,
        targetSource: "model",
        targetEmUnits: 0.4,
        pick: {
          status: "no_trade",
          riskProfile: "balanced",
          confidence: "LOW",
          alternatives: [],
          rationale: ["No qualifying strategy"],
          blockers: [],
          humanApprovalRequired: true,
          disclaimer: "",
        },
        score: 0,
        gateBucket: "no_fit",
        gateReasons: ["No qualifying strategy"],
      },
    ],
    skipped: [{ symbol: "TSLA", reason: "Chain fetch failed" }],
    truncatedSymbols: 1,
    assumptions: ["Targets scoped to the stated thesis."],
    matrix: [],
    typeRollup: [],
    mode: "per_name_best",
    fits: [],
    fitsTotal: 0,
    gate: { fit: 1, borderline: 1, noFit: 1 },
    borderline: [],
    gateParams: {},
    profileRef: null,
    generatedAt: "2026-10-24T09:05:29Z",
    modelVersion: "1.2.0",
    requestSnapshot: {
      template: {
        thesis: "BULLISH",
        targetDate: "2026-11-13",
        maxPlannedLoss: 500,
        minRewardRisk: 2,
        allowedStrategies: [],
      },
      mode: "per_name_best",
      riskProfile: "balanced",
      profile: null,
    },
    configSnapshot: { maxScanSymbols: 20, targetFactors: {}, targetEmMultiples: {} },
    coverage: {
      considered: 5,
      scanned: 4,
      truncated: 1,
      evaluated: 3,
      errors: 1,
      withTrades: 2,
      eventCalendar: { covered: 4, total: 4, coveragePct: 100 },
    },
    partial: {
      evaluatedCount: 3,
      consideredCount: 5,
      coverageErrors: 1,
      truncatedCount: 1,
      topSkipReason: "Chain fetch failed",
      topSkipCount: 1,
    },
  } as unknown as OpportunityScanResult;
}

function sheetRows(wb: XLSX.WorkBook, name: string): Array<Record<string, unknown>> {
  const ws = wb.Sheets[name];
  expect(ws, `sheet ${name}`).toBeDefined();
  return XLSX.utils.sheet_to_json(ws) as Array<Record<string, unknown>>;
}

function summaryByField(wb: XLSX.WorkBook): Map<string, string> {
  const rows = sheetRows(wb, "Run Summary & Methodology");
  return new Map(rows.map((r) => [String(r["Field"]), String(r["Value"])]));
}

describe("adaptOpportunityScanToOptionScreenResult (#1291)", () => {
  it("maps opportunity rows to populated contracts-tab rows", () => {
    const adapted = adaptOpportunityScanToOptionScreenResult(scheduledScan());
    const wb = parseOptionsXlsx(generateOptionsXlsx(adapted));
    const rows = sheetRows(wb, "Screened Contracts");
    expect(rows).toHaveLength(2);
    expect(rows[0]["Underlying"]).toBe("AAPL");
    expect(rows[0]["Strike"]).toBe(250);
    expect(rows[0]["IV %"]).toBe(28.4);
    expect(rows[0]["Delta"]).toBe(0.42);
    expect(String(rows[0]["Highlight"])).toContain("Bull Call Spread");
    expect(rows[1]["Underlying"]).toBe("MSFT");
    expect(rows[1]["Type"]).toBe("PUT");
  });

  it("fills the summary from coverage/scanned/generatedAt with status + Coverage row", () => {
    const adapted = adaptOpportunityScanToOptionScreenResult(scheduledScan());
    const byField = summaryByField(parseOptionsXlsx(generateOptionsXlsx(adapted)));
    expect(byField.get("Scanned at")).toBe("2026-10-24T09:05:29Z");
    expect(byField.get("Underlyings scanned")).toBe("4");
    expect(byField.get("Contracts evaluated")).toBe("3");
    expect(byField.get("Contracts matched")).toBe("2");
    expect(byField.get("Status")).toBe("matches_found");
    expect(byField.get("Filter summary")).toContain("BULLISH");
    expect(byField.get("Warning 1")).toContain("Targets scoped");
    const coverage = byField.get("Coverage") ?? "";
    expect(coverage).toContain("3 of 5");
    expect(coverage).toContain("1 quote/chain failures");
    expect(coverage).toContain("1 truncated");
    expect(optionsXlsxFileName(adapted)).toBe("options-report-2026-10-24.xlsx");
  });

  it("an empty scheduled scan yields the no-contracts row, no_matches, and no Coverage row", () => {
    const scan = scheduledScan();
    (scan as unknown as { opportunities: unknown[] }).opportunities = [];
    (scan as unknown as { withTrades: number }).withTrades = 0;
    delete (scan as unknown as { partial?: unknown }).partial;
    const adapted = adaptOpportunityScanToOptionScreenResult(scan);
    const wb = parseOptionsXlsx(generateOptionsXlsx(adapted));
    const rows = sheetRows(wb, "Screened Contracts");
    expect(rows).toHaveLength(1);
    expect(String(rows[0]["Underlying"])).toContain("no contracts");
    const byField = summaryByField(wb);
    expect(byField.get("Status")).toBe("no_matches");
    expect(byField.has("Coverage")).toBe(false);
  });

  it("a manual-shaped result passes through unchanged", () => {
    const manual = {
      totalUnderlyingsScanned: 3,
      totalContractsEvaluated: 120,
      matchedCount: 1,
      filterApplied: {},
      filterSummary: "DTE 7-45",
      contracts: [{ symbol: "AAPL", underlyingSymbol: "AAPL" }],
      scannedAt: "2026-10-23T09:05:29Z",
      status: "matches_found",
    } as unknown as OptionScreenResult;
    expect(adaptOpportunityScanToOptionScreenResult(manual as never)).toBe(manual);
  });
});
