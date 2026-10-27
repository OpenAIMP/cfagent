/**
 * #930 (parent #913, S12) — provenance labeling & advertised-surface cleanup.
 *
 * Pins (all must fail before the fix, pass after):
 * 1. A quote served from the 5-minute quote cache is stamped "cached" with
 *    its age — never bare "live" — and carries the same values (no
 *    substitute numbers).
 * 2. environment.config.json no longer advertises the unimplemented
 *    curated-universe preference (curatedUniverseEnabled /
 *    curatedUniversePath / providerPreference).
 * 3. The Alpaca platform's getStatus reports broker "alpaca", not "etrade".
 * 4. The fallbackModel AI-failover surface is gone from config: no
 *    fallbackModel key in the AI config, the environment JSON, or the
 *    EtapiConfigModal client. (Issue #930's second branch: the waiver for
 *    this removal is owed on #913 before this PR can be marked ready.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { YahooFinanceProvider } from "../src/services/marketDataResearch";
import { __resetQuoteCache } from "../src/services/quoteCache";
import envConfig from "../environment.config.json";
import { getAiConfig } from "../src/config/etapiConfig";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";

const CHART_URL = "/v8/finance/chart/";

function chartPayload(symbol: string) {
  const closes = Array.from({ length: 30 }, (_, i) => 200 + i * 0.35);
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            longName: "Wells Fargo & Company",
            regularMarketPrice: 210.5,
            regularMarketPreviousClose: 208.0,
            regularMarketDayHigh: 212.0,
            regularMarketDayLow: 207.0,
            regularMarketVolume: 1234567,
            currency: "USD",
          },
          indicators: { quote: [{ close: closes }] },
        },
      ],
    },
  };
}

beforeEach(() => {
  __resetQuoteCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes(CHART_URL)) {
        const sym = decodeURIComponent(String(url).split(CHART_URL)[1].split("?")[0]);
        return {
          ok: true,
          status: 200,
          json: async () => chartPayload(sym),
          text: async () => JSON.stringify(chartPayload(sym)),
        } as any;
      }
      throw new Error("network down");
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetQuoteCache();
});

describe("#930 cache-hit stamping", () => {
  it("a cached quote is stamped cached with age, never bare live, same values", async () => {
    const provider = new YahooFinanceProvider();
    const fresh = await provider.getQuote("WFC");
    expect(fresh.provenance).toBe("live");
    expect(fresh.price).toBe(210.5);

    const cached = await provider.getQuote("WFC");
    expect(cached.provenance).toBe("cached");
    expect((cached as any).fromCache).toBe(true);
    expect(typeof (cached as any).cacheAgeMs).toBe("number");
    expect((cached as any).cacheAgeMs).toBeGreaterThanOrEqual(0);
    expect(typeof cached.note).toBe("string");
    expect(cached.note).toMatch(/cach/i);
    // Same values, no substitute numbers.
    expect(cached.price).toBe(210.5);
    expect(cached.previousClose).toBe(208.0);
    expect(cached.timestamp).toBe(fresh.timestamp);
  });
});

describe("#930 config matches code: curated-universe preference removed", () => {
  it("environment.config.json advertises no curated-universe preference", () => {
    const etapi = (envConfig as any).defaults.etapi;
    const screener = etapi.screener as Record<string, unknown>;
    const stockScreener = etapi.stockScreener as Record<string, unknown>;
    expect(screener.curatedUniverseEnabled).toBeUndefined();
    expect(screener.curatedUniversePath).toBeUndefined();
    expect(stockScreener.curatedUniverseEnabled).toBeUndefined();
    expect(stockScreener.curatedUniversePath).toBeUndefined();
    expect(stockScreener.providerPreference).toBeUndefined();
  });
});

describe("#930 Alpaca status identity", () => {
  it("Alpaca getStatus reports broker alpaca", async () => {
    const env = {
      ALPACA_API_KEY: "test-key",
      ALPACA_SECRET_KEY: "test-secret",
      ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
    } as any;
    const platform = new AlpacaTradingPlatform(env, undefined, "default_trader");
    const status = await platform.getStatus();
    expect(status.broker).toBe("alpaca");
    expect(status.configured).toBe(true);
  });
});

describe("#930 fallbackModel surface removed", () => {
  it("the AI config carries no fallbackModel key", () => {
    const ai = getAiConfig() as unknown as Record<string, unknown>;
    expect("fallbackModel" in ai).toBe(false);
  });

  it("environment.config.json carries no fallbackModel key", () => {
    const ai = (envConfig as any).defaults.etapi.ai as Record<string, unknown>;
    expect("fallbackModel" in ai).toBe(false);
  });

  it("the EtapiConfigModal client offers no fallbackModel setting", () => {
    const modal = readFileSync("src/client/options/EtapiConfigModal.tsx", "utf8");
    expect(modal).not.toContain("fallbackModel");
    expect(modal).not.toContain("Fallback Resilience Model");
  });
});
