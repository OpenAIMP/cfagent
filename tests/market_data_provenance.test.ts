import { describe, it, expect, vi, afterEach } from "vitest";
import { __resetQuoteCache } from "../src/services/quoteCache";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose real
// module graph pulls in `cloudflare:` protocol imports the node test loader
// cannot resolve. Mock it with a plain base class (same pattern as
// tests/schedules_create_route.test.ts) so the /market-data/bars route can be
// driven through the real onRequest dispatch.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import {
  YahooFinanceProvider,
  AlpacaMarketDataProvider,
  HybridMarketDataProvider,
  MarketDataResearchService,
  marketDataResearchBarsSourceLabel,
  weakestMarketDataResearchProvenance,
} from "../src/services/marketDataResearch";
// Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
// Agents SDK actors now — mock the SDK with a plain base class
// (the api_chat_route.test.ts idiom) so the real module graph's
// `cloudflare:` imports never reach the node loader.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

/**
 * Issue #117 (audit #115 F10/F11) provenance contract, as superseded by
 * issue #923 (epic #913 S5) — live-only: a failed live fetch now REJECTS
 * with an explicit unavailable error; no static/generated substitute is
 * served anywhere. The live pins below are unchanged: a successful
 * (mocked) live fetch IS provenance "live", the /market-data/bars route derives
 * its `source` from the bars' actual provenance, and a fully live report
 * may say "consensus" with its provenance bound into the DID attestation.
 * The former #117 fallback pins are rewritten here as #923 rejection pins.
 */

const CHART_PAYLOAD = {
  chart: {
    result: [
      {
        meta: {
          symbol: "NVDA",
          longName: "NVIDIA Corporation",
          currency: "USD",
          regularMarketPrice: 200,
          regularMarketPreviousClose: 195,
          chartPreviousClose: 195,
          regularMarketVolume: 1234567,
          regularMarketDayHigh: 205,
          regularMarketDayLow: 198,
          fiftyTwoWeekHigh: 220,
          fiftyTwoWeekLow: 100,
        },
        timestamp: [1700000000, 1700086400, 1700172800],
        indicators: {
          quote: [
            {
              close: [190, 195, 200],
              open: [189, 194, 199],
              high: [192, 197, 202],
              low: [188, 193, 197],
              volume: [1000, 1100, 1200],
            },
          ],
        },
      },
    ],
  },
};

const QUOTE_SUMMARY_PAYLOAD = {
  quoteSummary: {
    result: [
      {
        price: { longName: "NVIDIA Corporation", marketCap: { raw: 5e12 } },
        summaryDetail: {
          trailingPE: { raw: 55 },
          forwardPE: { raw: 40 },
          marketCap: { raw: 5e12 },
          fiftyTwoWeekHigh: { raw: 220 },
          fiftyTwoWeekLow: { raw: 100 },
          dividendYield: { raw: 0.001 },
        },
        defaultKeyStatistics: {
          enterpriseValue: { raw: 5.1e12 },
          pegRatio: { raw: 1.1 },
          priceToBook: { raw: 40 },
          beta: { raw: 1.7 },
        },
        financialData: {
          targetMeanPrice: { raw: 250 },
          targetHighPrice: { raw: 300 },
          targetLowPrice: { raw: 180 },
          recommendationKey: "strong_buy",
          recommendationMean: { raw: 1.4 },
          numberOfAnalystOpinions: { raw: 42 },
          profitMargins: { raw: 0.55 },
          operatingMargins: { raw: 0.6 },
          returnOnEquity: { raw: 1.1 },
          totalRevenue: { raw: 1.3e11 },
          grossProfits: { raw: 9e10 },
          ebitda: { raw: 8e10 },
          freeCashflow: { raw: 6e10 },
        },
      },
    ],
  },
};

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

function stubFetchDown() {
  return stubFetch(async () => {
    throw new Error("network unavailable");
  });
}

/** Yahoo chart endpoints succeed; everything else (crumb, quoteSummary) fails. */
function stubFetchChartOnly() {
  return stubFetch(async (url) => {
    if (url.includes("/v8/finance/chart/")) return jsonResponse(CHART_PAYLOAD);
    throw new Error("endpoint unavailable");
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  // #930: the module-level quote cache leaks across tests in this file —
  // an earlier successful NVDA fetch would otherwise make the "fully live
  // report" test read a cached quote (now honestly stamped "cached").
  // Resetting restores that test's fresh-fetch premise; no assertion here
  // is weakened.
  __resetQuoteCache();
});

describe("provenance helpers (#117)", () => {
  it("weakestMarketDataResearchProvenance returns the least-live input", () => {
    expect(weakestMarketDataResearchProvenance("live")).toBe("live");
    expect(weakestMarketDataResearchProvenance("live", "static")).toBe("static");
    expect(weakestMarketDataResearchProvenance("live", "static", "generated")).toBe("generated");
    expect(weakestMarketDataResearchProvenance()).toBe("live");
  });

  it("marketDataResearchBarsSourceLabel names the provider API only for live bars", () => {
    expect(marketDataResearchBarsSourceLabel("yfinance", "live")).toBe("Yahoo Finance Chart API");
    expect(marketDataResearchBarsSourceLabel("alpaca", "live")).toBe("Alpaca Market Data v2");
    expect(marketDataResearchBarsSourceLabel("yfinance", "generated")).toContain("not live");
    expect(marketDataResearchBarsSourceLabel("alpaca", "generated")).not.toContain("Alpaca Market Data v2");
    expect(marketDataResearchBarsSourceLabel("yfinance", "static")).toContain("not live");
  });
});

describe("Yahoo quote provenance (#117)", () => {
  it("failed fetch + table ticker -> rejects explicit unavailable, never a static price (#923)", async () => {
    stubFetchDown();
    await expect(new YahooFinanceProvider().getQuote("NVDA")).rejects.toThrow(/unavailable/i);
  });

  it("failed fetch + unknown ticker -> rejects explicit unavailable, never a hash-invented profile (#923)", async () => {
    stubFetchDown();
    await expect(new YahooFinanceProvider().getQuote("CUSTOMCORP")).rejects.toThrow(/unavailable/i);
  });

  it("successful chart fetch -> live", async () => {
    stubFetchChartOnly();
    const quote = await new YahooFinanceProvider().getQuote("NVDA");
    expect(quote.provenance).toBe("live");
    expect(quote.note).toBeUndefined();
    expect(quote.price).toBe(200);
  });
});

describe("Alpaca quote provenance (#117)", () => {
  it("unconfigured Alpaca rejects — no profile served, static or generated (#923)", async () => {
    stubFetchDown();
    const provider = new AlpacaMarketDataProvider({} as Env);
    await expect(provider.getQuote("AAPL")).rejects.toThrow(/unavailable/i);
    await expect(provider.getQuote("ZZZZUNKNOWN")).rejects.toThrow(/unavailable/i);
  });

  it("configured Alpaca with a failing fetch rejects — no profile fallback (#923)", async () => {
    stubFetchDown();
    const env = {
      ALPACA_API_KEY_ID: "key",
      ALPACA_API_SECRET_KEY: "secret",
      ALPACA_DATA_URL: "https://data.alpaca.test",
    } as unknown as Env;
    await expect(new AlpacaMarketDataProvider(env).getQuote("AAPL")).rejects.toThrow(/unavailable/i);
  });

  it("configured Alpaca with a successful fetch -> live", async () => {
    stubFetch(async (url) => {
      if (url.includes("/quotes/latest")) {
        return jsonResponse({ quote: { bp: 150.1, ap: 150.3, bs: 10, as: 12, t: "2026-10-17T13:00:00Z" } });
      }
      throw new Error("unexpected url " + url);
    });
    const env = {
      ALPACA_API_KEY_ID: "key",
      ALPACA_API_SECRET_KEY: "secret",
      ALPACA_DATA_URL: "https://data.alpaca.test",
    } as unknown as Env;
    const quote = await new AlpacaMarketDataProvider(env).getQuote("AAPL");
    expect(quote.provenance).toBe("live");
    expect(quote.price).toBe(150.2);
  });
});

describe("Historical bars provenance (#117)", () => {
  it("Yahoo failed bars reject — no synthetic bars (#923)", async () => {
    stubFetchDown();
    await expect(new YahooFinanceProvider().getHistoricalBars("AAPL", "1D", 30)).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("Yahoo live bars are live", async () => {
    stubFetchChartOnly();
    const bars = await new YahooFinanceProvider().getHistoricalBars("NVDA", "1D", 30);
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((b) => b.provenance === "live")).toBe(true);
  });

  it("unconfigured Alpaca bars reject — no synthetic bars (#923)", async () => {
    stubFetchDown();
    await expect(
      new AlpacaMarketDataProvider({} as Env).getHistoricalBars("AAPL", "1D", 30),
    ).rejects.toThrow(/unavailable/i);
  });

  it("configured Alpaca live bars are live", async () => {
    stubFetch(async (url) => {
      if (url.includes("/bars")) {
        return jsonResponse({
          bars: [
            { t: "2026-10-15T04:00:00Z", o: 148, h: 152, l: 147, c: 151, v: 900000, vw: 150.1, n: 4200 },
            { t: "2026-10-16T04:00:00Z", o: 151, h: 153, l: 150, c: 152, v: 950000, vw: 151.8, n: 4500 },
          ],
        });
      }
      throw new Error("unexpected url " + url);
    });
    const env = {
      ALPACA_API_KEY_ID: "key",
      ALPACA_API_SECRET_KEY: "secret",
      ALPACA_DATA_URL: "https://data.alpaca.test",
    } as unknown as Env;
    const bars = await new AlpacaMarketDataProvider(env).getHistoricalBars("AAPL", "1D", 30);
    expect(bars.length).toBe(2);
    expect(bars.every((b) => b.provenance === "live")).toBe(true);
  });
});

describe("GET /market-data/bars route source stamping (#117)", () => {
  function makeAgent() {
    const sql = new MockSqlStorage();
    const ctx = {
      storage: { sql },
      id: { toString: () => "market-data-bars-route-test" },
    } as any;
    const agent: any = Object.create(OrchestratorAgent.prototype);
    agent.ctx = ctx;
    agent.env = {} as any;
    // onRequest touches the typed scheduling API during dispatch (the same
    // stubs tests/schedules_create_route.test.ts installs).
    agent.schedule = async () => ({ id: "stub-schedule" });
    agent.scheduleEvery = async () => ({ id: "stub-interval" });
    return agent;
  }

  async function getBars(agent: any, qs: string) {
    // onRequest queues /api requests as 202 async jobs; the job executor
    // (orchestrator.ts, capability "http.request") rebuilds the request and
    // calls routeRequest — drive the same production path here.
    const res = await agent.routeRequest(
      new Request(new URL(`/api/market-data/bars?${qs}`, "https://agent.internal"))
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  it("failed bars: route returns an explicit 500 unavailable error, no generated bars (#923)", async () => {
    stubFetchDown();
    const { status, body } = await getBars(makeAgent(), "symbol=NVDA&provider=yfinance");
    expect(status).toBe(500);
    expect(body.error).toMatch(/unavailable/i);
    expect(body.bars).toBeUndefined();
  });

  it("live bars: provenance live and source names the provider API", async () => {
    stubFetchChartOnly();
    const { status, body } = await getBars(makeAgent(), "symbol=NVDA&provider=yfinance");
    expect(status).toBe(200);
    expect(body.provenance).toBe("live");
    expect(body.source).toBe("Yahoo Finance Chart API");
  });
});

describe("Fundamentals provenance (#117)", () => {
  it("failed fetches reject — no profile fundamentals, static or generated (#923)", async () => {
    stubFetchDown();
    const yf = new YahooFinanceProvider();
    await expect(yf.getFundamentals("MSFT")).rejects.toThrow(/unavailable/i);
    await expect(yf.getFundamentals("CUSTOMCORP")).rejects.toThrow(/unavailable/i);
  });

  it("chart-only fundamentals reject — no formula analyst block (#923)", async () => {
    stubFetchChartOnly();
    await expect(new YahooFinanceProvider().getFundamentals("NVDA")).rejects.toThrow(
      /unavailable/i,
    );
  });
});

describe("Hybrid quote provenance (#117)", () => {
  it("offline hybrid quote rejects — no weakest-provenance composite (#923)", async () => {
    // HYBOFF is never cached live earlier in this file (NVDA is, by the
    // successful-chart test), so a fetch-down stub genuinely exercises
    // the failure path instead of the 5-minute live-quote cache.
    stubFetchDown();
    const hybrid = new HybridMarketDataProvider({} as Env);
    await expect(hybrid.getQuote("HYBOFF")).rejects.toThrow(/unavailable/i);
    await expect(hybrid.getQuote("CUSTOMCORP")).rejects.toThrow(/unavailable/i);
  });
});

describe("Research report provenance (#117, F11)", () => {
  it("offline report rejects — no non-live report is assembled (#923)", async () => {
    stubFetchDown();
    await expect(new MarketDataResearchService({} as Env).generateResearchReport("NVDA")).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("sync report path throws explicit unavailable (#923)", () => {
    expect(() => new MarketDataResearchService({} as Env).generateResearchReportSync("CUSTOMCORP")).toThrow(
      /unavailable/i,
    );
  });
});

// NOTE: this describe runs last — a successful Yahoo crumb session is cached
// at module level for an hour, so the live-fundamentals/report tests are kept
// together at the end of the file.
describe("Live fundamentals and live report (#117)", () => {
  function stubFetchLiveYahoo() {
    return stubFetch(async (url) => {
      if (url.includes("fc.yahoo.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "",
          headers: { get: (h: string) => (h === "set-cookie" ? "A1=dummy; path=/" : null) },
        };
      }
      if (url.includes("getcrumb")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "dummy-crumb",
          headers: { get: (_h: string) => null },
        };
      }
      if (url.includes("/v10/finance/quoteSummary/")) return jsonResponse(QUOTE_SUMMARY_PAYLOAD);
      if (url.includes("/v8/finance/chart/")) return jsonResponse(CHART_PAYLOAD);
      throw new Error("unexpected url " + url);
    });
  }

  it("successful quoteSummary fetch -> live fundamentals with the real analyst target", async () => {
    stubFetchLiveYahoo();
    const f = await new YahooFinanceProvider().getFundamentals("NVDA");
    expect(f.provenance).toBe("live");
    expect(f.targetMeanPrice).toBe(250);
    expect(f.numberOfAnalystOpinions).toBe(42);
  });

  it("fully live report: provenance live and the narrative may say consensus", async () => {
    stubFetchLiveYahoo();
    const report = await new MarketDataResearchService({} as Env).generateResearchReport("NVDA");
    expect(report.quote.provenance).toBe("live");
    expect(report.fundamentals.provenance).toBe("live");
    expect(report.bars.every((b) => b.provenance === "live")).toBe(true);
    expect(report.provenance).toBe("live");
    expect(report.aiAnalysis).toContain("Consensus target price of $250.00");
    expect(report.aiAnalysis).not.toContain("Data notice");
    expect(report.agentAttestation.provenance).toBe("live");
  });
});
