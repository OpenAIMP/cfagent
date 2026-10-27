/**
 * Issue #1331 — migrate yahooHistory runtime consumers to platform
 * historicalBars, then delete the yahooHistory runtime.
 *
 * Characterization pins for the migration seam, written BEFORE the
 * implementation (TDD): the bar mapping, the live-only honesty rule
 * (a generated/synthetic bar is never technicals input — the old
 * path returned null on failure, never zero, never synthesized),
 * the historicalBars route helper, the history deps binding
 * (retry under the acquisition policy, run context rides along),
 * and the platform technicals batch (chunking, per-symbol failure
 * isolation, onBatch progress hook).
 *
 * Everything here imports from the NEW modules (technicals.ts,
 * platformHistory.ts). On pristine control those modules do not
 * exist, so every test fails there — the Red run. The
 * computeTechnicals pins guard the verbatim move of the pure
 * functions; they are move pins, not Red evidence for new behavior.
 */
import { describe, it, expect, vi } from "vitest";
import {
  computeTechnicals,
  classifyGap,
  marketDataResearchBarsToDailyBars,
  type YahooDailyBar,
} from "../src/trading/technicals";
import {
  yahooBarsProviderFromRoute,
  bindYahooHistoryDeps,
  fetchPlatformTechnicalsBatch,
  resolveYahooHistoryDeps,
  type YahooHistoryDeps,
} from "../src/trading/platformHistory";
import type { MarketDataResearchHistoricalBar } from "../src/types";

function liveBar(date: string, close: number): MarketDataResearchHistoricalBar {
  return {
    provenance: "live",
    timestamp: date,
    open: close - 0.3,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1_000_000,
  };
}

function generatedBar(date: string, close: number): MarketDataResearchHistoricalBar {
  return { ...liveBar(date, close), provenance: "generated" };
}

function liveSeries(n: number, startClose = 100, drift = 0.5): MarketDataResearchHistoricalBar[] {
  return Array.from({ length: n }, (_, i) => liveBar(`2026-09-${String(i + 1).padStart(2, "0")}`, startClose + i * drift));
}

const noSleep = () => Promise.resolve();
const oneAttempt = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
const threeAttempts = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };

describe("marketDataResearchBarsToDailyBars — mapping + live-only honesty", () => {
  it("maps live market-data bars to YahooDailyBar rows field-for-field", () => {
    const out = marketDataResearchBarsToDailyBars([liveBar("2026-09-01", 100), liveBar("2026-09-02", 101)]);
    expect(out).toEqual([
      { date: "2026-09-01", open: 99.7, high: 100.5, low: 99.5, close: 100, volume: 1_000_000 },
      { date: "2026-09-02", open: 100.7, high: 101.5, low: 100.5, close: 101, volume: 1_000_000 },
    ]);
  });

  it("empty input is unavailable, not zero bars", () => {
    expect(marketDataResearchBarsToDailyBars([])).toBeNull();
  });

  it("any generated bar rejects the whole series (never partial synthesis)", () => {
    expect(marketDataResearchBarsToDailyBars([liveBar("2026-09-01", 100), generatedBar("2026-09-02", 101)])).toBeNull();
    expect(marketDataResearchBarsToDailyBars([generatedBar("2026-09-01", 100)])).toBeNull();
  });

  it("an all-live series passes through", () => {
    expect(marketDataResearchBarsToDailyBars(liveSeries(3))?.length).toBe(3);
  });
});

describe("computeTechnicals / classifyGap — verbatim-move guards", () => {
  it("gap math: last open vs previous close, classified", () => {
    const bars: YahooDailyBar[] = [
      { date: "2026-09-01", open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { date: "2026-09-02", open: 103, high: 104, low: 102, close: 103, volume: 1 },
    ];
    const t = computeTechnicals("AAA", bars);
    expect(t.gapPercent).toBe(3);
    expect(t.gapDirection).toBe("up");
    expect(t.barsUsed).toBe(2);
    expect(t.source).toBe("Yahoo Finance");
  });

  it("RSI null below 15 bars, MACD null below 27 bars (honest, not estimated)", () => {
    const few = computeTechnicals("AAA", liveSeries(10).map((b) => ({
      date: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    })));
    expect(few.rsi14).toBeNull();
    expect(few.macdLine).toBeNull();
    expect(few.barsUsed).toBe(10);
    const many = computeTechnicals("AAA", liveSeries(30).map((b) => ({
      date: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    })));
    expect(many.rsi14).not.toBeNull();
    expect(many.macdLine).not.toBeNull();
  });

  it("null bars yield null indicators with barsUsed 0", () => {
    const t = computeTechnicals("AAA", null);
    expect(t.rsi14).toBeNull();
    expect(t.macdLine).toBeNull();
    expect(t.gapPercent).toBeNull();
    expect(t.barsUsed).toBe(0);
  });

  it("classifyGap thresholds", () => {
    expect(classifyGap(2.5)).toBe("up");
    expect(classifyGap(0.5)).toBe("flat");
    expect(classifyGap(-2.5)).toBe("down");
    expect(classifyGap(null)).toBeNull();
  });
});

describe("yahooBarsProviderFromRoute — historicalBars route, no silent substitution", () => {
  const configs = [{ id: "yahoo", lifecycleState: "enabled", enabled: true }];
  const routes = [{ capability: "historicalBars", primaryProviderId: "yahoo", gapFillProviderId: null, minTier: "freemium" }];
  const registry = (caps: readonly string[]) =>
    ({ get: (id: string) => (id === "yahoo" ? { id: "yahoo", capabilities: caps } : undefined) }) as any;

  it("returns the yahoo provider when route, config, and capability all hold", () => {
    const p = yahooBarsProviderFromRoute(registry(["historicalBars"]), configs as any, routes as any);
    expect(p.id).toBe("yahoo");
  });

  it("throws when the route does not name yahoo as primary", () => {
    expect(() =>
      yahooBarsProviderFromRoute(registry(["historicalBars"]), configs as any, [
        { capability: "historicalBars", primaryProviderId: "etrade", gapFillProviderId: null, minTier: "freemium" },
      ] as any)
    ).toThrow(/does not name yahoo as primary/);
  });

  it("throws when yahoo is not enabled", () => {
    expect(() =>
      yahooBarsProviderFromRoute(registry(["historicalBars"]), [
        { id: "yahoo", lifecycleState: "configured", enabled: false },
      ] as any, routes as any)
    ).toThrow(/not enabled/);
  });

  it("throws when no historicalBars-capable yahoo adapter is registered", () => {
    expect(() => yahooBarsProviderFromRoute(registry(["quotes"]), configs as any, routes as any)).toThrow(
      /no historicalBars-capable/
    );
  });
});

describe("bindYahooHistoryDeps — fetchBars through the adapter", () => {
  function stubProvider(bars: MarketDataResearchHistoricalBar[] | Error, calls: unknown[] = []) {
    return {
      id: "yahoo",
      getHistoricalBars: vi.fn(async (symbol: string, timeframe?: string, limit?: number, runContext?: unknown) => {
        calls.push([symbol, timeframe, limit, runContext]);
        if (bars instanceof Error) throw bars;
        return { providerId: "yahoo", capability: "historicalBars", result: bars };
      }),
    } as any;
  }

  it("maps live bars and passes timeframe, limit 60, and the run context through", async () => {
    const calls: unknown[] = [];
    const deps = bindYahooHistoryDeps(stubProvider(liveSeries(30), calls), {
      runId: "run-1",
      userLogin: "tester",
    });
    const out = await deps.fetchBars("AAA");
    expect(out?.length).toBe(30);
    expect(out?.[0].date).toBe("2026-09-01");
    expect(calls[0]).toEqual(["AAA", "1D", 60, { runId: "run-1", userLogin: "tester" }]);
  });

  it("generated bars are unavailable (null), not technicals input", async () => {
    const deps = bindYahooHistoryDeps(stubProvider([generatedBar("2026-09-01", 100)]), {
      runId: "run-1",
    }, { retryPolicy: oneAttempt, retrySleep: noSleep });
    expect(await deps.fetchBars("AAA")).toBeNull();
  });

  it("an adapter throw is unavailable (null), not a throw", async () => {
    const deps = bindYahooHistoryDeps(stubProvider(new Error("boom")), { runId: "run-1" }, {
      retryPolicy: oneAttempt,
      retrySleep: noSleep,
    });
    expect(await deps.fetchBars("AAA")).toBeNull();
  });

  it("retries under the acquisition policy: two failures then live bars succeed", async () => {
    let n = 0;
    const provider = {
      id: "yahoo",
      getHistoricalBars: vi.fn(async () => {
        n++;
        if (n < 3) throw new Error("throttled");
        return { providerId: "yahoo", capability: "historicalBars", result: liveSeries(30) };
      }),
    } as any;
    const deps = bindYahooHistoryDeps(provider, { runId: "run-1" }, {
      retryPolicy: threeAttempts,
      retrySleep: noSleep,
    });
    expect((await deps.fetchBars("AAA"))?.length).toBe(30);
    expect(n).toBe(3);
  });

  it("exhausted retries yield null", async () => {
    const provider = {
      id: "yahoo",
      getHistoricalBars: vi.fn(async () => {
        throw new Error("down");
      }),
    } as any;
    const deps = bindYahooHistoryDeps(provider, { runId: "run-1" }, {
      retryPolicy: threeAttempts,
      retrySleep: noSleep,
    });
    expect(await deps.fetchBars("AAA")).toBeNull();
    expect(provider.getHistoricalBars).toHaveBeenCalledTimes(3);
  });
});

describe("fetchPlatformTechnicalsBatch — batch shape of the old path", () => {
  function depsFor(symbols: Record<string, MarketDataResearchHistoricalBar[] | null>): YahooHistoryDeps {
    return {
      fetchBars: async (symbol: string) => {
        const bars = symbols[symbol] ?? null;
        return bars === null ? null : marketDataResearchBarsToDailyBars(bars);
      },
    };
  }

  it("returns a Map of technicals keyed by symbol, per-symbol failures isolated", async () => {
    const deps = depsFor({ AAA: liveSeries(30), BBB: null });
    const out = await fetchPlatformTechnicalsBatch(deps, ["AAA", "BBB"]);
    expect(out.get("AAA")?.macdLine).not.toBeNull();
    const bbb = out.get("BBB")!;
    expect(bbb.rsi14).toBeNull();
    expect(bbb.barsUsed).toBe(0);
  });

  it("chunks by concurrency and reports progress per chunk", async () => {
    const progress: Array<[number, number]> = [];
    const deps = depsFor({ A: liveSeries(30), B: liveSeries(30), C: liveSeries(30), D: liveSeries(30), E: liveSeries(30) });
    const out = await fetchPlatformTechnicalsBatch(deps, ["A", "B", "C", "D", "E"], {
      concurrency: 2,
      onBatch: async (completed, total) => {
        progress.push([completed, total]);
      },
    });
    expect(out.size).toBe(5);
    expect(progress).toEqual([[2, 5], [4, 5], [5, 5]]);
  });

  it("a throwing fetchBars is per-symbol null, never a batch failure", async () => {
    const deps: YahooHistoryDeps = {
      fetchBars: async (symbol: string) => {
        if (symbol === "BAD") throw new Error("nope");
        return marketDataResearchBarsToDailyBars(liveSeries(30));
      },
    };
    const out = await fetchPlatformTechnicalsBatch(deps, ["GOOD", "BAD"]);
    expect(out.get("GOOD")?.macdLine).not.toBeNull();
    expect(out.get("BAD")?.barsUsed).toBe(0);
  });
});

describe("resolveYahooHistoryDeps — degrading resolution (fix for the #336 regression)", () => {
  it("resolves undefined, never throws, when resolution fails", async () => {
    const deps = await resolveYahooHistoryDeps({
      sql: undefined as any,
      env: {} as any,
      userLogin: "tester",
      runId: "run-degraded",
    });
    expect(deps).toBeUndefined();
  });

  it("a null-fetching deps object through the batch yields honest null technicals for every symbol", async () => {
    const out = await fetchPlatformTechnicalsBatch({ fetchBars: async () => null }, ["AAA", "BBB"]);
    expect(out.size).toBe(2);
    for (const t of out.values()) {
      expect(t.barsUsed).toBe(0);
      expect(t.rsi14).toBeNull();
      expect(t.macdLine).toBeNull();
      expect(t.gapPercent).toBeNull();
    }
  });
});
