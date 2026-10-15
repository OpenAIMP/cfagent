/**
 * Issue #35 (G2): correlation & diversification inputs.
 * Pins: measured correlation math (exact ±1 cases, observation floor),
 * the measured → proxy-sector → unknown provenance ladder, and the
 * concentration acceptance test — a candidate duplicating concentrated
 * exposure is flagged with the correlated positions named.
 */
import { describe, it, expect } from "vitest";
import { CorrelationService, computeCorrelationFromCloses, sectorOf } from "../src/services/correlationService";
import { assessPortfolioConcentration, type CorrelationEstimator } from "../src/services/portfolioConcentration";
import type { PortfolioRiskReport } from "../src/services/portfolioRisk";

const PATTERN = [0.01, -0.005, 0.02, -0.01, 0.004, -0.015, 0.008, 0.012, -0.002, 0.006];
function closes(returns: number[], mirror = 1): Map<string, number> {
  const map = new Map<string, number>();
  const day = new Date("2025-01-02T00:00:00Z");
  let price = 100;
  map.set(day.toISOString().split("T")[0], price);
  for (const r of returns) {
    day.setUTCDate(day.getUTCDate() + 1);
    price *= 1 + r * mirror;
    map.set(day.toISOString().split("T")[0], price);
  }
  return map;
}
const rets = (n: number) => Array.from({ length: n }, (_, i) => PATTERN[i % PATTERN.length]);

describe("computeCorrelationFromCloses", () => {
  it("identical series correlate at exactly 1, mirrored at exactly -1", () => {
    const a = closes(rets(120));
    expect(computeCorrelationFromCloses(a, closes(rets(120)))!.correlation).toBe(1);
    expect(computeCorrelationFromCloses(a, closes(rets(120), -1))!.correlation).toBe(-1);
  });

  it("refuses below the observation floor and on zero variance", () => {
    expect(computeCorrelationFromCloses(closes(rets(30)), closes(rets(30)))).toBeNull();
    const flat = closes(new Array(120).fill(0));
    expect(computeCorrelationFromCloses(closes(rets(120)), flat)).toBeNull();
  });
});

describe("CorrelationService provenance ladder", () => {
  it("measures from live closes when available", async () => {
    const svc = new CorrelationService(async (symbol) => closes(rets(120), symbol === "MSFT" ? 1 : 1));
    const est = await svc.estimate("AAPL", "MSFT");
    expect(est.source).toBe("measured");
    expect(est.value).toBe(1);
    expect(est.observations).toBeGreaterThanOrEqual(60);
  });

  it("falls back to a labeled sector proxy — value stays null, never invented", async () => {
    const svc = new CorrelationService(async () => null);
    const est = await svc.estimate("AAPL", "MSFT");
    expect(est.source).toBe("proxy-sector");
    expect(est.value).toBeNull();
    expect(est.sector).toBe(sectorOf("AAPL"));
  });

  it("reports unknown across sectors with no data — not zero", async () => {
    const svc = new CorrelationService(async () => null);
    const est = await svc.estimate("AAPL", "ZZZZNOTREAL");
    expect(est.source).toBe("unknown");
    expect(est.value).toBeNull();
  });
});

function row(symbol: string, deltaDollars: number) {
  return {
    symbol, description: symbol, kind: "equity" as const, signedQuantity: 10,
    deltaShares: 10, deltaDollars, betaWeightedDeltaDollars: deltaDollars,
    gammaSharesPerDollar: 0, thetaDollarsPerDay: 0, vegaDollarsPerVolPoint: 0,
    rhoDollarsPerRatePoint: 0, beta: 1, betaSource: "computed-live" as const, definedMaxLoss: null,
  };
}

const reportFixture: PortfolioRiskReport = {
  accountId: "acct-1",
  asOf: "2026-10-15T00:00:00.000Z",
  nav: 100000,
  spyPrice: 500,
  totals: {} as PortfolioRiskReport["totals"],
  rows: [row("NVDA", 6000), row("AAPL", 3000), row("XOM", 1000)],
  partial: [],
  excluded: [],
  undefinedRiskPositions: [],
};

describe("assessPortfolioConcentration (acceptance)", () => {
  const estimator: CorrelationEstimator = async (a, b) => {
    const pair = [a, b].sort().join("|");
    if (pair === "MSFT|NVDA") return { value: 0.85, source: "measured", observations: 200 };
    if (pair === "AAPL|MSFT") return { value: 0.5, source: "measured", observations: 200 };
    if (pair === "CVX|NVDA" || pair === "AAPL|CVX" || pair === "CVX|XOM") return { value: 0.1, source: "measured", observations: 200 };
    return { value: null, source: "unknown", observations: 0 };
  };

  it("flags a candidate duplicating concentrated exposure, naming the positions", async () => {
    const result = await assessPortfolioConcentration(reportFixture, estimator, "MSFT");
    const tech = result.sectorShares.find((s) => s.sector === "Technology");
    expect(tech?.sharePct).toBe(90);
    const assessment = result.candidateAssessment!;
    const kinds = assessment.flags.map((f) => f.kind);
    expect(kinds).toContain("high-correlation");
    expect(kinds).toContain("sector-concentration");
    const corrFlag = assessment.flags.find((f) => f.kind === "high-correlation")!;
    expect(corrFlag.positions).toEqual(["NVDA"]);
    expect(corrFlag.correlation).toBe(0.85);
    const sectorFlag = assessment.flags.find((f) => f.kind === "sector-concentration")!;
    expect(sectorFlag.positions).toEqual(expect.arrayContaining(["AAPL", "NVDA"]));
    expect(assessment.status).toBe("partial-unknown"); // MSFT-XOM unknown, surfaced not hidden
  });

  it("does not flag an uncorrelated candidate in a different sector", async () => {
    const result = await assessPortfolioConcentration(reportFixture, estimator, "CVX");
    expect(result.candidateAssessment!.flags).toEqual([]);
    expect(result.candidateAssessment!.status).toBe("assessed");
  });
});
