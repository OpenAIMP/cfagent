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
 *
 * E2 (issue #1157): the E*TRADE adapter grows the two methods the
 * screening cutover needs — getQuotesBatch (the stock screener's
 * batch path, capturing one provider-response record per sub-batch
 * via the client's new onWireResponse hook) and getOptionExpiryDates
 * (the options engines' expiry lookup, served under optionsChains) —
 * plus bindETradeScreenerDeps, the LiveScreenerDeps binding the
 * stock screener consumes.
 */

import { ETradeService } from "../../services/etrade";
import type { IFossMarketDataProvider } from "../../patterns/interfaces";
import type {
  Env,
  ETradeOptionChain,
  ETradeQuote,
} from "../../types";
import type { SqlStorage } from "../../orm";
import type { QuoteTrace } from "../etrade/quoteTrace";
import type { LiveScreenerDeps } from "../liveScreener";
import { fetchAllUsStockListings } from "../../services/nasdaqListings";
import type {
  DataProvider,
  DataResult,
  DataRunContext,
  OptionsChainRequest,
} from "./contract";
import { recordCapture, resolveRunContext } from "./captureStore";
import { runDataProviderConformance } from "./conformance";
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
  | "getQuoteAsync"
  | "getOptionChains"
  | "getStatus"
  | "fetchQuotesRemote"
  | "getOptionExpireDates"
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
  /**
   * E2 (issue #1157): the caller's per-run QuoteTrace (issue #816),
   * forwarded verbatim to fetchQuotesRemote so the screener's trace
   * plumbing survives the platform route unchanged. Fetch-shaping
   * only — it is not part of capture or of the contract's run
   * context; absent, the batch call passes no trace, exactly as a
   * direct fetchQuotesRemote(symbols) call does.
   */
  trace?: QuoteTrace;
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
    getQuotesBatch: async (symbols: string[], runContext?: DataRunContext) => {
      if (!capture) {
        return tag(
          "etrade",
          "quotes",
          await service.fetchQuotesRemote(symbols, options?.trace)
        );
      }
      // E2 (issue #1157): the client's onWireResponse hook delivers
      // each sub-batch's parsed wire payload as the batch completes;
      // the adapter records ONE capture per sub-batch (rawKind
      // "provider-response", request params = that sub-batch's
      // symbols) and returns the service's normalized quotes exactly
      // as fetchQuotesRemote produced them — no raw ever rides the
      // result (the hook's payloads exist only in this closure and in
      // the captures written from it).
      const wireBatches: Array<{ symbols: string[]; payload: unknown }> = [];
      const quotes = await service.fetchQuotesRemote(
        symbols,
        options?.trace,
        (batchSymbols, payload) => {
          wireBatches.push({ symbols: batchSymbols, payload });
        }
      );
      const ctx = resolveRunContext(runContext);
      const blobDeps = { storage: capture.blobStorage, env: capture.env };
      if (wireBatches.length === 0) {
        // No wire response reached the hook (e.g. the service's
        // sandbox path, which returns [] without a batch request):
        // the result object is the deepest payload at the seam, so
        // it is what is captured, labeled "provider-result" — the
        // run still leaves its audit row, never a fabricated wire
        // payload.
        await recordCapture(capture.sql, blobDeps, {
          providerId: "etrade",
          capability: "quotes",
          requestParams: { symbols },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
          rawPayload: quotes,
          rawKind: "provider-result",
          normalizedResult: quotes,
          retentionClass: capture.retentionClass,
        });
        return tag("etrade", "quotes", quotes);
      }
      for (const batch of wireBatches) {
        const batchSymbols = new Set(batch.symbols);
        await recordCapture(capture.sql, blobDeps, {
          providerId: "etrade",
          capability: "quotes",
          requestParams: { symbols: batch.symbols },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
          rawPayload: batch.payload,
          rawKind: "provider-response",
          normalizedResult: quotes.filter((q) => batchSymbols.has(q.symbol)),
          retentionClass: capture.retentionClass,
        });
      }
      return tag("etrade", "quotes", quotes);
    },
    getOptionExpiryDates: async (
      symbol: string,
      runContext?: DataRunContext
    ) => {
      if (!capture) {
        return tag(
          "etrade",
          "optionsChains",
          await service.getOptionExpireDates(symbol)
        );
      }
      const dates = await service.getOptionExpireDates(symbol);
      const ctx = resolveRunContext(runContext);
      // The expiry-dates call has no wire hook on the client, so the
      // service's result is the deepest payload at the seam
      // ("provider-result"); an empty result is a completed fetch
      // with no payload — recorded as a no_payload audit row (the
      // chain-null treatment), never dressed up as a stored payload.
      await recordCapture(
        capture.sql,
        { storage: capture.blobStorage, env: capture.env },
        {
          providerId: "etrade",
          capability: "optionsChains",
          requestParams: { symbol, kind: "expiryDates" },
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          userLogin: ctx.userLogin,
          ...(dates.length > 0
            ? {
                rawPayload: dates,
                rawKind: "provider-result" as const,
              }
            : {}),
          normalizedResult: dates,
          retentionClass: capture.retentionClass,
        }
      );
      return tag("etrade", "optionsChains", dates);
    },
  };
}

/**
 * E3 (issue #1170): construct the E*TRADE adapter straight from an
 * environment + login — the no-ORM ETradeService form the platform
 * surfaces (lifecycle API reads, servability probes) share. The
 * construction lives here, inside the trading boundary, so the
 * platform owns its provider wiring in one place.
 */
export function createETradeDataProviderFromEnv(
  env: Env,
  userLogin: string,
  options?: ETradeDataProviderOptions
): DataProvider {
  return createETradeDataProvider(
    new ETradeService(env, undefined, userLogin || "default_trader"),
    options
  );
}

/**
 * E3 (issue #1170): the E*TRADE verification check the provisioning
 * lifecycle's verify action binds to — the adapter's own status
 * first (a service that reports itself unconfigured fails with
 * that reason, no probe attempted), then the P1 conformance kit
 * against the live adapter. Returns the lifecycle's verify-result
 * shape ({ ok, summary }); never throws — a probe error is a
 * failed verification with the reason, not a crash.
 */
export async function verifyETradeDataProvider(
  env: Env,
  userLogin: string
): Promise<{ ok: boolean; summary: string }> {
  const adapter = createETradeDataProviderFromEnv(env, userLogin);
  if (!adapter.isConfigured(env)) {
    return {
      ok: false,
      summary:
        "E*TRADE service reports not configured (no E*TRADE API credentials or MCP endpoint in the environment).",
    };
  }
  const report = await runDataProviderConformance(adapter);
  if (!report.ok) {
    const failures = report.checks
      .flatMap((c) => c.failures.map((f) => `${c.capability}: ${f}`))
      .join("; ");
    return { ok: false, summary: `E*TRADE adapter conformance failed — ${failures}` };
  }
  return {
    ok: true,
    summary: `E*TRADE adapter status configured; conformance passed for ${report.checks
      .map((c) => c.capability)
      .join(", ")}.`,
  };
}

/**
 * E2 (issue #1157): bind the stock screener's LiveScreenerDeps to
 * the platform — the seam ScreenerAgent.runScreenInner consumes via
 * acquireUniverse's etrade-only mode. The batch dep routes to the
 * adapter's getQuotesBatch (preserving the #495 batching and the
 * caller's QuoteTrace, forwarded through the adapter options); the
 * per-symbol dep routes to the adapter's getQuote. Both carry the
 * run's DataRunContext, so every quote the run acquires is captured
 * under the run's id. The returned deps have exactly the signatures
 * acquireUniverse has always consumed — the cutover is invisible to
 * the pipeline.
 *
 * The helper lives here, not in screener-agent.ts, because that
 * module extends the real `agents` Durable Object base and cannot
 * be imported under the repo's vitest setup (native cloudflare:
 * scheme) — no existing test imports it; the binding must stay
 * unit-pinnable.
 */
export function bindETradeScreenerDeps(
  service: ETradeDataSurface,
  capture: ETradeCaptureDeps,
  runContext: DataRunContext,
  trace?: QuoteTrace
): LiveScreenerDeps {
  const provider = createETradeDataProvider(service, { capture, trace });
  return {
    fetchETradeQuote: async (symbol: string) =>
      (await provider.getQuote!(symbol, runContext)).result as ETradeQuote,
    fetchETradeQuotes: async (symbols: string[]) =>
      (await provider.getQuotesBatch!(symbols, runContext)).result,
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
