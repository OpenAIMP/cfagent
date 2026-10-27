/**
 * Issue #1745 ([AGENTIC] Automated market data circuit breakers).
 *
 * Pins: the Decorator over IMarketDataProvider (Protected
 * Variations — the interface is unchanged, the wrapper only adds
 * breaker + fallback behavior). Batch/snapshot methods exist on the
 * wrapper exactly when the inner provider offers them (the pipeline's
 * optional-dep check relies on that shape); Sync cache reads pass
 * through unwrapped — they make no provider call.
 */
import { describe, expect, it, vi } from "vitest";
import { createBreakerRegistry } from "../src/breakers/breakerPorts";
import { BreakerOpenError } from "../src/breakers/breakerDecorator";
import { BreakerWrappedMarketDataProvider } from "../src/breakers/marketDataBreakerWrapper";
import type { IMarketDataProvider } from "../src/patterns/interfaces";

const noSleep = async () => {};

function fakeProvider(opts: { withBatch?: boolean; withSnapshot?: boolean } = {}) {
  const inner: any = {
    providerId: "yfinance",
    name: "Yahoo Finance (fake)",
    isConfigured: vi.fn(() => true),
    getQuote: vi.fn(async (symbol: string) => ({ symbol, price: 100 })),
    getFundamentals: vi.fn(async (symbol: string) => ({ symbol })),
    getHistoricalBars: vi.fn(async (symbol: string) => [{ symbol }]),
    getQuoteSync: vi.fn((symbol: string) => ({ symbol, price: 99 })),
    getFundamentalsSync: vi.fn((symbol: string) => ({ symbol })),
    getHistoricalBarsSync: vi.fn((symbol: string) => [{ symbol }]),
  };
  if (opts.withBatch) {
    inner.getQuotes = vi.fn(async (symbols: string[]) => symbols.map((s) => ({ symbol: s })));
  }
  if (opts.withSnapshot) {
    inner.getMarketSnapshot = vi.fn(async (symbol: string) => ({ symbol }));
  }
  return inner as IMarketDataProvider & Record<string, any>;
}

describe("BreakerWrappedMarketDataProvider", () => {
  it("delegates to the inner provider and passes identity through", async () => {
    const inner = fakeProvider({ withBatch: true });
    const r = createBreakerRegistry();
    const w = new BreakerWrappedMarketDataProvider(inner, r.breakerFor("yahoo"), {}, { sleep: noSleep });
    expect(w.providerId).toBe("yfinance");
    expect(w.name).toBe("Yahoo Finance (fake)");
    expect(w.isConfigured()).toBe(true);
    await expect(w.getQuote("AAPL")).resolves.toEqual({ symbol: "AAPL", price: 100 });
    await expect(w.getFundamentals("AAPL")).resolves.toEqual({ symbol: "AAPL" });
    await expect(w.getHistoricalBars("AAPL")).resolves.toEqual([{ symbol: "AAPL" }]);
    expect(inner.getQuote.mock.calls[0][0]).toBe("AAPL");
  });

  it("fallback served on failure and on the open gate; inner silent once open", async () => {
    const inner = fakeProvider();
    inner.getQuote.mockRejectedValue(new Error("down"));
    const r = createBreakerRegistry();
    const b = r.breakerFor("yahoo");
    const w = new BreakerWrappedMarketDataProvider(
      inner,
      b,
      { getQuote: async (symbol: string) => ({ symbol, price: 95, provenance: "cached" }) },
      { sleep: noSleep }
    );
    // Fallback semantics: whenever the live path cannot produce a value
    // (post-retry failure here), the self-labeling cached fallback is
    // served — and the failures still count toward the trip.
    for (let i = 0; i < 3; i++) {
      await expect(w.getQuote("AAPL")).resolves.toEqual({
        symbol: "AAPL",
        price: 95,
        provenance: "cached",
      });
    }
    expect(b.getState()).toBe("open");
    expect(inner.getQuote.mock.calls.length).toBe(9); // 3 executes × 3 attempts
    inner.getQuote.mockClear();
    await expect(w.getQuote("AAPL")).resolves.toEqual({
      symbol: "AAPL",
      price: 95,
      provenance: "cached",
    });
    expect(inner.getQuote).not.toHaveBeenCalled();
  });

  it("breaker open + no fallback throws a business error", async () => {
    const inner = fakeProvider();
    const r = createBreakerRegistry();
    const b = r.breakerFor("yahoo");
    const w = new BreakerWrappedMarketDataProvider(inner, b, {}, { sleep: noSleep });
    inner.getQuote.mockRejectedValue(new Error("raw 500"));
    for (let i = 0; i < 3; i++) {
      await expect(w.getQuote("AAPL")).rejects.toThrow("raw 500");
    }
    expect(b.getState()).toBe("open");
    await expect(w.getQuote("AAPL")).rejects.toThrow(BreakerOpenError);
  });

  it("getQuotes exists exactly when the inner provider offers it", async () => {
    const r = createBreakerRegistry();
    const withBatch = new BreakerWrappedMarketDataProvider(
      fakeProvider({ withBatch: true }),
      r.breakerFor("yahoo"),
      {},
      { sleep: noSleep }
    );
    const withoutBatch = new BreakerWrappedMarketDataProvider(
      fakeProvider(),
      r.breakerFor("alpaca"),
      {},
      { sleep: noSleep }
    );
    expect(typeof (withBatch as any).getQuotes).toBe("function");
    await expect((withBatch as any).getQuotes(["A", "B"])).resolves.toHaveLength(2);
    expect(typeof (withoutBatch as any).getQuotes).toBe("undefined");
  });

  it("Sync cache reads pass through unwrapped and never touch the breaker", () => {
    const inner = fakeProvider();
    const r = createBreakerRegistry();
    const b = r.breakerFor("yahoo");
    const w = new BreakerWrappedMarketDataProvider(inner, b, {}, { sleep: noSleep });
    expect((w as any).getQuoteSync("AAPL")).toEqual({ symbol: "AAPL", price: 99 });
    expect(b.snapshot().totalCalls).toBe(0);
  });
});
