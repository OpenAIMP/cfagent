/**
 * Issue #34 correction: beta is computed from live price history, not read
 * from a static table. These tests pin the regression math, the observation
 * floor, date alignment, and the provenance ladder
 * (computed-live → unavailable; the static tier was removed by #927).
 */
import { describe, it, expect } from "vitest";
import { BetaService, computeBetaFromCloses } from "../src/services/betaService";

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

describe("computeBetaFromCloses", () => {
  it("recovers an exact 2.0 beta when asset returns are twice the benchmark's", () => {
    const bench = closesFromReturns(500, benchReturns(120));
    const asset = closesFromReturns(100, benchReturns(120).map((r) => r * 2));
    const result = computeBetaFromCloses(asset, bench);
    expect(result).not.toBeNull();
    expect(result!.beta).toBeCloseTo(2, 3);
    expect(result!.observations).toBe(120);
  });

  it("gives beta 1 for the benchmark against itself", () => {
    const bench = closesFromReturns(500, benchReturns(80));
    expect(computeBetaFromCloses(bench, bench)!.beta).toBeCloseTo(1, 6);
  });

  it("refuses to compute below the minimum observation floor", () => {
    const bench = closesFromReturns(500, benchReturns(30));
    const asset = closesFromReturns(100, benchReturns(30));
    expect(computeBetaFromCloses(asset, bench)).toBeNull();
  });

  it("aligns on shared dates only and rejects a zero-variance benchmark", () => {
    const bench = closesFromReturns(500, benchReturns(90));
    const asset = closesFromReturns(100, benchReturns(90).map((r) => r * 0.5));
    // Drop a few asset dates: alignment must use the intersection.
    for (const d of [...asset.keys()].slice(0, 5)) asset.delete(d);
    const result = computeBetaFromCloses(asset, bench);
    expect(result).not.toBeNull();
    expect(result!.beta).toBeCloseTo(0.5, 3);

    const flat = closesFromReturns(500, new Array(90).fill(0));
    expect(computeBetaFromCloses(asset, flat)).toBeNull();
  });
});

describe("BetaService provenance ladder", () => {
  const liveFetcher = async (symbol: string) => {
    if (symbol === "SPY") return closesFromReturns(500, benchReturns(120));
    if (symbol === "ACME") return closesFromReturns(100, benchReturns(120).map((r) => r * 2));
    return null;
  };

  it("computes live beta with provenance and observation count", async () => {
    const svc = new BetaService(liveFetcher);
    const res = await svc.resolve("ACME");
    expect(res.source).toBe("computed-live");
    expect(res.beta).toBeCloseTo(2, 3);
    expect(res.observations).toBe(120);
  });

  it("treats SPY against itself as beta 1, computed-live", async () => {
    const svc = new BetaService(liveFetcher);
    const res = await svc.resolve("SPY");
    expect(res.beta).toBe(1);
    expect(res.source).toBe("computed-live");
  });

  it("returns unavailable — never a static-table number — when live history is unavailable (#927)", async () => {
    const svc = new BetaService(async () => null);
    const res = await svc.resolve("AAPL");
    expect(res.source).toBe("unavailable");
    expect(res.beta).toBeNull();
    expect(res.observations).toBe(0);
    const missing = await svc.resolve("ZZZZNOTREAL");
    expect(missing.source).toBe("unavailable");
    expect(missing.beta).toBeNull();
  });
});
