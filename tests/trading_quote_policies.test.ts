/**
 * Issue #291 quote unification — the LIVE_STRICT policy, pinned.
 *
 * Characterization of the semantics ETradeService.fetchQuoteRemote has
 * always enforced (and researchProviders relied on): a good live quote
 * wins; stub quotes never count; in the live environment a failure
 * throws with the carried detail — never a stale substitution; outside
 * it, the platform default chain answers.
 */

import { describe, it, expect } from "vitest";
import { fetchQuoteLiveStrict, isStubQuote } from "../src/trading/quotePolicies";
import type { ITradingPlatform } from "../src/trading/interfaces";

const good: any = { symbol: "AAPL", companyName: "Apple Inc.", lastPrice: 150 };
const stub: any = { symbol: "AAPL", companyName: "GOOGLE INC", lastPrice: 577.51 };

function platform(over: Partial<ITradingPlatform>): ITradingPlatform {
  return {
    platformId: "etrade",
    name: "fake",
    getStatus: async () => ({}),
    getQuote: async () => ({ ...good, quoteStatus: "STATIC_FALLBACK" }),
    getAccounts: async () => [],
    getPositions: async () => [],
    previewOrder: async () => ({}),
    executeOrder: async () => ({}),
    ...over,
  } as ITradingPlatform;
}

describe("isStubQuote", () => {
  it("flags the placeholder except for GOOG/GOOGL themselves", () => {
    expect(isStubQuote(stub, "AAPL")).toBe(true);
    expect(isStubQuote(stub, "GOOG")).toBe(false);
    expect(isStubQuote(stub, "GOOGL")).toBe(false);
    expect(isStubQuote(good, "AAPL")).toBe(false);
    expect(isStubQuote({ ...good, lastPrice: 577.51 }, "AAPL")).toBe(true);
  });
});

describe("fetchQuoteLiveStrict (#291)", () => {
  it("returns a good live quote untouched", async () => {
    const p = platform({ getQuoteDetailed: async () => ({ quote: good, error: null }) });
    await expect(fetchQuoteLiveStrict(p, "AAPL", { isLive: true })).resolves.toBe(good);
  });

  it("live env: a carried error throws with its detail", async () => {
    const p = platform({ getQuoteDetailed: async () => ({ quote: null, error: "OAuth token expired" }) });
    await expect(fetchQuoteLiveStrict(p, "AAPL", { isLive: true })).rejects.toThrow("OAuth token expired");
  });

  it("live env: a stub quote throws the generic no-live-quote error", async () => {
    const p = platform({ getQuoteDetailed: async () => ({ quote: stub, error: null }) });
    await expect(fetchQuoteLiveStrict(p, "AAPL", { isLive: true })).rejects.toThrow(
      "E*TRADE returned no live quote for AAPL",
    );
  });

  it("sandbox: failure falls back to the platform default chain", async () => {
    const p = platform({ getQuoteDetailed: async () => ({ quote: null, error: "down" }) });
    const q: any = await fetchQuoteLiveStrict(p, "AAPL", { isLive: false });
    expect(q.quoteStatus).toBe("STATIC_FALLBACK");
  });

  it("a platform without the detailed read fails closed in live env", async () => {
    const p = platform({});
    await expect(fetchQuoteLiveStrict(p, "AAPL", { isLive: true })).rejects.toThrow(
      "does not expose detailed quote reads",
    );
  });
});
