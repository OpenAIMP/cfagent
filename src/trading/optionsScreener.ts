/**
 * Dynamic Options Screener Engine
 *
 * Implements:
 * - Multi-symbol and sector-wide options chain scanning.
 * - Multi-factor filtering: IV, Delta, Gamma, Theta, Volume, Open Interest, DTE, Premium, Moneyness, Vega, Rho.
 * - Unusual option activity detection (Vol/OI divergence, IV skew).
 * - Real-time integration with E*TRADE REST API option chains.
 * - Input sanitization (NaN/enum/bounds), bounded upstream fan-out (symbol, expiration, and
 *   result caps with pooled concurrency), per-symbol fetch diagnostics, and machine-readable
 *   rejection codes.
 */

import type {
  OptionScreenerFilter,
  OptionScreenResult,
  OptionScreenSortKey,
  ScreenedOptionContractItem,
  OptionScreenRejection,
  OptionScreenFetchError,
  ETradeOptionChain,
  ETradeOptionChainContract,
} from "../types";
import type { ETradeRestClient } from "./etrade/client";
import { fetchAllUsStockListings, type NasdaqStockListing } from "../services/nasdaqListings";
import { getScreenerConfig, type EtapiScreenerConfig } from "../config/etapiConfig";

const baseScreenerConfig = getScreenerConfig();
/** Maximum underlyings (explicit or discovered) any single screen may query. */
export const MAX_SCAN_SYMBOLS = baseScreenerConfig.maxScanSymbols;
/** Maximum expirations fetched per symbol per screen (nearest first). */
export const MAX_EXPIRATIONS_PER_SYMBOL = baseScreenerConfig.maxExpirationsPerSymbol;
/** Default DTE window applied when the caller supplies neither minDte nor maxDte. */
export const DEFAULT_MAX_DTE = baseScreenerConfig.defaultMaxDte;
/** Quote-age reference (seconds) used for FRESH/STALE labels when no filter is supplied. */
export const DEFAULT_QUOTE_AGE_SECONDS = baseScreenerConfig.defaultQuoteAgeSeconds;
/** Hard cap on returned contracts; `limit` is clamped to this value. */
export const MAX_RETURNED_CONTRACTS = baseScreenerConfig.maxReturnedContracts;
/** Rejection samples embedded in each result; the full count is reported via `rejectionCount`. */
export const MAX_REJECTIONS_RETURNED = baseScreenerConfig.maxRejectionsReturned;
/** Concurrent upstream symbol fetches per screen. */
const SYMBOL_FETCH_CONCURRENCY = baseScreenerConfig.symbolFetchConcurrency;
/** Concurrent upstream expiration fetches per symbol. */
const EXPIRY_FETCH_CONCURRENCY = baseScreenerConfig.expiryFetchConcurrency;
/** Unusual-activity signal threshold (volume / open interest). */
const UNUSUAL_VOLUME_OI_RATIO = baseScreenerConfig.unusualVolumeOiRatio;
const HIGH_DELTA_THRESHOLD = baseScreenerConfig.highDeltaThreshold;
const HIGH_IV_THRESHOLD = baseScreenerConfig.highIvThreshold;
const LOW_IV_THRESHOLD = baseScreenerConfig.lowIvThreshold;

/**
 * Builds a standard OCC OSI contract symbol (e.g. AAPL 2026-01-16 C 150 -> AAPL260116C00150000)
 * for contracts where E*TRADE did not supply an osiKey.
 */
function buildOsiSymbol(
  root: string,
  expiry: { year: number; month: number; day: number },
  type: "CALL" | "PUT",
  strike: number
): string {
  const yy = String(expiry.year % 100).padStart(2, "0");
  const mm = String(expiry.month).padStart(2, "0");
  const dd = String(expiry.day).padStart(2, "0");
  const strikeCode = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${root.toUpperCase()}${yy}${mm}${dd}${type === "CALL" ? "C" : "P"}${strikeCode}`;
}

/** Runs `fn` over `items` with at most `limit` in-flight executions, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}

export interface SanitizedOptionScreenFilter {
  /** The effective filter actually applied (defaults filled in, invalid values removed). */
  filter: OptionScreenerFilter;
  /** Non-fatal notices about dropped, clamped, or defaulted inputs. */
  warnings: string[];
}

const CONTRACT_TYPES = new Set(["CALL", "PUT", "BOTH"]);
const MONEYNESS_VALUES = new Set(["ITM", "OTM", "ATM", "ALL"]);
const SORT_KEYS = new Set<OptionScreenSortKey>(["volume", "spreadPct", "iv", "volumeOiRatio", "dte", "strikeDistance"]);

type NumericFilterKey = Exclude<keyof OptionScreenerFilter, "underlyingSymbols" | "sector" | "contractType" | "moneyness" | "sortBy">;

const NUMERIC_FILTER_KEYS: NumericFilterKey[] = [
  "maxUnderlyings", "minVolume", "minOpenInterest", "maxSpreadPct", "maxQuoteAgeSeconds",
  "minDelta", "maxDelta", "minGamma", "maxGamma", "minTheta", "maxTheta",
  "minPrice", "maxPrice", "minImpliedVolatility", "maxImpliedVolatility",
  "minDte", "maxDte", "maxStrikeDistancePct", "limit",
  "minVega", "maxVega", "minRho", "maxRho",
];

const NON_NEGATIVE_KEYS: NumericFilterKey[] = [
  "maxUnderlyings", "minVolume", "minOpenInterest", "maxSpreadPct", "maxQuoteAgeSeconds",
  "minPrice", "maxPrice", "minImpliedVolatility", "maxStrikeDistancePct", "minDte", "maxDte", "limit",
  "minVega", "maxVega", "minRho", "maxRho",
];

const BOUNDED_PAIRS: Array<[NumericFilterKey, NumericFilterKey]> = [
  ["minDte", "maxDte"],
  ["minDelta", "maxDelta"],
  ["minGamma", "maxGamma"],
  ["minTheta", "maxTheta"],
  ["minImpliedVolatility", "maxImpliedVolatility"],
  ["minPrice", "maxPrice"],
  ["minVega", "maxVega"],
  ["minRho", "maxRho"],
];

/**
 * Normalizes a caller-supplied filter into the filter that is actually executed:
 * drops non-finite numerics (e.g. Number("abc") from query strings), validates enums,
 * clamps negative/oversized bounds, swaps inverted min/max pairs, caps the universe and
 * result sizes, and applies the default DTE window. Never throws; every adjustment is
 * reported in `warnings`.
 */
export function sanitizeOptionScreenerFilter(raw: OptionScreenerFilter = {}, config: EtapiScreenerConfig = getScreenerConfig()): SanitizedOptionScreenFilter {
  const warnings: string[] = [];
  const filter: OptionScreenerFilter = { ...raw };
  if (raw.underlyingSymbols) filter.underlyingSymbols = [...raw.underlyingSymbols];
  const numeric = filter as Record<string, unknown>;

  for (const key of NUMERIC_FILTER_KEYS) {
    const value = filter[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      delete filter[key];
      warnings.push(`Ignored invalid numeric filter '${String(key)}'.`);
    }
  }

  if (filter.contractType !== undefined && !CONTRACT_TYPES.has(filter.contractType)) {
    delete filter.contractType;
    warnings.push("Ignored unrecognized contractType; screening both calls and puts.");
  }
  if (filter.moneyness !== undefined && !MONEYNESS_VALUES.has(filter.moneyness)) {
    delete filter.moneyness;
    warnings.push("Ignored unrecognized moneyness filter.");
  }
  if (filter.sortBy !== undefined && !SORT_KEYS.has(filter.sortBy)) {
    delete filter.sortBy;
    warnings.push("Ignored unrecognized sortBy; defaulting to volume.");
  }

  for (const key of NON_NEGATIVE_KEYS) {
    const value = filter[key];
    if (typeof value === "number" && value < 0) {
      numeric[key] = 0;
      warnings.push(`Clamped '${String(key)}' to 0.`);
    }
  }

  for (const key of ["minDelta", "maxDelta"] as const) {
    const value = filter[key];
    if (typeof value === "number" && (value < 0 || value > 1)) {
      filter[key] = Math.min(1, Math.max(0, value));
      warnings.push(`Clamped '${key}' into the 0..1 absolute-delta range.`);
    }
  }

  for (const [minKey, maxKey] of BOUNDED_PAIRS) {
    const min = filter[minKey];
    const max = filter[maxKey];
    if (typeof min === "number" && typeof max === "number" && min > max) {
      numeric[minKey] = max;
      numeric[maxKey] = min;
      warnings.push(`Swapped inverted '${String(minKey)}'/'${String(maxKey)}' bounds.`);
    }
  }

  if (filter.underlyingSymbols) {
    const normalized = Array.from(new Set(filter.underlyingSymbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
    if (normalized.length > config.maxScanSymbols) {
      warnings.push(`Underlying list trimmed from ${normalized.length} to ${config.maxScanSymbols} symbols.`);
      normalized.length = config.maxScanSymbols;
    }
    if (normalized.length === 0) delete filter.underlyingSymbols;
    else filter.underlyingSymbols = normalized;
  }
  if (filter.maxUnderlyings !== undefined) {
    const floored = Math.max(1, Math.floor(filter.maxUnderlyings));
    if (floored > config.maxScanSymbols) {
      warnings.push(`maxUnderlyings capped at ${config.maxScanSymbols}.`);
      filter.maxUnderlyings = config.maxScanSymbols;
    } else {
      filter.maxUnderlyings = floored;
    }
  }
  if (filter.limit !== undefined) {
    const floored = Math.max(1, Math.floor(filter.limit));
    if (floored > config.maxReturnedContracts) {
      warnings.push(`limit capped at ${config.maxReturnedContracts} contracts.`);
      filter.limit = config.maxReturnedContracts;
    } else {
      filter.limit = floored;
    }
  } else {
    filter.limit = config.maxReturnedContracts;
  }

  // Scanning every listed expiration fans out into dozens of upstream calls per symbol,
  // so an unbounded DTE window is never fetched implicitly.
  if (filter.minDte === undefined && filter.maxDte === undefined) {
    filter.minDte = config.defaultMinDte;
    filter.maxDte = config.defaultMaxDte;
    warnings.push(`No DTE window supplied; defaulting to ${config.defaultMinDte}-${config.defaultMaxDte} days to expiration.`);
  }

  return { filter, warnings };
}

export class DynamicOptionsScreener {
  private client?: ETradeRestClient;
  public config: EtapiScreenerConfig;
  private static testChainsFixture: Record<string, ETradeOptionChain> = {};
  private static testListingsFixture: NasdaqStockListing[] | null = null;

  constructor(client?: ETradeRestClient, config?: Partial<EtapiScreenerConfig>) {
    this.client = client;
    const base = getScreenerConfig((client as any)?.env, (client as any)?.overrideEnv);
    this.config = config ? { ...base, ...config } : base;
  }

  /**
   * Test fixture injector — allows deterministic testing of options chain filtering
   */
  static setTestChainsFixture(fixture: Record<string, ETradeOptionChain>): void {
    DynamicOptionsScreener.testChainsFixture = fixture;
  }

  static clearTestChainsFixture(): void {
    DynamicOptionsScreener.testChainsFixture = {};
  }

  static setTestListingsFixture(fixture: NasdaqStockListing[] | null): void {
    DynamicOptionsScreener.testListingsFixture = fixture;
  }

  /**
   * Resolve explicit underlyings or discover from all current U.S. exchange listings.
   * Discovery is deterministic (alphabetically sorted) and always capped at
   * `maxUnderlyings`, which sanitizeOptionScreenerFilter clamps to MAX_SCAN_SYMBOLS.
   */
  async resolveUnderlyings(filter: OptionScreenerFilter): Promise<string[]> {
    if (filter.underlyingSymbols && filter.underlyingSymbols.length > 0) {
      return Array.from(new Set(filter.underlyingSymbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
    }

    const listings = DynamicOptionsScreener.testListingsFixture ?? await fetchAllUsStockListings();
    const discovered = Array.from(new Set(listings.map((listing) => listing.symbol.toUpperCase()))).sort();
    const cap = filter.maxUnderlyings && filter.maxUnderlyings > 0 ? filter.maxUnderlyings : this.config.maxScanSymbols;
    return discovered.slice(0, cap);
  }

  /**
   * Fetches every expiration of a symbol inside the effective DTE window.
   *
   * Returns per-symbol diagnostics alongside the chains so callers can distinguish a
   * legitimate empty slice (expirations exist, none in the window) from upstream
   * failures (auth/network/rate-limit/empty payload). Identical expirations are
   * deduped and at most maxExpirationsPerSymbol requests are issued, pooled at
   * expiryFetchConcurrency.
   */
  private async fetchChainsForSymbol(
    symbol: string,
    filter: OptionScreenerFilter
  ): Promise<{ chains: ETradeOptionChain[]; fetchErrors: OptionScreenFetchError[]; expirationsTruncated: number }> {
    const fixture = DynamicOptionsScreener.testChainsFixture[symbol];
    if (fixture) return { chains: [fixture], fetchErrors: [], expirationsTruncated: 0 };
    if (!this.client) {
      return {
        chains: [],
        fetchErrors: [{ symbol, reason: "No E*TRADE client configured for live chain fetch." }],
        expirationsTruncated: 0,
      };
    }
    const client = this.client;

    let expirations: Array<{ year: number; month: number; day: number }> = [];
    let expirationError: string | null = null;
    try {
      expirations = await client.getOptionExpireDates(symbol);
    } catch (err) {
      expirationError = err instanceof Error ? err.message : "Expiration date fetch failed.";
    }

    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const seenExpirations = new Set<string>();
    const eligibleExpirations = expirations
      .filter((expiry) => {
        const key = `${expiry.year}-${expiry.month}-${expiry.day}`;
        if (seenExpirations.has(key)) return false;
        seenExpirations.add(key);
        const expirationUtc = Date.UTC(expiry.year, expiry.month - 1, expiry.day);
        const dte = Math.ceil((expirationUtc - todayUtc) / (24 * 60 * 60 * 1000));
        return (filter.minDte === undefined || dte >= filter.minDte) &&
          (filter.maxDte === undefined || dte <= filter.maxDte);
      })
      .sort((a, b) => Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day));

    if (eligibleExpirations.length === 0) {
      // Expirations exist but none fall inside the requested window: a legitimate empty slice.
      if (expirations.length > 0) return { chains: [], fetchErrors: [], expirationsTruncated: 0 };
      // Expiration feed unavailable: fall back to a single unscoped chain request.
      const chain = await client.getOptionChains({ symbol }).catch(() => null);
      if (chain) return { chains: [chain], fetchErrors: [], expirationsTruncated: 0 };
      return {
        chains: [],
        fetchErrors: [{ symbol, reason: expirationError || client.lastError || "Option chain fetch returned no data." }],
        expirationsTruncated: 0,
      };
    }

    const requested = eligibleExpirations.slice(0, this.config.maxExpirationsPerSymbol);
    const expirationsTruncated = eligibleExpirations.length - requested.length;
    const chains = await mapLimit(requested, this.config.expiryFetchConcurrency, (expiry) =>
      client.getOptionChains({
        symbol,
        expiryYear: expiry.year,
        expiryMonth: expiry.month,
        expiryDay: expiry.day,
        includeWeekly: true,
      }).catch(() => null),
    );
    const fetched = chains.filter((chain): chain is ETradeOptionChain => Boolean(chain));
    if (fetched.length === 0) {
      return {
        chains: [],
        fetchErrors: [{
          symbol,
          reason: client.lastError || expirationError || `All ${requested.length} expiration fetches returned no data.`,
        }],
        expirationsTruncated,
      };
    }
    if (fetched.length < requested.length) {
      return {
        chains: fetched,
        fetchErrors: [{
          symbol,
          reason: `${requested.length - fetched.length} of ${requested.length} expiration fetches returned no data.`,
        }],
        expirationsTruncated,
      };
    }
    return { chains: fetched, fetchErrors: [], expirationsTruncated };
  }

  fetchChainForSymbolSync(symbol: string): ETradeOptionChain | null {
    const cleanSym = symbol.toUpperCase().trim();
    if (DynamicOptionsScreener.testChainsFixture[cleanSym]) {
      return DynamicOptionsScreener.testChainsFixture[cleanSym];
    }
    return null;
  }

  /**
   * Synchronous options screening for explicit symbols with injected test fixtures only.
   * Applies the same sanitization and validation as `screenOptions`.
   */
  screenOptionsSync(rawFilter: OptionScreenerFilter = {}): OptionScreenResult {
    const { filter, warnings } = sanitizeOptionScreenerFilter(rawFilter, this.config);
    if (filter.sector && !["all", "any"].includes(filter.sector.toLowerCase())) {
      return {
        ...this.evaluateChains([], filter, 0, { warnings }),
        status: "error",
        validationError: "The dynamic all-listings feed does not include sector classifications; remove the sector filter or specify underlying symbols.",
      };
    }
    const symbols = filter.underlyingSymbols || [];
    if (symbols.length === 0) {
      return {
        ...this.evaluateChains([], filter, 0, { warnings }),
        status: "error",
        validationError: "Synchronous screening requires explicit underlying symbols.",
      };
    }
    const chains = symbols.flatMap((sym) => {
      const chain = this.fetchChainForSymbolSync(sym);
      return chain ? [{ symbol: sym, chain }] : [];
    });
    const fetchErrors: OptionScreenFetchError[] = symbols
      .filter((sym) => !DynamicOptionsScreener.testChainsFixture[sym])
      .map((symbol) => ({ symbol, reason: "No injected chain fixture for symbol." }));
    const result = this.evaluateChains(chains, filter, symbols.length, { fetchErrors, warnings });
    if (fetchErrors.length > 0 && chains.length === 0) result.status = "error";
    return result;
  }

  /**
   * Evaluates options filters across one or more underlyings (async with live upstream fetch).
   *
   * The filter is sanitized first (invalid inputs dropped, bounds clamped, defaults applied),
   * symbols are fetched through a bounded concurrency pool, and upstream failures are reported
   * via `fetchErrors` with `status: "error"` when nothing could be fetched.
   */
  async screenOptions(rawFilter: OptionScreenerFilter = {}): Promise<OptionScreenResult> {
    const { filter, warnings } = sanitizeOptionScreenerFilter(rawFilter, this.config);

    if (filter.sector && !["all", "any"].includes(filter.sector.toLowerCase())) {
      return {
        ...this.evaluateChains([], filter, 0, { warnings }),
        status: "error",
        validationError: "The dynamic all-listings feed does not include sector classifications; remove the sector filter or specify underlying symbols.",
      };
    }
    if ((!filter.underlyingSymbols || filter.underlyingSymbols.length === 0) && filter.maxUnderlyings === undefined) {
      return {
        ...this.evaluateChains([], filter, 0, { warnings }),
        status: "error",
        validationError: "Specify underlying symbols or set the visible maximum-underlyings limit before scanning option chains.",
      };
    }

    const symbols = await this.resolveUnderlyings(filter);
    const outcomes = await mapLimit(symbols, this.config.symbolFetchConcurrency, (symbol) =>
      this.fetchChainsForSymbol(symbol, filter),
    );
    const chains = outcomes.flatMap((outcome, index) =>
      outcome.chains.map((chain) => ({ symbol: symbols[index], chain })),
    );
    const fetchErrors = outcomes.flatMap((outcome) => outcome.fetchErrors);
    const expirationsTruncated = outcomes.reduce((total, outcome) => total + outcome.expirationsTruncated, 0);
    if (expirationsTruncated > 0) {
      warnings.push(
        `Fetch window capped at ${this.config.maxExpirationsPerSymbol} expirations per symbol; ${expirationsTruncated} later expiration(s) were skipped. Tighten the DTE window to include them.`,
      );
    }

    const result = this.evaluateChains(chains, filter, symbols.length, { fetchErrors, warnings });
    if (fetchErrors.length > 0 && chains.length === 0) {
      result.status = "error";
    }
    return result;
  }

  evaluateChains(
    chains: Array<{ symbol: string; chain: ETradeOptionChain }>,
    filter: OptionScreenerFilter = {},
    totalUnderlyingsScanned = new Set(chains.map((chain) => chain.symbol)).size,
    diagnostics: { fetchErrors?: OptionScreenFetchError[]; warnings?: string[] } = {}
  ): OptionScreenResult {
    const symbols = Array.from(new Set(chains.map((c) => c.symbol)));
    const summaryParts: string[] = [];

    if (symbols.length <= 5) {
      summaryParts.push(`Symbols: [${symbols.join(", ")}]`);
    } else {
      summaryParts.push(`${symbols.length} Symbols`);
    }

    if (filter.maxUnderlyings !== undefined) summaryParts.push(`Max underlyings: ${filter.maxUnderlyings}`);
    if (filter.sector && !["all", "any"].includes(filter.sector.toLowerCase())) summaryParts.push(`Sector: ${filter.sector}`);
    if (filter.contractType && filter.contractType !== "BOTH") summaryParts.push(`Type: ${filter.contractType}`);
    if (filter.minDelta !== undefined) summaryParts.push(`Delta >= ${filter.minDelta}`);
    if (filter.maxDelta !== undefined) summaryParts.push(`Delta <= ${filter.maxDelta}`);
    if (filter.minGamma !== undefined) summaryParts.push(`Gamma >= ${filter.minGamma}`);
    if (filter.maxGamma !== undefined) summaryParts.push(`Gamma <= ${filter.maxGamma}`);
    if (filter.minTheta !== undefined) summaryParts.push(`Theta >= ${filter.minTheta}`);
    if (filter.maxTheta !== undefined) summaryParts.push(`Theta <= ${filter.maxTheta}`);
    if (filter.minVega !== undefined) summaryParts.push(`Vega >= ${filter.minVega}`);
    if (filter.maxVega !== undefined) summaryParts.push(`Vega <= ${filter.maxVega}`);
    if (filter.minRho !== undefined) summaryParts.push(`Rho >= ${filter.minRho}`);
    if (filter.maxRho !== undefined) summaryParts.push(`Rho <= ${filter.maxRho}`);
    if (filter.minImpliedVolatility !== undefined) summaryParts.push(`IV >= ${(filter.minImpliedVolatility * 100).toFixed(0)}%`);
    if (filter.maxImpliedVolatility !== undefined) summaryParts.push(`IV <= ${(filter.maxImpliedVolatility * 100).toFixed(0)}%`);
    if (filter.minVolume !== undefined) summaryParts.push(`Min Vol >= ${filter.minVolume}`);
    if (filter.minOpenInterest !== undefined) summaryParts.push(`Min OI >= ${filter.minOpenInterest}`);
    if (filter.maxSpreadPct !== undefined) summaryParts.push(`Max spread <= ${filter.maxSpreadPct}%`);
    if (filter.maxQuoteAgeSeconds !== undefined) summaryParts.push(`Quote age <= ${filter.maxQuoteAgeSeconds}s`);
    if (filter.minPrice !== undefined) summaryParts.push(`Premium >= $${filter.minPrice}`);
    if (filter.maxPrice !== undefined) summaryParts.push(`Premium <= $${filter.maxPrice}`);
    if (filter.minDte !== undefined || filter.maxDte !== undefined) {
      summaryParts.push(`DTE: ${filter.minDte ?? 0}d - ${filter.maxDte ?? 365}d`);
    }
    if (filter.moneyness && filter.moneyness !== "ALL") summaryParts.push(`Moneyness: ${filter.moneyness}`);
    if (filter.sortBy && filter.sortBy !== "volume") summaryParts.push(`Sort: ${filter.sortBy}`);

    const rejections: OptionScreenRejection[] = [];
    const rejectionCounter = { total: 0 };
    const passedContracts: ScreenedOptionContractItem[] = [];
    let totalContractsEvaluated = 0;

    for (const item of chains) {
      const sym = item.symbol;
      const chain = item.chain;
      if (!chain || !chain.pairs || chain.pairs.length === 0) continue;

      const underlyingPrice = chain.underlyingPrice;
      const expiry = chain.selectedExpiry;
      if (!underlyingPrice || underlyingPrice <= 0 || !expiry) continue;

      const expDateStr = `${expiry.year}-${String(expiry.month).padStart(2, "0")}-${String(expiry.day).padStart(2, "0")}`;
      const expiryDateObj = new Date(Date.UTC(expiry.year, expiry.month - 1, expiry.day));
      const nowObj = new Date();
      const diffMs = expiryDateObj.getTime() - nowObj.getTime();
      const daysToExpiration = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (daysToExpiration < 0) continue;
      const context: ContractScreenContext = {
        symbol: sym,
        expiry,
        expirationDate: expDateStr,
        daysToExpiration,
        underlyingPrice,
      };

      for (const pair of chain.pairs) {
        const candidates: ETradeOptionChainContract[] = [];
        if (filter.contractType === "PUT") {
          if (pair.put) candidates.push(pair.put);
        } else if (filter.contractType === "CALL") {
          if (pair.call) candidates.push(pair.call);
        } else {
          if (pair.call) candidates.push(pair.call);
          if (pair.put) candidates.push(pair.put);
        }

        for (const c of candidates) {
          totalContractsEvaluated++;

          const outcome = evaluateContract(c, context, filter, this.config);
          if (outcome.rejection) {
            rejectionCounter.total++;
            if (rejections.length < this.config.maxRejectionsReturned) rejections.push(outcome.rejection);
          } else if (outcome.item) {
            passedContracts.push(outcome.item);
          }
        }
      }
    }

    sortScreenedContracts(passedContracts, filter.sortBy);

    const totalMatches = passedContracts.length;
    const effectiveLimit = filter.limit && filter.limit > 0 ? filter.limit : this.config.maxReturnedContracts;
    const finalContracts = passedContracts.slice(0, effectiveLimit);
    const warnings = [...(diagnostics.warnings ?? [])];
    if (totalMatches > finalContracts.length) {
      warnings.push(`Returned ${finalContracts.length} of ${totalMatches} matching contracts (limit ${effectiveLimit}).`);
    }

    const staleReturned = finalContracts.filter((contract) => contract.quoteFreshness === "STALE");
    const unknownFreshness = finalContracts.filter((contract) => contract.quoteFreshness === "UNKNOWN");
    const staleQuoteAges = staleReturned
      .map((contract) => contract.quoteAgeSeconds)
      .filter((age): age is number => age !== undefined && Number.isFinite(age));
    const fetchErrors = diagnostics.fetchErrors ?? [];

    return {
      totalUnderlyingsScanned,
      totalContractsEvaluated,
      matchedCount: finalContracts.length,
      totalMatches,
      rejectionCount: rejectionCounter.total,
      filterApplied: { ...filter },
      filterSummary: summaryParts.join(", ") || "Live E*TRADE option chains",
      contracts: finalContracts,
      scannedAt: new Date().toISOString(),
      quoteQuality: {
        maxAgeSeconds: filter.maxQuoteAgeSeconds,
        referenceAgeSeconds: filter.maxQuoteAgeSeconds ?? this.config.defaultQuoteAgeSeconds,
        staleContractsReturned: staleReturned.length,
        unknownFreshnessContracts: unknownFreshness.length,
        ...(staleQuoteAges.length > 0 ? { freshestStaleQuoteAgeSeconds: Math.min(...staleQuoteAges) } : {}),
      },
      status: finalContracts.length > 0 ? "matches_found" : "no_matches",
      rejections: rejections.slice(0, this.config.maxRejectionsReturned),
      ...(fetchErrors.length > 0 ? { fetchErrors } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}

/** Shared per-expiration values used while screening each contract. */
interface ContractScreenContext {
  symbol: string;
  expiry: { year: number; month: number; day: number };
  expirationDate: string;
  daysToExpiration: number;
  underlyingPrice: number;
}

interface ContractOutcome {
  rejection?: OptionScreenRejection;
  item?: ScreenedOptionContractItem;
}

function contractRejection(
  code: OptionScreenRejection["code"],
  contractSymbol: string,
  underlyingSymbol: string,
  reason: string,
  extra: Partial<OptionScreenRejection> = {},
): OptionScreenRejection {
  return { code, contractSymbol, underlyingSymbol, reason, ...extra };
}

/**
 * Applies every filter to a single contract in rejection-priority order
 * (adjusted -> quote validity -> spread -> premium -> DTE -> Greeks -> IV ->
 * liquidity -> moneyness -> strike distance). Returns either the first rejection
 * or the fully enriched result item; never mutates its inputs.
 */
function evaluateContract(
  c: ETradeOptionChainContract,
  context: ContractScreenContext,
  filter: OptionScreenerFilter,
  config: EtapiScreenerConfig = getScreenerConfig(),
): ContractOutcome {
  const { symbol, expiry, expirationDate, daysToExpiration, underlyingPrice } = context;
  const contractSym = c.osiKey
    || buildOsiSymbol(c.optionRootSymbol || c.symbol || symbol, expiry, c.optionType, c.strikePrice);
  const delta = c.delta !== undefined ? Math.abs(c.delta) : undefined;
  const gamma = c.gamma;
  const theta = c.theta;
  const vega = c.vega;
  const rho = c.rho;
  const iv = c.impliedVolatility;
  const vol = c.volume;
  const oi = c.openInterest;
  const strike = c.strikePrice;

  if (c.adjustedFlag) {
    return { rejection: contractRejection("ADJUSTED_CONTRACT", contractSym, symbol, "Adjusted/non-standard contract is excluded") };
  }

  // Quote age; negative ages (future timestamps / clock skew) are treated as unknown.
  const quoteTimestampMs = c.timeStamp
    ? c.timeStamp < 1_000_000_000_000 ? c.timeStamp * 1000 : c.timeStamp
    : undefined;
  const quoteAgeSeconds = quoteTimestampMs === undefined
    ? undefined
    : (Date.now() - quoteTimestampMs) / 1000;
  const freshnessReference = filter.maxQuoteAgeSeconds ?? DEFAULT_QUOTE_AGE_SECONDS;
  const quoteFreshness = quoteAgeSeconds === undefined || quoteAgeSeconds < 0
    ? "UNKNOWN" as const
    : quoteAgeSeconds > freshnessReference ? "STALE" as const : "FRESH" as const;

  if (c.bid <= 0 || c.ask <= 0 || c.ask < c.bid) {
    return { rejection: contractRejection("INVALID_QUOTE", contractSym, symbol, `Invalid bid/ask quote (bid ${c.bid}, ask ${c.ask})`) };
  }
  const midpoint = (c.bid + c.ask) / 2;
  const spreadPct = ((c.ask - c.bid) / midpoint) * 100;
  if (filter.maxSpreadPct !== undefined && spreadPct > filter.maxSpreadPct) {
    return { rejection: contractRejection("SPREAD_TOO_WIDE", contractSym, symbol, `Spread (${spreadPct.toFixed(2)}%) exceeds maximum ${filter.maxSpreadPct}%`, { spreadPct }) };
  }

  // Premium bounds, evaluated on the bid/ask midpoint.
  if (filter.minPrice !== undefined && midpoint < filter.minPrice) {
    return { rejection: contractRejection("PREMIUM_OUT_OF_RANGE", contractSym, symbol, `Premium ($${midpoint.toFixed(2)}) below minimum $${filter.minPrice}`, { spreadPct }) };
  }
  if (filter.maxPrice !== undefined && midpoint > filter.maxPrice) {
    return { rejection: contractRejection("PREMIUM_OUT_OF_RANGE", contractSym, symbol, `Premium ($${midpoint.toFixed(2)}) exceeds maximum $${filter.maxPrice}`, { spreadPct }) };
  }

  if (filter.minDte !== undefined && daysToExpiration < filter.minDte) {
    return { rejection: contractRejection("DTE_OUT_OF_RANGE", contractSym, symbol, `DTE (${daysToExpiration}d) below minimum ${filter.minDte}d`, { daysToExpiration }) };
  }
  if (filter.maxDte !== undefined && daysToExpiration > filter.maxDte) {
    return { rejection: contractRejection("DTE_OUT_OF_RANGE", contractSym, symbol, `DTE (${daysToExpiration}d) exceeds maximum ${filter.maxDte}d`, { daysToExpiration }) };
  }

  // Delta filters compare the ABSOLUTE delta; rejections report the absolute value
  // while returned contracts keep their signed delta (see OptionScreenerFilter docs).
  if (filter.minDelta !== undefined && (delta === undefined || delta < filter.minDelta)) {
    return { rejection: contractRejection("DELTA_OUT_OF_RANGE", contractSym, symbol, `Delta (${delta?.toFixed(2) ?? "N/A"}) below minimum ${filter.minDelta}`, { delta }) };
  }
  if (filter.maxDelta !== undefined && (delta === undefined || delta > filter.maxDelta)) {
    return { rejection: contractRejection("DELTA_OUT_OF_RANGE", contractSym, symbol, `Delta (${delta?.toFixed(2) ?? "N/A"}) exceeds maximum ${filter.maxDelta}`, { delta }) };
  }

  if (filter.minGamma !== undefined && (gamma === undefined || gamma < filter.minGamma)) {
    return { rejection: contractRejection("GAMMA_OUT_OF_RANGE", contractSym, symbol, `Gamma (${gamma?.toFixed(4) ?? "N/A"}) below minimum ${filter.minGamma}`, { gamma }) };
  }
  if (filter.maxGamma !== undefined && (gamma === undefined || gamma > filter.maxGamma)) {
    return { rejection: contractRejection("GAMMA_OUT_OF_RANGE", contractSym, symbol, `Gamma (${gamma?.toFixed(4) ?? "N/A"}) exceeds maximum ${filter.maxGamma}`, { gamma }) };
  }
  if (filter.minTheta !== undefined && (theta === undefined || theta < filter.minTheta)) {
    return { rejection: contractRejection("THETA_OUT_OF_RANGE", contractSym, symbol, `Theta (${theta?.toFixed(4) ?? "N/A"}) below minimum ${filter.minTheta}`, { theta }) };
  }
  if (filter.maxTheta !== undefined && (theta === undefined || theta > filter.maxTheta)) {
    return { rejection: contractRejection("THETA_OUT_OF_RANGE", contractSym, symbol, `Theta (${theta?.toFixed(4) ?? "N/A"}) exceeds maximum ${filter.maxTheta}`, { theta }) };
  }

  if (filter.minVega !== undefined && (vega === undefined || vega < filter.minVega)) {
    return { rejection: contractRejection("VEGA_OUT_OF_RANGE", contractSym, symbol, `Vega (${vega?.toFixed(4) ?? "N/A"}) below minimum ${filter.minVega.toFixed(4)}`, { vega }) };
  }
  if (filter.maxVega !== undefined && (vega === undefined || vega > filter.maxVega)) {
    return { rejection: contractRejection("VEGA_OUT_OF_RANGE", contractSym, symbol, `Vega (${vega?.toFixed(4) ?? "N/A"}) exceeds maximum ${filter.maxVega.toFixed(4)}`, { vega }) };
  }
  if (filter.minRho !== undefined && (rho === undefined || rho < filter.minRho)) {
    return { rejection: contractRejection("RHO_OUT_OF_RANGE", contractSym, symbol, `Rho (${rho?.toFixed(4) ?? "N/A"}) below minimum ${filter.minRho.toFixed(4)}`, { rho }) };
  }
  if (filter.maxRho !== undefined && (rho === undefined || rho > filter.maxRho)) {
    return { rejection: contractRejection("RHO_OUT_OF_RANGE", contractSym, symbol, `Rho (${rho?.toFixed(4) ?? "N/A"}) exceeds maximum ${filter.maxRho.toFixed(4)}`, { rho }) };
  }

  if (filter.minImpliedVolatility !== undefined && (iv === undefined || iv < filter.minImpliedVolatility)) {
    return { rejection: contractRejection("IV_OUT_OF_RANGE", contractSym, symbol, `IV (${iv === undefined ? "N/A" : `${(iv * 100).toFixed(1)}%`}) below minimum ${(filter.minImpliedVolatility * 100).toFixed(1)}%`, { iv }) };
  }
  if (filter.maxImpliedVolatility !== undefined && (iv === undefined || iv > filter.maxImpliedVolatility)) {
    return { rejection: contractRejection("IV_OUT_OF_RANGE", contractSym, symbol, `IV (${iv === undefined ? "N/A" : `${(iv * 100).toFixed(1)}%`}) exceeds maximum ${(filter.maxImpliedVolatility * 100).toFixed(1)}%`, { iv }) };
  }

  if (filter.minVolume !== undefined && (vol === undefined || vol < filter.minVolume)) {
    return { rejection: contractRejection("VOLUME_TOO_LOW", contractSym, symbol, `Volume (${vol?.toLocaleString() ?? "N/A"}) below minimum ${filter.minVolume.toLocaleString()}`, { volume: vol }) };
  }
  if (filter.minOpenInterest !== undefined && (oi === undefined || oi < filter.minOpenInterest)) {
    return { rejection: contractRejection("OPEN_INTEREST_TOO_LOW", contractSym, symbol, `Open Interest (${oi?.toLocaleString() ?? "N/A"}) below minimum ${filter.minOpenInterest.toLocaleString()}`) };
  }

  // Moneyness with configurable ATM band around the underlying price.
  const strikeDistPct = Number((Math.abs(strike - underlyingPrice) / underlyingPrice * 100).toFixed(2));
  const atmBand = config.atmBandPct;
  let moneyness: "ITM" | "OTM" | "ATM" = "ATM";
  if (c.optionType === "CALL") {
    if (strike < underlyingPrice * (1 - atmBand)) moneyness = "ITM";
    else if (strike > underlyingPrice * (1 + atmBand)) moneyness = "OTM";
  } else {
    if (strike > underlyingPrice * (1 + atmBand)) moneyness = "ITM";
    else if (strike < underlyingPrice * (1 - atmBand)) moneyness = "OTM";
  }
  if (filter.moneyness && filter.moneyness !== "ALL" && moneyness !== filter.moneyness) {
    return { rejection: contractRejection("MONEYNESS_MISMATCH", contractSym, symbol, `Moneyness (${moneyness}) does not match filter (${filter.moneyness})`, { strikePrice: strike }) };
  }

  if (filter.maxStrikeDistancePct !== undefined && strikeDistPct > filter.maxStrikeDistancePct) {
    return { rejection: contractRejection("STRIKE_DISTANCE_TOO_WIDE", contractSym, symbol, `Strike distance (${strikeDistPct}%) exceeds maximum ${filter.maxStrikeDistancePct}%`, { strikePrice: strike }) };
  }

  // Passed all checks: compute signals and enrich the result item.
  const volOiRatio = oi && oi > 0 && vol !== undefined ? Number((vol / oi).toFixed(2)) : undefined;
  const item: ScreenedOptionContractItem = {
    ...c,
    osiKey: contractSym,
    underlyingSymbol: symbol,
    underlyingPrice,
    daysToExpiration,
    expirationDate,
    moneyness,
    strikeDistancePct: strikeDistPct,
    spreadPct,
    quoteAgeSeconds,
    quoteFreshness,
    ...(quoteTimestampMs !== undefined && quoteAgeSeconds !== undefined && quoteAgeSeconds >= 0
      ? { quoteTimestamp: new Date(quoteTimestampMs).toISOString() }
      : {}),
    volumeOiRatio: volOiRatio,
    technicalSignal: computeTechnicalSignal(volOiRatio, delta, iv, config),
    highlightReason: `${symbol} $${strike} ${c.optionType} | ${daysToExpiration}d DTE | IV: ${iv === undefined ? "N/A" : `${(iv * 100).toFixed(0)}%`}`,
  };
  return { item };
}

/** Direction-agnostic technical signal derived from liquidity and volatility heuristics. */
function computeTechnicalSignal(
  volOiRatio: number | undefined,
  absDelta: number | undefined,
  iv: number | undefined,
  config: EtapiScreenerConfig = getScreenerConfig()
): string {
  if (volOiRatio !== undefined && volOiRatio >= config.unusualVolumeOiRatio) {
    return `Unusual Volume Spike (Vol/OI: ${volOiRatio}x)`;
  }
  if (absDelta !== undefined && absDelta >= config.highDeltaThreshold) {
    return `High Delta Momentum (|delta| >= ${config.highDeltaThreshold})`;
  }
  if (iv !== undefined && iv >= config.highIvThreshold) return "High Implied Volatility Expansion";
  if (iv !== undefined && iv <= config.lowIvThreshold) return "Low IV Value Opportunity";
  return "Liquid Standard Option";
}

const SCREENED_CONTRACT_COMPARATORS: Record<OptionScreenSortKey, (a: ScreenedOptionContractItem, b: ScreenedOptionContractItem) => number> = {
  volume: (a, b) => (b.volume ?? 0) - (a.volume ?? 0),
  spreadPct: (a, b) => a.spreadPct - b.spreadPct,
  iv: (a, b) => (b.impliedVolatility ?? -1) - (a.impliedVolatility ?? -1),
  volumeOiRatio: (a, b) => (b.volumeOiRatio ?? -1) - (a.volumeOiRatio ?? -1),
  dte: (a, b) => a.daysToExpiration - b.daysToExpiration,
  strikeDistance: (a, b) => a.strikeDistancePct - b.strikeDistancePct,
};

/** In-place sort honoring `sortBy` with deterministic tie-breakers (symbol, then strike). */
function sortScreenedContracts(contracts: ScreenedOptionContractItem[], sortBy: OptionScreenSortKey = "volume"): void {
  const compare = SCREENED_CONTRACT_COMPARATORS[sortBy] ?? SCREENED_CONTRACT_COMPARATORS.volume;
  contracts.sort((a, b) => compare(a, b) || a.underlyingSymbol.localeCompare(b.underlyingSymbol) || a.strikePrice - b.strikePrice);
}
