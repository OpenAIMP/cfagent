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

const DEFAULT_OPTION_FILTERS: Required<Pick<
  OptionScreenerFilter,
  "minDte" | "maxDte" | "minVolume" | "minOpenInterest" | "maxSpreadPct" | "maxQuoteAgeSeconds"
>> = {
  minDte: 14,
  maxDte: 60,
  minVolume: 50,
  minOpenInterest: 500,
  maxSpreadPct: 10,
  maxQuoteAgeSeconds: 60,
};

export class DynamicOptionsScreener {
  private client?: ETradeRestClient;
  private static testChainsFixture: Record<string, ETradeOptionChain> = {};

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

  /**
  * Resolve explicit underlyings or discover candidates from live movers and user watchlists.
   */
  async resolveUnderlyings(filter: OptionScreenerFilter): Promise<string[]> {
    if (filter.underlyingSymbols && filter.underlyingSymbols.length > 0) {
      return Array.from(new Set(filter.underlyingSymbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
    }

    if (!this.client) return [];
    const [active, gainers, losers, watchlists] = await Promise.all([
      this.client.getMarketMovers("active"),
      this.client.getMarketMovers("gainers"),
      this.client.getMarketMovers("losers"),
      this.client.getWatchlists(),
    ]);
    const symbols = [
      ...active,
      ...gainers,
      ...losers,
      ...watchlists.flatMap((watchlist) => watchlist.symbols || []),
    ].map((symbol) => symbol.toUpperCase().trim()).filter(Boolean);
    const candidates = Array.from(new Set(symbols)).slice(0, 50);
    if (!filter.sector || ["all", "any"].includes(filter.sector.toLowerCase())) return candidates;

    const quotes = await this.client.fetchQuotes(candidates, { overrideSymbolCount: true });
    const sector = filter.sector.toLowerCase().trim();
    return quotes
      .filter((quote) => {
        const quoteSector = (quote.sector || "").toLowerCase().trim();
        if (!quoteSector) return false;
        if (sector === "tech" || sector === "technology") {
          return quoteSector.includes("tech") || quoteSector.includes("semiconductor");
        }
        return quoteSector === sector || quoteSector.includes(sector) || sector.includes(quoteSector);
      })
      .map((quote) => quote.symbol);
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
      return dte >= (filter.minDte ?? DEFAULT_OPTION_FILTERS.minDte) &&
        dte <= (filter.maxDte ?? DEFAULT_OPTION_FILTERS.maxDte);
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
    const appliedFilter = { ...DEFAULT_OPTION_FILTERS, ...filter };
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
    const symbols = await this.resolveUnderlyings(filter);
    const appliedFilter = { ...DEFAULT_OPTION_FILTERS, ...filter };
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
          const contractSym = c.symbol || `${sym}_${c.strikePrice}_${c.optionType}`;
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
          if (
            quoteAgeSeconds === undefined ||
            quoteAgeSeconds < 0 ||
            (filter.maxQuoteAgeSeconds !== undefined && quoteAgeSeconds > filter.maxQuoteAgeSeconds)
          ) {
            rejections.push({
              contractSymbol: contractSym,
              underlyingSymbol: sym,
              reason: `Quote is missing, future-dated, or stale (${quoteAgeSeconds?.toFixed(1) ?? "N/A"}s)`,
              quoteAgeSeconds,
            });
            continue;
          }

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
            underlyingSymbol: sym,
            underlyingPrice,
            daysToExpiration,
            expirationDate: expDateStr,
            moneyness,
            strikeDistancePct: strikeDistPct,
            spreadPct,
            quoteAgeSeconds,
            quoteTimestamp: new Date(quoteTimestampMs as number).toISOString(),
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

    const limit = filter.limit || 25;
    const finalContracts = passedContracts.slice(0, limit);
    const staleRejections = rejections.filter((rejection) => rejection.reason.startsWith("Quote is missing, future-dated, or stale"));
    const rejectedQuoteAges = staleRejections
      .map((rejection) => rejection.quoteAgeSeconds)
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
        staleContractsRejected: staleRejections.length,
        ...(rejectedQuoteAges.length > 0 ? { freshestRejectedAgeSeconds: Math.min(...rejectedQuoteAges) } : {}),
      },
      status: finalContracts.length > 0 ? "matches_found" : "no_matches",
      rejections: rejections.slice(0, 50),
    };
  }

}
