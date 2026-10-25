/**
 * Issue #1555 (parent #913), Alpaca half only — the Nasdaq half was
 * already satisfied by #1554 (ee15dc75) and is not re-done here.
 *
 * AlpacaTradingPlatform.getQuote must never invent numeric fields:
 * peRatio, marketCap, week52High/Low, high52/low52, and rsi are
 * OPTIONAL on ETradeQuote, so a snapshot that lacks them must yield
 * an omitted field — never a hardcoded 28.0 / 50.0 / high*1.25 /
 * low*0.75 / 50.0. Real snapshot values, when present, pass through
 * untouched. Price/bid/ask/volume/open/high/low are real Alpaca
 * data and are unaffected.
 *
 * The platform's AlpacaMarketDataProvider is stubbed (private field
 * via cast) so no network is touched.
 */
import { describe, it, expect } from "vitest";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";

const SNAPSHOT = {
  price: 250.5,
  change: 2.5,
  changePercent: 1.01,
  bid: 250.4,
  ask: 250.6,
  volume: 123456,
  open: 248.0,
  high: 252.0,
  low: 247.5,
};

function platformWithSnapshot(snapshot: Record<string, unknown>) {
  const platform = new AlpacaTradingPlatform(
    {} as never,
    undefined,
    "test-user"
  );
  (platform as unknown as { alpacaData: unknown }).alpacaData = {
    getQuote: async () => snapshot,
  };
  return platform;
}

describe("Issue #1555 — Alpaca getQuote invents nothing", () => {
  it("omits peRatio, marketCap, 52-week, and rsi when the snapshot lacks them", async () => {
    const quote = await platformWithSnapshot({ ...SNAPSHOT }).getQuote("nvda");
    expect(quote.symbol).toBe("NVDA");
    expect(quote.lastPrice).toBe(250.5);
    expect(quote.peRatio).toBeUndefined();
    expect(quote.marketCap).toBeUndefined();
    expect(quote.week52High).toBeUndefined();
    expect(quote.week52Low).toBeUndefined();
    expect(quote.high52).toBeUndefined();
    expect(quote.low52).toBeUndefined();
    expect(quote.rsi).toBeUndefined();
    // Price data is genuinely Alpaca, so the source label stays.
    expect(quote.source).toBe("Alpaca Real-Time NBBO Feed");
  });

  it("passes real snapshot values through when present, never rescaled", async () => {
    const quote = await platformWithSnapshot({
      ...SNAPSHOT,
      high52: 300.0,
      low52: 200.0,
      rsi14: 62.5,
      peRatio: 45.2,
      marketCap: 3.1e12,
    }).getQuote("NVDA");
    expect(quote.week52High).toBe(300.0);
    expect(quote.high52).toBe(300.0);
    expect(quote.week52Low).toBe(200.0);
    expect(quote.low52).toBe(200.0);
    expect(quote.rsi).toBe(62.5);
    expect(quote.peRatio).toBe(45.2);
    expect(quote.marketCap).toBe(3.1e12);
  });
});
