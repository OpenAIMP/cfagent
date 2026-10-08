import curatedData from "./curatedStockUniverse.json";
import type { NasdaqExchange, NasdaqStockListing } from "../services/nasdaqListings";

export interface CuratedStockSecurity {
  symbol: string;
  companyName: string;
  sector: string;
  exchange: NasdaqExchange;
  defaultPrice?: number;
  marketCap?: number;
}

export type YFinanceSecurityDefinition = CuratedStockSecurity;

let runtimeCuratedUniverse: CuratedStockSecurity[] = [...(curatedData as CuratedStockSecurity[])];

/**
 * The static curated universe loaded from the externalized JSON configuration file.
 */
export const CURATED_STOCK_UNIVERSE: CuratedStockSecurity[] = curatedData as CuratedStockSecurity[];

/**
 * Backward compatibility alias for the Yahoo Finance screener & discovery engine.
 */
export const YFINANCE_MARKET_UNIVERSE: CuratedStockSecurity[] = CURATED_STOCK_UNIVERSE;

/**
 * Returns the currently active curated stock universe (externalized JSON + optional runtime modifications).
 */
export function getCuratedStockUniverse(): CuratedStockSecurity[] {
  return runtimeCuratedUniverse;
}

/**
 * Sets or overrides the active curated universe at runtime.
 */
export function setCuratedStockUniverse(universe: CuratedStockSecurity[] | null): void {
  runtimeCuratedUniverse = universe ? [...universe] : [...CURATED_STOCK_UNIVERSE];
}

/**
 * Looks up a specific security by ticker from the curated stock universe.
 */
export function getCuratedStockBySymbol(symbol: string): CuratedStockSecurity | undefined {
  const clean = symbol.trim().toUpperCase();
  return runtimeCuratedUniverse.find((item) => item.symbol.toUpperCase() === clean);
}

/**
 * Transforms the curated stock list into NasdaqStockListing structures for
 * DynamicMarketScreener when the remote Nasdaq API is rate-limited, blocked, or unavailable.
 *
 * @param filterExchange Optional exchange filter ("NASDAQ" | "NYSE" | "AMEX" | "ALL")
 */
export function getCuratedStockListings(filterExchange?: string): NasdaqStockListing[] {
  const normExchange = filterExchange ? filterExchange.trim().toUpperCase() : undefined;

  let candidates = runtimeCuratedUniverse;
  if (normExchange && normExchange !== "ALL") {
    candidates = runtimeCuratedUniverse.filter(
      (item) => item.exchange.toUpperCase() === normExchange
    );
    // If the filtered exchange yields 0 results, fall back to entire universe
    if (candidates.length === 0) {
      candidates = runtimeCuratedUniverse;
    }
  }

  return candidates.map((item) => ({
    symbol: item.symbol,
    companyName: item.companyName,
    exchange: item.exchange,
    lastPrice: item.defaultPrice ?? 150.0,
    change: 1.25,
    changePercent: 0.85,
    marketCap: item.marketCap ?? 50e9,
  }));
}
