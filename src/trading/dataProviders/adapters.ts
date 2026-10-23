/**
 * Issue #1118 (P1 of epic #1116): built-in DataProvider adapters.
 *
 * Each adapter WRAPS an existing implementation and returns its
 * results UNCHANGED — reference parity, pinned by test, in the #1103
 * adapter method. The payload inside the DataResult envelope is the
 * wrapped implementation's own result object, by reference. Adapters
 * add exactly three things: the platform's provider id, its declared
 * capability set, and the provenance envelope carrying both. They do
 * not convert, filter, enrich, or retry; any of that belongs to later
 * slices and would break parity if smuggled in here.
 *
 *   etrade — ETradeService (src/services/etrade.ts), the REFERENCE
 *            adapter: the full E*TRADE-first lifecycle of epic #1116 is
 *            built against this provider, so its mapping is the
 *            contract's worked example.
 *   yahoo  — YahooFinanceProvider (IFossMarketDataProvider).
 *   alpaca — AlpacaMarketDataProvider (IFossMarketDataProvider).
 *   nasdaq — fetchAllUsStockListings (src/services/nasdaqListings.ts),
 *            promoted from a listings helper to a provider: it serves
 *            the screenUniverse capability (universe membership).
 *
 * There is deliberately NO public adapter: public is seeded in the
 * config store as a descriptor in "registered" state, and its
 * integration is its own later slice under #1116.
 */

import type { ETradeService } from "../../services/etrade";
import type { IFossMarketDataProvider } from "../../patterns/interfaces";
import type { Env } from "../../types";
import { fetchAllUsStockListings } from "../../services/nasdaqListings";
import type {
  DataProvider,
  DataResult,
  OptionsChainRequest,
} from "./contract";

/** Tag a wrapped result with its provenance envelope (payload by reference). */
function tag<T>(
  providerId: DataProvider["id"],
  capability: DataProvider["capabilities"][number],
  result: T
): DataResult<T> {
  return { providerId, capability, result };
}

/**
 * The E*TRADE data surface this adapter consumes — the data-path
 * subset of ETradeService. Order/account methods are NOT part of the
 * data-provider contract and are deliberately absent.
 */
export type ETradeDataSurface = Pick<
  ETradeService,
  "getQuoteAsync" | "getOptionChains" | "getStatus"
>;

/**
 * Reference adapter: wraps an ETradeService.
 *
 * Capability mapping:
 *   quotes       → getQuoteAsync(symbol) — the live REST quote path,
 *                  returning the service's ETradeQuote unchanged.
 *   optionsChains → getOptionChains(params) — the request object is
 *                  passed through field-for-field; the service's
 *                  ETradeOptionChain (or null) is returned unchanged.
 *
 * isConfigured defers to the service's own status (ETradeBrokerStatus
 * .configured), so the platform reports configuration exactly as the
 * service itself computes it — no second opinion.
 */
export function createETradeDataProvider(service: ETradeDataSurface): DataProvider {
  return {
    id: "etrade",
    name: "E*TRADE",
    capabilities: ["quotes", "optionsChains"] as const,
    isConfigured: () => service.getStatus().configured,
    getQuote: async (symbol: string) =>
      tag("etrade", "quotes", await service.getQuoteAsync(symbol)),
    getOptionsChain: async (request: OptionsChainRequest) =>
      tag(
        "etrade",
        "optionsChains",
        await service.getOptionChains({
          symbol: request.symbol,
          expiryYear: request.expiryYear,
          expiryMonth: request.expiryMonth,
          expiryDay: request.expiryDay,
          strikePrice: request.strikePrice,
          noOfStrikes: request.noOfStrikes,
          includeWeekly: request.includeWeekly,
          chainType: request.chainType,
        })
      ),
  };
}

/**
 * Shared FOSS adapter: YahooFinanceProvider and AlpacaMarketDataProvider
 * both implement IFossMarketDataProvider, whose quote/bars/fundamentals
 * surface maps one-for-one onto the contract. Results pass through by
 * reference.
 */
function createFossDataProvider(
  id: "yahoo" | "alpaca",
  name: string,
  provider: IFossMarketDataProvider,
  env?: Env
): DataProvider {
  return {
    id,
    name,
    capabilities: ["quotes", "historicalBars", "fundamentals"] as const,
    isConfigured: () => provider.isConfigured(env),
    getQuote: async (symbol: string) =>
      tag(id, "quotes", await provider.getQuote(symbol)),
    getHistoricalBars: async (symbol: string, timeframe?: string, limit?: number) =>
      tag(
        id,
        "historicalBars",
        await provider.getHistoricalBars(symbol, timeframe, limit)
      ),
    getFundamentals: async (symbol: string) =>
      tag(id, "fundamentals", await provider.getFundamentals(symbol)),
  };
}

/** Yahoo adapter — wraps YahooFinanceProvider (the FOSS "yfinance" impl). */
export function createYahooDataProvider(
  provider: IFossMarketDataProvider,
  env?: Env
): DataProvider {
  return createFossDataProvider("yahoo", "Yahoo Finance", provider, env);
}

/** Alpaca adapter — wraps AlpacaMarketDataProvider. */
export function createAlpacaDataProvider(
  provider: IFossMarketDataProvider,
  env?: Env
): DataProvider {
  return createFossDataProvider("alpaca", "Alpaca Markets", provider, env);
}

/**
 * Nasdaq adapter — wraps the listings fetch. The fetcher is injectable
 * (nasdaqListings' own seam: fetchAllUsStockListings already accepts a
 * fetch implementation) so tests and later slices can substitute the
 * transport without touching the adapter.
 */
export function createNasdaqDataProvider(
  fetchListings: typeof fetchAllUsStockListings = fetchAllUsStockListings
): DataProvider {
  return {
    id: "nasdaq",
    name: "Nasdaq Listings",
    capabilities: ["screenUniverse"] as const,
    // Public listings feed, no credentials — configured by construction,
    // matching the FOSS provider-status semantics for Yahoo.
    isConfigured: () => true,
    getScreenUniverse: async () =>
      tag("nasdaq", "screenUniverse", await fetchListings()),
  };
}
