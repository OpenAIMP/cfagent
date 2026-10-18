import { describe, expect, it, vi } from "vitest";
import { fetchAllUsStockListings } from "../src/services/nasdaqListings";

describe("dynamic all-exchange stock listings", () => {
  it("loads and normalizes Nasdaq, NYSE, and AMEX rows without a static ticker universe", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const exchange = url.searchParams.get("exchange");
      const rowsByExchange: Record<string, unknown[]> = {
        nasdaq: [{ symbol: "abc", name: "Alpha Corp Common Stock", lastsale: "$25.50", netchange: "1.25", pctchange: "5.15%", marketCap: "25,000,000,000" }],
        nyse: [{ symbol: "xyz", name: "Xray Inc Common Stock", lastsale: "$80.00", netchange: "-2.00", pctchange: "-2.44%", marketCap: "80,000,000,000" }],
        amex: [{ symbol: "etf", name: "Example ETF", lastsale: "$40.00", netchange: "0.10", pctchange: "0.25%", marketCap: "1,000,000,000" }],
      };
      return new Response(JSON.stringify({
        data: {
          totalrecords: rowsByExchange[exchange || ""]?.length || 0,
          table: { rows: rowsByExchange[exchange || ""] || [] },
        },
      }), { status: 200 });
    });

    const listings = await fetchAllUsStockListings(fetcher as typeof fetch);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(listings.map((listing) => listing.symbol)).toEqual(["ABC", "XYZ", "ETF"]);
    expect(listings.map((listing) => listing.exchange)).toEqual(["nasdaq", "nyse", "amex"]);
    expect(listings[0].lastPrice).toBe(25.5);
    expect(listings[0].changePercent).toBe(5.15);
    expect(listings[0].marketCap).toBe(25_000_000_000);
  });

  it("skips rows without a usable symbol or positive last sale", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: {
        totalrecords: 2,
        table: { rows: [
          { symbol: "", name: "Missing symbol", lastsale: "$10.00" },
          { symbol: "ZERO", name: "No current price", lastsale: "-" },
        ] },
      },
    }), { status: 200 }));

    const listings = await fetchAllUsStockListings(fetcher as typeof fetch);
    expect(listings).toEqual([]);
  });
});