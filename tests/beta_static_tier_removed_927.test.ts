/**
 * Issue #927 (parent #913 S9): the static beta table tier is removed.
 * Beta is computed live from Yahoo/Alpaca bars vs SPY (Tier 1) or
 * unavailable (Tier 3). A live failure must NEVER serve a static-table
 * number, even for a symbol that exists in the market-data table.
 */
import { describe, it, expect } from "vitest";
import { BetaService } from "../src/services/betaService";
import { aggregatePortfolioRisk, type ResolvedPosition } from "../src/services/portfolioRisk";
import type { ETradePosition } from "../src/types";

const BENCH_RETURNS = [0.01, -0.005, 0.02, -0.01, 0.004, -0.015, 0.008, 0.012, -0.002, 0.006];

function closesFromReturns(start: number, returns: number[], startDate = "2025-01-02"): Map<string, number> {
  const map = new Map<string, number>();
  const day = new Date(`${startDate}T00:00:00Z`);
  let price = start;
  map.set(day.toISOString().split("T")[0], price);
  for (const r of returns) {
    day.setUTCDate(day.getUTCDate() + 1);
    price *= 1 + r;
    map.set(day.toISOString().split("T")[0], price);
  }
  return map;
}

function benchReturns(n: number): number[] {
  return Array.from({ length: n }, (_, i) => BENCH_RETURNS[i % BENCH_RETURNS.length]);
}

function equityPosition(partial: Partial<ETradePosition>): ETradePosition {
  return {
    symbol: "AAPL",
    description: "Common Stock",
    quantity: 100,
    pricePaid: 180,
    costBasis: 18000,
    currentPrice: 200,
    marketPrice: 200,
    marketValue: 20000,
    totalGain: 2000,
    unrealizedGainLoss: 2000,
    totalGainPercent: 11,
    unrealizedGainLossPercent: 11,
    daysGain: 0,
    daysGainPercent: 0,
    securityType: "EQ",
    positionType: "LONG",
    ...partial,
  };
}

function resolved(partial: Partial<ResolvedPosition>): ResolvedPosition {
  return {
    position: equityPosition({}),
    kind: "equity",
    signedQuantity: 100,
    referencePrice: 200,
    greeks: { delta: 1, gamma: 0, theta: 0, vega: 0, rho: 0 },
    beta: 1.2,
    betaSource: "computed-live" as const,
    betaObservations: 252,
    ...partial,
  };
}

const OPTS = { nav: 100000, spyPrice: 500, asOf: "2026-10-15T00:00:00.000Z" };

describe("S9: static beta tier removed", () => {
  it("live failure for a table symbol returns unavailable, never a static beta", async () => {
    // AAPL exists in the market-data table; a null fetcher must not surface its table beta.
    const svc = new BetaService(async () => null);
    const res = await svc.resolve("AAPL");
    expect(res.beta).toBeNull();
    expect(res.source).toBe("unavailable");
    expect(res.observations).toBe(0);
  });

  it("a live regression that fails (too few observations) returns unavailable, never static", async () => {
    const svc = new BetaService(async (symbol: string) => {
      if (symbol === "SPY") return closesFromReturns(500, benchReturns(120));
      if (symbol === "AAPL") return closesFromReturns(100, benchReturns(30));
      return null;
    });
    const res = await svc.resolve("AAPL");
    expect(res.beta).toBeNull();
    expect(res.source).toBe("unavailable");
  });

  it("a benchmark fetch failure returns unavailable, never static", async () => {
    const svc = new BetaService(async (symbol: string) => {
      if (symbol === "SPY") return null;
      return closesFromReturns(100, benchReturns(120));
    });
    const res = await svc.resolve("AAPL");
    expect(res.beta).toBeNull();
    expect(res.source).toBe("unavailable");
  });

  it("control: live computation still works", async () => {
    const svc = new BetaService(async (symbol: string) => {
      if (symbol === "SPY") return closesFromReturns(500, benchReturns(120));
      if (symbol === "ACME") return closesFromReturns(100, benchReturns(120).map((r) => r * 2));
      return null;
    });
    const res = await svc.resolve("ACME");
    expect(res.source).toBe("computed-live");
    expect(res.beta).toBeCloseTo(2, 3);
  });

  it("control: SPY against itself is still beta 1, computed-live", async () => {
    const svc = new BetaService(async (symbol: string) => {
      if (symbol === "SPY") return closesFromReturns(500, benchReturns(120));
      return null;
    });
    const res = await svc.resolve("SPY");
    expect(res.beta).toBe(1);
    expect(res.source).toBe("computed-live");
  });

  it("an unavailable position is excluded from beta-weighted totals and counted as unavailable", () => {
    const book: ResolvedPosition[] = [
      resolved({}),
      resolved({
        position: equityPosition({ symbol: "XYZ", quantity: 50, marketPrice: 40, marketValue: 2000 }),
        signedQuantity: 50,
        referencePrice: 40,
        beta: null,
        betaSource: "unavailable" as const,
        betaObservations: 0,
      }),
    ];
    const report = aggregatePortfolioRisk(book, OPTS);
    // Only the live row contributes: 100 sh * $200 * 1.2 = $24,000.
    expect(report.totals.betaWeightedDeltaDollars).toBe(24000);
    expect(report.totals.betaCoverage).toEqual({ covered: 1, total: 2, computedLive: 1, unavailable: 1 });
    expect(report.partial.map((p) => p.symbol)).toEqual(["XYZ"]);
  });
});
