/**
 * Issue #1654 slice 8 (adapter half) — minute-bar provider extension.
 *
 * The two historical-bars providers in src/services/fossResearch.ts
 * (YahooFinanceProvider, AlpacaMarketDataProvider) silently collapsed
 * every minute timeframe to daily bars (slice 7's finding: both mapped
 * only W/M/H/D, and both truncated timestamps to date-only, so no ET
 * intraday window could be built). This suite pins the extension:
 * minute timeframes pass through to the upstream APIs, full ISO
 * timestamps are preserved, existing daily mappings stay byte-identical,
 * and unmapped minute values fail explicitly instead of collapsing.
 *
 * Fixtures only — no live network (the suite is hermetic; fetch is
 * stubbed per test). Production code passes provider data through;
 * nothing here fabricates a bar.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  YahooFinanceProvider,
  AlpacaMarketDataProvider,
} from "../src/services/fossResearch";
import type { Env } from "../src/types";

function jsonResponse(body: unknown, ok = true): any {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (_h: string) => null },
  };
}

function stubFetch(handler: (url: string) => Promise<any>) {
  const mock = vi.fn(async (input: any) => handler(String(input)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Two 15-minute-apart epochs on 2026-10-26 (a Monday, regular session).
const EPOCH_1 = 1761492600; // 2026-10-26T17:30:00Z
const EPOCH_2 = 1761493500; // 2026-10-26T17:45:00Z

const YAHOO_CHART = {
  chart: {
    result: [
      {
        timestamp: [EPOCH_1, EPOCH_2],
        indicators: {
          quote: [
            {
              open: [100, 101],
              high: [101, 102],
              low: [99, 100],
              close: [100.5, 101.5],
              volume: [1000, 2000],
            },
          ],
        },
      },
    ],
  },
};

const ALPACA_BARS = {
  bars: [
    { t: "2026-10-26T17:30:00Z", o: 100, h: 101, l: 99, c: 100.5, v: 1000, vw: 100.2, n: 50 },
    { t: "2026-10-26T17:45:00Z", o: 101, h: 102, l: 100, c: 101.5, v: 2000, vw: 101.2, n: 60 },
  ],
};

const ALPACA_ENV = {
  ALPACA_API_KEY_ID: "key",
  ALPACA_API_SECRET_KEY: "secret",
  ALPACA_DATA_URL: "https://data.alpaca.test",
} as unknown as Env;

describe("Yahoo minute intervals (#1654 slice 8 adapters)", () => {
  it("15Min requests interval=15m with range=1d (today's session)", async () => {
    const fetchMock = stubFetch(async (url) => {
      if (url.includes("/v8/finance/chart/")) return jsonResponse(YAHOO_CHART);
      throw new Error("unexpected url " + url);
    });
    const bars = await new YahooFinanceProvider().getHistoricalBars("AAPL", "15Min", 30);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("interval=15m");
    expect(url).toContain("range=1d");
    expect(bars.length).toBe(2);
  });

  it("1Min/2Min/5Min/30Min/90Min map to 1m/2m/5m/30m/90m", async () => {
    for (const [tf, interval] of [
      ["1Min", "1m"],
      ["2Min", "2m"],
      ["5Min", "5m"],
      ["30Min", "30m"],
      ["90Min", "90m"],
    ] as const) {
      const fetchMock = stubFetch(async (url) => {
        if (url.includes("/v8/finance/chart/")) return jsonResponse(YAHOO_CHART);
        throw new Error("unexpected url " + url);
      });
      await new YahooFinanceProvider().getHistoricalBars("AAPL", tf, 30);
      expect(String(fetchMock.mock.calls[0][0])).toContain(`interval=${interval}`);
      vi.unstubAllGlobals();
    }
  });

  it("60Min is a documented alias for 1h (Yahoo has no 60m interval)", async () => {
    const fetchMock = stubFetch(async (url) => {
      if (url.includes("/v8/finance/chart/")) return jsonResponse(YAHOO_CHART);
      throw new Error("unexpected url " + url);
    });
    await new YahooFinanceProvider().getHistoricalBars("AAPL", "60Min", 30);
    expect(String(fetchMock.mock.calls[0][0])).toContain("interval=1h");
  });

  it("Yahoo bars preserve full ISO timestamps (epoch -> ISO, not date-only)", async () => {
    stubFetch(async (url) => {
      if (url.includes("/v8/finance/chart/")) return jsonResponse(YAHOO_CHART);
      throw new Error("unexpected url " + url);
    });
    const bars = await new YahooFinanceProvider().getHistoricalBars("AAPL", "15Min", 30);
    expect(bars[0].timestamp).toBe(new Date(EPOCH_1 * 1000).toISOString());
    expect(bars[1].timestamp).toBe(new Date(EPOCH_2 * 1000).toISOString());
    expect(bars[0].timestamp).toContain("T");
  });

  it("daily Yahoo bars also carry full ISO timestamps (no date-only truncation)", async () => {
    stubFetch(async (url) => {
      if (url.includes("/v8/finance/chart/")) return jsonResponse(YAHOO_CHART);
      throw new Error("unexpected url " + url);
    });
    const bars = await new YahooFinanceProvider().getHistoricalBars("AAPL", "1D", 30);
    expect(bars[0].timestamp).toBe(new Date(EPOCH_1 * 1000).toISOString());
  });

  it("existing daily mappings are unchanged (1D/1W/1M/1H intervals)", async () => {
    for (const [tf, interval] of [
      ["1D", "1d"],
      ["1W", "1wk"],
      ["1M", "1mo"],
      ["1H", "1h"],
    ] as const) {
      const fetchMock = stubFetch(async (url) => {
        if (url.includes("/v8/finance/chart/")) return jsonResponse(YAHOO_CHART);
        throw new Error("unexpected url " + url);
      });
      await new YahooFinanceProvider().getHistoricalBars("AAPL", tf, 30);
      expect(String(fetchMock.mock.calls[0][0])).toContain(`interval=${interval}`);
      vi.unstubAllGlobals();
    }
  });

  it("15M stays monthly (1mo) — the M-vs-MIN distinction is preserved", async () => {
    const fetchMock = stubFetch(async (url) => {
      if (url.includes("/v8/finance/chart/")) return jsonResponse(YAHOO_CHART);
      throw new Error("unexpected url " + url);
    });
    await new YahooFinanceProvider().getHistoricalBars("AAPL", "15M", 30);
    expect(String(fetchMock.mock.calls[0][0])).toContain("interval=1mo");
  });

  it("an unmapped minute value fails explicitly before any fetch (never collapses to daily)", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(YAHOO_CHART));
    await expect(new YahooFinanceProvider().getHistoricalBars("AAPL", "7Min", 30)).rejects.toThrow(
      /unsupported.*timeframe/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Alpaca minute timeframes (#1654 slice 8 adapters)", () => {
  it("15Min requests timeframe=15Min", async () => {
    const fetchMock = stubFetch(async (url) => {
      if (url.includes("/bars")) return jsonResponse(ALPACA_BARS);
      throw new Error("unexpected url " + url);
    });
    const bars = await new AlpacaMarketDataProvider(ALPACA_ENV).getHistoricalBars("AAPL", "15Min", 30);
    expect(String(fetchMock.mock.calls[0][0])).toContain("timeframe=15Min");
    expect(bars.length).toBe(2);
  });

  it("1Min/5Min/59Min pass through verbatim (upstream range is 1–59Min)", async () => {
    for (const tf of ["1Min", "5Min", "59Min"] as const) {
      const fetchMock = stubFetch(async (url) => {
        if (url.includes("/bars")) return jsonResponse(ALPACA_BARS);
        throw new Error("unexpected url " + url);
      });
      await new AlpacaMarketDataProvider(ALPACA_ENV).getHistoricalBars("AAPL", tf, 30);
      expect(String(fetchMock.mock.calls[0][0])).toContain(`timeframe=${tf}`);
      vi.unstubAllGlobals();
    }
  });

  it("Alpaca bars preserve full ISO timestamps verbatim (no date-only truncation)", async () => {
    stubFetch(async (url) => {
      if (url.includes("/bars")) return jsonResponse(ALPACA_BARS);
      throw new Error("unexpected url " + url);
    });
    const bars = await new AlpacaMarketDataProvider(ALPACA_ENV).getHistoricalBars("AAPL", "15Min", 30);
    expect(bars[0].timestamp).toBe("2026-10-26T17:30:00Z");
    expect(bars[1].timestamp).toBe("2026-10-26T17:45:00Z");
  });

  it("daily Alpaca bars also carry full ISO timestamps (no date-only truncation)", async () => {
    stubFetch(async (url) => {
      if (url.includes("/bars")) return jsonResponse(ALPACA_BARS);
      throw new Error("unexpected url " + url);
    });
    const bars = await new AlpacaMarketDataProvider(ALPACA_ENV).getHistoricalBars("AAPL", "1D", 30);
    expect(bars[0].timestamp).toBe("2026-10-26T17:30:00Z");
  });

  it("existing daily mappings are unchanged (1D/1W/1M/1H timeframes)", async () => {
    for (const [tf, alpacaTf] of [
      ["1D", "1Day"],
      ["1W", "1Week"],
      ["1M", "1Month"],
      ["1H", "1Hour"],
    ] as const) {
      const fetchMock = stubFetch(async (url) => {
        if (url.includes("/bars")) return jsonResponse(ALPACA_BARS);
        throw new Error("unexpected url " + url);
      });
      await new AlpacaMarketDataProvider(ALPACA_ENV).getHistoricalBars("AAPL", tf, 30);
      expect(String(fetchMock.mock.calls[0][0])).toContain(`timeframe=${alpacaTf}`);
      vi.unstubAllGlobals();
    }
  });

  it("the minute mapping applies to the crypto bars endpoint too", async () => {
    const fetchMock = stubFetch(async (url) => {
      if (url.includes("/bars")) return jsonResponse({ bars: { "BTC/USD": ALPACA_BARS.bars } });
      throw new Error("unexpected url " + url);
    });
    await new AlpacaMarketDataProvider(ALPACA_ENV).getHistoricalBars("BTC/USD", "15Min", 30);
    expect(String(fetchMock.mock.calls[0][0])).toContain("timeframe=15Min");
  });

  it("out-of-range minute values (0Min, 60Min) fail explicitly before any fetch", async () => {
    for (const tf of ["0Min", "60Min"] as const) {
      const fetchMock = stubFetch(async () => jsonResponse(ALPACA_BARS));
      await expect(new AlpacaMarketDataProvider(ALPACA_ENV).getHistoricalBars("AAPL", tf, 30)).rejects.toThrow(
        /unsupported.*timeframe/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("unconfigured Alpaca still rejects (existing behavior, unchanged)", async () => {
    await expect(
      new AlpacaMarketDataProvider({} as Env).getHistoricalBars("AAPL", "15Min", 30),
    ).rejects.toThrow(/unavailable/i);
  });
});
