import { describe, expect, it } from "vitest";
import type { ScreenedOptionContractItem } from "../src/types";
import { recommendOptionStrategies, type StrategyRequest } from "../src/trading/options/strategyEngine";
import {
  buildNamesByStrategyRows,
  buildStrategiesByNameRows,
  buildStrategyCoverage,
} from "../src/trading/optionsReportMatrix";
import type { ScanMatrixRow, ScanTypeRollup } from "../src/trading/options/opportunityScanner";

const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const expiryDate = expiry.toISOString().slice(0, 10);

function makeContracts(): ScreenedOptionContractItem[] {
  const quoteTimestamp = Date.now();
  return [90, 95, 100, 105, 110].flatMap((strike) => {
    const timeValue = Math.max(0.3, 3 - Math.abs(strike - 100) * 0.12);
    const callMid = Math.max(0.3, Math.max(100 - strike, 0) + timeValue);
    const putMid = Math.max(0.3, Math.max(strike - 100, 0) + timeValue);
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (100 - strike) / 40));
    const base = {
      underlyingSymbol: "XYZ",
      underlyingPrice: 100,
      daysToExpiration: 30,
      expirationDate: expiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: Math.abs(strike - 100),
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(quoteTimestamp).toISOString(),
      quoteFreshness: "FRESH" as const,
      bidSize: 10,
      askSize: 10,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      spreadOi: undefined,
      technicalSignal: "Test fixture",
      highlightReason: "Test fixture",
      volumeOiRatio: 0.5,
    };
    return [
      { ...base, optionType: "CALL" as const, symbol: `XYZ${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: `XYZ${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
}

function request(overrides: Partial<StrategyRequest> = {}): StrategyRequest {
  return {
    symbol: "XYZ",
    thesis: "bullish",
    targetPrice: 110,
    targetDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 1_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "long_put"],
    ...overrides,
  };
}

function cell(strategyType: string, passed: number, bestComposite: number | null, bestLabel?: string): ScanMatrixRow["cells"][number] {
  return {
    strategyType,
    best: bestComposite === null ? null : {
      candidateId: `${strategyType}-1`, label: bestLabel ?? strategyType, compositeScore: bestComposite,
      score: 70, expirationDate: expiryDate, legs: [], netDebit: 1, maxLoss: 100,
      maxProfit: 200, maxProfitUnbounded: false, targetRewardRisk: 2, probabilityOfProfit: 0.6,
    },
    evaluatedCount: passed + 1,
    passedCount: passed,
    rejectedCount: 1,
    rejectionReasons: { "test reason": 1 },
  };
}

function matrixRow(symbol: string, cells: ScanMatrixRow["cells"], gateBucket: ScanMatrixRow["gateBucket"] = "fit"): ScanMatrixRow {
  return {
    symbol, verdict: "pass", targetPrice: 100, targetSource: "test",
    targetEmUnits: 1, cells, gateBucket, gateReasons: [],
  };
}

describe("All-strategy evaluation (#2091)", () => {
  it("thesis scope still skips a thesis-conflicting strategy", () => {
    const result = recommendOptionStrategies(makeContracts(), request());
    const longPut = result.evaluations.find((e) => e.id === "long_put");
    expect(longPut).toBeDefined();
    expect(longPut!.status).toBe("skipped");
    expect(longPut!.summary).toMatch(/bullish/);
  });

  it("all scope evaluates a thesis-conflicting strategy instead of skipping it", () => {
    const result = recommendOptionStrategies(makeContracts(), request({ evaluateAllStrategies: true }));
    const longPut = result.evaluations.find((e) => e.id === "long_put");
    expect(longPut).toBeDefined();
    expect(longPut!.status).not.toBe("skipped");
    expect(longPut!.summary).not.toMatch(/conflicts with/);
    expect(longPut!.generated).toBeGreaterThan(0);
  });

  it("builds the strategies-by-name rows from matrix cells", () => {
    const matrix = [
      matrixRow("NVDA", [cell("long_call", 2, 88, "Long Call"), cell("long_put", 0, null)]),
      matrixRow("AAPL", [cell("long_call", 1, 71, "Long Call")]),
    ];
    const rows = buildStrategiesByNameRows(matrix);
    expect(rows).toHaveLength(2);
    expect(rows[0].symbol).toBe("NVDA");
    expect(rows[0].passing.map((p) => p.strategyType)).toEqual(["long_call"]);
    expect(rows[0].passing[0].bestComposite).toBe(88);
    expect(rows[1].passing.map((p) => p.strategyType)).toEqual(["long_call"]);
  });

  it("builds the names-by-strategy rows from the rollup", () => {
    const rollup: ScanTypeRollup[] = [
      {
        strategyType: "long_call", symbolsEvaluated: 2, symbolsPassed: 2,
        evaluatedCount: 3, passedCount: 3, rejectedCount: 1, rejectionReasons: {},
        bestOverall: { symbol: "NVDA", candidateId: "x", label: "Long Call", compositeScore: 88, score: 70, expirationDate: expiryDate, legs: [], netDebit: 1, maxLoss: 100, maxProfit: 200, maxProfitUnbounded: false, targetRewardRisk: 2, probabilityOfProfit: 0.6 },
      },
    ];
    const rows = buildNamesByStrategyRows(rollup);
    expect(rows).toHaveLength(1);
    expect(rows[0].bestSymbol).toBe("NVDA");
    expect(rows[0].symbolsPassed).toBe(2);
  });

  it("coverage names horizon-skipped strategies instead of dropping them", () => {
    const matrix = [matrixRow("NVDA", [cell("long_call", 1, 80)])];
    const coverage = buildStrategyCoverage(matrix, ["long_call", "leaps_call"], 45);
    expect(coverage.evaluatedStrategyIds).toEqual(["long_call"]);
    const skipped = coverage.notEvaluated.find((n) => n.id === "leaps_call");
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toMatch(/expir|horizon/i);
  });

  it("coverage reports a built-no-candidate strategy without a horizon claim", () => {
    const matrix = [matrixRow("NVDA", [cell("long_call", 1, 80)])];
    const coverage = buildStrategyCoverage(matrix, ["long_call", "short_put"], 45);
    const skipped = coverage.notEvaluated.find((n) => n.id === "short_put");
    expect(skipped).toBeDefined();
    expect(skipped!.reason).not.toMatch(/expir|horizon/i);
  });
});
