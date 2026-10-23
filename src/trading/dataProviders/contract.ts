/**
 * Issue #1118 (P1 of epic #1116): the DataProvider plugin contract.
 *
 * Before this module, provider identity existed in three incompatible
 * vocabularies — `StockScreenProvider = "etrade" | "yahoo"`, the FOSS
 * ids `"yfinance" | "alpaca" | "hybrid"`, and the #1103 ScreeningProvider
 * ids `"etrade-yahoo-stocks" | "dynamic-options"` — provider composition
 * was hardcoded at each call site (FossResearchService constructs its
 * providers inline; E*TRADE is constructed at 57 data-path sites), and
 * no module could name "the provider that serves capability X" at all.
 *
 * This contract is the ONE vocabulary (epic #1116; the provider set and
 * precedence are the owner's decision, comment 6358627401 on #1116):
 *
 *   ids:          etrade | public | yahoo | nasdaq | alpaca
 *   capabilities: quotes | optionsChains | screenUniverse |
 *                 historicalBars | fundamentals | news
 *
 * Normalized shapes consolidate the existing interfaces rather than
 * inventing new DTOs: quotes are the two quote shapes the codebase
 * already normalizes to (ETradeQuote for the E*TRADE/pipeline side,
 * FossQuote for the FOSS side); chains are ETradeOptionChain; the
 * screen universe is NasdaqStockListing[] (nasdaqListings is the
 * universe-membership source); bars and fundamentals are the FOSS
 * shapes. Adapters return the wrapped implementations' results
 * UNCHANGED (parity pinned, the #1103 adapter method) — consolidation
 * here names the shapes under one contract; it does not convert between
 * them. `news` has a contract shape but no declaring adapter yet in
 * this slice (it arrives with the public integration, a later slice).
 *
 * Composition + provenance (owner correction, comment 6358714200 on
 * #1116): screening does not pick one winning provider — it COMPOSES
 * several in a single run (today: Nasdaq universe + Yahoo bars and
 * quote gap-fill + E*TRADE quotes/chains). Two consequences live here
 * and in the registry/store:
 *
 *   1. Every result travels in a DataResult envelope tagging the
 *      provider that supplied it and the capability it served — the
 *      #1103 provenance-tagging idiom, at element level: because one
 *      provider call returns one provider's data, the envelope on the
 *      call attributes every element in it. When a run composes
 *      providers, each element keeps the tag of the call that fetched
 *      it. (FossQuote also carries a legacy per-quote `provider` field
 *      in the FOSS vocabulary; the envelope's platform id is the
 *      authoritative provenance.)
 *   2. WHICH providers compose a run is capability ROUTING — a
 *      per-capability primary plus an optional declared gap-fill —
 *      stored in the config store (providerConfigStore.ts) and
 *      resolved by the registry (registry.ts). The precedence order
 *      above remains only as the default where no route is declared
 *      and as the overlap-resolution order within routing.
 *
 * A provider declares the capabilities it serves; methods for
 * undeclared capabilities are absent (ISP, mirroring
 * IFossMarketDataProvider's optional getMarketSnapshot). The registry
 * (registry.ts) resolves capabilities against the provider-config store
 * (providerConfigStore.ts) — declared here, enforced there.
 */

import type {
  Env,
  ETradeQuote,
  ETradeOptionChain,
  FossQuote,
  FossHistoricalBar,
  FossCompanyFundamentals,
} from "../../types";
import type { NasdaqStockListing } from "../../services/nasdaqListings";

/** The five owner-set provider ids, in owner precedence order. */
export const DATA_PROVIDER_IDS = [
  "etrade",
  "public",
  "yahoo",
  "nasdaq",
  "alpaca",
] as const;
export type DataProviderId = (typeof DATA_PROVIDER_IDS)[number];

/** The capability vocabulary every provider declares from. */
export const DATA_PROVIDER_CAPABILITIES = [
  "quotes",
  "optionsChains",
  "screenUniverse",
  "historicalBars",
  "fundamentals",
  "news",
] as const;
export type DataProviderCapability = (typeof DATA_PROVIDER_CAPABILITIES)[number];

/** quotes — the two existing normalized quote shapes (see header). */
export type QuoteResult = ETradeQuote | FossQuote;

/**
 * optionsChains request — consolidates the parameter shape
 * ETradeService.getOptionChains already accepts.
 */
export interface OptionsChainRequest {
  symbol: string;
  expiryYear?: number;
  expiryMonth?: number;
  expiryDay?: number;
  strikePrice?: number;
  noOfStrikes?: number;
  includeWeekly?: boolean;
  chainType?: "CALL" | "PUT" | "CALLPUT";
}

/** optionsChains — the E*TRADE chain shape; null = provider has no chain for the request. */
export type OptionsChainResult = ETradeOptionChain | null;

/** screenUniverse — listed-stock universe membership (nasdaqListings shape). */
export type ScreenUniverseResult = NasdaqStockListing[];

/** historicalBars — the FOSS bar shape (Yahoo/Alpaca). */
export type HistoricalBarsResult = FossHistoricalBar[];

/** fundamentals — the FOSS company-fundamentals shape (Yahoo/Alpaca). */
export type FundamentalsResult = FossCompanyFundamentals;

/**
 * news — contract-only in this slice: no existing provider surface is
 * wrapped yet, so no adapter declares it. The shape is the minimal
 * normalized article the platform will require of any news provider.
 */
export interface DataNewsArticle {
  headline: string;
  source: string;
  publishedAt: string;
  symbol?: string;
  url?: string;
  summary?: string;
}
export type NewsResult = DataNewsArticle[];

/**
 * The provenance envelope every capability result travels in: the
 * wrapped implementation's result object, BY REFERENCE (parity is
 * preserved — the envelope wraps, never copies or converts), tagged
 * with the platform provider id and the capability served.
 */
export interface DataResult<T> {
  readonly providerId: DataProviderId;
  readonly capability: DataProviderCapability;
  readonly result: T;
}

/**
 * Run context for a platform-routed fetch (E1, issue #1133): the run
 * the fetch belongs to, and the tenant/user scope it executes under.
 * Every field is optional for the caller — capture (captureStore.ts)
 * resolves a missing runId to a generated collection-run id and a
 * missing tenant to "default", so a fetch through the platform is
 * always attributable to exactly one run and one tenant scope, and no
 * platform-routed fetch goes uncaptured for want of a caller-supplied
 * context.
 */
export interface DataRunContext {
  runId?: string;
  tenantId?: string;
  userLogin?: string;
}

/**
 * The plugin contract. A provider implements the methods for exactly
 * the capabilities it declares in `capabilities`; the conformance kit
 * (conformance.ts) fails a provider that declares a capability whose
 * method is missing, whose envelope mislabels the serving provider,
 * or whose payload returns a non-conformant shape.
 *
 * Each method takes an optional trailing DataRunContext (E1): the
 * attribution capture writes against. Adapters that do not capture
 * (yet) accept and ignore it.
 */
export interface DataProvider {
  readonly id: DataProviderId;
  readonly name: string;
  readonly capabilities: readonly DataProviderCapability[];
  /** Mirrors IFossMarketDataProvider: is this provider usable as configured? */
  isConfigured(env?: Env): boolean;
  getQuote?(
    symbol: string,
    runContext?: DataRunContext
  ): Promise<DataResult<QuoteResult>>;
  getOptionsChain?(
    request: OptionsChainRequest,
    runContext?: DataRunContext
  ): Promise<DataResult<OptionsChainResult>>;
  getScreenUniverse?(
    runContext?: DataRunContext
  ): Promise<DataResult<ScreenUniverseResult>>;
  getHistoricalBars?(
    symbol: string,
    timeframe?: string,
    limit?: number,
    runContext?: DataRunContext
  ): Promise<DataResult<HistoricalBarsResult>>;
  getFundamentals?(
    symbol: string,
    runContext?: DataRunContext
  ): Promise<DataResult<FundamentalsResult>>;
  getNews?(
    symbol: string,
    runContext?: DataRunContext
  ): Promise<DataResult<NewsResult>>;
}
