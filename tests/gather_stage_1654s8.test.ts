/**
 * Issue #1654 slice 8 — Gather stage (feed/gather/analysis ruling).
 *
 * TDD red→green: gather computes every slice value from real daily bars
 * and attaches it to the feed quote; analysis (evaluateUniverse, via
 * screenWithQuotes) then fires on the GATHERED value, never on
 * feed-carried data. No bars means no attachments (fail-closed
 * preserved). Persistence follows the capture/blob pattern: one JSON
 * blob per run under gather/<runId>.json, no separate store.
 */
import { describe, it, expect } from "vitest";
import {
  gatherDataset,
  gatherEnrichedQuote,
  persistGatheredDataset,
  readGatheredDataset,
} from "../src/trading/gather";
import type { CaptureBlobDeps } from "../src/trading/dataProviders/captureStore";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { YahooDailyBar } from "../src/trading/technicals";
import type { ETradeQuote } from "../src/types";

function bar(
  date: string,
  close: number,
  volume = 100
): YahooDailyBar {
  return { date, open: close, high: close + 1, low: close - 1, close, volume };
}

function flatBars(n: number): YahooDailyBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 100,
  }));
}

function risingBars(n: number): YahooDailyBar[] {
  return Array.from({ length: n }, (_, i) => bar(
    `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    100 + i
  ));
}

function makeQuote(overrides: Partial<ETradeQuote> = {}): ETradeQuote {
  return {
    symbol: "TEST",
    companyName: "Test Co",
    lastPrice: 100,
    change: 1,
    changePercent: 1,
    bid: 99,
    ask: 101,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    timestamp: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
}

function memoryDeps(): CaptureBlobDeps {
  const store = new Map<string, unknown>();
  return {
    env: {},
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  };
}

describe("gatherEnrichedQuote", () => {
  it("attaches AVWAP exactly: anchor at the lowest low, volume-weighted forward", () => {
    const gathered = gatherEnrichedQuote({
      quote: makeQuote(),
      dailyBars: risingBars(30),
    });
    // Anchor is bar 0 (lowest low 99); all volumes equal, so AVWAP is
    // the mean close: (100 + 129) / 2 = 114.5.
    expect(gathered.quote.anchoredVwap).toBeCloseTo(114.5, 6);
    expect(gathered.provenance.barsUsed).toBe(30);
  });

  it("attaches regime UP on rising halves and a bias score + label", () => {
    const gathered = gatherEnrichedQuote({
      quote: makeQuote(),
      dailyBars: risingBars(30),
    });
    expect(gathered.quote.regime).toBe("UP");
    expect(typeof gathered.quote.compositeBiasScore).toBe("number");
    expect(gathered.quote.compositeBias).toBeDefined();
  });

  it("attaches flat-bar values honestly: AVWAP 100, %B 0.5, ATR% 0, no Fib levels", () => {
    const gathered = gatherEnrichedQuote({
      quote: makeQuote(),
      dailyBars: flatBars(30),
    });
    expect(gathered.quote.anchoredVwap).toBe(100);
    expect(gathered.quote.percentB).toBe(0.5);
    expect(gathered.quote.atrPct).toBe(0);
    expect(gathered.quote.regime).toBe("RNG");
    // Zero range means no retracement levels: absent, never invented.
    expect(gathered.fibLevels).toBeUndefined();
  });

  it("attaches nothing when no bars are supplied (fail-closed preserved)", () => {
    const gathered = gatherEnrichedQuote({ quote: makeQuote() });
    expect(gathered.quote.anchoredVwap).toBeUndefined();
    expect(gathered.quote.percentB).toBeUndefined();
    expect(gathered.quote.atrPct).toBeUndefined();
    expect(gathered.quote.regime).toBeUndefined();
    expect(gathered.quote.compositeBiasScore).toBeUndefined();
    expect(gathered.fibLevels).toBeUndefined();
    expect(gathered.provenance.barsUsed).toBe(0);
    expect(gathered.provenance.barCompleteness).toBe("unknown");
  });

  it("labels Alpaca bars within 15 minutes of fetch as iex-partial, Yahoo as complete", () => {
    const bars = [
      bar("2026-10-26T14:00:00.000Z", 100),
      bar("2026-10-26T14:50:00.000Z", 101),
    ];
    const alpaca = gatherEnrichedQuote({
      quote: makeQuote(),
      dailyBars: bars,
      barProviderId: "alpaca",
      barsFetchedAt: "2026-10-26T15:00:00.000Z",
    });
    expect(alpaca.provenance.barCompleteness).toBe("iex-partial");
    const yahoo = gatherEnrichedQuote({
      quote: makeQuote(),
      dailyBars: bars,
      barProviderId: "yahoo",
      barsFetchedAt: "2026-10-26T15:00:00.000Z",
    });
    expect(yahoo.provenance.barCompleteness).toBe("complete");
  });
});

describe("gather → analysis proof (slice 8)", () => {
  it("the strict AVWAP gate fires on the GATHERED value, not on feed data", () => {
    const gathered = gatherEnrichedQuote({
      quote: makeQuote(),
      dailyBars: risingBars(30),
    });
    expect(gathered.quote.anchoredVwap).toBeCloseTo(114.5, 6);
    const screener = new DynamicMarketScreener([]);

    // Above the gathered AVWAP: passes.
    const pass = screener.screenWithQuotes(
      [{ ...gathered.quote, lastPrice: 115 }],
      { requireAboveAnchoredVwap: true }
    );
    expect(pass.matchedCount).toBe(1);

    // Exactly AT the gathered AVWAP: rejects under the strict ruling.
    const equal = screener.screenWithQuotes(
      [{ ...gathered.quote, lastPrice: 114.5 }],
      { requireAboveAnchoredVwap: true }
    );
    expect(equal.matchedCount).toBe(0);
    expect(equal.ledger.rejections[0].reason).toMatch(/anchored vwap/i);

    // Control: the raw feed quote (no gather) fail-closes as unavailable,
    // proving the gate above fired on gathered data.
    const raw = screener.screenWithQuotes([makeQuote({ lastPrice: 115 })], {
      requireAboveAnchoredVwap: true,
    });
    expect(raw.matchedCount).toBe(0);
    expect(raw.ledger.rejections[0].reason).toMatch(/unavailable/i);
  });
});

describe("gather persistence (capture/blob, no separate store)", () => {
  it("round-trips a dataset through gather/<runId>.json and returns null when absent", async () => {
    const deps = memoryDeps();
    const dataset = gatherDataset("run-1654s8", [
      { quote: makeQuote(), dailyBars: risingBars(30), barProviderId: "yahoo", barsFetchedAt: "2026-10-26T00:00:00.000Z" },
      { quote: makeQuote({ symbol: "FLAT" }), dailyBars: flatBars(30) },
    ]);
    const { key } = await persistGatheredDataset(deps, dataset);
    expect(key).toBe("gather/run-1654s8.json");
    const back = await readGatheredDataset(deps, "run-1654s8");
    expect(back).not.toBeNull();
    expect(back!.runId).toBe("run-1654s8");
    expect(back!.symbols).toHaveLength(2);
    expect(back!.symbols[0].quote.anchoredVwap).toBeCloseTo(114.5, 6);
    expect(back!.symbols[0].provenance.barCompleteness).toBe("complete");
    await expect(readGatheredDataset(deps, "run-missing")).resolves.toBeNull();
  });
});
