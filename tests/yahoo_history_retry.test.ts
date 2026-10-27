/**
 * Issue #1184 (#1173 R2): the Yahoo history leg retries.
 * Issue #1331: adapted — the deleted fetchYahooDailyHistory is
 * gone; the same contract now lives on the platform history seam
 * (bindYahooHistoryDeps.fetchBars). The retry level shifts from
 * host fetches (query1→query2 per attempt) to adapter calls: the
 * market-data provider already tries both hosts per call, so one seam
 * attempt covers both hosts. Pins, unchanged in intent: a
 * throttle-then-OK sequence recovers through the shared
 * acquisition policy; total failure still returns honest null.
 */
import { describe, expect, it, vi } from "vitest";
import { bindYahooHistoryDeps } from "../src/trading/platformHistory";
import type { MarketDataResearchHistoricalBar } from "../src/types";

function liveSeries(n: number): MarketDataResearchHistoricalBar[] {
  return Array.from({ length: n }, (_, i) => ({
    provenance: "live" as const,
    timestamp: `2026-09-${String(i + 1).padStart(2, "0")}`,
    open: 100 + i - 0.5,
    high: 100 + i + 0.5,
    low: 100 + i - 1,
    close: 100 + i,
    volume: 1_000_000,
  }));
}

const policy = { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
const noSleep = async () => {};

describe("bindYahooHistoryDeps.fetchBars — retry under the acquisition policy", () => {
  it("recovers when the first attempt is throttled", async () => {
    let calls = 0;
    const provider = {
      id: "yahoo",
      getHistoricalBars: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("429 throttled");
        return { providerId: "yahoo", capability: "historicalBars", result: liveSeries(30) };
      }),
    } as any;
    const deps = bindYahooHistoryDeps(provider, { runId: "run-1" }, { retryPolicy: policy, retrySleep: noSleep });
    const bars = await deps.fetchBars("ZZRTRY1");
    expect(bars).not.toBeNull();
    expect(bars!).toHaveLength(30);
    expect(calls).toBe(2);
  });

  it("returns honest null when every attempt fails", async () => {
    let calls = 0;
    const provider = {
      id: "yahoo",
      getHistoricalBars: vi.fn(async () => {
        calls++;
        throw new Error("503");
      }),
    } as any;
    const deps = bindYahooHistoryDeps(provider, { runId: "run-1" }, { retryPolicy: policy, retrySleep: noSleep });
    const bars = await deps.fetchBars("ZZRTRY2");
    expect(bars).toBeNull();
    expect(calls).toBe(2);
  });
});
