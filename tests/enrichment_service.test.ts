/**
 * Issue #1888: enrichment service — flag selection, minute serving,
 * coverage accounting, Yahoo fallback on Alpaca failure (qualified
 * partial, never hard failure), killswitch/global-halt refusal,
 * envelope emission (counts + ids only).
 */
import { describe, expect, it, vi } from "vitest";
import {
  runEnrichment,
  type EnrichmentMarketData,
} from "../src/enrichment/enrichmentService";
import type { EnrichmentRunStore } from "../src/enrichment/enrichmentPorts";

function marketData(overrides: Partial<EnrichmentMarketData> = {}): EnrichmentMarketData {
  const bars = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: `2026-10-27T14:3${i}:00.000Z`,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000,
    }));
  return {
    isAlpacaConfigured: () => true,
    getQuote: async () => ({ ok: true }),
    getFundamentals: async () => ({ ok: true }),
    getBars: async (_symbol, _provider, timeframe) =>
      timeframe === "1D" ? bars(2) : bars(3),
    ...overrides,
  };
}

function store(): EnrichmentRunStore & { runs: unknown[] } {
  const runs: unknown[] = [];
  return {
    runs,
    recordRun: async (run) => {
      runs.push(run);
    },
    listRuns: async () => [...(runs as [])],
  };
}

describe("runEnrichment", () => {
  it("Yahoo mode serves quote + fundamentals + daily + minute bars with coverage", async () => {
    const s = store();
    const emit = vi.fn();
    const result = await runEnrichment({
      jobId: "job-yahoo",
      stage: "feed",
      symbols: ["NVDA", "AAPL"],
      marketData: marketData(),
      alpacaFlagOn: false,
      killswitchThrown: false,
      globalHalted: false,
      store: s,
      emit,
      nowMs: () => 0,
    });
    expect(result.provider).toBe("yahoo");
    expect(result.symbolsRequested).toBe(2);
    expect(result.symbolsServed).toBe(2);
    expect(result.dailyBars).toBe(4);
    expect(result.minuteBars).toBe(6);
    expect(result.partial).toBe(false);
    expect(s.runs).toHaveLength(1);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].type).toBe("enrichment.completed");
  });

  it("Alpaca mode uses Yahoo for fundamentals (never faked) and Alpaca for bars", async () => {
    const seen: Array<{ symbol: string; provider: string; kind: string }> = [];
    const md = marketData({
      getFundamentals: async (symbol, provider) => {
        seen.push({ symbol, provider, kind: "fundamentals" });
        return { ok: true };
      },
      getBars: async (symbol, provider, timeframe) => {
        seen.push({ symbol, provider, kind: "bars" });
        return timeframe === "1D" ? [{ timestamp: "t", open: 1, high: 1, low: 1, close: 1, volume: 1 }] : [];
      },
    });
    const result = await runEnrichment({
      jobId: "job-alpaca",
      stage: "gather",
      symbols: ["NVDA"],
      marketData: md,
      alpacaFlagOn: true,
      killswitchThrown: false,
      globalHalted: false,
      nowMs: () => 0,
    });
    expect(result.provider).toBe("alpaca");
    expect(result.mode).toBe("alpaca-fallback");
    expect(seen.filter((s) => s.kind === "fundamentals")[0].provider).toBe("yahoo");
    expect(seen.filter((s) => s.kind === "bars").every((s) => s.provider === "alpaca")).toBe(true);
  });

  it("Alpaca failure falls back to Yahoo per symbol (qualified partial, no throw)", async () => {
    const md = marketData({
      getBars: async (symbol, provider, timeframe) => {
        if (provider === "alpaca") throw new Error("alpaca down");
        return timeframe === "1D"
          ? [{ timestamp: "t", open: 1, high: 1, low: 1, close: 1, volume: 1 }]
          : [{ timestamp: "t", open: 1, high: 1, low: 1, close: 1, volume: 1 }];
      },
      getQuote: async (_symbol, provider) => {
        if (provider === "alpaca") throw new Error("alpaca down");
        return { ok: true };
      },
    });
    const result = await runEnrichment({
      jobId: "job-fallback",
      stage: "feed",
      symbols: ["NVDA"],
      marketData: md,
      alpacaFlagOn: true,
      killswitchThrown: false,
      globalHalted: false,
      nowMs: () => 0,
    });
    expect(result.symbolsServed).toBe(1);
    expect(result.fallbacks).toBeGreaterThan(0);
    expect(result.partial).toBe(false);
  });

  it("all providers failing yields a partial run, never a throw", async () => {
    const md = marketData({
      getQuote: async () => {
        throw new Error("down");
      },
      getBars: async () => {
        throw new Error("down");
      },
      getFundamentals: async () => {
        throw new Error("down");
      },
    });
    const result = await runEnrichment({
      jobId: "job-dead",
      stage: "feed",
      symbols: ["NVDA"],
      marketData: md,
      alpacaFlagOn: false,
      killswitchThrown: false,
      globalHalted: false,
      nowMs: () => 0,
    });
    expect(result.symbolsServed).toBe(0);
    expect(result.partial).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("killswitch thrown stops the run before any fetch", async () => {
    const getQuote = vi.fn(async () => ({ ok: true }));
    const result = await runEnrichment({
      jobId: "job-stopped",
      stage: "feed",
      symbols: ["NVDA"],
      marketData: marketData({ getQuote }),
      alpacaFlagOn: false,
      killswitchThrown: true,
      globalHalted: false,
      nowMs: () => 0,
    });
    expect(result.stopped).toBe(true);
    expect(getQuote).not.toHaveBeenCalled();
    expect(result.symbolsServed).toBe(0);
  });

  it("global halt also stops the run before any fetch", async () => {
    const getQuote = vi.fn(async () => ({ ok: true }));
    const result = await runEnrichment({
      jobId: "job-halted",
      stage: "feed",
      symbols: ["NVDA"],
      marketData: marketData({ getQuote }),
      alpacaFlagOn: false,
      killswitchThrown: false,
      globalHalted: true,
      nowMs: () => 0,
    });
    expect(result.stopped).toBe(true);
    expect(getQuote).not.toHaveBeenCalled();
  });

  it("unsupported minute timeframe for the active provider is a 400-class error, not a fetch", async () => {
    await expect(
      runEnrichment({
        jobId: "job-badmin",
        stage: "feed",
        symbols: ["NVDA"],
        minuteTimeframe: "90Min",
        marketData: marketData(),
        alpacaFlagOn: true,
        killswitchThrown: false,
        globalHalted: false,
        nowMs: () => 0,
      }),
    ).rejects.toThrow(/90Min/);
  });

  it("emit failure never fails the run", async () => {
    const result = await runEnrichment({
      jobId: "job-emit",
      stage: "feed",
      symbols: ["NVDA"],
      marketData: marketData(),
      alpacaFlagOn: false,
      killswitchThrown: false,
      globalHalted: false,
      emit: () => {
        throw new Error("sink down");
      },
      nowMs: () => 0,
    });
    expect(result.symbolsServed).toBe(1);
  });
});
