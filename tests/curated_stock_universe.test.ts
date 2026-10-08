import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CURATED_STOCK_UNIVERSE,
  getCuratedStockUniverse,
  setCuratedStockUniverse,
  getCuratedStockBySymbol,
  getCuratedStockListings,
  YFINANCE_MARKET_UNIVERSE,
} from "../src/config/curatedStockUniverse";
import { DynamicMarketScreener } from "../src/trading/screener";
import curatedJson from "../src/config/curatedStockUniverse.json";
import envConfig from "../environment.config.json";

describe("Externalized Curated Stock Universe", () => {
  afterEach(() => {
    // Restore default curated universe
    setCuratedStockUniverse(null);
    DynamicMarketScreener.setTestListingsFixture(null);
  });

  describe("JSON Configuration Integrity", () => {
    it("successfully loads externalized JSON universe with over 100 liquid tickers", () => {
      expect(Array.isArray(curatedJson)).toBe(true);
      expect(curatedJson.length).toBeGreaterThanOrEqual(100);
      expect(CURATED_STOCK_UNIVERSE.length).toBe(curatedJson.length);
    });

    it("verifies every entry has required fields: symbol, companyName, sector, and valid exchange", () => {
      const validExchanges = new Set(["nasdaq", "nyse", "amex"]);
      for (const entry of curatedJson) {
        expect(entry.symbol).toBeTruthy();
        expect(typeof entry.symbol).toBe("string");
        expect(entry.companyName).toBeTruthy();
        expect(entry.sector).toBeTruthy();
        expect(validExchanges.has(entry.exchange)).toBe(true);
        if (entry.defaultPrice !== undefined) {
          expect(entry.defaultPrice).toBeGreaterThan(0);
        }
        if (entry.marketCap !== undefined) {
          expect(entry.marketCap).toBeGreaterThan(0);
        }
      }
    });

    it("ensures all three major exchanges (NASDAQ, NYSE, AMEX) are represented", () => {
      const nasdaq = curatedJson.filter((item) => item.exchange === "nasdaq");
      const nyse = curatedJson.filter((item) => item.exchange === "nyse");
      const amex = curatedJson.filter((item) => item.exchange === "amex");

      expect(nasdaq.length).toBeGreaterThanOrEqual(30);
      expect(nyse.length).toBeGreaterThanOrEqual(30);
      expect(amex.length).toBeGreaterThanOrEqual(10);
    });

    it("environment.config.json references the externalized universe path", () => {
      const screenerConfig = (envConfig.defaults.etapi.screener as Record<string, any>);
      expect(screenerConfig.curatedUniversePath).toBe("src/config/curatedStockUniverse.json");
      expect(screenerConfig.curatedUniverseEnabled).toBe(true);

      const stockScreenerConfig = ((envConfig.defaults.etapi as Record<string, any>).stockScreener as Record<string, any>);
      expect(stockScreenerConfig.curatedUniversePath).toBe("src/config/curatedStockUniverse.json");
      expect(stockScreenerConfig.curatedUniverseEnabled).toBe(true);
    });
  });

  describe("Runtime Access & Lookup Utilities", () => {
    it("getCuratedStockBySymbol retrieves individual stocks case-insensitively", () => {
      const nvda = getCuratedStockBySymbol("nvda");
      expect(nvda).toBeDefined();
      expect(nvda?.symbol).toBe("NVDA");
      expect(nvda?.exchange).toBe("nasdaq");
      expect(nvda?.sector).toBe("Semiconductors");

      const jpm = getCuratedStockBySymbol("JPM");
      expect(jpm).toBeDefined();
      expect(jpm?.exchange).toBe("nyse");

      const spy = getCuratedStockBySymbol("spy");
      expect(spy).toBeDefined();
      expect(spy?.exchange).toBe("amex");

      expect(getCuratedStockBySymbol("NONEXISTENT_XYZ")).toBeUndefined();
    });

    it("allows runtime modification and clean resetting via setCuratedStockUniverse", () => {
      const customList = [
        { symbol: "TEST1", companyName: "Test 1 Corp", sector: "Tech", exchange: "nasdaq" as const },
        { symbol: "TEST2", companyName: "Test 2 Inc", sector: "Finance", exchange: "nyse" as const },
      ];
      setCuratedStockUniverse(customList);
      expect(getCuratedStockUniverse()).toHaveLength(2);
      expect(getCuratedStockBySymbol("TEST1")).toBeDefined();

      setCuratedStockUniverse(null);
      expect(getCuratedStockUniverse().length).toBe(curatedJson.length);
      expect(getCuratedStockBySymbol("TEST1")).toBeUndefined();
    });

    it("maintains backward compatibility alias YFINANCE_MARKET_UNIVERSE", () => {
      expect(YFINANCE_MARKET_UNIVERSE).toBe(CURATED_STOCK_UNIVERSE);
      expect(YFINANCE_MARKET_UNIVERSE.length).toBe(CURATED_STOCK_UNIVERSE.length);
    });
  });

  describe("NasdaqStockListing Transformation & Filtering", () => {
    it("getCuratedStockListings transforms universe into NasdaqStockListing rows with valid fields", () => {
      const listings = getCuratedStockListings();
      expect(listings.length).toBe(curatedJson.length);

      const first = listings[0];
      expect(first.symbol).toBeTruthy();
      expect(first.companyName).toBeTruthy();
      expect(["nasdaq", "nyse", "amex"]).toContain(first.exchange);
      expect(first.lastPrice).toBeGreaterThan(0);
      expect(first.marketCap).toBeGreaterThan(0);
    });

    it("filters listings by specific exchange accurately", () => {
      const nasdaqListings = getCuratedStockListings("NASDAQ");
      expect(nasdaqListings.length).toBeGreaterThan(0);
      expect(nasdaqListings.every((l) => l.exchange === "nasdaq")).toBe(true);

      const nyseListings = getCuratedStockListings("NYSE");
      expect(nyseListings.length).toBeGreaterThan(0);
      expect(nyseListings.every((l) => l.exchange === "nyse")).toBe(true);

      const amexListings = getCuratedStockListings("AMEX");
      expect(amexListings.length).toBeGreaterThan(0);
      expect(amexListings.every((l) => l.exchange === "amex")).toBe(true);
    });
  });

  describe("DynamicMarketScreener Integration with Externalized Universe", () => {
    it("DynamicMarketScreener uses externalized universe when listings are empty", async () => {
      const screener = new DynamicMarketScreener();

      // Screen with ALL exchange using externalized universe fallback
      const result = await screener.screenLive({
        exchange: "ALL",
        trend: "all",
      });

      expect(result.discovery?.mode).toBe("all_us_listings");
      expect(result.discovery?.sourceCounts).toBeDefined();
      expect(result.discovery?.sourceCounts.nasdaq).toBeGreaterThan(0);
      expect(result.discovery?.sourceCounts.nyse).toBeGreaterThan(0);
      expect(result.discovery?.sourceCounts.amex).toBeGreaterThan(0);
      expect(result.ledger.universeSymbols.length).toBeGreaterThanOrEqual(100);
    });

    it("DynamicMarketScreener exchange filter works with the externalized universe", async () => {
      const screener = new DynamicMarketScreener();

      const nasdaqResult = await screener.screenLive({
        exchange: "NASDAQ",
        trend: "all",
      });
      expect(nasdaqResult.stocks.length).toBeGreaterThan(0);
      expect(nasdaqResult.stocks.every((s) => s.listingExchange === "NASDAQ")).toBe(true);

      const nyseResult = await screener.screenLive({
        exchange: "NYSE",
        trend: "all",
      });
      expect(nyseResult.stocks.length).toBeGreaterThan(0);
      expect(nyseResult.stocks.every((s) => s.listingExchange === "NYSE")).toBe(true);
    });
  });
});
