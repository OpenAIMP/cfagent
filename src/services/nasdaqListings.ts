import { withBreaker } from "../breakers/breakerDecorator";
import { BreakerOpenError } from "../breakers/breakerPorts";
import { defaultBreakerRegistry } from "../breakers/createBreakerPorts";
import type { CircuitBreaker } from "../breakers/breakerPorts";

export type NasdaqExchange = "nasdaq" | "nyse" | "amex";

export interface NasdaqStockListing {
  symbol: string;
  companyName: string;
  exchange: NasdaqExchange;
  /** Optional listings-feed snapshot; screening prices always come from E*TRADE. */
  lastPrice?: number;
  change: number;
  changePercent: number;
  marketCap?: number;
  /** Live sector metadata from Nasdaq's listings feed; never a local ticker map. */
  sector?: string;
  industry?: string;
  etf?: string;
}

interface NasdaqScreenerRow {
  symbol?: string;
  name?: string;
  lastsale?: string;
  netchange?: string;
  pctchange?: string;
  marketCap?: string;
  sector?: string;
  industry?: string;
  etf?: string;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[$,%\s,]/g, "");
  if (!normalized || normalized === "-" || normalized.toLowerCase() === "n/a") return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRow(row: NasdaqScreenerRow, exchange: NasdaqExchange): NasdaqStockListing | null {
  const symbol = String(row.symbol || "").trim().toUpperCase();
  const lastPrice = parseNumber(row.lastsale);
  // This endpoint defines membership, not tradable quote availability. Keep
  // valid symbols even when Nasdaq omits last-sale data; E*TRADE quote
  // acquisition decides whether the screen can complete for the full set.
  if (!/^[A-Z0-9./-]+$/.test(symbol)) return null;

  return {
    symbol,
    companyName: String(row.name || symbol).trim(),
    exchange,
    lastPrice: lastPrice && lastPrice > 0 ? lastPrice : undefined,
    change: parseNumber(row.netchange) ?? 0,
    changePercent: parseNumber(row.pctchange) ?? 0,
    marketCap: parseNumber(row.marketCap),
    sector: String(row.sector || "").trim() || undefined,
    industry: String(row.industry || "").trim() || undefined,
    etf: String(row.etf || "").trim() || undefined,
  };
}

import { getExternalApisConfig } from "../config/etapiConfig";
import { getCachedQuote, setCachedQuote } from "./quoteCache";

export async function fetchAllUsStockListings(
  fetcher: typeof fetch = fetch,
  // Issue #1745: breaker (tests inject an isolated one; production
  // shares the per-isolate default). No fallback: listings have no
  // stale cache beyond the 5-minute quoteCache checked above, and
  // #1554 forbids substituting the curated universe.
  opts?: { breaker?: CircuitBreaker }
): Promise<NasdaqStockListing[]> {
  // #411: the full-universe sweep is cached for 5 minutes in memory.
  const cachedListings = getCachedQuote<NasdaqStockListing[]>("nasdaq:listings:all");
  if (cachedListings && cachedListings.length > 0) return cachedListings;
  const nasdaqBreaker = opts?.breaker ?? defaultBreakerRegistry().breakerFor("nasdaq");
  const extConfig = getExternalApisConfig();
  const exchanges: NasdaqExchange[] = (extConfig?.nasdaqListings?.exchanges as NasdaqExchange[]) || ["nasdaq", "nyse", "amex"];
  const pageSize = extConfig?.nasdaqListings?.pageSize || 5000;
  const timeoutMs = extConfig?.nasdaqListings?.timeoutMs || 2500;
  const baseUrl = extConfig?.nasdaqListings?.url || "https://api.nasdaq.com/api/screener/stocks";

  let pages: NasdaqStockListing[][] = [];
  try {
    pages = (
      await withBreaker(nasdaqBreaker, () =>
        Promise.all(exchanges.map(async (exchange) => {
      const listings: NasdaqStockListing[] = [];
      let offset = 0;
      let totalRecords = Number.POSITIVE_INFINITY;

      while (offset < totalRecords) {
        const url = new URL(baseUrl);
        url.searchParams.set("tableonly", "true");
        url.searchParams.set("limit", String(pageSize));
        url.searchParams.set("offset", String(offset));
        url.searchParams.set("exchange", exchange);

        let response: Response;
        try {
          response = await fetcher(url.toString(), {
            signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined,
            headers: {
              Accept: "application/json, text/plain, */*",
              Origin: "https://www.nasdaq.com",
              "User-Agent": "Mozilla/5.0",
            },
          });
        } catch (fetchErr) {
          throw new Error(`Nasdaq ${exchange.toUpperCase()} listings timed out or failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
        }
        if (!response.ok) {
          throw new Error(`Nasdaq ${exchange.toUpperCase()} listings failed [HTTP ${response.status}]`);
        }

        const payload = await response.json() as {
          data?: {
            totalrecords?: number | string;
            table?: { rows?: NasdaqScreenerRow[] };
          };
        };
        const rows = payload.data?.table?.rows || [];
        totalRecords = Number(payload.data?.totalrecords ?? rows.length);
        listings.push(...rows.map((row) => parseRow(row, exchange)).filter((row): row is NasdaqStockListing => row !== null));
        if (rows.length === 0) break;
        offset += rows.length;
      }

      return listings;
    })))).value;
  } catch (err) {
    // Issue #1745: a tripped breaker surfaces as its business error,
    // unwrapped — the #1554 wrap below is for provider errors only.
    if (err instanceof BreakerOpenError) throw err;
    // #1554 (parent #913): fail explicit. The curated universe must
    // never be substituted for a failed live feed, and a failed feed
    // must never be cached: NasdaqStockListing carries no provenance
    // field, so substituted rows would be indistinguishable from live
    // rows downstream. Callers surface this throw as unavailable.
    throw new Error(
      `Live Nasdaq listings feed failed: ${err instanceof Error ? err.message : String(err)}; no static universe was substituted.`
    );
  }

  const unique = new Map<string, NasdaqStockListing>();
  for (const exchangeListings of pages) {
    for (const listing of exchangeListings) {
      if (!unique.has(listing.symbol)) unique.set(listing.symbol, listing);
    }
  }
  const listings = Array.from(unique.values());
  if (listings.length === 0) {
    // #1554 (parent #913): an empty live result is a failure, not a
    // cue to substitute the curated table (see the catch above).
    throw new Error("Live Nasdaq listings feed returned no listings; no static universe was substituted.");
  }
  setCachedQuote("nasdaq:listings:all", listings);
  return listings;
}
