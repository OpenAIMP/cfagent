export type NasdaqExchange = "nasdaq" | "nyse" | "amex";

export interface NasdaqStockListing {
  symbol: string;
  companyName: string;
  exchange: NasdaqExchange;
  lastPrice: number;
  change: number;
  changePercent: number;
  marketCap?: number;
}

interface NasdaqScreenerRow {
  symbol?: string;
  name?: string;
  lastsale?: string;
  netchange?: string;
  pctchange?: string;
  marketCap?: string;
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
  if (!/^[A-Z0-9./-]+$/.test(symbol) || !lastPrice || lastPrice <= 0) return null;

  return {
    symbol,
    companyName: String(row.name || symbol).trim(),
    exchange,
    lastPrice,
    change: parseNumber(row.netchange) ?? 0,
    changePercent: parseNumber(row.pctchange) ?? 0,
    marketCap: parseNumber(row.marketCap),
  };
}

export async function fetchAllUsStockListings(fetcher: typeof fetch = fetch): Promise<NasdaqStockListing[]> {
  const exchanges: NasdaqExchange[] = ["nasdaq", "nyse", "amex"];
  const pageSize = 5000;
  const pages = await Promise.all(exchanges.map(async (exchange) => {
    const listings: NasdaqStockListing[] = [];
    let offset = 0;
    let totalRecords = Number.POSITIVE_INFINITY;

    while (offset < totalRecords) {
      const url = new URL("https://api.nasdaq.com/api/screener/stocks");
      url.searchParams.set("tableonly", "true");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("exchange", exchange);

      const response = await fetcher(url.toString(), {
        headers: {
          Accept: "application/json, text/plain, */*",
          Origin: "https://www.nasdaq.com",
          "User-Agent": "Mozilla/5.0",
        },
      });
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
  }));

  const unique = new Map<string, NasdaqStockListing>();
  for (const exchangeListings of pages) {
    for (const listing of exchangeListings) {
      if (!unique.has(listing.symbol)) unique.set(listing.symbol, listing);
    }
  }
  return Array.from(unique.values());
}