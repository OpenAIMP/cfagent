/**
 * Dynamic Options Screener Engine
 *
 * Implements:
 * - Multi-symbol and sector-wide options chain scanning.
 * - Multi-factor filtering: IV, Delta, Gamma, Theta, Volume, Open Interest, DTE, Moneyness.
 * - Unusual option activity detection (Vol/OI divergence, IV skew).
 * - Real-time integration with E*TRADE REST API option chains.
 */

import type {
  OptionScreenerFilter,
  OptionScreenResult,
  ScreenedOptionContractItem,
  OptionScreenRejection,
  ETradeOptionChain,
  ETradeOptionChainContract,
} from "../types";
import type { ETradeRestClient } from "./etrade/client";
import { fetchAllUsStockListings, type NasdaqStockListing } from "../services/nasdaqListings";

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


export class DynamicOptionsScreener {
  private client?: ETradeRestClient;
  private static testChainsFixture: Record<string, ETradeOptionChain> = {};
  private static testListingsFixture: NasdaqStockListing[] | null = null;

  constructor(client?: ETradeRestClient) {
    this.client = client;
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
   */
  async resolveUnderlyings(filter: OptionScreenerFilter): Promise<string[]> {
    if (filter.underlyingSymbols && filter.underlyingSymbols.length > 0) {
      return Array.from(new Set(filter.underlyingSymbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
    }

    const listings = DynamicOptionsScreener.testListingsFixture ?? await fetchAllUsStockListings();
    const discovered = Array.from(new Set(listings.map((listing) => listing.symbol.toUpperCase())));
    return filter.maxUnderlyings && filter.maxUnderlyings > 0
      ? discovered.slice(0, filter.maxUnderlyings)
      : discovered;
  }

  /**
  * Fetch a real E*TRADE option chain or a test-only injected fixture.
   */
  async fetchChainForSymbol(symbol: string): Promise<ETradeOptionChain | null> {
    const cleanSym = symbol.toUpperCase().trim();

    // 1. Check test fixture
    if (DynamicOptionsScreener.testChainsFixture[cleanSym]) {
      return DynamicOptionsScreener.testChainsFixture[cleanSym];
    }

    // 2. Query upstream client if available
    if (this.client) {
      const chain = await this.client.getOptionChains({ symbol: cleanSym }).catch(() => null);
      if (chain && chain.pairs && chain.pairs.length > 0) {
        return chain;
      }
    }

    return null;
  }

  private async fetchChainsForSymbol(
    symbol: string,
    filter: OptionScreenerFilter
  ): Promise<ETradeOptionChain[]> {
    const fixture = DynamicOptionsScreener.testChainsFixture[symbol];
    if (fixture) return [fixture];
    if (!this.client) return [];

    let expirations: Array<{ year: number; month: number; day: number }> = [];
    try {
      expirations = await this.client.getOptionExpireDates(symbol);
    } catch {
      expirations = [];
    }

    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const eligibleExpirations = expirations.filter((expiry) => {
      const expirationUtc = Date.UTC(expiry.year, expiry.month - 1, expiry.day);
      const dte = Math.ceil((expirationUtc - todayUtc) / (24 * 60 * 60 * 1000));
      return (filter.minDte === undefined || dte >= filter.minDte) &&
        (filter.maxDte === undefined || dte <= filter.maxDte);
    });

    if (eligibleExpirations.length === 0) {
      if (expirations.length > 0) return [];
      const chain = await this.client.getOptionChains({ symbol }).catch(() => null);
      return chain ? [chain] : [];
    }

    const chains = await Promise.all(eligibleExpirations.map((expiry) =>
      this.client!.getOptionChains({
        symbol,
        expiryYear: expiry.year,
        expiryMonth: expiry.month,
        expiryDay: expiry.day,
        includeWeekly: true,
      }).catch(() => null)
    ));
    return chains.filter((chain): chain is ETradeOptionChain => Boolean(chain));
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
   */
  screenOptionsSync(filter: OptionScreenerFilter = {}): OptionScreenResult {
    const appliedFilter = filter;
    const symbols = filter.underlyingSymbols?.map((symbol) => symbol.toUpperCase().trim()).filter(Boolean) || [];
    const chains = symbols.flatMap((sym) => {
      const chain = this.fetchChainForSymbolSync(sym);
      return chain ? [{ symbol: sym, chain }] : [];
    });
    return this.evaluateChains(chains, appliedFilter, symbols.length);
  }

  /**
   * Evaluates options filters across one or more underlyings (async with live upstream fetch)
   */
  async screenOptions(filter: OptionScreenerFilter = {}): Promise<OptionScreenResult> {
    if (filter.sector && !["all", "any"].includes(filter.sector.toLowerCase())) {
      const result = this.evaluateChains([], filter, 0);
      return { ...result, validationError: "The dynamic all-listings feed does not include sector classifications; remove the sector filter or specify underlying symbols." };
    }
    if ((!filter.underlyingSymbols || filter.underlyingSymbols.length === 0) && filter.maxUnderlyings === undefined) {
      const result = this.evaluateChains([], filter, 0);
      return { ...result, validationError: "Specify underlying symbols or set the visible maximum-underlyings limit before scanning option chains." };
    }
    const symbols = await this.resolveUnderlyings(filter);
    const appliedFilter = filter;
    const fetched = await Promise.all(symbols.map(async (symbol) => ({
      symbol,
      chains: await this.fetchChainsForSymbol(symbol, appliedFilter),
    })));
    const chains = fetched.flatMap((item) => item.chains.map((chain) => ({ symbol: item.symbol, chain })));
    return this.evaluateChains(chains, appliedFilter, symbols.length);
  }

  private evaluateChains(
    chains: Array<{ symbol: string; chain: ETradeOptionChain }>,
    filter: OptionScreenerFilter = {},
    totalUnderlyingsScanned = new Set(chains.map((chain) => chain.symbol)).size
  ): OptionScreenResult {
    const symbols = Array.from(new Set(chains.map((c) => c.symbol)));
    const summaryParts: string[] = [];

    if (symbols.length <= 5) {
      summaryParts.push(`Symbols: [${symbols.join(", ")}]`);
    } else {
      summaryParts.push(`${symbols.length} Symbols`);
    }

    if (filter.sector) summaryParts.push(`Sector: ${filter.sector}`);
    if (filter.contractType && filter.contractType !== "BOTH") summaryParts.push(`Type: ${filter.contractType}`);
    if (filter.minDelta !== undefined) summaryParts.push(`Delta >= ${filter.minDelta}`);
    if (filter.maxDelta !== undefined) summaryParts.push(`Delta <= ${filter.maxDelta}`);
    if (filter.minGamma !== undefined) summaryParts.push(`Gamma >= ${filter.minGamma}`);
    if (filter.maxGamma !== undefined) summaryParts.push(`Gamma <= ${filter.maxGamma}`);
    if (filter.minTheta !== undefined) summaryParts.push(`Theta >= ${filter.minTheta}`);
    if (filter.maxTheta !== undefined) summaryParts.push(`Theta <= ${filter.maxTheta}`);
    if (filter.minImpliedVolatility !== undefined) summaryParts.push(`IV >= ${(filter.minImpliedVolatility * 100).toFixed(0)}%`);
    if (filter.maxImpliedVolatility !== undefined) summaryParts.push(`IV <= ${(filter.maxImpliedVolatility * 100).toFixed(0)}%`);
    if (filter.minVolume !== undefined) summaryParts.push(`Min Vol >= ${filter.minVolume}`);
    if (filter.minOpenInterest !== undefined) summaryParts.push(`Min OI >= ${filter.minOpenInterest}`);
    if (filter.maxSpreadPct !== undefined) summaryParts.push(`Max spread <= ${filter.maxSpreadPct}%`);
    if (filter.maxQuoteAgeSeconds !== undefined) summaryParts.push(`Quote age <= ${filter.maxQuoteAgeSeconds}s`);
    if (filter.minDte !== undefined || filter.maxDte !== undefined) {
      summaryParts.push(`DTE: ${filter.minDte ?? 0}d - ${filter.maxDte ?? 365}d`);
    }
    if (filter.moneyness && filter.moneyness !== "ALL") summaryParts.push(`Moneyness: ${filter.moneyness}`);

    const rejections: OptionScreenRejection[] = [];
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
          const contractSym = c.osiKey
            || buildOsiSymbol(c.optionRootSymbol || c.symbol || sym, expiry, c.optionType, c.strikePrice);
          const delta = c.delta !== undefined ? Math.abs(c.delta) : undefined;
          const gamma = c.gamma;
          const theta = c.theta;
          const iv = c.impliedVolatility;
          const vol = c.volume;
          const oi = c.openInterest;
          const strike = c.strikePrice;

          if (c.adjustedFlag) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: "Adjusted/non-standard contract is excluded",
            });
            continue;
          }

          const quoteTimestampMs = c.timeStamp
            ? c.timeStamp < 1_000_000_000_000 ? c.timeStamp * 1000 : c.timeStamp
            : undefined;
          const quoteAgeSeconds = quoteTimestampMs === undefined
            ? undefined
            : (Date.now() - quoteTimestampMs) / 1000;
          const quoteFreshness = quoteAgeSeconds === undefined || quoteAgeSeconds < 0
            ? "UNKNOWN" as const
            : filter.maxQuoteAgeSeconds === undefined
            ? "UNKNOWN" as const
            : quoteAgeSeconds > filter.maxQuoteAgeSeconds ? "STALE" as const : "FRESH" as const;

          if (c.bid <= 0 || c.ask <= 0 || c.ask < c.bid) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Invalid bid/ask quote (bid ${c.bid}, ask ${c.ask})`,
            });
            continue;
          }

          const midpoint = (c.bid + c.ask) / 2;
          const spreadPct = ((c.ask - c.bid) / midpoint) * 100;
          if (filter.maxSpreadPct !== undefined && spreadPct > filter.maxSpreadPct) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Spread (${spreadPct.toFixed(2)}%) exceeds maximum ${filter.maxSpreadPct}%`,
              spreadPct,
            });
            continue;
          }

          // 1. DTE check
          if (filter.minDte !== undefined && daysToExpiration < filter.minDte) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `DTE (${daysToExpiration}d) below minimum ${filter.minDte}d`,
              daysToExpiration,
            });
            continue;
          }
          if (filter.maxDte !== undefined && daysToExpiration > filter.maxDte) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `DTE (${daysToExpiration}d) exceeds maximum ${filter.maxDte}d`,
              daysToExpiration,
            });
            continue;
          }

          // 2. Delta check
          if (filter.minDelta !== undefined && (delta === undefined || delta < filter.minDelta)) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Delta (${delta?.toFixed(2) ?? "N/A"}) below minimum ${filter.minDelta}`,
              delta,
            });
            continue;
          }
          if (filter.maxDelta !== undefined && (delta === undefined || delta > filter.maxDelta)) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Delta (${delta?.toFixed(2) ?? "N/A"}) exceeds maximum ${filter.maxDelta}`,
              delta,
            });
            continue;
          }

          if (filter.minGamma !== undefined && (gamma === undefined || gamma < filter.minGamma)) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Gamma (${gamma?.toFixed(4) ?? "N/A"}) below minimum ${filter.minGamma}`,
              gamma,
            });
            continue;
          }
          if (filter.maxGamma !== undefined && (gamma === undefined || gamma > filter.maxGamma)) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Gamma (${gamma?.toFixed(4) ?? "N/A"}) exceeds maximum ${filter.maxGamma}`,
              gamma,
            });
            continue;
          }
          if (filter.minTheta !== undefined && (theta === undefined || theta < filter.minTheta)) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Theta (${theta?.toFixed(4) ?? "N/A"}) below minimum ${filter.minTheta}`,
              theta,
            });
            continue;
          }
          if (filter.maxTheta !== undefined && (theta === undefined || theta > filter.maxTheta)) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Theta (${theta?.toFixed(4) ?? "N/A"}) exceeds maximum ${filter.maxTheta}`,
              theta,
            });
            continue;
          }

          // 3. Implied Volatility check
          if (filter.minImpliedVolatility !== undefined && (iv === undefined || iv < filter.minImpliedVolatility)) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `IV (${iv === undefined ? "N/A" : `${(iv * 100).toFixed(1)}%`}) below minimum ${(filter.minImpliedVolatility * 100).toFixed(1)}%`,
              iv,
            });
            continue;
          }
          if (filter.maxImpliedVolatility !== undefined && (iv === undefined || iv > filter.maxImpliedVolatility)) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `IV (${iv === undefined ? "N/A" : `${(iv * 100).toFixed(1)}%`}) exceeds maximum ${(filter.maxImpliedVolatility * 100).toFixed(1)}%`,
              iv,
            });
            continue;
          }

          // 4. Volume check
          if (filter.minVolume !== undefined && (vol === undefined || vol < filter.minVolume)) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Volume (${vol?.toLocaleString() ?? "N/A"}) below minimum ${filter.minVolume.toLocaleString()}`,
              volume: vol,
            });
            continue;
          }

          // 5. Open Interest check
          if (filter.minOpenInterest !== undefined && (oi === undefined || oi < filter.minOpenInterest)) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Open Interest (${oi?.toLocaleString() ?? "N/A"}) below minimum ${filter.minOpenInterest.toLocaleString()}`,
            });
            continue;
          }

          // 6. Moneyness calculation
          const strikeDistPct = Number((Math.abs(strike - underlyingPrice) / underlyingPrice * 100).toFixed(2));
          let moneyness: "ITM" | "OTM" | "ATM" = "ATM";
          if (c.optionType === "CALL") {
            if (strike < underlyingPrice * 0.98) moneyness = "ITM";
            else if (strike > underlyingPrice * 1.02) moneyness = "OTM";
            else moneyness = "ATM";
          } else {
            if (strike > underlyingPrice * 1.02) moneyness = "ITM";
            else if (strike < underlyingPrice * 0.98) moneyness = "OTM";
            else moneyness = "ATM";
          }

          if (filter.moneyness && filter.moneyness !== "ALL" && moneyness !== filter.moneyness) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Moneyness (${moneyness}) does not match filter (${filter.moneyness})`,
              strikePrice: strike,
            });
            continue;
          }

          // 7. Max strike distance from underlying
          if (filter.maxStrikeDistancePct !== undefined && strikeDistPct > filter.maxStrikeDistancePct) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Strike distance (${strikeDistPct}%) exceeds maximum ${filter.maxStrikeDistancePct}%`,
              strikePrice: strike,
            });
            continue;
          }

          // Passed all checks! Compute signals
          const volOiRatio = oi && oi > 0 && vol !== undefined ? Number((vol / oi).toFixed(2)) : undefined;
          let technicalSignal = "Liquid Standard Option";
          if (volOiRatio && volOiRatio >= 1.5) {
            technicalSignal = `Unusual Volume Spike (Vol/OI: ${volOiRatio}x)`;
          } else if (delta !== undefined && delta >= 0.65) {
            technicalSignal = "High Delta Trending Momentum";
          } else if (iv !== undefined && iv >= 0.70) {
            technicalSignal = "High Implied Volatility Expansion";
          } else if (iv !== undefined && iv <= 0.30) {
            technicalSignal = "Low IV Value Opportunity";
          }

          passedContracts.push({
            ...c,
            osiKey: contractSym,
            underlyingSymbol: sym,
            underlyingPrice,
            daysToExpiration,
            expirationDate: expDateStr,
            moneyness,
            strikeDistancePct: strikeDistPct,
            spreadPct,
            quoteAgeSeconds,
            quoteFreshness,
            ...(quoteTimestampMs !== undefined && quoteAgeSeconds !== undefined && quoteAgeSeconds >= 0
              ? { quoteTimestamp: new Date(quoteTimestampMs).toISOString() }
              : {}),
            volumeOiRatio: volOiRatio,
            technicalSignal,
            highlightReason: `${sym} $${strike} ${c.optionType} | ${daysToExpiration}d DTE | IV: ${iv === undefined ? "N/A" : `${(iv * 100).toFixed(0)}%`}`,
            validationStatus: "PASS_CONFIRMED",
          });
        }
      }
    }

    // Sort by volume descending by default
    passedContracts.sort((a, b) => (b.volume || 0) - (a.volume || 0));

    const finalContracts = filter.limit && filter.limit > 0
      ? passedContracts.slice(0, filter.limit)
      : passedContracts;
    const staleReturned = finalContracts.filter((contract) => contract.quoteFreshness === "STALE");
    const unknownFreshness = finalContracts.filter((contract) => contract.quoteFreshness === "UNKNOWN");
    const staleQuoteAges = staleReturned
      .map((contract) => contract.quoteAgeSeconds)
      .filter((age): age is number => age !== undefined && Number.isFinite(age));

    return {
      totalUnderlyingsScanned,
      totalContractsEvaluated,
      matchedCount: finalContracts.length,
      filterApplied: filter,
      filterSummary: summaryParts.join(", ") || "Live E*TRADE option chains",
      contracts: finalContracts,
      scannedAt: new Date().toISOString(),
      quoteQuality: {
        maxAgeSeconds: filter.maxQuoteAgeSeconds,
        staleContractsReturned: staleReturned.length,
        unknownFreshnessContracts: unknownFreshness.length,
        ...(staleQuoteAges.length > 0 ? { freshestStaleQuoteAgeSeconds: Math.min(...staleQuoteAges) } : {}),
      },
      status: finalContracts.length > 0 ? "matches_found" : "no_matches",
      rejections: rejections.slice(0, 50),
    };
  }

}
