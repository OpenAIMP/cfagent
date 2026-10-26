/**
 * Issue #1745 ([AGENTIC] Automated market data circuit breakers).
 *
 * Pins: the factory opt-in — createYahooDataProvider wraps the
 * provider in the breaker Decorator exactly when a breaker is
 * passed, and leaves the raw provider untouched otherwise (so
 * verifiers and conformance tests, which pass no breaker, are
 * unaffected). The wrapped path trips and then surfaces the
 * business error instead of the raw provider error.
 */
import { describe, expect, it, vi } from "vitest";
import { createBreakerRegistry } from "../src/breakers/breakerPorts";
import { BreakerOpenError } from "../src/breakers/breakerDecorator";
import {
  createAlpacaDataProvider,
  createYahooDataProvider,
} from "../src/trading/dataProviders/adapters";

function fakeProvider(providerId: "yfinance" | "alpaca") {
  return {
    providerId,
    name: `${providerId} (fake)`,
    isConfigured: vi.fn(() => true),
    getQuote: vi.fn(async (symbol: string) => ({ symbol, price: 100 })),
    getFundamentals: vi.fn(async (symbol: string) => ({ symbol })),
    getHistoricalBars: vi.fn(async (symbol: string) => [{ symbol }]),
  };
}

describe("factory breaker opt-in", () => {
  it("yahoo: fallback attempted on failure; tripped breaker serves the fallback error, never the raw error", async () => {
    const inner = fakeProvider("yfinance");
    inner.getQuote.mockRejectedValue(new Error("raw yahoo 500"));
    const registry = createBreakerRegistry();
    const adapter = createYahooDataProvider(inner as never, undefined, {
      breaker: registry.breakerFor("yahoo"),
    });
    // No cached quote exists, so the Yahoo cache fallback itself
    // throws its business error — the raw provider error never
    // surfaces, and the failures still count toward the trip.
    for (let i = 0; i < 3; i++) {
      await expect(adapter.getQuote("AAPL")).rejects.toThrow(
        /yahoo fallback unavailable: no cached Yahoo quote/
      );
    }
    expect(registry.breakerFor("yahoo").getState()).toBe("open");
    const callsBefore = inner.getQuote.mock.calls.length;
    await expect(adapter.getQuote("AAPL")).rejects.toThrow(
      /yahoo fallback unavailable: no cached Yahoo quote/
    );
    expect(inner.getQuote.mock.calls.length).toBe(callsBefore);
  });

  it("alpaca (no fallback): trips after threshold, then the business error", async () => {
    const inner = fakeProvider("alpaca");
    inner.getQuote.mockRejectedValue(new Error("raw alpaca 500"));
    const registry = createBreakerRegistry();
    const adapter = createAlpacaDataProvider(inner as never, undefined, {
      breaker: registry.breakerFor("alpaca"),
    });
    for (let i = 0; i < 3; i++) {
      await expect(adapter.getQuote("AAPL")).rejects.toThrow("raw alpaca 500");
    }
    expect(registry.breakerFor("alpaca").getState()).toBe("open");
    await expect(adapter.getQuote("AAPL")).rejects.toThrow(BreakerOpenError);
  });

  it("without a breaker, raw provider errors propagate unchanged every time", async () => {
    const inner = fakeProvider("yfinance");
    inner.getQuote.mockRejectedValue(new Error("raw yahoo 500"));
    const adapter = createYahooDataProvider(inner as never, undefined, {});
    for (let i = 0; i < 5; i++) {
      await expect(adapter.getQuote("AAPL")).rejects.toThrow("raw yahoo 500");
    }
    expect(inner.getQuote.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});
