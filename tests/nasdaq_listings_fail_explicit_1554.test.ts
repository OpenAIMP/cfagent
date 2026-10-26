import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAllUsStockListings } from "../src/services/nasdaqListings";
import { __resetQuoteCache } from "../src/services/quoteCache";
import { __resetDefaultBreakerRegistry } from "../src/breakers/createBreakerPorts";
import { getCuratedStockListings } from "../src/config/curatedStockUniverse";

/**
 * Issue #1554 (parent #913): fetchAllUsStockListings() must FAIL EXPLICIT
 * on a live Nasdaq failure or an empty live result. It must never
 * substitute the static curated table (getCuratedStockListings(), whose
 * rows hardcode lastPrice = defaultPrice ?? 150.0, change 1.25,
 * changePercent 0.85, marketCap ?? 50e9) and must never cache that
 * substitution, because NasdaqStockListing carries no provenance field
 * and downstream consumers cannot tell fallback rows from live rows.
 */
describe("Nasdaq listings fail-explicit (#1554, parent #913)", () => {
  // Issue #1745: the nasdaq breaker is shared per isolate, and this
  // file runs several failure cases before its success control —
  // without a reset the tripped breaker would (correctly) reject
  // the control. Resetting test state, not production behavior.
  beforeEach(() => { __resetQuoteCache(); __resetDefaultBreakerRegistry(); });

  it("throws on live-feed failure instead of returning curated rows", async () => {
    const fetcher = vi.fn(async () => { throw new Error("network down"); });
    await expect(fetchAllUsStockListings(fetcher as typeof fetch)).rejects.toThrow(/Nasdaq/i);
    // A second call must still fail (no curated fallback cached under nasdaq:listings:all).
    __resetQuoteCache();
    await expect(fetchAllUsStockListings(fetcher as typeof fetch)).rejects.toThrow(/Nasdaq/i);
  });

  it("throws on a non-OK live response instead of returning curated rows", async () => {
    const fetcher = vi.fn(async () => new Response("blocked", { status: 500 }));
    await expect(fetchAllUsStockListings(fetcher as typeof fetch)).rejects.toThrow(/Nasdaq/i);
  });

  it("throws on an empty live result instead of returning curated rows", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { totalrecords: 0, table: { rows: [] } },
    }), { status: 200 }));
    await expect(fetchAllUsStockListings(fetcher as typeof fetch)).rejects.toThrow(/no listings/i);
    // Sanity: the curated table is non-empty, so a returned array here
    // would prove the substitution; the throw above is the contract.
    expect(getCuratedStockListings().length).toBeGreaterThan(0);
  });

  it("control: a live success still returns live rows", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const exchange = url.searchParams.get("exchange");
      const rowsByExchange: Record<string, unknown[]> = {
        nasdaq: [{ symbol: "abc", name: "Alpha Corp", lastsale: "$25.50", netchange: "1.25", pctchange: "5.15%", marketCap: "25000000000" }],
        nyse: [{ symbol: "xyz", name: "Xray Inc", lastsale: "$80.00", netchange: "-2.00", pctchange: "-2.44%", marketCap: "80000000000" }],
        amex: [{ symbol: "etf", name: "Example ETF", lastsale: "$40.00", netchange: "0.10", pctchange: "0.25%", marketCap: "1000000000" }],
      };
      return new Response(JSON.stringify({
        data: {
          totalrecords: rowsByExchange[exchange || ""]?.length || 0,
          table: { rows: rowsByExchange[exchange || ""] || [] },
        },
      }), { status: 200 });
    });
    const listings = await fetchAllUsStockListings(fetcher as typeof fetch);
    expect(listings.map((l) => l.symbol)).toEqual(["ABC", "XYZ", "ETF"]);
  });
});
