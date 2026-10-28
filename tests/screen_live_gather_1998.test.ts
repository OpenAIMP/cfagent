/**
 * Issue #1998 (Phase 3): screenLive's gather hook. Without a hook,
 * technical filters refuse exactly as before; with one, the screen
 * evaluates the hook's read-back rows, ledger-rejects no-row and
 * field-missing symbols honestly, and never evaluates a missing
 * field as a real zero.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { ETradeQuote } from "../src/types";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";

const LISTINGS: NasdaqStockListing[] = [
  { symbol: "AAA", companyName: "AAA Corp", exchange: "NASDAQ", lastPrice: 100, change: 1, changePercent: 1 },
  { symbol: "BBB", companyName: "BBB Corp", exchange: "NASDAQ", lastPrice: 100, change: 1, changePercent: 1 },
  { symbol: "CCC", companyName: "CCC Corp", exchange: "NASDAQ", lastPrice: 100, change: 1, changePercent: 1 },
];

function quote(symbol: string, fields: Partial<ETradeQuote>): ETradeQuote {
  return {
    symbol,
    companyName: `${symbol} Corp`,
    lastPrice: 100,
    change: 1,
    changePercent: 1,
    bid: 99,
    ask: 101,
    volume: 500_000,
    open: 99,
    high: 101,
    low: 98,
    timestamp: "2026-10-27T00:00:00.000Z",
    ...fields,
  };
}

afterEach(() => {
  DynamicMarketScreener.setTestListingsFixture(null);
});

describe("screenLive gather hook (#1998)", () => {
  it("without a hook, a momentum filter refuses exactly as before", async () => {
    DynamicMarketScreener.setTestListingsFixture(LISTINGS);
    const result = await new DynamicMarketScreener().screenLive({ momentum: "bullish_breakout" });
    expect(result.validationError).toMatch(/technical momentum/);
    expect(result.matchedCount).toBe(0);
    expect(result.gather).toBeUndefined();
  });

  it("with a hook, an enriched breakout passes and no-row symbols are honestly rejected", async () => {
    DynamicMarketScreener.setTestListingsFixture(LISTINGS);
    const hook = {
      enrich: vi.fn(async () => ({
        runId: "goal-run-9",
        // AAA breaks out (last >= 52w high, positive change); BBB has a
        // row but lacks the breakout field; CCC has no row at all.
        enrichedQuotes: [
          quote("AAA", { lastPrice: 210, changePercent: 2, week52High: 200, week52Low: 100, averageVolume: 1_000_000 }),
          quote("BBB", { lastPrice: 90, changePercent: 1, averageVolume: 1_000_000 }),
        ],
        missingSymbols: ["CCC"],
        missingFields: { BBB: ["week52High"], CCC: ["quote"] },
        gapFilledCount: 0,
        routeVersionHash: "abc123",
      })),
    };
    const result = await new DynamicMarketScreener().screenLive(
      { momentum: "bullish_breakout" },
      { enrichment: hook as never }
    );
    expect(hook.enrich).toHaveBeenCalledTimes(1);
    expect(result.stocks.map((s) => s.symbol)).toEqual(["AAA"]);
    expect(result.gather).toEqual({
      runId: "goal-run-9",
      stored: 2,
      missing: 1,
      excluded: 1,
      gapFilled: 0,
      routeVersionHash: "abc123",
      status: "ok",
    });
    expect(result.totalScanned).toBe(3);
    expect(result.ledger?.totalEvaluated).toBe(3);
    const bySymbol = new Map(result.ledger!.rejections.map((r) => [r.symbol, r.reason]));
    expect(bySymbol.get("BBB")).toMatch(/week52High/);
    expect(bySymbol.get("CCC")).toMatch(/No persisted gather row/);
    // BBB's rejection names missing data, never a market-fact claim.
    expect(bySymbol.get("BBB")).not.toMatch(/not making a positive 52-week high breakout/);
  });

  it("a hook returning no evaluable rows fails the leg, never an empty success", async () => {
    DynamicMarketScreener.setTestListingsFixture(LISTINGS);
    const hook = {
      enrich: async () => ({
        runId: "goal-run-10",
        enrichedQuotes: [],
        missingSymbols: ["AAA", "BBB", "CCC"],
        missingFields: {},
        gapFilledCount: 0,
        routeVersionHash: "abc123",
      }),
    };
    const result = await new DynamicMarketScreener().screenLive(
      { momentum: "bullish_breakout" },
      { enrichment: hook as never }
    );
    expect(result.validationError).toMatch(/no stored rows/);
    expect(result.matchedCount).toBe(0);
  });

  it("a sector filter still refuses even with a hook (not enrichable)", async () => {
    DynamicMarketScreener.setTestListingsFixture(LISTINGS);
    const hook = { enrich: vi.fn(async () => { throw new Error("must not run"); }) };
    const result = await new DynamicMarketScreener().screenLive(
      { momentum: "bullish_breakout", sector: "Technology" },
      { enrichment: hook as never }
    );
    expect(result.validationError).toMatch(/sector/);
    expect(hook.enrich).not.toHaveBeenCalled();
  });

  it("a filter needing no technicals never calls the hook", async () => {
    DynamicMarketScreener.setTestListingsFixture(LISTINGS);
    const hook = { enrich: vi.fn(async () => { throw new Error("must not run"); }) };
    const result = await new DynamicMarketScreener().screenLive(
      { exchange: "ALL" },
      { enrichment: hook as never }
    );
    expect(hook.enrich).not.toHaveBeenCalled();
    expect(result.validationError).toBeUndefined();
  });
});
