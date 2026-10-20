/**
 * Issue #118 (audit F12/F13): E*TRADE quote fallback provenance.
 *
 * When the live REST quote call fails, the platform/service fall back to
 * static data (curated universe table / cached screener universe). Those
 * fallbacks must never be stamped REALTIME / "E*TRADE Live Market Feed",
 * must not invent bid/ask/volume, and every surface priced or narrated from
 * them (order previews, NLQ chat/voice answers) must disclose the non-live
 * pricing basis. The genuine live path stays byte-identical.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeService } from "../src/services/etrade";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { planNLQ, executeNLQQuery, executeNLQQueryAsync, formatTradingQuoteHeadline } from "../src/agents/nlq";
import type { Env, ETradeQuote } from "../src/types";

const liveEnv: Env = {
  APP_BASE_URL: "https://agent.openaimp.com",
  ETRADE_ENVIRONMENT: "live",
} as Env;

const sandboxEnv: Env = {
  APP_BASE_URL: "https://agent.openaimp.com",
  ETRADE_ENVIRONMENT: "sandbox",
} as Env;

// JPM is in the curated universe (defaultPrice 222) but NOT in the screener
// test fixture, so it exercises the curated-table fallback deterministically.
const CURATED_ONLY = "JPM";
const FIXTURE_SYMBOL = "NVDA";

const nullClient = { fetchQuote: async () => null } as any;

function liveQuote(symbol: string): ETradeQuote {
  return {
    symbol,
    companyName: "Live Corp",
    lastPrice: 500.25,
    price: 500.25,
    change: 5.25,
    changePercent: 1.06,
    bid: 500.2,
    ask: 500.3,
    volume: 1234567,
    open: 495,
    high: 502,
    low: 494,
    week52High: 550,
    week52Low: 400,
    quoteStatus: "REALTIME",
    source: "E*TRADE REST API [PROD / Live]",
    timestamp: new Date().toISOString(),
  };
}

describe("Issue #118 — E*TRADE quote fallback provenance", () => {
  let orm: DatabaseORM;
  const sessionId = "quote_provenance_session";

  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    const sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
  });

  afterEach(() => {
    DynamicMarketScreener.setTestUniverseFixture([]);
  });

  describe("platform getQuote (F12)", () => {
    it("LIVE env + failed REST + curated symbol → STATIC_FALLBACK, no invented bid/ask/volume", async () => {
      const platform = new ETradeTradingPlatform(liveEnv, undefined, "tester", undefined, nullClient);
      const q = await platform.getQuote(CURATED_ONLY);
      expect(q.quoteStatus).toBe("STATIC_FALLBACK");
      expect(q.quoteStatus).not.toBe("REALTIME");
      expect(q.source).not.toContain("Live Market Feed");
      expect(q.source).toMatch(/curated/i);
      expect(q.lastPrice).toBe(222);
      expect(q.bid).toBe(0);
      expect(q.ask).toBe(0);
      expect(q.volume).toBe(0);
      expect(q.week52High).toBe(0);
      expect(q.week52Low).toBe(0);
    });

    it("LIVE env + failed REST + cached universe symbol → never upgraded to REALTIME", async () => {
      const platform = new ETradeTradingPlatform(liveEnv, undefined, "tester", undefined, nullClient);
      const q = await platform.getQuote(FIXTURE_SYMBOL);
      expect(q.quoteStatus).not.toBe("REALTIME");
      expect(q.quoteStatus).toBe("STATIC_FALLBACK");
      expect(q.source).not.toBe("E*TRADE Live Market Feed");
    });

    it("LIVE env + successful REST → live quote returned unchanged", async () => {
      const live = liveQuote("ACME");
      const stubClient = { fetchQuote: async () => live } as any;
      const platform = new ETradeTradingPlatform(liveEnv, undefined, "tester", undefined, stubClient);
      const q = await platform.getQuote("ACME");
      expect(q).toBe(live);
      expect(q.quoteStatus).toBe("REALTIME");
      expect(q.source).toBe("E*TRADE REST API [PROD / Live]");
      expect(q.bid).toBe(500.2);
      expect(q.ask).toBe(500.3);
      expect(q.volume).toBe(1234567);
    });

    it("TEST env + curated symbol → SIMULATED_LEVEL1 stamps kept, invented fields removed", async () => {
      const platform = new ETradeTradingPlatform(sandboxEnv, undefined, "tester", undefined, nullClient);
      const q = await platform.getQuote(CURATED_ONLY);
      expect(q.quoteStatus).toBe("SIMULATED_LEVEL1");
      expect(q.source).toBe("E*TRADE Market Universe Feed");
      expect(q.bid).toBe(0);
      expect(q.ask).toBe(0);
      expect(q.volume).toBe(0);
    });

    it("unknown symbol → throws auth error (issue #294)", async () => {
      const platform = new ETradeTradingPlatform(liveEnv, undefined, "tester", undefined, nullClient);
      await expect(platform.getQuote("ZZZZNOTREAL")).rejects.toThrow(/auth required/i);
    });
  });

  describe("service getQuote twin (F12)", () => {
    it("LIVE env curated symbol → STATIC_FALLBACK with static-table source and zeroed invented fields", () => {
      const service = new ETradeService(orm, liveEnv);
      const q = service.getQuote(CURATED_ONLY);
      expect(q.quoteStatus).toBe("STATIC_FALLBACK");
      expect(q.source).not.toContain("Live");
      expect(q.source).toMatch(/curated/i);
      expect(q.lastPrice).toBe(222);
      expect(q.bid).toBe(0);
      expect(q.ask).toBe(0);
      expect(q.volume).toBe(0);
    });

    it("LIVE env cached universe symbol → STATIC_FALLBACK, not a live-feed label", () => {
      const service = new ETradeService(orm, liveEnv);
      const q = service.getQuote(FIXTURE_SYMBOL);
      expect(q.quoteStatus).toBe("STATIC_FALLBACK");
      expect(q.source).not.toBe("E*TRADE Market Data Feed");
    });

    it("TEST env curated symbol → SIMULATED_LEVEL1 kept (sandbox behaviour unchanged)", () => {
      const service = new ETradeService(orm, sandboxEnv);
      const q = service.getQuote(CURATED_ONLY);
      expect(q.quoteStatus).toBe("SIMULATED_LEVEL1");
      expect(q.source).toBe("E*TRADE Market Data Feed");
      expect(q.bid).toBe(0);
      expect(q.volume).toBe(0);
    });

    it("getQuoteAsync returns a genuine live quote unchanged", async () => {
      const service = new ETradeService(orm, liveEnv);
      const live = liveQuote("ACME");
      // Issue #462: fetchQuoteRemote calls fetchQuoteDetailed (per-call
      // error capture) — mock the detailed seam, not the shared wrapper.
      (service.client as any).fetchQuoteDetailed = async () => ({ quote: live, error: null });
      const q = await service.getQuoteAsync("ACME");
      expect(q).toBe(live);
      expect(q.quoteStatus).toBe("REALTIME");
    });
  });

  describe("order previews priced from fallback quotes (F12)", () => {
    it("platform previewOrder (LIVE, static fallback) flags the draft and the message", async () => {
      const platform = new ETradeTradingPlatform(liveEnv, undefined, "tester", undefined, nullClient);
      const draft = await platform.previewOrder({
        sessionId,
        symbol: CURATED_ONLY,
        orderAction: "BUY",
        quantity: 10,
        orderType: "MARKET",
      });
      expect(draft.pricingQuoteStatus).toBe("STATIC_FALLBACK");
      expect(draft.previewMessage).toContain("NON-LIVE QUOTE");
      expect(draft.previewMessage).toContain("STATIC_FALLBACK");
      expect(draft.estimatedPrice).toBe(222);
    });

    it("service previewOrder (LIVE, static fallback) flags the draft and the message", () => {
      const service = new ETradeService(orm, liveEnv);
      const draft = service.previewOrder({
        sessionId,
        symbol: CURATED_ONLY,
        orderAction: "BUY",
        quantity: 10,
        orderType: "MARKET",
      });
      expect(draft.pricingQuoteStatus).toBe("STATIC_FALLBACK");
      expect(draft.previewMessage).toContain("NON-LIVE QUOTE");
    });

    it("service previewOrder (sandbox, simulated quote) records status without the non-live alarm", () => {
      const service = new ETradeService(orm, sandboxEnv);
      const draft = service.previewOrder({
        sessionId,
        symbol: FIXTURE_SYMBOL,
        orderAction: "BUY",
        quantity: 10,
        orderType: "MARKET",
      });
      expect(draft.pricingQuoteStatus).toBe("SIMULATED_LEVEL1");
      expect(draft.previewMessage).not.toContain("NON-LIVE QUOTE");
    });
  });

  describe("NLQ quote + preview surfaces (F13)", () => {
    it("headline claims 'Real-time' only for a REALTIME quote", () => {
      expect(formatTradingQuoteHeadline(liveQuote("ACME"))).toContain("Real-time quote for ACME");
      const fallback = { ...liveQuote(CURATED_ONLY), quoteStatus: "STATIC_FALLBACK", bid: 0, ask: 0 };
      const headline = formatTradingQuoteHeadline(fallback);
      expect(headline).not.toContain("Real-time");
      expect(headline).toContain("Static fallback quote");
      expect(headline).toContain("not live market data");
      const simulated = { ...liveQuote(CURATED_ONLY), quoteStatus: "SIMULATED_LEVEL1" };
      expect(formatTradingQuoteHeadline(simulated)).toContain("Simulated quote");
      const delayed = { ...liveQuote("ACME"), quoteStatus: "DELAYED" };
      expect(formatTradingQuoteHeadline(delayed)).toContain("Delayed quote");
      expect(formatTradingQuoteHeadline(delayed)).not.toContain("Real-time quote");
    });

    it("sync quote action: rows carry quoteStatus and the summary never claims real-time for fallback data", async () => {
      const plan = await planNLQ(sandboxEnv, `quote ${CURATED_ONLY}`);
      expect(plan.tradingData?.action).toBe("quote");
      const result = executeNLQQuery(orm, sessionId, plan, sandboxEnv);
      expect(result.rows[0].quoteStatus).toBe("SIMULATED_LEVEL1");
      expect(result.summary).not.toContain("Real-time quote");
      expect(result.summary).toContain("Simulated quote");
      expect(result.rows[0].bidAsk).toBe("N/A (no live bid/ask)");
    });

    it("async quote action: rows carry quoteStatus and the summary never claims real-time for fallback data", async () => {
      const plan = await planNLQ(sandboxEnv, `quote ${CURATED_ONLY}`);
      const result = await executeNLQQueryAsync(orm, sessionId, plan, sandboxEnv);
      expect(result.rows[0].quoteStatus).toBe("SIMULATED_LEVEL1");
      expect(result.summary).not.toContain("Real-time quote");
      expect(result.summary).toContain("Simulated quote");
    });

    it("sync preview_order in LIVE env discloses static-fallback pricing in summary and rows", async () => {
      const plan = await planNLQ(liveEnv, `buy 10 shares of ${CURATED_ONLY}`);
      expect(plan.tradingData?.action).toBe("preview_order");
      const result = executeNLQQuery(orm, sessionId, plan, liveEnv);
      expect(result.rows[0].pricingQuoteStatus).toBe("STATIC_FALLBACK");
      expect(result.summary).toContain("NON-LIVE QUOTE");
      expect(result.summary).toContain("STATIC_FALLBACK");
    });

    it("async preview_order in LIVE env propagates quote failures instead of substituting fallback data", async () => {
      const plan = await planNLQ(liveEnv, `buy 10 shares of ${CURATED_ONLY}`);
      const quoteFailure = vi.spyOn(ETradeService.prototype, "fetchQuoteRemote")
        .mockRejectedValue(new Error("fixture: live quote unavailable"));
      try {
        await expect(executeNLQQueryAsync(orm, sessionId, plan, liveEnv))
          .rejects.toThrow("fixture: live quote unavailable");
      } finally {
        quoteFailure.mockRestore();
      }
    });
  });
});
