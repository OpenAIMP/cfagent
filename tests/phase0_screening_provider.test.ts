/**
 * Issue #1098 (Phase 0 of epic #1096) — unified ScreeningProvider pins.
 *
 *  - One provider contract covers both asset classes: a stock provider
 *    wrapping an IMarketScreener (the E*TRADE/Yahoo DynamicMarketScreener
 *    seam) and an options provider wrapping DynamicOptionsScreener's
 *    screenOptions() must return the underlying result UNCHANGED, tagged
 *    with the provider id and asset class (regression parity).
 *  - The registry resolves a provider by asset class, and fails
 *    EXPLICITLY (typed ScreeningProviderNotFoundError) when no provider
 *    is registered for an asset class — never a silent fallback to a
 *    different provider (contrast TradingPlatformRegistry's fallback,
 *    which is the wrong semantic for screening provenance).
 *  - A provider rejects a request for an asset class it does not serve
 *    instead of returning a mislabeled result.
 *  - Registering two providers under one id is an explicit error, so
 *    provenance ids stay unambiguous.
 */
import { describe, it, expect } from "vitest";
import {
  ScreeningProviderRegistry,
  ScreeningProviderNotFoundError,
  createStockScreeningProvider,
  createOptionsScreeningProvider,
  createDefaultScreeningRegistry,
} from "../src/trading/screeningProvider";
import type { StockScreenResult, OptionScreenResult } from "../src/types";

const stockResult = {
  totalScanned: 2,
  totalScreened: 2,
  matchedCount: 1,
  filterApplied: { sector: "Technology" },
  filterSummary: "sector=Technology",
  stocks: [],
  scannedAt: "2026-10-23T00:00:00.000Z",
} as unknown as StockScreenResult;

const optionResult = {
  totalUnderlyingsScanned: 1,
  totalContractsEvaluated: 10,
  matchedCount: 3,
  filterApplied: { underlyingSymbols: ["NVDA"] },
  filterSummary: "symbols=NVDA",
  contracts: [],
  scannedAt: "2026-10-23T00:00:00.000Z",
  status: "matches_found",
} as unknown as OptionScreenResult;

function fakeStockScreener() {
  return { screenMarkets: async (_filter?: unknown) => stockResult };
}
function fakeOptionsScreener() {
  return { screenOptions: async (_filter?: unknown) => optionResult };
}

describe("ScreeningProvider (issue #1098)", () => {
  it("stock provider returns the wrapped screener's result unchanged", async () => {
    const provider = createStockScreeningProvider("etrade-yahoo", fakeStockScreener() as any);
    expect(provider.assetClasses).toEqual(["stocks"]);
    const out = await provider.screen({ assetClass: "stocks", filter: { sector: "Technology" } });
    expect(out.assetClass).toBe("stocks");
    expect(out.providerId).toBe("etrade-yahoo");
    if (out.assetClass === "stocks") expect(out.result).toBe(stockResult);
  });

  it("options provider returns the wrapped screener's result unchanged", async () => {
    const provider = createOptionsScreeningProvider("dynamic-options", fakeOptionsScreener() as any);
    expect(provider.assetClasses).toEqual(["options"]);
    const out = await provider.screen({ assetClass: "options", filter: { underlyingSymbols: ["NVDA"] } });
    expect(out.assetClass).toBe("options");
    expect(out.providerId).toBe("dynamic-options");
    if (out.assetClass === "options") expect(out.result).toBe(optionResult);
  });

  it("a provider rejects a request for an asset class it does not serve", async () => {
    const provider = createStockScreeningProvider("etrade-yahoo", fakeStockScreener() as any);
    await expect(provider.screen({ assetClass: "options", filter: {} } as any)).rejects.toThrow(/does not serve asset class/);
  });

  it("registry resolves by asset class and routes screen() accordingly", async () => {
    const registry = new ScreeningProviderRegistry();
    registry.register(createStockScreeningProvider("etrade-yahoo", fakeStockScreener() as any));
    registry.register(createOptionsScreeningProvider("dynamic-options", fakeOptionsScreener() as any));
    expect(registry.resolve("stocks").id).toBe("etrade-yahoo");
    expect(registry.resolve("options").id).toBe("dynamic-options");
    expect(registry.list().map((p) => p.id).sort()).toEqual(["dynamic-options", "etrade-yahoo"]);
    const out = await registry.screen({ assetClass: "options", filter: {} });
    expect(out.providerId).toBe("dynamic-options");
  });

  it("registry fails explicitly (typed error) for an unregistered asset class", () => {
    const registry = new ScreeningProviderRegistry();
    registry.register(createStockScreeningProvider("etrade-yahoo", fakeStockScreener() as any));
    expect(() => registry.resolve("options")).toThrow(ScreeningProviderNotFoundError);
    expect(() => registry.resolve("options")).toThrow(/options/);
  });

  it("registering a duplicate provider id is an explicit error", () => {
    const registry = new ScreeningProviderRegistry();
    registry.register(createStockScreeningProvider("dup", fakeStockScreener() as any));
    expect(() => registry.register(createStockScreeningProvider("dup", fakeStockScreener() as any))).toThrow(/already registered/);
  });

  it("default registry wires the stock and options providers under stable ids", () => {
    const registry = createDefaultScreeningRegistry({
      stockScreener: fakeStockScreener() as any,
      optionsScreener: fakeOptionsScreener() as any,
    });
    expect(registry.resolve("stocks").id).toBe("etrade-yahoo-stocks");
    expect(registry.resolve("options").id).toBe("dynamic-options");
  });
});
