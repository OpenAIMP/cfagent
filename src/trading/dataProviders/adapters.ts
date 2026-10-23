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
 *
 * E1 (issue #1133): the E*TRADE adapter optionally takes capture deps;
 * wired with them, every fetch through it writes a capture
 * (captureStore.ts) — the raw payload at the deepest seam reachable
 * (see captureStore.ts's header for the seam analysis) plus the
 * normalized digest, attributed to the caller's run context or a
 * generated collection run. Capture never changes what the fetch
 * returns and never fails it (recordCapture does not throw). The
 * yahoo/alpaca/nasdaq adapters are untouched by E1: their capture
 * lands with their add-provider slices.
 */

import type { ETradeService } from "../../services/etrade";
import type { IFossMarketDataProvider } from "../../patterns/interfaces";
import type { Env, ETradeOptionChain, ETradeQuote } from "../../types";
import type { SqlStorage } from "../../orm";
import { fetchAllUsStockListings } from "../../services/nasdaqListings";
import type {
  DataProvider,
  DataResult,
  DataRunContext,
  OptionsChainRequest,
} from "./contract";
import { recordCapture, resolveRunContext } from "./captureStore";
import type {
  CaptureBlobEnv,
  CaptureBlobStorage,
  DataCaptureRawKind,
  DataCaptureRetentionClass,
} from "./captureStore";

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
 * Capture wiring for the E*TRADE adapter (E1, issue #1133): the
 * capture store's SQL handle and the blob seam's two halves. Supplied
 * by whoever constructs the platform's E*TRADE provider in a context
 * that owns storage (a Durable Object); absent, the adapter is the
 * plain P1 parity wrapper and captures nothing.
 */
export interface ETradeCaptureDeps {
  sql: SqlStorage;
  blobStorage: CaptureBlobStorage;
  env: CaptureBlobEnv;
  retentionClass?: DataCaptureRetentionClass;
}

export interface ETradeDataProviderOptions {
  capture?: ETradeCaptureDeps;
}

/**
 * The REST client's raw-chain hook, as a surface type: ETradeService
 * .getOptionChains forwards its params object verbatim to
 * ETradeRestClient.getOptionChains (src/services/etrade.ts), whose
 * declared params include `includeRawResponse` (src/trading/etrade/
 * client.ts) — when set, the returned chain carries the parsed
 * OptionChainResponse object as `raw` (ETradeOptionChain.raw in
 * src/types.ts). The service's own declared params omit the flag, so
 * the capturing path widens the surface type here rather than
 * modifying the service.
 */
type ETradeRawChainSurface = {
  getOptionChains(
    params: OptionsChainRequest & { includeRawResponse?: boolean }
  ): Promise<ETradeOptionChain | null>;
};

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
 *
 * With capture deps (E1), the fetches additionally write captures.
 * For chains the capturing path requests the client's raw hook and
 * strips the echoed `raw` from the result the caller receives — the
 * caller gets the same normalized chain the plain path returns (the
 * pairs array by reference); the raw payload lives in the capture.
 * Quotes work the same way: the capturing path requests the client's
 * includeRawResponse hook (forwarded by ETradeService.getQuoteAsync /
 * fetchQuoteRemote to fetchQuoteDetailed) and strips the echoed `raw`
 * from the quote the caller receives. If the wrapped surface does not
 * honor the hook (no `raw` on the returned chain/quote), the result
 * passes through by reference and the capture falls back to it,
 * labeled "provider-result".
 */
export function createETradeDataProvider(
  service: ETradeDataSurface,
  options?: ETradeDataProviderOptions
): DataProvider {
  const capture = options?.capture;
  return {
    id: "etrade",
    name: "E*TRADE",
    capabilities: ["quotes", "optionsChains"] as const,
    isConfigured: () => service.getStatus().configured,
    getQuote: async (symbol: string, runContext?: DataRunContext) => {
      if (!capture) {
        return tag("etrade", "quotes", await service.getQuoteAsync(symbol));
      }
      const result = await service.getQuoteAsync(symbol, {
        includeRawResponse: true,
      });
      const ctx = resolveRunContext(runContext);
      let normalized: ETradeQuote = result;
      let rawPayload: unknown = result;
      let rawKind: DataCaptureRawKind = "provider-result";
      if (result.raw !== undefined) {
        const stripped: ETradeQuote = { ...result };
        delete stripped.raw;
        normalized = stripped;
        rawPayload = result.raw;
        rawKind = "provider-response";
      }
      await recordCapture(
        capture.sql,
        { storage: capture.blobStorage, env: capture.env },
        {
          providerId: "etrade",
          capability: "quotes",
          requestParams: { symbol },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
          rawPayload,
          rawKind,
          normalizedResult: normalized,
          retentionClass: capture.retentionClass,
        }
      );
      return tag("etrade", "quotes", normalized);
    },
    getOptionsChain: async (
      request: OptionsChainRequest,
      runContext?: DataRunContext
    ) => {
      const params = {
        symbol: request.symbol,
        expiryYear: request.expiryYear,
        expiryMonth: request.expiryMonth,
        expiryDay: request.expiryDay,
        strikePrice: request.strikePrice,
        noOfStrikes: request.noOfStrikes,
        includeWeekly: request.includeWeekly,
        chainType: request.chainType,
      };
      if (!capture) {
        return tag(
          "etrade",
          "optionsChains",
          await service.getOptionChains(params)
        );
      }
      const chain = await (
        service as ETradeDataSurface & ETradeRawChainSurface
      ).getOptionChains({ ...params, includeRawResponse: true });
      const ctx = resolveRunContext(runContext);
      const blobDeps = { storage: capture.blobStorage, env: capture.env };
      if (chain === null) {
        // A completed fetch with no payload: an audit row records the
        // attempt (status no_payload); no raw is fabricated for it.
        await recordCapture(capture.sql, blobDeps, {
          providerId: "etrade",
          capability: "optionsChains",
          requestParams: request,
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
          retentionClass: capture.retentionClass,
        });
        return tag("etrade", "optionsChains", null);
      }
      let normalized: ETradeOptionChain = chain;
      let rawPayload: unknown = chain;
      let rawKind: DataCaptureRawKind = "provider-result";
      if (chain.raw !== undefined) {
        const stripped: ETradeOptionChain = { ...chain };
        delete stripped.raw;
        normalized = stripped;
        rawPayload = chain.raw;
        rawKind = "provider-response";
      }
      await recordCapture(capture.sql, blobDeps, {
        providerId: "etrade",
        capability: "optionsChains",
        requestParams: request,
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        userLogin: ctx.userLogin,
        rawPayload,
        rawKind,
        normalizedResult: normalized,
        retentionClass: capture.retentionClass,
      });
      return tag("etrade", "optionsChains", normalized);
    },
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
