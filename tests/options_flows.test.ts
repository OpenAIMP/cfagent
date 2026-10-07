import { describe, expect, it } from "vitest";
import {
  RAW_LIVE_FLOW_ITEMS,
  RAW_NEWS_FLOW_ITEMS,
  RAW_INSIDER_FLOW_ITEMS,
  RAW_CONGRESS_FLOW_ITEMS,
  DEFAULT_SAVED_PRESETS,
  DEFAULT_FILTER_CONFIG,
  filterLiveFlowItems,
  filterNewsFlowItems,
  filterInsiderFlowItems,
  filterCongressFlowItems,
  calculateFlowSummary,
  classifyTradeSentiment,
  convertOptionChainToFlowItems,
  generateDynamicFlowUniverse,
  getDynamicLiveFlowItems,
  getDynamicFlowSummary,
  sortAndScaleLeaderboard,
  fetchRealMarketFlowsForSymbol,
  resolveDynamicFlowSymbols,
} from "../src/trading/options/flows/flowService";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain } from "../src/types";

describe("Options Flows Engine & Institutional Activity Suite", () => {
  it("contains curated live flows matching OptionStrat institutional data", () => {
    expect(RAW_LIVE_FLOW_ITEMS.length).toBeGreaterThanOrEqual(15);

    const symbols = RAW_LIVE_FLOW_ITEMS.map((f) => f.symbol);
    expect(symbols).toContain("QQQ");
    expect(symbols).toContain("NVDA");
    expect(symbols).toContain("AAPL");
    expect(symbols).toContain("XSP");
    expect(symbols).toContain("IWM");

    // Check order types
    const types = new Set(RAW_LIVE_FLOW_ITEMS.map((f) => f.type));
    expect(types.has("SWEEP")).toBe(true);
    expect(types.has("SPLIT")).toBe(true);
    expect(types.has("BLOCK")).toBe(true);
  });

  it("filters live flows by ticker symbol and minimum premium", () => {
    const qqqFlows = filterLiveFlowItems(RAW_LIVE_FLOW_ITEMS, { tickers: ["QQQ"] });
    expect(qqqFlows.length).toBeGreaterThan(0);
    expect(qqqFlows.every((f) => f.symbol === "QQQ")).toBe(true);

    const largeFlows = filterLiveFlowItems(RAW_LIVE_FLOW_ITEMS, { minPremium: 100000 });
    expect(largeFlows.length).toBeGreaterThan(0);
    expect(largeFlows.every((f) => f.premium >= 100000)).toBe(true);
  });

  it("evaluates YOLO preset filter: < 3 days DTE, Buy side only, chance < 20%", () => {
    const yoloPreset = DEFAULT_SAVED_PRESETS.find((p) => p.id === "yolos")!;
    expect(yoloPreset).toBeDefined();

    const yoloFlows = filterLiveFlowItems(RAW_LIVE_FLOW_ITEMS, yoloPreset.config);
    expect(yoloFlows.length).toBeGreaterThan(0);
    for (const flow of yoloFlows) {
      expect(flow.dte).toBeLessThanOrEqual(3);
      expect(flow.side).toBe("BUY");
      expect(flow.chance).toBeLessThan(20);
    }
  });

  it("evaluates In The Know preset: small-cap stocks, < 14 days, Vol > OI", () => {
    const inTheKnowPreset = DEFAULT_SAVED_PRESETS.find((p) => p.id === "in_the_know")!;
    expect(inTheKnowPreset).toBeDefined();

    const inTheKnowFlows = filterLiveFlowItems(RAW_LIVE_FLOW_ITEMS, inTheKnowPreset.config);
    for (const flow of inTheKnowFlows) {
      expect(flow.dte).toBeLessThanOrEqual(14);
      expect(flow.assetType).toBe("stock");
      expect(flow.marketCap).toBe("small");
      expect(flow.volOverOi).toBe(true);
    }
  });

  it("evaluates Highly Unusual preset: > $1.00m premium with Vol > OI", () => {
    const highlyUnusualPreset = DEFAULT_SAVED_PRESETS.find((p) => p.id === "highly_unusual")!;
    expect(highlyUnusualPreset).toBeDefined();

    const unusualFlows = filterLiveFlowItems(RAW_LIVE_FLOW_ITEMS, highlyUnusualPreset.config);
    for (const flow of unusualFlows) {
      expect(flow.premium).toBeGreaterThanOrEqual(1000000);
      expect(flow.volOverOi).toBe(true);
    }
  });

  it("filters news flow items by tagged tickers", () => {
    expect(RAW_NEWS_FLOW_ITEMS.length).toBeGreaterThanOrEqual(8);

    const nvdaNews = filterNewsFlowItems(RAW_NEWS_FLOW_ITEMS, ["NVDA"]);
    expect(nvdaNews.length).toBeGreaterThan(0);
    expect(nvdaNews.every((n) => n.symbols.includes("NVDA"))).toBe(true);

    const googNews = filterNewsFlowItems(RAW_NEWS_FLOW_ITEMS, ["GOOGL"]);
    expect(googNews.length).toBeGreaterThan(0);
  });

  it("filters insider flow items by ticker and executive member name", () => {
    expect(RAW_INSIDER_FLOW_ITEMS.length).toBeGreaterThanOrEqual(6);

    const mtnInsiders = filterInsiderFlowItems(RAW_INSIDER_FLOW_ITEMS, { tickers: ["MTN"] });
    expect(mtnInsiders.length).toBeGreaterThanOrEqual(5);

    const angelaTrades = filterInsiderFlowItems(RAW_INSIDER_FLOW_ITEMS, { insiderNames: ["Angela"] });
    expect(angelaTrades.length).toBe(1);
    expect(angelaTrades[0].member).toContain("Angela A Korch");
    expect(angelaTrades[0].premium).toBe(3710000);

    const millionPlus = filterInsiderFlowItems(RAW_INSIDER_FLOW_ITEMS, { minPremium: 2000000 });
    expect(millionPlus.every((i) => i.premium >= 2000000)).toBe(true);
  });

  it("filters congressional disclosures by chamber and political party", () => {
    expect(RAW_CONGRESS_FLOW_ITEMS.length).toBeGreaterThanOrEqual(5);

    const senateTrades = filterCongressFlowItems(RAW_CONGRESS_FLOW_ITEMS, { chamber: "Senate" });
    expect(senateTrades.length).toBeGreaterThan(0);
    expect(senateTrades.every((c) => c.chamber === "Senate")).toBe(true);

    const repTrades = filterCongressFlowItems(RAW_CONGRESS_FLOW_ITEMS, { party: "Republican" });
    expect(repTrades.length).toBeGreaterThan(0);
    expect(repTrades.every((c) => c.party === "Republican")).toBe(true);

    const pelosiTrade = filterCongressFlowItems(RAW_CONGRESS_FLOW_ITEMS, { tickers: ["NVDA"] });
    expect(pelosiTrade.length).toBeGreaterThan(0);
    expect(pelosiTrade[0].politician).toBe("Nancy Pelosi");
    expect(pelosiTrade[0].transaction).toBe("Option Exercise");
  });

  it("calculates accurate flow summary analytics and sentiment dial", () => {
    const summary = calculateFlowSummary(RAW_LIVE_FLOW_ITEMS);
    expect(summary.totalTrades).toBe(RAW_LIVE_FLOW_ITEMS.length);
    expect(summary.totalPremium).toBeGreaterThan(0);
    expect(summary.callPremium + summary.putPremium).toBe(summary.totalPremium);
    expect(summary.bullishSentimentRatio).toBeGreaterThanOrEqual(0);
    expect(summary.bullishSentimentRatio).toBeLessThanOrEqual(100);
    expect(summary.topBullishSymbols.length).toBeGreaterThan(0);
    expect(summary.topBearishSymbols.length).toBeGreaterThan(0);
    expect(summary.largestTrades.length).toBeLessThanOrEqual(5);
    expect(summary.bullishLeaderboard.length).toBe(20);
    expect(summary.bearishLeaderboard.length).toBe(20);
  });

  it("verifies dual leaderboard bars parity for Bullish vs Bearish flows", () => {
    const summary = calculateFlowSummary(RAW_LIVE_FLOW_ITEMS);
    const bullishSymbols = summary.bullishLeaderboard.map((b) => b.symbol);
    const bearishSymbols = summary.bearishLeaderboard.map((b) => b.symbol);

    expect(bullishSymbols).toContain("WMT");
    expect(bullishSymbols).toContain("ARM");
    expect(bullishSymbols).toContain("SPYM");
    expect(bullishSymbols).toContain("NKE");
    expect(bullishSymbols).toContain("LITE");
    expect(bullishSymbols).toContain("GOOGL");
    expect(bullishSymbols).toContain("IWM");

    expect(bearishSymbols).toContain("ETHA");
    expect(bearishSymbols).toContain("/HE");
    expect(bearishSymbols).toContain("U");
    expect(bearishSymbols).toContain("SKHY");
    expect(bearishSymbols).toContain("NVDA");
    expect(bearishSymbols).toContain("AAPL");

    const wmtBullish = summary.bullishLeaderboard.find((b) => b.symbol === "WMT")!;
    expect(wmtBullish.tradeCount).toBe(27);
    expect(wmtBullish.premiumFormatted).toBe("$15.27m");

    const nvdaBearish = summary.bearishLeaderboard.find((b) => b.symbol === "NVDA")!;
    expect(nvdaBearish.tradeCount).toBe(373);
    expect(nvdaBearish.premiumFormatted).toBe("$172.13m");
  });

  it("verifies WMT multi-leg Combo trade breakdown for builder integration", () => {
    const wmtTrades = filterLiveFlowItems(RAW_LIVE_FLOW_ITEMS, { tickers: ["WMT"] });
    expect(wmtTrades.length).toBeGreaterThanOrEqual(5);

    const comboTrade = wmtTrades.find((t) => t.strategy.includes("Buy 97.5/135 Combo"))!;
    expect(comboTrade).toBeDefined();
    expect(comboTrade.strategyTitle).toBe("WMT Long Combo");
    expect(comboTrade.premiumFormatted).toBe("$314k");
    expect(comboTrade.isCredit).toBe(true);
    expect(comboTrade.creditOrDebitText).toBe("CREDIT");
    expect(comboTrade.totalQuantity).toBe(4000);
    expect(comboTrade.returnSinceFillText).toContain("-$5.50 (-3.5%) return since Oct 6, 2026, 3:51 PM");

    // Check leg structure
    expect(comboTrade.legsDetails).toBeDefined();
    expect(comboTrade.legsDetails!.length).toBe(2);

    const buyLeg = comboTrade.legsDetails!.find((l) => l.action === "Buy")!;
    expect(buyLeg.option).toBe("135C 1/15/27");
    expect(buyLeg.quantity).toBe(2000);
    expect(buyLeg.strike).toBe(135);

    const sellLeg = comboTrade.legsDetails!.find((l) => l.action === "Sell")!;
    expect(sellLeg.option).toBe("97.5P 1/15/27");
    expect(sellLeg.quantity).toBe(2000);
    expect(sellLeg.strike).toBe(97.5);
  });

  it("evaluates criteria-based sentiment engine (classifyTradeSentiment)", () => {
    // 1. Long Call -> Bullish
    const longCall = classifyTradeSentiment({ strategy: "Buy 100 Call", side: "BUY" });
    expect(longCall.sentiment).toBe("bullish");
    expect(longCall.confidence).toBeGreaterThanOrEqual(80);

    // 2. Short Call -> Bearish
    const shortCall = classifyTradeSentiment({ strategy: "Sell 100 Call", side: "SELL" });
    expect(shortCall.sentiment).toBe("bearish");

    // 3. Long Put -> Bearish
    const longPut = classifyTradeSentiment({ strategy: "Buy 100 Put", side: "BUY" });
    expect(longPut.sentiment).toBe("bearish");

    // 4. Short Put -> Bullish
    const shortPut = classifyTradeSentiment({ strategy: "Sell 100 Put", side: "SELL" });
    expect(shortPut.sentiment).toBe("bullish");

    // 5. Long Combo (Buy Call + Sell Put) -> Bullish
    const longCombo = classifyTradeSentiment({
      strategy: "Buy 97.5/135 Combo",
      legsDetails: [
        { action: "Buy", option: "135C 1/15/27", quantity: 2000, optionType: "CALL" },
        { action: "Sell", option: "97.5P 1/15/27", quantity: 2000, optionType: "PUT" },
      ],
    });
    expect(longCombo.sentiment).toBe("bullish");
    expect(longCombo.confidence).toBeGreaterThanOrEqual(95);
    expect(longCombo.reasoning).toContain("Long Combo");

    // 6. Bull Call Spread -> Bullish
    const bullCall = classifyTradeSentiment({ strategy: "Buy 108/115 Calls" });
    expect(bullCall.sentiment).toBe("bullish");

    // 7. Neutral Straddle / Condor
    const straddle = classifyTradeSentiment({ strategy: "Buy 500 Straddle" });
    expect(straddle.sentiment).toBe("neutral");

    // 8. Aggressive ask crossing boost
    const aggressiveCall = classifyTradeSentiment({
      strategy: "Buy 150 Call",
      side: "BUY",
      fillPrice: 2.5,
      ask: 2.45,
    });
    expect(aggressiveCall.sentiment).toBe("bullish");
    expect(aggressiveCall.confidence).toBeGreaterThanOrEqual(90);
    expect(aggressiveCall.reasoning).toContain("Aggressive Call Buying");
  });

  describe("Dynamic Options Flow Engine (Option Chain Conversion & Live Synthesis)", () => {
    it("converts an ETradeOptionChain into dynamic institutional LiveFlowItem prints", () => {
      const mockChain: ETradeOptionChain = {
        symbol: "NVDA",
        underlyingPrice: 125.5,
        selectedExpiry: { year: 2026, month: 11, day: 20 },
        pairs: [
          {
            call: {
              symbol: "NVDA",
              optionType: "CALL",
              strikePrice: 130,
              lastPrice: 4.5,
              bid: 4.3,
              ask: 4.4,
              volume: 2500,
              openInterest: 1000,
              delta: 0.45,
            },
            put: {
              symbol: "NVDA",
              optionType: "PUT",
              strikePrice: 120,
              lastPrice: 2.2,
              bid: 2.1,
              ask: 2.15,
              volume: 350,
              openInterest: 500,
              delta: -0.35,
            },
          },
        ],
      };

      const flowItems = convertOptionChainToFlowItems(mockChain);
      expect(flowItems.length).toBe(2);

      // 1. Call print: 130C, lastPrice 4.5 >= ask 4.4 -> BUY, volume 2500 >= 1000 and premium >= 250k -> BLOCK
      const callPrint = flowItems.find((f) => f.strategy.includes("Call"))!;
      expect(callPrint).toBeDefined();
      expect(callPrint.symbol).toBe("NVDA");
      expect(callPrint.strike).toBe(130);
      expect(callPrint.side).toBe("BUY");
      expect(callPrint.sentiment).toBe("bullish");
      expect(callPrint.type).toBe("BLOCK");
      expect(callPrint.volOverOi).toBe(true);
      expect(callPrint.isOtm).toBe(true);
      expect(callPrint.premium).toBeGreaterThanOrEqual(250000);
      expect(callPrint.premiumFormatted).toMatch(/^\$[0-9.]+[km]$/);

      // 2. Put print: 120P, lastPrice 2.2 >= ask 2.15 -> BUY, volume 350 -> SPLIT
      const putPrint = flowItems.find((f) => f.strategy.includes("Put"))!;
      expect(putPrint).toBeDefined();
      expect(putPrint.symbol).toBe("NVDA");
      expect(putPrint.strike).toBe(120);
      expect(putPrint.side).toBe("BUY");
      expect(putPrint.sentiment).toBe("bearish");
      expect(putPrint.type).toBe("SPLIT");
      expect(putPrint.volOverOi).toBe(false);
      expect(putPrint.isOtm).toBe(true);
    });

    it("synthesizes dynamic options flow universe with authentic market prints and live timestamps", () => {
      const dynamicFlows = generateDynamicFlowUniverse();
      expect(dynamicFlows.length).toBeGreaterThanOrEqual(30);

      const symbols = new Set(dynamicFlows.map((f) => f.symbol));
      expect(symbols.has("NVDA")).toBe(true);
      expect(symbols.has("AAPL")).toBe(true);
      expect(symbols.has("QQQ")).toBe(true);
      expect(symbols.has("TSLA")).toBe(true);
      expect(symbols.has("WMT")).toBe(true);

      const types = new Set(dynamicFlows.map((f) => f.type));
      expect(types.has("SWEEP")).toBe(true);
      expect(types.has("BLOCK")).toBe(true);
      expect(types.has("SPLIT")).toBe(true);

      // Verify timestamps are dynamically generated for today (within last 4 hours)
      const now = Date.now();
      for (const flow of dynamicFlows) {
        expect(flow.timestamp).toBeLessThanOrEqual(now);
        expect(flow.timestamp).toBeGreaterThan(now - 4 * 3600 * 1000);
        expect(flow.sentiment).toMatch(/bullish|bearish|neutral/);
        expect(flow.premiumFormatted).toBeDefined();
      }
    });

    it("dynamically retrieves filtered live flows and merges chain fixtures via getDynamicLiveFlowItems", async () => {
      const customChain: ETradeOptionChain = {
        symbol: "CUSTOM",
        underlyingPrice: 75.0,
        selectedExpiry: { year: 2026, month: 12, day: 18 },
        pairs: [
          {
            call: {
              symbol: "CUSTOM",
              optionType: "CALL",
              strikePrice: 80,
              lastPrice: 3.0,
              bid: 2.8,
              ask: 2.9,
              volume: 1200,
              openInterest: 400,
            },
          },
        ],
      };

      DynamicOptionsScreener.setTestChainsFixture({ CUSTOM: customChain });

      // Fetch dynamic flows for CUSTOM ticker
      const customFlows = await getDynamicLiveFlowItems(undefined, { tickers: ["CUSTOM"] });
      expect(customFlows.length).toBeGreaterThan(0);
      expect(customFlows.some((f) => f.symbol === "CUSTOM" && f.strike === 80)).toBe(true);

      const customTrade = customFlows.find((f) => f.symbol === "CUSTOM" && f.strike === 80)!;
      expect(customTrade.sentiment).toBe("bullish");
      expect(customTrade.volOverOi).toBe(true);

      DynamicOptionsScreener.clearTestChainsFixture();
    });

    it("computes dynamic FlowSummary and dual leaderboards over live flow data", async () => {
      const summary = await getDynamicFlowSummary(undefined, { tickers: ["NVDA", "AAPL", "WMT"] });
      expect(summary.totalTrades).toBeGreaterThan(0);
      expect(summary.totalPremium).toBeGreaterThan(0);
      expect(summary.bullishSentimentRatio).toBeGreaterThanOrEqual(0);
      expect(summary.bullishSentimentRatio).toBeLessThanOrEqual(100);
      expect(summary.bullishLeaderboard.length).toBeGreaterThan(0);
      expect(summary.bearishLeaderboard.length).toBeGreaterThan(0);
      expect(summary.largestTrades.length).toBeGreaterThan(0);
    });

    it("sortAndScaleLeaderboard correctly scales percentages and ranks by premium", () => {
      const items = [
        { symbol: "NVDA", tradeCount: 15, premiumRaw: 50000000, premiumFormatted: "$50.00m", pctWidth: 0 },
        { symbol: "AAPL", tradeCount: 10, premiumRaw: 25000000, premiumFormatted: "$25.00m", pctWidth: 0 },
        { symbol: "TSLA", tradeCount: 5, premiumRaw: 10000000, premiumFormatted: "$10.00m", pctWidth: 0 },
      ];

      const scaled = sortAndScaleLeaderboard(items);
      expect(scaled[0].symbol).toBe("NVDA");
      expect(scaled[0].pctWidth).toBe(100);
      expect(scaled[1].symbol).toBe("AAPL");
      expect(scaled[1].pctWidth).toBe(50);
      expect(scaled[2].symbol).toBe("TSLA");
      expect(scaled[2].pctWidth).toBe(20);
    });

    it("calculateFlowSummary computes dynamic leaderboards from custom active trades", () => {
      const customTrades = [
        {
          id: "trade_1",
          time: "11:55am",
          timestamp: Date.now(),
          symbol: "IWM",
          strategy: "Buy 278 Call",
          underlyingPrice: 277.5,
          expiration: "0d",
          dte: 0,
          strike: 278,
          premium: 2000000,
          premiumFormatted: "$2.00m",
          type: "SWEEP" as const,
          side: "BUY" as const,
          sentiment: "bullish" as const,
          volume: 5000,
          openInterest: 1000,
          volOverOi: true,
          isOtm: true,
          hasEarnings: false,
          chance: 25,
          marketCap: "mid" as const,
          assetType: "etf" as const,
        },
        {
          id: "trade_2",
          time: "11:54am",
          timestamp: Date.now() - 60000,
          symbol: "SPY",
          strategy: "Buy 775 Put",
          underlyingPrice: 776.0,
          expiration: "0d",
          dte: 0,
          strike: 775,
          premium: 5000000,
          premiumFormatted: "$5.00m",
          type: "BLOCK" as const,
          side: "BUY" as const,
          sentiment: "bearish" as const,
          volume: 10000,
          openInterest: 5000,
          volOverOi: true,
          isOtm: true,
          hasEarnings: false,
          chance: 40,
          marketCap: "large" as const,
          assetType: "etf" as const,
        },
      ];

      const summary = calculateFlowSummary(customTrades);
      expect(summary.totalTrades).toBe(2);
      expect(summary.totalPremium).toBe(7000000);
      expect(summary.callPremium).toBe(2000000);
      expect(summary.putPremium).toBe(5000000);
      expect(summary.bullishLeaderboard.some((b) => b.symbol === "IWM")).toBe(true);
      expect(summary.bearishLeaderboard.some((b) => b.symbol === "SPY")).toBe(true);
    });

    it("updates summary leaderboards dynamically when filtered by marketCaps", () => {
      const allTrades = [
        {
          id: "t_large",
          time: "11:50am",
          timestamp: Date.now(),
          symbol: "NVDA",
          strategy: "Buy 130 Call",
          underlyingPrice: 128.5,
          expiration: "3d",
          dte: 3,
          strike: 130,
          premium: 10000000,
          premiumFormatted: "$10.00m",
          type: "SWEEP" as const,
          side: "BUY" as const,
          sentiment: "bullish" as const,
          volume: 5000,
          openInterest: 2000,
          volOverOi: true,
          isOtm: true,
          hasEarnings: false,
          chance: 35,
          marketCap: "large" as const,
          assetType: "stock" as const,
        },
        {
          id: "t_mid",
          time: "11:45am",
          timestamp: Date.now() - 300000,
          symbol: "IWM",
          strategy: "Buy 278 Put",
          underlyingPrice: 277.5,
          expiration: "0d",
          dte: 0,
          strike: 278,
          premium: 4500000,
          premiumFormatted: "$4.50m",
          type: "BLOCK" as const,
          side: "BUY" as const,
          sentiment: "bearish" as const,
          volume: 20000,
          openInterest: 1000,
          volOverOi: true,
          isOtm: false,
          hasEarnings: false,
          chance: 55,
          marketCap: "mid" as const,
          assetType: "etf" as const,
        },
        {
          id: "t_small",
          time: "11:40am",
          timestamp: Date.now() - 600000,
          symbol: "MARA",
          strategy: "Buy 11 Call",
          underlyingPrice: 10.2,
          expiration: "7d",
          dte: 7,
          strike: 11,
          premium: 1200000,
          premiumFormatted: "$1.20m",
          type: "SWEEP" as const,
          side: "BUY" as const,
          sentiment: "bullish" as const,
          volume: 8000,
          openInterest: 1500,
          volOverOi: true,
          isOtm: true,
          hasEarnings: false,
          chance: 28,
          marketCap: "small" as const,
          assetType: "stock" as const,
        },
      ];

      // 1. Filter by Small-Cap only
      const smallTrades = filterLiveFlowItems(allTrades, { marketCaps: ["small"] });
      expect(smallTrades.length).toBe(1);
      expect(smallTrades[0].symbol).toBe("MARA");

      const smallSummary = calculateFlowSummary(smallTrades);
      expect(smallSummary.bullishLeaderboard.map((b) => b.symbol)).toEqual(["MARA"]);
      expect(smallSummary.bearishLeaderboard).toHaveLength(0);

      // 2. Filter by Mid-Cap only
      const midTrades = filterLiveFlowItems(allTrades, { marketCaps: ["mid"] });
      expect(midTrades.length).toBe(1);
      expect(midTrades[0].symbol).toBe("IWM");

      const midSummary = calculateFlowSummary(midTrades);
      expect(midSummary.bearishLeaderboard.map((b) => b.symbol)).toEqual(["IWM"]);
      expect(midSummary.bullishLeaderboard).toHaveLength(0);

      // 3. Filter by Large-Cap only
      const largeTrades = filterLiveFlowItems(allTrades, { marketCaps: ["large"] });
      expect(largeTrades.length).toBe(1);
      expect(largeTrades[0].symbol).toBe("NVDA");

      const largeSummary = calculateFlowSummary(largeTrades);
      expect(largeSummary.bullishLeaderboard.map((b) => b.symbol)).toEqual(["NVDA"]);
      expect(largeSummary.bearishLeaderboard).toHaveLength(0);
    });

    it("dynamically resolves active flow underlyings partitioned by market capitalization", async () => {
      // 1. Small cap dynamic resolution
      const smallSymbols = await resolveDynamicFlowSymbols({ marketCaps: ["small"] });
      expect(smallSymbols.length).toBeGreaterThan(0);
      expect(smallSymbols.every((s) => typeof s === "string" && s.length > 0)).toBe(true);

      // 2. Mid cap dynamic resolution
      const midSymbols = await resolveDynamicFlowSymbols({ marketCaps: ["mid"] });
      expect(midSymbols.length).toBeGreaterThan(0);
      expect(midSymbols.every((s) => typeof s === "string" && s.length > 0)).toBe(true);

      // 3. Large cap dynamic resolution
      const largeSymbols = await resolveDynamicFlowSymbols({ marketCaps: ["large"] });
      expect(largeSymbols.length).toBeGreaterThan(0);
      expect(largeSymbols.every((s) => typeof s === "string" && s.length > 0)).toBe(true);

      // 4. Multi-cap resolution
      const multiSymbols = await resolveDynamicFlowSymbols({ marketCaps: ["large", "mid", "small"] });
      expect(multiSymbols.length).toBeGreaterThanOrEqual(10);
    });

    it("ensures market summary maintains full multi-symbol universe without collapsing on ticker drilldown", async () => {
      // Generate market items across multiple symbols
      const marketItems = generateDynamicFlowUniverse({
        referenceTimestamp: Date.now(),
        symbols: ["NVDA", "AAPL", "IWM", "MARA", "TSLA"],
      });

      // User drills down to NVDA
      const drilledItems = filterLiveFlowItems(marketItems, { tickers: ["NVDA"] });
      expect(drilledItems.every((item) => item.symbol === "NVDA")).toBe(true);

      // Returning to summary: general market config ignores single drilled ticker
      const summaryConfig: FlowFilterConfig = {
        tickers: [], // cleared when returning to summary
        sides: ["BUY", "SELL"],
        orderTypes: ["SWEEP", "BLOCK", "SPLIT", "SINGLE"],
        assetTypes: ["stock", "etf"],
        marketCaps: ["large", "mid", "small"],
        minPremium: 0,
        unusualOnly: false,
        volOverOiOnly: false,
        otmOnly: false,
        earningsOnly: false,
        aboveAskBelowBidOnly: false,
        chanceRange: [0, 100],
        minDte: 0,
        maxDte: 365,
        insiderNames: [],
      };

      const restoredMarket = filterLiveFlowItems(marketItems, summaryConfig);
      const summary = calculateFlowSummary(restoredMarket);

      // Verify that summary contains multiple symbols and has NOT collapsed to just NVDA
      const allSummarySymbols = new Set([
        ...summary.bullishLeaderboard.map((b) => b.symbol),
        ...summary.bearishLeaderboard.map((b) => b.symbol),
      ]);

      expect(allSummarySymbols.size).toBeGreaterThan(1);
      expect(allSummarySymbols.has("NVDA")).toBe(true);
      expect(allSummarySymbols.has("IWM") || allSummarySymbols.has("AAPL")).toBe(true);
    });
  });
});

