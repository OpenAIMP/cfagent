import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchAllUsStockListings } from "../src/services/nasdaqListings";
import { __resetQuoteCache } from "../src/services/quoteCache";

/**
 * Issue #411 — the Nasdaq listings fetch (one paged sweep per exchange for
 * the full US universe) is cached for 5 minutes in memory instead of being
 * re-run on every screener pass.
 */
let fetcherCalls = 0;
const row = {
  symbol: "NVDA",
  name: "NVIDIA Corporation",
  lastsale: "$129.00",
  netchange: "1.00",
  pctchange: "0.78%",
  marketCap: "3170000000000",
  sector: "Technology",
};
const fetcher = async () => {
  fetcherCalls += 1;
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { totalrecords: "1", table: { rows: [row] } } }),
  } as unknown as Response;
};

describe("Nasdaq listings cache (#411)", () => {
  beforeEach(() => {
    __resetQuoteCache();
    fetcherCalls = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetQuoteCache();
  });

  it("serves repeat sweeps from the cache instead of refetching", async () => {
    const first = await fetchAllUsStockListings(fetcher as any);
    const afterFirst = fetcherCalls;
    expect(afterFirst).toBeGreaterThan(0);
    expect(first.some((l) => l.symbol === "NVDA")).toBe(true);
    const second = await fetchAllUsStockListings(fetcher as any);
    expect(second).toEqual(first);
    expect(fetcherCalls).toBe(afterFirst);
  });

  it("refetches after the 5-minute TTL", async () => {
    await fetchAllUsStockListings(fetcher as any);
    const afterFirst = fetcherCalls;
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await fetchAllUsStockListings(fetcher as any);
    expect(fetcherCalls).toBeGreaterThan(afterFirst);
  });
});
