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
} from "../src/trading/options/flows/flowService";

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
});
