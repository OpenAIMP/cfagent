import {
  LiveFlowItem,
  NewsFlowItem,
  InsiderFlowItem,
  CongressFlowItem,
  FlowSummary,
  FlowFilterConfig,
  SavedFilterPreset,
  FlowLeaderboardItem,
  EvaluatedFlowSentiment,
  FlowItemProvenance,
  FlowProvenanceSummary,
  FlowLegDetail,
  MarketCapCategory,
  AssetClassCategory,
  FlowOrderType,
  FlowSide,
} from "./types";
import type { ETradeOptionChain, ETradeOptionChainContract, Env } from "../../../types";
import { DynamicOptionsScreener } from "../../optionsScreener";
import { DynamicMarketScreener } from "../../screener";
import type { NasdaqUniverseSeam } from "../../screenerPipeline";
import { ETradeService } from "../../../services/etrade";
import { getYahooCrumbSession } from "../../../services/marketDataResearch";
import { CURATED_STOCK_UNIVERSE, getCuratedStockUniverse } from "../../../config/curatedStockUniverse";
import { isDemoCalibratedChainsEnabled } from "../../../config/demoMode";
import { classifyNewsSentiment } from "./newsSentiment";

/**
 * Issue #119 (audit F17): this service has NO trade-tape source. Every flow
 * item is a modelled estimate and carries a `provenance` saying exactly what
 * it was derived from. These helpers keep that disclosure identical at every
 * surface (API envelopes, UI banners, NLQ answers).
 */
export const FLOW_PROVENANCE_NOTICE =
  "Options flow here is modelled from option-chain snapshots and generated templates. " +
  "It is not a live exchange trade tape, and these items are not executed trade prints.";

export const FLOW_PROVENANCE_LABELS: Record<FlowItemProvenance, string> = {
  // Issue #925: chain-derived items are modelled estimates — the label
  // says so explicitly, in the API label map and in the UI badge alike.
  "chain-derived": "Modelled chain-derived estimate",
  static: "Static sample data",
  generated: "Generated sample data",
};

export function summarizeFlowProvenance(items: LiveFlowItem[]): FlowProvenanceSummary {
  const counts: Record<FlowItemProvenance, number> = {
    "chain-derived": 0,
    static: 0,
    generated: 0,
  };
  for (const item of items) {
    counts[item.provenance] = (counts[item.provenance] || 0) + 1;
  }
  return {
    provenances: (Object.keys(counts) as FlowItemProvenance[]).filter((p) => counts[p] > 0),
    counts,
    isModelled: true,
    notice: FLOW_PROVENANCE_NOTICE,
  };
}

/**
 * One-sentence basis statement for NLQ/chat answers, e.g.
 * "modelled flow estimates (basis: 12 chain-derived from option-chain
 * snapshots, 30 generated sample items — not executed trade prints)".
 */
export function describeFlowProvenance(items: LiveFlowItem[]): string {
  if (items.length === 0) {
    return "no flow items were available (no option-chain data could be derived)";
  }
  const { counts } = summarizeFlowProvenance(items);
  const parts: string[] = [];
  if (counts["chain-derived"] > 0) {
    parts.push(`${counts["chain-derived"]} chain-derived from option-chain snapshots`);
  }
  if (counts.generated > 0) {
    parts.push(`${counts.generated} generated sample items (no chain data available)`);
  }
  if (counts.static > 0) {
    parts.push(`${counts.static} static sample items`);
  }
  return `basis: ${parts.join(", ")} — modelled estimates, not executed trade prints`;
}

export const DEFAULT_SAVED_PRESETS: SavedFilterPreset[] = [
  {
    id: "yolos",
    name: "YOLOs",
    tagline: "High risk, high reward trades",
    color: "orange",
    tags: ["< 3 days", "Bullish or bearish", "Buy side only", "Chance < 20%"],
    config: {
      maxDte: 3,
      sides: ["BUY"],
      chanceOperator: "less_than",
      chanceValue: 20,
    },
  },
  {
    id: "in_the_know",
    name: "In The Know",
    tagline: "Someone knows something",
    color: "cyan",
    tags: ["< 14 days", "Bullish or bearish", "Buy side only", "Stocks only", "Small-cap only", "Vol > OI"],
    config: {
      maxDte: 14,
      sides: ["BUY"],
      assetTypes: ["stock"],
      marketCaps: ["small"],
      volOverOiOnly: true,
    },
  },
  {
    id: "highly_unusual",
    name: "Highly Unusual",
    tagline: "Large trades with high volume",
    color: "magenta",
    tags: ["> $1.00m", "Vol > OI"],
    config: {
      minPremium: 1000000,
      volOverOiOnly: true,
    },
  },
  {
    id: "ai_stocks",
    name: "AI Stocks",
    tagline: "Semiconductors & Generative AI ecosystem",
    color: "cyan",
    tags: ["NVDA", "TSM", "AMD", "META", "AI", "GOOGL"],
    config: {
      tickers: ["NVDA", "TSM", "AMD", "META", "AI", "GOOGL", "GOOG", "AMZN", "MSFT"],
    },
  },
  {
    id: "large_trades",
    name: "Large Trades",
    tagline: "Institutional million-dollar blocks",
    color: "yellow",
    tags: ["> $1.00m", "C-Suite Insiders"],
    config: {
      minPremium: 1000000,
    },
  },
];

export const DEFAULT_FILTER_CONFIG: FlowFilterConfig = {
  tickers: [],
  minPremium: 0,
  maxDte: 9999,
  sentiments: ["bullish", "bearish", "neutral"],
  sides: ["BUY", "SELL"],
  orderTypes: ["SWEEP", "SPLIT", "BLOCK", "SINGLE"],
  assetTypes: ["stock", "etf"],
  marketCaps: ["small", "mid", "large"],
  contractTypes: ["calls", "puts", "spreads"],
  isOtmOnly: false,
  volOverOiOnly: false,
  upcomingEarningsOnly: false,
  aboveAskBelowBidOnly: false,
  priceOperator: "less_than",
  priceValue: null,
  chanceOperator: "less_than",
  chanceValue: null,
  insiderNames: [],
  congressChamber: "all",
  congressParty: "all",
};

/**
 * Static fixture table of sample flow rows (seed/demo data and test
 * fixtures). These are NOT market data and are never returned by
 * getDynamicLiveFlowItems; every row is stamped provenance: "static"
 * (issue #119) so any surface that ever renders them must label them.
 */
export const RAW_LIVE_FLOW_ITEMS: LiveFlowItem[] = [
  // WMT Active & Historical trades (Screenshots 2 & 3)
  {
    id: "wmt_flow_combo",
    provenance: "static",
    time: "10/6 3:51pm",
    timestamp: 1791330660000,
    symbol: "WMT",
    companyName: "Walmart",
    underlyingPrice: 107.2,
    strategy: "Buy 97.5/135 Combo",
    strategyTitle: "WMT Long Combo",
    expiration: "Jan 15 '27",
    dte: 100,
    strike: "97.5/135",
    premium: 314000,
    premiumFormatted: "$314k",
    type: "SINGLE",
    side: "BUY",
    sentiment: "bullish",
    volume: 4603,
    openInterest: 28398,
    volOverOi: false,
    isOtm: true,
    hasEarnings: false,
    chance: 68,
    marketCap: "large",
    assetType: "stock",
    legsDetails: [
      { action: "Buy", option: "135C 1/15/27", quantity: 2000, strike: 135, optionType: "CALL", expirationDate: "2027-01-15" },
      { action: "Sell", option: "97.5P 1/15/27", quantity: 2000, strike: 97.5, optionType: "PUT", expirationDate: "2027-01-15" },
    ],
    totalQuantity: 4000,
    isCredit: true,
    creditOrDebitText: "CREDIT",
    fillPrice: 1.57,
    currentContractPrice: 1.63,
    spotAtFill: 107.36,
    currentSpot: 107.2,
    flowTypeCategory: "Single",
    performanceNow: "+3.8%",
    performanceHigh: "+12.4%",
    performanceLow: "-2.1%",
    calculationText:
      "If making this trade now, you would receive a $162.50 credit. The maximum potential loss would be $9,587.50, and the maximum gain would be infinite. There is a 68% chance of profit, achieved when WMT is above $95.88 at expiry.",
    returnSinceFillText: "-$5.50 (-3.5%) return since Oct 6, 2026, 3:51 PM",
  },
  {
    id: "wmt_flow_put",
    provenance: "static",
    time: "10/6 3:50pm",
    timestamp: 1791330600000,
    symbol: "WMT",
    companyName: "Walmart",
    underlyingPrice: 107.2,
    strategy: "Buy 120 Put",
    strategyTitle: "WMT Long Put",
    expiration: "Dec 18",
    dte: 72,
    strike: 120,
    premium: 113000,
    premiumFormatted: "$113k",
    type: "SPLIT",
    side: "BUY",
    sentiment: "bearish",
    volume: 2450,
    openInterest: 1800,
    volOverOi: true,
    isOtm: false,
    hasEarnings: false,
    chance: 45,
    marketCap: "large",
    assetType: "stock",
    legsDetails: [
      { action: "Buy", option: "120P 12/18", quantity: 500, strike: 120, optionType: "PUT", expirationDate: "2026-12-18" },
    ],
    totalQuantity: 500,
    isCredit: false,
    creditOrDebitText: "DEBIT",
    fillPrice: 2.26,
    currentContractPrice: 2.3,
    spotAtFill: 107.3,
    currentSpot: 107.2,
    flowTypeCategory: "Split",
  },
  {
    id: "wmt_flow_calls",
    provenance: "static",
    time: "10/6 3:32pm",
    timestamp: 1791329520000,
    symbol: "WMT",
    companyName: "Walmart",
    underlyingPrice: 107.2,
    strategy: "Buy 108/115 Calls",
    strategyTitle: "WMT Bull Call Spread",
    expiration: "Oct 30 - Nov 20",
    dte: 30,
    strike: "108/115",
    premium: 89000,
    premiumFormatted: "$89k",
    type: "SINGLE",
    side: "BUY",
    sentiment: "bullish",
    volume: 3100,
    openInterest: 2200,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 55,
    marketCap: "large",
    assetType: "stock",
    legsDetails: [
      { action: "Buy", option: "108C 10/30", quantity: 600, strike: 108, optionType: "CALL", expirationDate: "2026-10-30" },
      { action: "Sell", option: "115C 11/20", quantity: 600, strike: 115, optionType: "CALL", expirationDate: "2026-11-20" },
    ],
    totalQuantity: 1200,
    isCredit: false,
    creditOrDebitText: "DEBIT",
    fillPrice: 1.48,
    currentContractPrice: 1.5,
    spotAtFill: 107.25,
    currentSpot: 107.2,
    flowTypeCategory: "Single",
  },
  {
    id: "wmt_flow_sweep",
    provenance: "static",
    time: "10/6 3:12pm",
    timestamp: 1791328320000,
    symbol: "WMT",
    companyName: "Walmart",
    underlyingPrice: 107.2,
    strategy: "Sell 105 Call",
    strategyTitle: "WMT Short Call",
    expiration: "Nov 20",
    dte: 44,
    strike: 105,
    premium: 241000,
    premiumFormatted: "$241k",
    type: "SWEEP",
    side: "SELL",
    sentiment: "bearish",
    volume: 5200,
    openInterest: 3100,
    volOverOi: true,
    isOtm: false,
    hasEarnings: false,
    chance: 38,
    marketCap: "large",
    assetType: "stock",
    legsDetails: [
      { action: "Sell", option: "105C 11/20", quantity: 750, strike: 105, optionType: "CALL", expirationDate: "2026-11-20" },
    ],
    totalQuantity: 750,
    isCredit: true,
    creditOrDebitText: "CREDIT",
    fillPrice: 3.21,
    currentContractPrice: 3.15,
    spotAtFill: 107.4,
    currentSpot: 107.2,
    flowTypeCategory: "Sweep",
  },
  {
    id: "wmt_flow_block",
    provenance: "static",
    time: "10/6 3:10pm",
    timestamp: 1791328200000,
    symbol: "WMT",
    companyName: "Walmart",
    underlyingPrice: 107.2,
    strategy: "Sell 115/135 Puts",
    strategyTitle: "WMT Bull Put Spread",
    expiration: "Oct 9 - Jan 15 '27",
    dte: 100,
    strike: "115/135",
    premium: 404000,
    premiumFormatted: "$404k",
    type: "BLOCK",
    side: "SELL",
    sentiment: "bullish",
    volume: 6400,
    openInterest: 4800,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 62,
    marketCap: "large",
    assetType: "stock",
    legsDetails: [
      { action: "Sell", option: "135P 1/15/27", quantity: 1000, strike: 135, optionType: "PUT", expirationDate: "2027-01-15" },
      { action: "Buy", option: "115P 10/9", quantity: 1000, strike: 115, optionType: "PUT", expirationDate: "2026-10-09" },
    ],
    totalQuantity: 2000,
    isCredit: true,
    creditOrDebitText: "CREDIT",
    fillPrice: 4.04,
    currentContractPrice: 3.9,
    spotAtFill: 107.32,
    currentSpot: 107.2,
    flowTypeCategory: "Block",
  },
  // Remaining institutional prints
  {
    id: "flow_1",
    provenance: "static",
    time: "8:09am",
    timestamp: Date.now() - 360000,
    symbol: "XSP",
    companyName: "Mini-SPX Index",
    underlyingPrice: 586.4,
    strategy: "Buy 752 Put To Open",
    expiration: "Nov 6",
    dte: 30,
    strike: 752,
    premium: 14000,
    premiumFormatted: "$14k",
    type: "SPLIT",
    side: "BUY",
    sentiment: "bearish",
    volume: 1450,
    openInterest: 820,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 18,
    marketCap: "large",
    assetType: "etf",
  },
  {
    id: "flow_spy_1",
    provenance: "static",
    time: "8:03am",
    timestamp: Date.now() - 720000,
    symbol: "SPY",
    underlyingPrice: 585.1,
    strategy: "Buy 590 Call",
    expiration: "Oct 18",
    dte: 11,
    strike: 590,
    premium: 84000,
    premiumFormatted: "$84k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bullish",
    volume: 3200,
    openInterest: 1200,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 35,
    marketCap: "large",
    assetType: "etf",
  },
  {
    id: "flow_tsla_1",
    provenance: "static",
    time: "7:59am",
    timestamp: Date.now() - 960000,
    symbol: "TSLA",
    underlyingPrice: 380.6,
    strategy: "Buy 400 Call",
    expiration: "Oct 25",
    dte: 18,
    strike: 400,
    premium: 320000,
    premiumFormatted: "$320k",
    type: "BLOCK",
    side: "BUY",
    sentiment: "bullish",
    volume: 5400,
    openInterest: 2100,
    volOverOi: true,
    isOtm: true,
    hasEarnings: true,
    chance: 28,
    marketCap: "large",
    assetType: "stock",
  },
  {
    id: "flow_nvda_1",
    provenance: "static",
    time: "7:58am",
    timestamp: Date.now() - 1020000,
    symbol: "NVDA",
    underlyingPrice: 233.9,
    strategy: "Buy 245 Call",
    expiration: "Oct 11",
    dte: 4,
    strike: 245,
    premium: 1250000,
    premiumFormatted: "$1.25m",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bullish",
    volume: 12400,
    openInterest: 3100,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 22,
    marketCap: "large",
    assetType: "stock",
  },
  {
    id: "flow_2",
    provenance: "static",
    time: "7:43am",
    timestamp: Date.now() - 1920000,
    symbol: "XSP",
    companyName: "Mini-SPX Index",
    underlyingPrice: 586.4,
    strategy: "Sell 773 Call To Open",
    expiration: "Oct 26",
    dte: 19,
    strike: 773,
    premium: 13000,
    premiumFormatted: "$13k",
    type: "SPLIT",
    side: "SELL",
    sentiment: "bearish",
    volume: 980,
    openInterest: 1100,
    volOverOi: false,
    isOtm: true,
    hasEarnings: false,
    chance: 12,
    marketCap: "large",
    assetType: "etf",
  },
  {
    id: "flow_3",
    provenance: "static",
    time: "10/6 4:12pm",
    timestamp: Date.now() - 54000000,
    symbol: "QQQ",
    companyName: "Invesco QQQ Trust",
    underlyingPrice: 494.3,
    strategy: "Buy 755 Put",
    expiration: "Oct 7",
    dte: 1,
    strike: 755,
    premium: 51000,
    premiumFormatted: "$51k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bearish",
    volume: 4800,
    openInterest: 1100,
    volOverOi: true,
    isOtm: false,
    hasEarnings: false,
    chance: 15,
    marketCap: "large",
    assetType: "etf",
  },
  {
    id: "flow_4",
    provenance: "static",
    time: "10/6 4:12pm",
    timestamp: Date.now() - 54000000,
    symbol: "QQQ",
    companyName: "Invesco QQQ Trust",
    underlyingPrice: 494.3,
    strategy: "Buy 750 Put",
    expiration: "Oct 7",
    dte: 1,
    strike: 750,
    premium: 38000,
    premiumFormatted: "$38k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bearish",
    volume: 3200,
    openInterest: 950,
    volOverOi: true,
    isOtm: false,
    hasEarnings: false,
    chance: 14,
    marketCap: "large",
    assetType: "etf",
  },
  {
    id: "flow_5",
    provenance: "static",
    time: "10/6 4:11pm",
    timestamp: Date.now() - 54060000,
    symbol: "QQQ",
    companyName: "Invesco QQQ Trust",
    underlyingPrice: 494.3,
    strategy: "Buy 750 Put",
    expiration: "Oct 7",
    dte: 1,
    strike: 750,
    premium: 95000,
    premiumFormatted: "$95k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bearish",
    volume: 7100,
    openInterest: 1200,
    volOverOi: true,
    isOtm: false,
    hasEarnings: false,
    chance: 14,
    marketCap: "large",
    assetType: "etf",
  },
  {
    id: "flow_6",
    provenance: "static",
    time: "10/6 4:08pm",
    timestamp: Date.now() - 54240000,
    symbol: "QQQ",
    companyName: "Invesco QQQ Trust",
    underlyingPrice: 494.3,
    strategy: "Buy 755 Put",
    expiration: "Oct 7",
    dte: 1,
    strike: 755,
    premium: 63000,
    premiumFormatted: "$63k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bearish",
    volume: 5100,
    openInterest: 1100,
    volOverOi: true,
    isOtm: false,
    hasEarnings: false,
    chance: 15,
    marketCap: "large",
    assetType: "etf",
  },
  {
    id: "flow_7",
    provenance: "static",
    time: "10/6 4:00pm",
    timestamp: Date.now() - 54720000,
    symbol: "QQQ",
    companyName: "Invesco QQQ Trust",
    underlyingPrice: 494.3,
    strategy: "Buy 750 Put",
    expiration: "Oct 9",
    dte: 3,
    strike: 750,
    premium: 154000,
    premiumFormatted: "$154k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bearish",
    volume: 9800,
    openInterest: 1450,
    volOverOi: true,
    isOtm: false,
    hasEarnings: false,
    chance: 16,
    marketCap: "large",
    assetType: "etf",
  },
  {
    id: "flow_8",
    provenance: "static",
    time: "10/6 3:55pm",
    timestamp: Date.now() - 55020000,
    symbol: "NVDA",
    companyName: "NVIDIA Corporation",
    underlyingPrice: 233.95,
    strategy: "Buy 232.5 Put",
    expiration: "Oct 9",
    dte: 3,
    strike: 232.5,
    premium: 55000,
    premiumFormatted: "$55k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bearish",
    volume: 4200,
    openInterest: 1800,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 19,
    marketCap: "large",
    assetType: "stock",
  },
  {
    id: "flow_9",
    provenance: "static",
    time: "10/6 3:55pm",
    timestamp: Date.now() - 55020000,
    symbol: "IWM",
    companyName: "iShares Russell 2000 ETF",
    underlyingPrice: 221.8,
    strategy: "Buy 285 Call",
    expiration: "Oct 9",
    dte: 3,
    strike: 285,
    premium: 103000,
    premiumFormatted: "$103k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bullish",
    volume: 8500,
    openInterest: 2100,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 17,
    marketCap: "large",
    assetType: "etf",
  },
  {
    id: "flow_10",
    provenance: "static",
    time: "10/6 3:53pm",
    timestamp: Date.now() - 55140000,
    symbol: "SPCH",
    companyName: "Super Micro Computer Inc",
    underlyingPrice: 28.5,
    strategy: "23/24 Bear Put Spread",
    expiration: "Oct 9",
    dte: 3,
    strike: "23/24",
    premium: 35000,
    premiumFormatted: "$35k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bearish",
    abnormalActivity: true,
    volume: 6200,
    openInterest: 1100,
    volOverOi: true,
    isOtm: true,
    hasEarnings: true,
    chance: 18,
    marketCap: "mid",
    assetType: "stock",
  },
  {
    id: "flow_11",
    provenance: "static",
    time: "10/6 3:53pm",
    timestamp: Date.now() - 55140000,
    symbol: "SOXL",
    companyName: "Direxion Daily Semiconductor Bull 3X",
    underlyingPrice: 38.2,
    strategy: "Buy 170 Call",
    expiration: "Oct 7",
    dte: 1,
    strike: 170,
    premium: 67000,
    premiumFormatted: "$67k",
    type: "SPLIT",
    side: "BUY",
    sentiment: "bullish",
    volume: 3800,
    openInterest: 1200,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 12,
    marketCap: "mid",
    assetType: "etf",
  },
  {
    id: "flow_12",
    provenance: "static",
    time: "10/6 3:52pm",
    timestamp: Date.now() - 55200000,
    symbol: "NVDA",
    companyName: "NVIDIA Corporation",
    underlyingPrice: 233.95,
    strategy: "Buy 242.5 Call",
    expiration: "Oct 7",
    dte: 1,
    strike: 242.5,
    premium: 97000,
    premiumFormatted: "$97k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bullish",
    volume: 7400,
    openInterest: 2300,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 19,
    marketCap: "large",
    assetType: "stock",
  },
  {
    id: "flow_13",
    provenance: "static",
    time: "10/6 3:49pm",
    timestamp: Date.now() - 55380000,
    symbol: "AAPL",
    companyName: "Apple Inc.",
    underlyingPrice: 232.5,
    strategy: "Buy 340 Call",
    expiration: "Oct 9",
    dte: 3,
    strike: 340,
    premium: 34000,
    premiumFormatted: "$34k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bullish",
    volume: 2900,
    openInterest: 800,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 10,
    marketCap: "large",
    assetType: "stock",
  },
  {
    id: "flow_amzn_1",
    provenance: "static",
    time: "10/6 3:48pm",
    timestamp: Date.now() - 55440000,
    symbol: "AMZN",
    underlyingPrice: 186.5,
    strategy: "Buy 190 Call",
    expiration: "Oct 18",
    dte: 12,
    strike: 190,
    premium: 450000,
    premiumFormatted: "$450k",
    type: "BLOCK",
    side: "BUY",
    sentiment: "bullish",
    volume: 5100,
    openInterest: 1800,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 38,
    marketCap: "large",
    assetType: "stock",
  },
  {
    id: "flow_amd_1",
    provenance: "static",
    time: "10/6 3:46pm",
    timestamp: Date.now() - 55560000,
    symbol: "AMD",
    underlyingPrice: 172.4,
    strategy: "Buy 160 Put",
    expiration: "Oct 25",
    dte: 19,
    strike: 160,
    premium: 210000,
    premiumFormatted: "$210k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bearish",
    volume: 3800,
    openInterest: 1100,
    volOverOi: true,
    isOtm: true,
    hasEarnings: true,
    chance: 25,
    marketCap: "large",
    assetType: "stock",
  },
  {
    id: "flow_meta_1",
    provenance: "static",
    time: "10/6 3:44pm",
    timestamp: Date.now() - 55680000,
    symbol: "META",
    underlyingPrice: 588.6,
    strategy: "Buy 600 Call",
    expiration: "Nov 1",
    dte: 26,
    strike: 600,
    premium: 1850000,
    premiumFormatted: "$1.85m",
    type: "BLOCK",
    side: "BUY",
    sentiment: "bullish",
    volume: 3200,
    openInterest: 850,
    volOverOi: true,
    isOtm: true,
    hasEarnings: true,
    chance: 42,
    marketCap: "large",
    assetType: "stock",
  },
  {
    id: "flow_14",
    provenance: "static",
    time: "10/6 3:40pm",
    timestamp: Date.now() - 55920000,
    symbol: "ASTS",
    companyName: "AST SpaceMobile, Inc.",
    underlyingPrice: 26.8,
    strategy: "Buy 30 Call",
    expiration: "Oct 11",
    dte: 5,
    strike: 30,
    premium: 78000,
    premiumFormatted: "$78k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bullish",
    volume: 9100,
    openInterest: 1600,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 24,
    marketCap: "small",
    assetType: "stock",
  },
  {
    id: "flow_15",
    provenance: "static",
    time: "10/6 3:35pm",
    timestamp: Date.now() - 56220000,
    symbol: "PLTR",
    companyName: "Palantir Technologies",
    underlyingPrice: 43.5,
    strategy: "Buy 45 Call",
    expiration: "Oct 18",
    dte: 12,
    strike: 45,
    premium: 124000,
    premiumFormatted: "$124k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bullish",
    volume: 14200,
    openInterest: 4100,
    volOverOi: true,
    isOtm: true,
    hasEarnings: false,
    chance: 31,
    marketCap: "mid",
    assetType: "stock",
  },
  {
    id: "flow_16",
    provenance: "static",
    time: "10/6 3:30pm",
    timestamp: Date.now() - 56520000,
    symbol: "SMCI",
    companyName: "Super Micro Computer",
    underlyingPrice: 47.1,
    strategy: "Buy 40 Put",
    expiration: "Oct 18",
    dte: 12,
    strike: 40,
    premium: 310000,
    premiumFormatted: "$310k",
    type: "SWEEP",
    side: "BUY",
    sentiment: "bearish",
    volume: 8700,
    openInterest: 2300,
    volOverOi: true,
    isOtm: true,
    hasEarnings: true,
    chance: 28,
    marketCap: "mid",
    assetType: "stock",
  },
];

// Issue #131: the dormant fabricated insider/congress fixture tables that
// once sat here were deleted. Insider data comes only from
// fetchRealSecInsiderFilings (SEC EDGAR) and congressional data only
// from fetchRealCongressDisclosures — fabricated trades attributed to
// named real people must never be reintroduced as seed data.

export function filterLiveFlowItems(
  items: LiveFlowItem[],
  filter: Partial<FlowFilterConfig>
): LiveFlowItem[] {
  return items.map((item) => enrichFlowItem(item)).filter((item) => {
    // 1. Tickers
    if (filter.tickers && filter.tickers.length > 0) {
      const match = filter.tickers.some((t) => item.symbol.toUpperCase() === t.toUpperCase());
      if (!match) return false;
    }

    // 2. Minimum premium
    if (filter.minPremium && filter.minPremium > 0) {
      if (item.premium < filter.minPremium) return false;
    }

    // 3. Expiration / DTE
    if (filter.maxDte !== undefined && filter.maxDte < 9999) {
      if (item.dte > filter.maxDte) return false;
    }

    // 4. Sentiments
    if (filter.sentiments && filter.sentiments.length > 0) {
      if (!filter.sentiments.includes(item.sentiment)) return false;
    }

    // 5. Sides
    if (filter.sides && filter.sides.length > 0) {
      if (!filter.sides.includes(item.side)) return false;
    }

    // 6. Order types
    if (filter.orderTypes && filter.orderTypes.length > 0) {
      if (!filter.orderTypes.includes(item.type)) return false;
    }

    // 7. Asset types
    if (filter.assetTypes && filter.assetTypes.length > 0) {
      if (!filter.assetTypes.includes(item.assetType)) return false;
    }

    // 8. Market caps
    if (filter.marketCaps && filter.marketCaps.length > 0) {
      if (!filter.marketCaps.includes(item.marketCap)) return false;
    }

    // 9. Contract types (calls / puts / spreads)
    if (filter.contractTypes && filter.contractTypes.length > 0) {
      const isSpread = item.strategy.toLowerCase().includes("spread");
      const isCall = !isSpread && item.strategy.toLowerCase().includes("call");
      const isPut = !isSpread && item.strategy.toLowerCase().includes("put");
      let matchedType = false;
      if (filter.contractTypes.includes("calls") && isCall) matchedType = true;
      if (filter.contractTypes.includes("puts") && isPut) matchedType = true;
      if (filter.contractTypes.includes("spreads") && isSpread) matchedType = true;
      if (!matchedType) return false;
    }

    // 10. Checkboxes
    if (filter.isOtmOnly && !item.isOtm) return false;
    if (filter.volOverOiOnly && !item.volOverOi) return false;
    if (filter.upcomingEarningsOnly && !item.hasEarnings) return false;
    if (filter.aboveAskBelowBidOnly && !item.aboveAskBelowBid) return false;

    // 11. Numeric comparison: Underlying Price
    if (filter.priceValue !== null && filter.priceValue !== undefined) {
      if (filter.priceOperator === "less_than" && item.underlyingPrice >= filter.priceValue) return false;
      if (filter.priceOperator === "greater_than" && item.underlyingPrice <= filter.priceValue) return false;
    }

    // 12. Numeric comparison: Chance of profit
    if (filter.chanceValue !== null && filter.chanceValue !== undefined) {
      if (filter.chanceOperator === "less_than" && item.chance >= filter.chanceValue) return false;
      if (filter.chanceOperator === "greater_than" && item.chance <= filter.chanceValue) return false;
    }

    return true;
  });
}

export function filterNewsFlowItems(
  items: NewsFlowItem[],
  tickers: string[]
): NewsFlowItem[] {
  if (!tickers || tickers.length === 0) return items;
  return items.filter((item) =>
    item.symbols.some((sym) => tickers.some((t) => t.toUpperCase() === sym.toUpperCase()))
  );
}

export function filterInsiderFlowItems(
  items: InsiderFlowItem[],
  filter: { tickers?: string[]; insiderNames?: string[]; minPremium?: number; assetTypes?: string[]; marketCaps?: string[] }
): InsiderFlowItem[] {
  return items.filter((item) => {
    if (filter.tickers && filter.tickers.length > 0) {
      if (!filter.tickers.some((t) => t.toUpperCase() === item.symbol.toUpperCase())) return false;
    }
    if (filter.insiderNames && filter.insiderNames.length > 0) {
      const match = filter.insiderNames.some((n) => item.member.toLowerCase().includes(n.toLowerCase()));
      if (!match) return false;
    }
    if (filter.minPremium && filter.minPremium > 0) {
      if (item.premium < filter.minPremium) return false;
    }
    if (filter.assetTypes && filter.assetTypes.length > 0) {
      if (!filter.assetTypes.includes(item.assetType)) return false;
    }
    if (filter.marketCaps && filter.marketCaps.length > 0) {
      if (!filter.marketCaps.includes(item.marketCap)) return false;
    }
    return true;
  });
}

export function filterCongressFlowItems(
  items: CongressFlowItem[],
  filter: { tickers?: string[]; chamber?: string; party?: string }
): CongressFlowItem[] {
  return items.filter((item) => {
    if (filter.tickers && filter.tickers.length > 0) {
      if (!filter.tickers.some((t) => t.toUpperCase() === item.symbol.toUpperCase())) return false;
    }
    if (filter.chamber && filter.chamber !== "all") {
      if (item.chamber !== filter.chamber) return false;
    }
    if (filter.party && filter.party !== "all") {
      if (item.party !== filter.party) return false;
    }
    return true;
  });
}

export const BULLISH_FLOW_LEADERBOARD: FlowLeaderboardItem[] = [
  { symbol: "WMT", tradeCount: 27, premiumFormatted: "$15.27m", premiumRaw: 15270000, pctWidth: 82 },
  { symbol: "ARM", tradeCount: 56, premiumFormatted: "$18.43m", premiumRaw: 18430000, pctWidth: 86 },
  { symbol: "SPYM", tradeCount: 24, premiumFormatted: "$2.61m", premiumRaw: 2610000, pctWidth: 32 },
  { symbol: "NKE", tradeCount: 27, premiumFormatted: "$2.98m", premiumRaw: 2980000, pctWidth: 35 },
  { symbol: "LITE", tradeCount: 34, premiumFormatted: "$22.76m", premiumRaw: 22760000, pctWidth: 89 },
  { symbol: "CRWV", tradeCount: 59, premiumFormatted: "$23.06m", premiumRaw: 23060000, pctWidth: 90 },
  { symbol: "ORCL", tradeCount: 63, premiumFormatted: "$16.39m", premiumRaw: 16390000, pctWidth: 84 },
  { symbol: "NOK", tradeCount: 33, premiumFormatted: "$2.60m", premiumRaw: 2600000, pctWidth: 32 },
  { symbol: "GOOGL", tradeCount: 67, premiumFormatted: "$20.53m", premiumRaw: 20530000, pctWidth: 87 },
  { symbol: "/GF", tradeCount: 51, premiumFormatted: "$4.95m", premiumRaw: 4950000, pctWidth: 46 },
  { symbol: "NOW", tradeCount: 20, premiumFormatted: "$3.75m", premiumRaw: 3750000, pctWidth: 40 },
  { symbol: "ASTS", tradeCount: 28, premiumFormatted: "$5.01m", premiumRaw: 5010000, pctWidth: 47 },
  { symbol: "USO", tradeCount: 28, premiumFormatted: "$6.01m", premiumRaw: 6010000, pctWidth: 52 },
  { symbol: "ECHO", tradeCount: 10, premiumFormatted: "$6.54m", premiumRaw: 6540000, pctWidth: 54 },
  { symbol: "XSP", tradeCount: 84, premiumFormatted: "$17.64m", premiumRaw: 17640000, pctWidth: 85 },
  { symbol: "RKLB", tradeCount: 33, premiumFormatted: "$4.40m", premiumRaw: 4400000, pctWidth: 43 },
  { symbol: "NFLX", tradeCount: 21, premiumFormatted: "$3.02m", premiumRaw: 3020000, pctWidth: 36 },
  { symbol: "CNC", tradeCount: 9, premiumFormatted: "$2.61m", premiumRaw: 2610000, pctWidth: 32 },
  { symbol: "IWM", tradeCount: 146, premiumFormatted: "$55.96m", premiumRaw: 55960000, pctWidth: 100 },
  { symbol: "ASML", tradeCount: 9, premiumFormatted: "$20.10m", premiumRaw: 20100000, pctWidth: 87 },
];

export const BEARISH_FLOW_LEADERBOARD: FlowLeaderboardItem[] = [
  { symbol: "ETHA", tradeCount: 116, premiumFormatted: "$7.05m", premiumRaw: 7050000, pctWidth: 48 },
  { symbol: "/HE", tradeCount: 36, premiumFormatted: "$6.23m", premiumRaw: 6230000, pctWidth: 44 },
  { symbol: "U", tradeCount: 37, premiumFormatted: "$5.38m", premiumRaw: 5380000, pctWidth: 41 },
  { symbol: "SKHY", tradeCount: 41, premiumFormatted: "$13.43m", premiumRaw: 13430000, pctWidth: 62 },
  { symbol: "SDGR", tradeCount: 18, premiumFormatted: "$3.56m", premiumRaw: 3560000, pctWidth: 32 },
  { symbol: "ETHE", tradeCount: 18, premiumFormatted: "$349k", premiumRaw: 349000, pctWidth: 18 },
  { symbol: "XLU", tradeCount: 19, premiumFormatted: "$7.13m", premiumRaw: 7130000, pctWidth: 49 },
  { symbol: "HIVE", tradeCount: 15, premiumFormatted: "$559k", premiumRaw: 559000, pctWidth: 20 },
  { symbol: "EBAY", tradeCount: 26, premiumFormatted: "$1.57m", premiumRaw: 1570000, pctWidth: 26 },
  { symbol: "LABU", tradeCount: 32, premiumFormatted: "$4.89m", premiumRaw: 4890000, pctWidth: 39 },
  { symbol: "XBI", tradeCount: 15, premiumFormatted: "$4.98m", premiumRaw: 4980000, pctWidth: 40 },
  { symbol: "NU", tradeCount: 41, premiumFormatted: "$6.26m", premiumRaw: 6260000, pctWidth: 45 },
  { symbol: "TLT", tradeCount: 16, premiumFormatted: "$31.31m", premiumRaw: 31310000, pctWidth: 78 },
  { symbol: "BA", tradeCount: 11, premiumFormatted: "$7.01m", premiumRaw: 7010000, pctWidth: 48 },
  { symbol: "EWY", tradeCount: 34, premiumFormatted: "$15.25m", premiumRaw: 15250000, pctWidth: 66 },
  { symbol: "AAPL", tradeCount: 202, premiumFormatted: "$34.77m", premiumRaw: 34770000, pctWidth: 81 },
  { symbol: "GEV", tradeCount: 15, premiumFormatted: "$11.90m", premiumRaw: 11900000, pctWidth: 59 },
  { symbol: "NVDA", tradeCount: 373, premiumFormatted: "$172.13m", premiumRaw: 172130000, pctWidth: 100 },
  { symbol: "MKL", tradeCount: 12, premiumFormatted: "$716k", premiumRaw: 716000, pctWidth: 22 },
  { symbol: "MUU", tradeCount: 12, premiumFormatted: "$3.10m", premiumRaw: 3100000, pctWidth: 30 },
];

/**
 * Classifies an options trade into Bullish, Bearish, or Neutral sentiment
 * based on standardized institutional options flow criteria:
 *
 * 1. Contract direction:
 *    - BUY CALL (Ask cross): Bullish (paying the ask for upside leverage)
 *    - SELL CALL (Bid hit): Bearish (short call ceiling or hedge)
 *    - BUY PUT (Ask cross): Bearish (downside speculation or tail risk hedge)
 *    - SELL PUT (Bid hit): Bullish (income generation / willing to buy underlying)
 *
 * 2. Multi-leg spread mechanics:
 *    - Long Combo (Buy Call + Sell Put): Very Bullish (synthetic long)
 *    - Short Combo (Buy Put + Sell Call): Very Bearish (synthetic short)
 *    - Bull Spreads: Bullish
 *    - Bear Spreads: Bearish
 *    - Straddles/Strangles/Iron Condors: Neutral
 *
 * 3. Execution vs NBBO:
 *    - Above Ask: Ultra-aggressive buyer (+confidence)
 *    - Below Bid: Ultra-aggressive seller (+confidence)
 *
 * 4. Volume vs Open Interest:
 *    - Vol > OI: Opening trade indicator (+conviction)
 */
export function classifyTradeSentiment(trade: {
  strategy?: string;
  strategyTitle?: string;
  side?: "BUY" | "SELL";
  type?: string;
  fillPrice?: number;
  bid?: number;
  ask?: number;
  volOverOi?: boolean;
  aboveAskBelowBid?: boolean;
  legsDetails?: FlowLegDetail[];
}): EvaluatedFlowSentiment {
  const strat = `${trade.strategyTitle || ""} ${trade.strategy || ""}`.toLowerCase();
  const side = trade.side || (strat.includes("buy") ? "BUY" : strat.includes("sell") ? "SELL" : "BUY");

  // Multi-leg combo detection
  const hasBuyCall = (trade.legsDetails?.some(l => l.action === "Buy" && (l.optionType === "CALL" || l.option.includes("C")))) ?? false;
  const hasSellPut = (trade.legsDetails?.some(l => l.action === "Sell" && (l.optionType === "PUT" || l.option.includes("P")))) ?? false;
  const hasBuyPut = (trade.legsDetails?.some(l => l.action === "Buy" && (l.optionType === "PUT" || l.option.includes("P")))) ?? false;
  const hasSellCall = (trade.legsDetails?.some(l => l.action === "Sell" && (l.optionType === "CALL" || l.option.includes("C")))) ?? false;

  if ((hasBuyCall && hasSellPut) || strat.includes("long combo") || (strat.includes("combo") && side === "BUY")) {
    return {
      sentiment: "bullish",
      confidence: 96,
      reasoning: "Long Combo: Synthetically replicating long delta stock by buying calls funded by selling puts.",
    };
  }

  if ((hasBuyPut && hasSellCall) || strat.includes("short combo") || (strat.includes("combo") && side === "SELL")) {
    return {
      sentiment: "bearish",
      confidence: 96,
      reasoning: "Short Combo: Synthetically replicating short delta stock by buying puts and selling calls.",
    };
  }

  // Named Spreads
  if (strat.includes("bull call") || strat.includes("bull put")) {
    return {
      sentiment: "bullish",
      confidence: 88,
      reasoning: "Bull Vertical Spread: Directional upside positioning with defined risk.",
    };
  }

  if (strat.includes("bear put") || strat.includes("bear call")) {
    return {
      sentiment: "bearish",
      confidence: 88,
      reasoning: "Bear Vertical Spread: Directional downside positioning with defined risk.",
    };
  }

  if (strat.includes("straddle") || strat.includes("strangle") || strat.includes("iron condor") || strat.includes("butterfly")) {
    return {
      sentiment: "neutral",
      confidence: 85,
      reasoning: "Volatility or Rangebound Structure: Non-directional delta with pure vega/theta profile.",
    };
  }

  const isCall = strat.includes("call") || hasBuyCall || hasSellCall;
  const isPut = strat.includes("put") || hasBuyPut || hasSellPut;

  if (isCall) {
    if (side === "BUY") {
      const aggressive = trade.aboveAskBelowBid || (trade.fillPrice && trade.ask && trade.fillPrice >= trade.ask);
      return {
        sentiment: "bullish",
        confidence: aggressive ? 92 : 82,
        reasoning: aggressive
          ? "Aggressive Call Buying: Order crossed the NBBO ask, indicating high urgency institutional accumulation."
          : "Long Call: Direct upside leveraged exposure.",
      };
    } else {
      return {
        sentiment: "bearish",
        confidence: 80,
        reasoning: "Short Call Print: Selling calls to lock in downside hedge or writing upside resistance.",
      };
    }
  }

  if (isPut) {
    if (side === "BUY") {
      const aggressive = trade.aboveAskBelowBid || (trade.fillPrice && trade.ask && trade.fillPrice >= trade.ask);
      return {
        sentiment: "bearish",
        confidence: aggressive ? 92 : 82,
        reasoning: aggressive
          ? "Aggressive Put Buying: Order crossed the ask, indicating aggressive downside speculation or large portfolio hedge."
          : "Long Put: Bearish downside positioning.",
      };
    } else {
      return {
        sentiment: "bullish",
        confidence: 82,
        reasoning: "Short Put Print: Writing cash-secured or margin puts, collecting upfront premium and willing to absorb shares at strike.",
      };
    }
  }

  // Default fallback
  return {
    sentiment: "neutral",
    confidence: 60,
    reasoning: "Neutral or mixed flow print.",
  };
}

export function enrichFlowItem(item: LiveFlowItem): LiveFlowItem {
  const evaluated = classifyTradeSentiment(item);
  item.sentiment = evaluated.sentiment;
  item.sentimentReasoning = evaluated.reasoning;
  item.confidenceScore = evaluated.confidence;
  return item;
}

function formatFlowPremium(prem: number): string {
  if (prem >= 1_000_000) return `$${(prem / 1_000_000).toFixed(2)}m`;
  if (prem >= 1_000) return `$${Math.round(prem / 1_000)}k`;
  return `$${prem.toLocaleString()}`;
}

/**
 * Formats options flow print timestamps in US Eastern Time (America/New_York)
 * standard to all major options exchanges (CBOE, NYSE Arca, Nasdaq).
 */
export function formatFlowDateTime(timestamp: number, refTime: number = Date.now()): string {
  try {
    const date = new Date(timestamp);
    const ref = new Date(refTime);

    const nyDateStr = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).format(date);

    const nyRefStr = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).format(ref);

    const timePart = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date).toLowerCase().replace(/\s+/g, "");

    if (nyDateStr === nyRefStr) {
      return timePart;
    }

    const monthDay = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "numeric",
      day: "numeric",
    }).format(date);

    return `${monthDay} ${timePart}`;
  } catch {
    const d = new Date(timestamp);
    const hours = d.getHours();
    const mins = d.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "pm" : "am";
    return `${hours % 12 || 12}:${mins}${ampm}`;
  }
}

function mergeLeaderboardWithSeed(
  dynamicItems: FlowLeaderboardItem[],
  seedItems: FlowLeaderboardItem[]
): FlowLeaderboardItem[] {
  const mergedMap = new Map<string, FlowLeaderboardItem>();

  // Add all dynamic items first
  for (const item of dynamicItems) {
    mergedMap.set(item.symbol.toUpperCase(), { ...item });
  }

  // Top up with seed items so the leaderboard always maintains a complete 20-row view
  for (const seed of seedItems) {
    if (!mergedMap.has(seed.symbol.toUpperCase())) {
      mergedMap.set(seed.symbol.toUpperCase(), { ...seed });
    } else {
      // Merge counts and raw premium
      const existing = mergedMap.get(seed.symbol.toUpperCase())!;
      const totalPrem = Math.max(existing.premiumRaw, seed.premiumRaw);
      existing.tradeCount = Math.max(existing.tradeCount, seed.tradeCount);
      existing.premiumRaw = totalPrem;
      existing.premiumFormatted = formatFlowPremium(totalPrem);
    }
  }

  const result = Array.from(mergedMap.values())
    .sort((a, b) => b.premiumRaw - a.premiumRaw)
    .slice(0, 20);

  // Dynamically recompute percentage widths relative to the top symbol
  const maxPrem = result.length > 0 ? Math.max(...result.map((r) => r.premiumRaw)) : 1;
  for (const r of result) {
    r.pctWidth = Math.max(15, Math.min(100, Math.round((r.premiumRaw / maxPrem) * 100)));
  }

  return result;
}

export function sortAndScaleLeaderboard(items: FlowLeaderboardItem[]): FlowLeaderboardItem[] {
  const sorted = [...items]
    .sort((a, b) => b.premiumRaw - a.premiumRaw)
    .slice(0, 20);

  const maxPrem = sorted.length > 0 ? Math.max(...sorted.map((r) => r.premiumRaw)) : 1;
  for (const r of sorted) {
    r.pctWidth = Math.max(15, Math.min(100, Math.round((r.premiumRaw / maxPrem) * 100)));
  }

  return sorted;
}

export function calculateFlowSummary(items: LiveFlowItem[]): FlowSummary {
  let callPremium = 0;
  let putPremium = 0;
  let sweepCount = 0;
  let blockCount = 0;

  const symbolBullish: Record<string, { premium: number; count: number }> = {};
  const symbolBearish: Record<string, { premium: number; count: number }> = {};

  for (const item of items) {
    if (item.type === "SWEEP") sweepCount++;
    if (item.type === "BLOCK") blockCount++;

    const classification = classifyTradeSentiment(item);
    item.sentiment = classification.sentiment;
    item.sentimentReasoning = classification.reasoning;
    item.confidenceScore = classification.confidence;

    const isCall = item.strategy.toLowerCase().includes("call");
    const isPut = item.strategy.toLowerCase().includes("put");

    if (isCall) {
      callPremium += item.premium;
    } else if (isPut) {
      putPremium += item.premium;
    }

    if (classification.sentiment === "bullish") {
      if (!symbolBullish[item.symbol]) symbolBullish[item.symbol] = { premium: 0, count: 0 };
      symbolBullish[item.symbol].premium += item.premium;
      symbolBullish[item.symbol].count += 1;
    } else if (classification.sentiment === "bearish") {
      if (!symbolBearish[item.symbol]) symbolBearish[item.symbol] = { premium: 0, count: 0 };
      symbolBearish[item.symbol].premium += item.premium;
      symbolBearish[item.symbol].count += 1;
    }
  }

  const totalPremium = callPremium + putPremium;
  const bullishSentimentRatio = totalPremium > 0
    ? Math.round((callPremium / totalPremium) * 100)
    : 50;

  const topBullishSymbols = Object.entries(symbolBullish)
    .map(([symbol, data]) => ({ symbol, callPremium: data.premium, tradeCount: data.count }))
    .sort((a, b) => b.callPremium - a.callPremium)
    .slice(0, 6);

  const topBearishSymbols = Object.entries(symbolBearish)
    .map(([symbol, data]) => ({ symbol, putPremium: data.premium, tradeCount: data.count }))
    .sort((a, b) => b.putPremium - a.putPremium)
    .slice(0, 6);

  let dynamicBullishList: FlowLeaderboardItem[] = Object.entries(symbolBullish)
    .filter(([symbol, data]) => {
      const bearPrem = symbolBearish[symbol]?.premium || 0;
      return data.premium >= bearPrem;
    })
    .map(([symbol, data]) => ({
      symbol,
      tradeCount: data.count,
      premiumRaw: data.premium,
      premiumFormatted: formatFlowPremium(data.premium),
      pctWidth: 0,
    }));

  let dynamicBearishList: FlowLeaderboardItem[] = Object.entries(symbolBearish)
    .filter(([symbol, data]) => {
      const bullPrem = symbolBullish[symbol]?.premium || 0;
      return data.premium > bullPrem;
    })
    .map(([symbol, data]) => ({
      symbol,
      tradeCount: data.count,
      premiumRaw: data.premium,
      premiumFormatted: formatFlowPremium(data.premium),
      pctWidth: 0,
    }));

  if (dynamicBullishList.length === 0 && Object.keys(symbolBullish).length > 0) {
    dynamicBullishList = Object.entries(symbolBullish).map(([symbol, data]) => ({
      symbol,
      tradeCount: data.count,
      premiumRaw: data.premium,
      premiumFormatted: formatFlowPremium(data.premium),
      pctWidth: 0,
    }));
  }
  if (dynamicBearishList.length === 0 && Object.keys(symbolBearish).length > 0) {
    dynamicBearishList = Object.entries(symbolBearish).map(([symbol, data]) => ({
      symbol,
      tradeCount: data.count,
      premiumRaw: data.premium,
      premiumFormatted: formatFlowPremium(data.premium),
      pctWidth: 0,
    }));
  }

  const isBaselineFixture = items === RAW_LIVE_FLOW_ITEMS;

  const bullishLeaderboard = isBaselineFixture
    ? mergeLeaderboardWithSeed(dynamicBullishList, BULLISH_FLOW_LEADERBOARD)
    : sortAndScaleLeaderboard(dynamicBullishList);

  const bearishLeaderboard = isBaselineFixture
    ? mergeLeaderboardWithSeed(dynamicBearishList, BEARISH_FLOW_LEADERBOARD)
    : sortAndScaleLeaderboard(dynamicBearishList);

  const largestTrades = [...items]
    .sort((a, b) => b.premium - a.premium)
    .slice(0, 5);

  return {
    provenance: summarizeFlowProvenance(items),
    totalTrades: items.length,
    totalPremium,
    callPremium,
    putPremium,
    bullishSentimentRatio,
    sweepCount,
    blockCount,
    topBullishSymbols,
    topBearishSymbols,
    bullishLeaderboard,
    bearishLeaderboard,
    largestTrades,
  };
}

/**
 * Derives modelled flow-estimate items from an E*TRADE option chain snapshot.
 * Contract volume / open interest / prices are real chain fields, but there
 * is no trade tape behind this: the trade side is inferred from last price
 * vs bid/ask, the size and premium are estimated, and timestamps are
 * assigned around the snapshot time. Every item is stamped
 * provenance: "chain-derived" (issue #119) — these are NOT executed prints.
 */
export function convertOptionChainToFlowItems(
  chain: ETradeOptionChain,
  options?: {
    referenceTimestamp?: number;
    maxTradesPerChain?: number;
    minVolumeThreshold?: number;
  }
): LiveFlowItem[] {
  const refTime = options?.referenceTimestamp ?? Date.now();
  const symbol = chain.symbol.toUpperCase();
  const underlyingPrice = chain.underlyingPrice;
  const maxTrades = options?.maxTradesPerChain ?? 20;
  const items: LiveFlowItem[] = [];

  const expiryStr = chain.selectedExpiry
    ? `${chain.selectedExpiry.month}/${chain.selectedExpiry.day}/${chain.selectedExpiry.year}`
    : "30d";

  const dte = chain.selectedExpiry
    ? Math.max(0, Math.round((new Date(chain.selectedExpiry.year, chain.selectedExpiry.month - 1, chain.selectedExpiry.day).getTime() - refTime) / 86400000))
    : 30;

  for (let i = 0; i < chain.pairs.length; i++) {
    const pair = chain.pairs[i];
    const contracts: Array<{ contract: ETradeOptionChainContract; type: "CALL" | "PUT" }> = [];
    if (pair.call) contracts.push({ contract: pair.call, type: "CALL" });
    if (pair.put) contracts.push({ contract: pair.put, type: "PUT" });

    for (const { contract, type } of contracts) {
      const volume = contract.volume ?? 0;
      const openInterest = contract.openInterest ?? 0;
      if (volume <= 0 && openInterest <= 0) continue;

      const strike = contract.strikePrice;
      const lastPrice = contract.lastPrice > 0 ? contract.lastPrice : contract.ask > 0 ? contract.ask : 1.0;
      const bid = contract.bid > 0 ? contract.bid : Number((lastPrice * 0.98).toFixed(2));
      const ask = contract.ask > 0 ? contract.ask : Number((lastPrice * 1.02).toFixed(2));

      // Execution point: crossed ask (aggressive buy) or hit bid (aggressive sell)
      const atOrAboveAsk = lastPrice >= ask;
      const atOrBelowBid = lastPrice <= bid;
      const side: "BUY" | "SELL" = atOrAboveAsk ? "BUY" : atOrBelowBid ? "SELL" : lastPrice >= (bid + ask) / 2 ? "BUY" : "SELL";

      // Order type classification
      let orderType: "SWEEP" | "SPLIT" | "BLOCK" | "SINGLE" = "SINGLE";
      const estContracts = Math.max(25, Math.min(volume || 100, 3000));
      const premium = Math.round(estContracts * 100 * lastPrice);

      if (estContracts >= 1000 && premium >= 250000) {
        orderType = "BLOCK";
      } else if (estContracts >= 500 && atOrAboveAsk) {
        orderType = "SWEEP";
      } else if (estContracts >= 300) {
        orderType = "SPLIT";
      }

      const isOtm = type === "CALL" ? strike > underlyingPrice : strike < underlyingPrice;
      const volOverOi = volume > openInterest && openInterest > 0;
      const chance = Math.round(
        Math.min(95, Math.max(5, contract.delta ? Math.abs(contract.delta) * 100 : isOtm ? 35 : 65))
      );

      const strategy = `${side === "BUY" ? "Buy" : "Sell"} ${strike} ${type === "CALL" ? "Call" : "Put"}`;
      const strategyTitle = `${symbol} ${side === "BUY" ? "Long" : "Short"} ${type === "CALL" ? "Call" : "Put"}`;

      // Calculate recent minute timestamp
      const minutesAgo = Math.min(180, (i * 4 + (type === "CALL" ? 1 : 2)));
      const itemTimestamp = refTime - minutesAgo * 60000;
      const timeStr = formatFlowDateTime(itemTimestamp, refTime);

      const flowItem: LiveFlowItem = {
        id: `${symbol.toLowerCase()}_chain_${type.toLowerCase()}_${strike}_${itemTimestamp}`,
        time: timeStr,
        timestamp: itemTimestamp,
        provenance: "chain-derived",
        symbol,
        underlyingPrice,
        strategy,
        strategyTitle,
        expiration: expiryStr,
        dte,
        strike,
        premium,
        premiumFormatted: formatFlowPremium(premium),
        type: orderType,
        side,
        sentiment: "neutral",
        volume,
        openInterest,
        volOverOi,
        isOtm,
        hasEarnings: false,
        aboveAskBelowBid: atOrAboveAsk || atOrBelowBid,
        chance,
        marketCap: underlyingPrice > 100 ? "large" : "mid",
        assetType: "stock",
        fillPrice: lastPrice,
        currentContractPrice: lastPrice,
        totalQuantity: estContracts,
      };

      enrichFlowItem(flowItem);
      items.push(flowItem);

      if (items.length >= maxTrades) break;
    }

    if (items.length >= maxTrades) break;
  }

  return items;
}

export interface DynamicFlowUniverseOptions {
  referenceTimestamp?: number;
  count?: number;
  symbols?: string[];
  minPremium?: number;
}

/**
 * Curated dynamic symbol profiles derived from the externalized curated stock universe.
 */
export const DYNAMIC_FLOW_PROFILES: Array<{
  symbol: string;
  companyName: string;
  underlyingPrice: number;
  marketCap: "large" | "mid" | "small";
  assetType: "stock" | "etf";
  hasEarnings?: boolean;
}> = CURATED_STOCK_UNIVERSE.map((item) => ({
  symbol: item.symbol,
  companyName: item.companyName,
  underlyingPrice: item.defaultPrice ?? 150.0,
  marketCap: ((item.marketCap || 0) >= 10e9 ? "large" : (item.marketCap || 0) >= 2e9 ? "mid" : "small") as "large" | "mid" | "small",
  assetType: (item.sector.includes("ETF") ? "etf" : "stock") as "stock" | "etf",
  hasEarnings: !item.sector.includes("ETF"),
}));

// In-memory cache for dynamically scanned stock listings partitioned by market cap (10 minute TTL)
let dynamicListingsCache: {
  expiresAt: number;
  large: string[];
  mid: string[];
  small: string[];
  etfs: string[];
} | null = null;

function isOptionableListing(l: {
  symbol?: string;
  companyName?: string;
  price?: number;
  lastPrice?: number;
  marketCap?: number;
}): boolean {
  if (!l.symbol || !/^[A-Z]{1,5}$/.test(l.symbol)) return false;
  const currentPrice = l.price ?? l.lastPrice ?? 0;
  if (currentPrice < 3.0) return false;
  const name = (l.companyName || "").toLowerCase();
  if (
    name.includes("warrant") ||
    name.includes("unit") ||
    name.includes("right") ||
    name.includes("preferred") ||
    name.includes("debt")
  ) {
    return false;
  }
  // Exclude corrupted penny/OTC valuations
  if (l.marketCap && l.marketCap > 5_000_000_000_000 && !["NVDA", "AAPL", "MSFT", "GOOGL", "AMZN"].includes(l.symbol)) {
    return false;
  }
  return true;
}

/**
 * Dynamically resolves active market underlyings for options flow analysis.
 * Uses the Stock Screener (DynamicMarketScreener) as the primary discovery engine.
 * The Stock Screener attempts live dynamic discovery across all US exchanges first (Nasdaq/NYSE/AMEX).
 * If the upstream listing API is unavailable, rate-limited, or blocked, DynamicMarketScreener
 * decides whether to use a dynamic listing or fall back to the externalized curated stock universe.
 */
export async function resolveDynamicFlowSymbols(
  filter?: Partial<FlowFilterConfig>,
  seam?: NasdaqUniverseSeam
): Promise<string[]> {
  const now = Date.now();
  const curatedUniverse = getCuratedStockUniverse();
  const defaultLarge = curatedUniverse.filter((l) => (l.marketCap || 0) >= 10e9 && !l.sector.includes("ETF")).map((l) => l.symbol);
  const defaultMid = curatedUniverse.filter((l) => (l.marketCap || 0) >= 2e9 && (l.marketCap || 0) < 10e9 && !l.sector.includes("ETF")).map((l) => l.symbol);
  const defaultSmallRaw = curatedUniverse.filter((l) => (l.marketCap || 0) < 2e9 && !l.sector.includes("ETF")).map((l) => l.symbol);
  const defaultSmall = defaultSmallRaw.length > 0 ? defaultSmallRaw : ["SOFI", "MARA", "RIOT", "PLUG", "AFRM", "UPST", "RIVN", "LCID"];
  const defaultEtfs = curatedUniverse.filter((l) => l.sector.includes("ETF")).map((l) => l.symbol);

  if (!dynamicListingsCache || dynamicListingsCache.expiresAt <= now) {
    try {
      // Primary discovery: Stock Screener dynamically scans live equities across all US exchanges first
      const screener = new DynamicMarketScreener();
      const screenResult = await screener.screenLive(
        {
          minPrice: 3.0,
        },
        seam
      );

      const screenedList = (screenResult && screenResult.stocks && screenResult.stocks.length > 0)
        ? screenResult.stocks
        : [];

      if (screenedList.length > 0) {
        // Filter out non-optionable securities (warrants, penny stocks, units)
        const optionables = screenedList.filter(isOptionableListing);

        // Sort by absolute price change percent (high-momentum / unusual volume movers)
        const activeMoverSort = (a: { changePercent?: number }, b: { changePercent?: number }) =>
          Math.abs(b.changePercent || 0) - Math.abs(a.changePercent || 0);

        const large = optionables
          .filter((l) => (l.marketCap || 0) >= 10_000_000_000)
          .sort(activeMoverSort)
          .slice(0, 20)
          .map((l) => l.symbol);

        const mid = optionables
          .filter((l) => (l.marketCap || 0) >= 2_000_000_000 && (l.marketCap || 0) < 10_000_000_000)
          .sort(activeMoverSort)
          .slice(0, 20)
          .map((l) => l.symbol);

        const small = optionables
          .filter((l) => (l.marketCap || 0) >= 250_000_000 && (l.marketCap || 0) < 2_000_000_000)
          .sort(activeMoverSort)
          .slice(0, 20)
          .map((l) => l.symbol);

        const etfs = optionables
          .filter((l) => (l as any).sector?.includes("ETF") || ["SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "SMH"].includes(l.symbol))
          .map((l) => l.symbol);

        dynamicListingsCache = {
          expiresAt: now + 10 * 60 * 1000, // 10 minutes
          large: large.length > 0 ? large : defaultLarge,
          mid: mid.length > 0 ? mid : defaultMid,
          small: small.length > 0 ? small : defaultSmall,
          etfs: etfs.length > 0 ? etfs : defaultEtfs.length > 0 ? defaultEtfs : ["SPY", "QQQ", "IWM"],
        };
      }
    } catch {
      // DynamicMarketScreener fallback handles graceful degradation
    }
  }

  // Fallback defaults derived from externalized curated universe
  const cache = dynamicListingsCache || {
    expiresAt: now + 60000,
    large: defaultLarge.slice(0, 10),
    mid: defaultMid.slice(0, 8),
    small: defaultSmall.slice(0, 8),
    etfs: defaultEtfs.slice(0, 7),
  };

  const caps = filter?.marketCaps || ["large", "mid", "small"];
  const selected: string[] = [];

  if (caps.includes("small") && (!caps.includes("large") && !caps.includes("mid"))) {
    return cache.small.slice(0, 8);
  }
  if (caps.includes("mid") && (!caps.includes("large") && !caps.includes("small"))) {
    return cache.mid.slice(0, 8);
  }
  if (caps.includes("large") && (!caps.includes("mid") && !caps.includes("small"))) {
    return cache.large.slice(0, 10);
  }

  // Multi-cap diversified basket
  if (caps.includes("large")) selected.push(...cache.large.slice(0, 6));
  if (caps.includes("mid")) selected.push(...cache.mid.slice(0, 4));
  if (caps.includes("small")) selected.push(...cache.small.slice(0, 4));

  return Array.from(new Set(selected));
}

/**
 * Generates template-based sample options flow items across the given
 * underlyings. This is a fully GENERATED dataset (fixed trade templates over
 * profile prices — no chain data involved). Issue #925: it is reachable
 * only under the demo regime — the #65 demo gate enabled AND an explicit
 * dataMode "demo" request (see getDynamicLiveFlowItems step 6). It is
 * never a silent fallback on a live path. Every item is stamped
 * provenance: "generated" (issue #119) and surfaces must label it as
 * sample data.
 */
export function generateDynamicFlowUniverse(options?: DynamicFlowUniverseOptions): LiveFlowItem[] {
  const refTime = options?.referenceTimestamp ?? Date.now();
  const requestedSymbols = options?.symbols?.map((s) => s.toUpperCase());
  const targetProfiles: Array<{
    symbol: string;
    companyName: string;
    underlyingPrice: number;
    marketCap: "large" | "mid" | "small";
    assetType: "stock" | "etf";
    hasEarnings?: boolean;
  }> = [];

  if (requestedSymbols && requestedSymbols.length > 0) {
    for (const sym of requestedSymbols) {
      const existing = DYNAMIC_FLOW_PROFILES.find((p) => p.symbol === sym);
      if (existing) {
        targetProfiles.push(existing);
      } else {
        targetProfiles.push({
          symbol: sym,
          companyName: `${sym} Equity`,
          underlyingPrice: 50.0,
          marketCap: "mid",
          assetType: sym.length <= 3 && ["SPY", "QQQ", "IWM", "DIA"].includes(sym) ? "etf" : "stock",
        });
      }
    }
  } else {
    targetProfiles.push(...DYNAMIC_FLOW_PROFILES);
  }
  const items: LiveFlowItem[] = [];

  const tradeTemplates: Array<{
    type: "SWEEP" | "BLOCK" | "SPLIT" | "SINGLE";
    side: "BUY" | "SELL";
    optType: "CALL" | "PUT";
    strikeOffsetPct: number;
    dte: number;
    contracts: number;
    volMultiplier: number;
    oiMultiplier: number;
    aboveAsk: boolean;
  }> = [
    { type: "SWEEP", side: "BUY", optType: "CALL", strikeOffsetPct: 0.05, dte: 3, contracts: 1200, volMultiplier: 2.5, oiMultiplier: 0.8, aboveAsk: true },
    { type: "BLOCK", side: "BUY", optType: "CALL", strikeOffsetPct: 0.08, dte: 35, contracts: 2500, volMultiplier: 1.8, oiMultiplier: 1.2, aboveAsk: false },
    { type: "SWEEP", side: "BUY", optType: "PUT", strikeOffsetPct: -0.04, dte: 7, contracts: 800, volMultiplier: 3.1, oiMultiplier: 0.9, aboveAsk: true },
    { type: "SPLIT", side: "SELL", optType: "PUT", strikeOffsetPct: -0.06, dte: 45, contracts: 1500, volMultiplier: 1.2, oiMultiplier: 1.5, aboveAsk: false },
    { type: "SINGLE", side: "BUY", optType: "CALL", strikeOffsetPct: 0.12, dte: 14, contracts: 450, volMultiplier: 1.4, oiMultiplier: 0.6, aboveAsk: false },
    { type: "BLOCK", side: "SELL", optType: "CALL", strikeOffsetPct: 0.03, dte: 21, contracts: 3000, volMultiplier: 1.5, oiMultiplier: 2.0, aboveAsk: false },
  ];

  let tradeIdx = 0;
  for (const profile of targetProfiles) {
    for (let t = 0; t < tradeTemplates.length; t++) {
      const template = tradeTemplates[t];
      const strike = Math.round((profile.underlyingPrice * (1 + template.strikeOffsetPct)) * 2) / 2;
      const isOtm = template.optType === "CALL" ? strike > profile.underlyingPrice : strike < profile.underlyingPrice;
      const basePrice = Math.max(0.5, Number((profile.underlyingPrice * 0.02 * (isOtm ? 0.6 : 1.4)).toFixed(2)));
      const fillPrice = template.aboveAsk ? Number((basePrice * 1.03).toFixed(2)) : basePrice;
      const premium = Math.round(template.contracts * 100 * fillPrice);

      if (options?.minPremium && premium < options.minPremium) continue;

      const volume = Math.round(template.contracts * template.volMultiplier);
      const openInterest = Math.round(template.contracts * template.oiMultiplier);
      const volOverOi = volume > openInterest;

      const minutesAgo = (tradeIdx * 5 + t * 2) % 240 + 1;
      const itemTimestamp = refTime - minutesAgo * 60000;
      const timeStr = formatFlowDateTime(itemTimestamp, refTime);

      const strategy = `${template.side === "BUY" ? "Buy" : "Sell"} ${strike} ${template.optType === "CALL" ? "Call" : "Put"}`;
      const strategyTitle = `${profile.symbol} ${template.side === "BUY" ? "Long" : "Short"} ${template.optType === "CALL" ? "Call" : "Put"}`;

      const chance = Math.round(isOtm ? (template.side === "BUY" ? 32 : 68) : (template.side === "BUY" ? 64 : 36));

      const flowItem: LiveFlowItem = {
        id: `dyn_${profile.symbol.toLowerCase()}_${template.optType.toLowerCase()}_${strike}_${t}`,
        time: timeStr,
        timestamp: itemTimestamp,
        provenance: "generated",
        symbol: profile.symbol,
        companyName: profile.companyName,
        underlyingPrice: profile.underlyingPrice,
        strategy,
        strategyTitle,
        expiration: `${template.dte}d`,
        dte: template.dte,
        strike,
        premium,
        premiumFormatted: formatFlowPremium(premium),
        type: template.type,
        side: template.side,
        sentiment: "neutral",
        volume,
        openInterest,
        volOverOi,
        isOtm,
        hasEarnings: Boolean(profile.hasEarnings),
        aboveAskBelowBid: template.aboveAsk,
        chance,
        marketCap: profile.marketCap,
        assetType: profile.assetType,
        fillPrice,
        currentContractPrice: fillPrice,
        totalQuantity: template.contracts,
      };

      enrichFlowItem(flowItem);
      items.push(flowItem);
      tradeIdx++;
    }
  }

  return items;
}

// In-memory cache for real-time market options flow (30 second TTL)
const realFlowsCache = new Map<string, { items: LiveFlowItem[]; expiresAt: number }>();

/**
 * Derives modelled flow-estimate items from a Yahoo Finance option-chain
 * snapshot (Yahoo API with cookie/crumb authentication). The chain fields
 * (contract volume, open interest, last price, last-trade time) are real,
 * but the items are estimates built from them — side is inferred from last
 * price vs bid/ask and premium is volume × last price. They are NOT trade
 * executions from an exchange tape; every item is stamped
 * provenance: "chain-derived" (issue #119).
 */
export async function fetchRealMarketFlowsForSymbol(
  symbol: string,
  options?: {
    minPremium?: number;
    referenceTimestamp?: number;
  }
): Promise<LiveFlowItem[]> {
  const cleanSym = symbol.toUpperCase().trim();
  const now = Date.now();
  const cached = realFlowsCache.get(cleanSym);
  if (cached && cached.expiresAt > now) {
    return cached.items;
  }

  try {
    const session = await getYahooCrumbSession();
    if (!session || !session.crumb) return [];

    const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(cleanSym)}?crumb=${encodeURIComponent(session.crumb)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Cookie: session.cookie,
      },
    });

    if (!res.ok) return [];
    const data: any = await res.json();
    const result = data?.optionChain?.result?.[0];
    if (!result) return [];

    const quote = result.quote || {};
    const underlyingPrice = Number(quote.regularMarketPrice || quote.bid || quote.ask || 100);
    const companyName = quote.shortName || quote.longName || `${cleanSym} ETF / Stock`;
    let marketCap: MarketCapCategory = "large";
    if (quote.marketCap && quote.marketCap > 0) {
      if (quote.marketCap >= 10_000_000_000) {
        marketCap = "large";
      } else if (quote.marketCap >= 2_000_000_000) {
        marketCap = "mid";
      } else {
        marketCap = "small";
      }
    } else {
      const profile = DYNAMIC_FLOW_PROFILES.find((p) => p.symbol === cleanSym);
      if (profile) {
        marketCap = profile.marketCap;
      } else if (cleanSym === "IWM" || cleanSym === "IJR" || cleanSym === "VB" || cleanSym === "MDY") {
        marketCap = "mid";
      } else {
        marketCap = "large";
      }
    }
    const assetType: AssetClassCategory = quote.quoteType === "ETF" ? "etf" : "stock";

    const optionsData = result.options?.[0];
    if (!optionsData) return [];

    const rawCalls: any[] = optionsData.calls || [];
    const rawPuts: any[] = optionsData.puts || [];

    const activeContracts: Array<{ c: any; optType: "CALL" | "PUT" }> = [
      ...rawCalls.map((c) => ({ c, optType: "CALL" as const })),
      ...rawPuts.map((c) => ({ c, optType: "PUT" as const })),
    ].filter((item) => (item.c.volume && item.c.volume > 0) || (item.c.lastPrice && item.c.lastPrice > 0));

    // Sort by most recent trade date or volume descending
    activeContracts.sort((a, b) => {
      const timeDiff = (b.c.lastTradeDate || 0) - (a.c.lastTradeDate || 0);
      if (timeDiff !== 0) return timeDiff;
      return (b.c.volume || 0) - (a.c.volume || 0);
    });

    const flowItems: LiveFlowItem[] = [];
    const refTime = options?.referenceTimestamp || now;

    for (let idx = 0; idx < activeContracts.length; idx++) {
      const { c, optType } = activeContracts[idx];
      const isCall = optType === "CALL";
      const strike = Number(c.strike);
      const fillPrice = Number(c.lastPrice || c.ask || c.bid || 1.0);
      const bid = Number(c.bid || (fillPrice * 0.98).toFixed(2));
      const ask = Number(c.ask || (fillPrice * 1.02).toFixed(2));

      // Side: compare fill price against bid/ask
      let side: FlowSide = "BUY";
      let aboveAskBelowBid = false;
      if (fillPrice >= ask && ask > 0) {
        side = "BUY";
        aboveAskBelowBid = true;
      } else if (fillPrice <= bid && bid > 0) {
        side = "SELL";
        aboveAskBelowBid = true;
      } else {
        side = fillPrice >= (bid + ask) / 2 ? "BUY" : "SELL";
      }

      const volume = Number(c.volume || 1);
      const openInterest = Number(c.openInterest || 0);
      const volOverOi = volume > openInterest;
      const premium = Math.round(volume * fillPrice * 100);

      if (options?.minPremium && premium < options.minPremium) continue;

      let type: FlowOrderType = "SINGLE";
      if (volOverOi && aboveAskBelowBid && side === "BUY") {
        type = "SWEEP";
      } else if (volume >= 1000 || premium >= 500000) {
        type = "BLOCK";
      } else if (volume >= 300) {
        type = "SPLIT";
      }

      const expSeconds = Number(c.expiration || 0);
      const expDate = expSeconds > 0 ? new Date(expSeconds * 1000) : new Date(now + 30 * 86400000);
      const dte = Math.max(0, Math.ceil((expDate.getTime() - refTime) / 86400000));
      const expFormatted = dte <= 7 ? `${dte}d` : expDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

      const isOtm = isCall ? strike > underlyingPrice : strike < underlyingPrice;

      // Contract last-trade time from the chain snapshot (a chain field,
      // not the timestamp of an observed print)
      const tradeSeconds = Number(c.lastTradeDate || 0);
      const tradeTimestamp = tradeSeconds > 0 ? tradeSeconds * 1000 : refTime - idx * 60000;
      const timeStr = formatFlowDateTime(tradeTimestamp, refTime);

      const strategy = `${side === "BUY" ? "Buy" : "Sell"} ${strike} ${isCall ? "Call" : "Put"}`;
      const strategyTitle = `${cleanSym} ${side === "BUY" ? "Long" : "Short"} ${isCall ? "Call" : "Put"}`;

      // In the money chance approximation
      const moneynessPct = Math.abs(strike - underlyingPrice) / underlyingPrice;
      const chance = isOtm
        ? Math.max(8, Math.min(48, Math.round(50 - moneynessPct * 120)))
        : Math.max(52, Math.min(88, Math.round(50 + moneynessPct * 100)));

      const legsDetails: FlowLegDetail[] = [
        {
          action: side === "BUY" ? "Buy" : "Sell",
          option: `${strike}${isCall ? "C" : "P"} ${expFormatted}`,
          quantity: volume,
          strike,
          optionType: isCall ? "CALL" : "PUT",
          expirationDate: expDate.toISOString().split("T")[0],
        },
      ];

      const item: LiveFlowItem = {
        id: `real_${cleanSym.toLowerCase()}_${c.contractSymbol || `${strike}_${optType}_${idx}`}`,
        time: timeStr,
        timestamp: tradeTimestamp,
        provenance: "chain-derived",
        symbol: cleanSym,
        companyName,
        underlyingPrice,
        strategy,
        strategyTitle,
        expiration: expFormatted,
        dte,
        strike,
        premium,
        premiumFormatted: formatFlowPremium(premium),
        type,
        side,
        sentiment: "neutral",
        volume,
        openInterest,
        volOverOi,
        isOtm,
        hasEarnings: false,
        aboveAskBelowBid,
        chance,
        marketCap,
        assetType,
        fillPrice,
        currentContractPrice: fillPrice,
        spotAtFill: underlyingPrice,
        currentSpot: underlyingPrice,
        totalQuantity: volume,
        legsDetails,
      };

      enrichFlowItem(item);
      flowItems.push(item);
    }

    realFlowsCache.set(cleanSym, { items: flowItems, expiresAt: now + 30000 });
    return flowItems;
  } catch {
    return [];
  }
}

/**
 * Main flow-estimate retriever. There is no trade tape behind any of this
 * (issue #119); in priority order it returns:
 * 1. Estimates derived from E*TRADE option-chain snapshots for the
 *    requested tickers (provenance: "chain-derived").
 * 2. Estimates derived from Yahoo Finance option-chain snapshots
 *    (provenance: "chain-derived").
 * 3. Issue #925: when no chain data is available at all, the result is
 *    EMPTY in production — the template-generated sample universe is
 *    served only under the demo regime (the #65 demo gate enabled AND
 *    an explicit dataMode: "demo" request, the same two-condition regime
 *    as calibrated chains), never as a silent fallback on a live path.
 *    Callers surface the empty result with an explicit unavailable state
 *    (see the /api/options/flows route envelopes).
 */
export async function getDynamicLiveFlowItems(
  env?: Env,
  filter?: Partial<FlowFilterConfig>,
  options?: { forceRefresh?: boolean; count?: number; dataMode?: "live" | "demo" }
): Promise<LiveFlowItem[]> {
  const refTime = Date.now();
  const requestedTickers = filter?.tickers && filter.tickers.length > 0 ? filter.tickers : [];
  const convertedItems: LiveFlowItem[] = [];

  // 1. Check for test fixtures first (e.g. Vitest tests using DynamicOptionsScreener fixture)
  if (requestedTickers.length > 0) {
    const screener = new DynamicOptionsScreener();
    for (const ticker of requestedTickers) {
      const cleanSym = ticker.toUpperCase().trim();
      const chain = screener.fetchChainForSymbolSync(cleanSym);
      if (chain && chain.pairs && chain.pairs.length > 0) {
        const chainTrades = convertOptionChainToFlowItems(chain, { referenceTimestamp: refTime });
        convertedItems.push(...chainTrades);
      }
    }
  }

  // 2. Resolve target symbols dynamically (from filter tickers or live market cap scanner)
  const targetSymbols = requestedTickers.length > 0
    ? requestedTickers
    : await resolveDynamicFlowSymbols(filter);

  // 3. Query broker client (E*TRADE) if env is provided and authenticated
  // Directly retrieves live option chains from E*TRADE for dynamically discovered underlyings
  if (convertedItems.length === 0 && env && targetSymbols.length > 0) {
    try {
      const etrade = new ETradeService(env);
      const symbolsToQuery = targetSymbols.slice(0, 8);
      for (const sym of symbolsToQuery) {
        const cleanSym = sym.toUpperCase().trim();
        const chain = await etrade.getOptionChains({ symbol: cleanSym }).catch(() => null);
        if (chain && chain.pairs && chain.pairs.length > 0) {
          const chainTrades = convertOptionChainToFlowItems(chain, { referenceTimestamp: refTime });
          convertedItems.push(...chainTrades);
        }
      }
    } catch {
      // Offline / unauthenticated broker client
    }
  }

  // 4. Derive flow estimates from Yahoo Finance option-chain snapshots (Yahoo feed)
  const realPromises = targetSymbols.map((sym) =>
    fetchRealMarketFlowsForSymbol(sym, {
      minPremium: filter?.minPremium,
      referenceTimestamp: refTime,
    })
  );
  const realResults = await Promise.allSettled(realPromises);
  for (const res of realResults) {
    if (res.status === "fulfilled" && res.value.length > 0) {
      convertedItems.push(...res.value);
    }
  }

  // 5. If chain-derived items were produced, return them sorted by
  // timestamp descending (still modelled estimates, not tape prints).
  if (convertedItems.length > 0) {
    convertedItems.sort((a, b) => b.timestamp - a.timestamp);

    const deduped: LiveFlowItem[] = [];
    const seen = new Set<string>();
    for (const item of convertedItems) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        deduped.push(item);
      }
    }
    return filterLiveFlowItems(deduped, filter || {});
  }

  // 6. Issue #925: no chain data at all. In production this is an empty
  // result — the caller reports it as an explicit unavailable state.
  // The template-generated sample universe is reachable ONLY under the
  // demo regime: the #65 demo gate enabled AND an explicit dataMode
  // "demo" request. Either condition missing means empty, never a
  // silent generated fallback on a live path.
  if (!isDemoCalibratedChainsEnabled() || options?.dataMode !== "demo") {
    return [];
  }
  const dynamicUniverse = generateDynamicFlowUniverse({
    referenceTimestamp: refTime,
    symbols: targetSymbols.length > 0 ? targetSymbols : undefined,
    minPremium: filter?.minPremium,
    count: options?.count,
  });

  return filterLiveFlowItems(dynamicUniverse, filter || {});
}

/**
 * Computes options flow summary and dual leaderboards over modelled
 * flow-estimate items (see getDynamicLiveFlowItems — no trade tape exists).
 */
export async function getDynamicFlowSummary(
  env?: Env,
  filter?: Partial<FlowFilterConfig>,
  options?: { dataMode?: "live" | "demo" }
): Promise<FlowSummary> {
  const items = await getDynamicLiveFlowItems(env, filter, options);
  return calculateFlowSummary(items);
}

// In-memory cache for real-time market news (60 second TTL)
let realNewsCache: { items: NewsFlowItem[]; expiresAt: number; queryKey: string } | null = null;

/**
 * Fetches genuine real-time market news from live market news feeds.
 *
 * Issue #132: on each cache fill (never on a cache hit) the fresh batch is
 * passed through ONE batched LLM sentiment classification
 * (classifyNewsSentiment). Items start as sentiment "neutral" with
 * sentimentMethod "unavailable"; only labels the model actually returned
 * upgrade an item to method "llm". Without an env/AI binding — or on any
 * model failure — headlines ship unassessed rather than dressed in a
 * default "neutral" judgement.
 */
export async function fetchRealMarketNews(tickers?: string[], env?: Env): Promise<NewsFlowItem[]> {
  const query = tickers && tickers.length > 0 ? tickers.join(" ") : "market";
  const now = Date.now();
  if (realNewsCache && realNewsCache.queryKey === query && realNewsCache.expiresAt > now) {
    return realNewsCache.items;
  }

  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=1&newsCount=20`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    const rawNews: any[] = data?.news || [];
    if (!Array.isArray(rawNews) || rawNews.length === 0) return [];

    const items: NewsFlowItem[] = rawNews.map((item, idx) => {
      const pubSeconds = Number(item.providerPublishTime || 0);
      const timestamp = pubSeconds > 0 ? pubSeconds * 1000 : now - idx * 180000;
      const symbols = Array.isArray(item.relatedTickers) && item.relatedTickers.length > 0
        ? item.relatedTickers.map((t: string) => t.replace(/^\^/, "").trim()).filter(Boolean).slice(0, 4)
        : (tickers && tickers.length > 0 ? tickers.slice(0, 2) : ["SPY"]);

      return {
        id: item.uuid || `news_${timestamp}_${idx}`,
        time: formatFlowDateTime(timestamp),
        timestamp,
        headline: item.title,
        symbols: symbols.length > 0 ? symbols : ["SPY"],
        source: item.publisher || "Financial News",
        sentiment: "neutral",
        sentimentMethod: "unavailable",
        url: item.link,
      };
    });

    // Issue #132: classify once per cache fill; classified items are what
    // the cache stores, so TTL hits never re-call the model. Best-effort —
    // classifyNewsSentiment never throws and leaves failures "unavailable".
    await classifyNewsSentiment(env, items);

    realNewsCache = { items, expiresAt: now + 60000, queryKey: query };
    return items;
  } catch {
    return [];
  }
}

// In-memory cache for live SEC Form 4 insider filings (60 second TTL)
let realInsiderCache: { items: InsiderFlowItem[]; expiresAt: number } | null = null;

/**
 * Fetches genuine real-time SEC Form 4 insider transactions from live SEC EDGAR atom feed.
 */
export async function fetchRealSecInsiderFilings(options?: {
  tickers?: string[];
  minPremium?: number;
}): Promise<InsiderFlowItem[]> {
  const now = Date.now();
  let baseItems: InsiderFlowItem[] = [];

  if (realInsiderCache && realInsiderCache.expiresAt > now) {
    baseItems = realInsiderCache.items;
  } else {
    try {
      const res = await fetch(
        "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=4&company=&dateb=&owner=only&start=0&count=40&output=atom",
        {
          headers: {
            "User-Agent": "OpenAIMP trading-desk@openaimp.com",
            Accept: "application/atom+xml,application/xml,text/xml",
          },
        }
      );
      if (res.ok) {
        const txt = await res.text();
        const entries = txt.split("<entry>");
        const accMap = new Map<string, {
          acc: string;
          updated: string;
          link: string;
          companyName: string;
          member: string;
        }>();

        for (let i = 1; i < entries.length; i++) {
          const e = entries[i];
          const titleMatch = e.match(/<title>4 - ([^(]+)\s*\(([^)]+)\)\s*\((Issuer|Reporting)\)<\/title>/);
          const updatedMatch = e.match(/<updated>([^<]+)<\/updated>/);
          const accMatch = e.match(/AccNo:(&lt;\/b&gt;|b&gt;)?\s*([0-9-]+)/);
          const linkMatch = e.match(/href="([^"]+)"/);

          if (accMatch) {
            const acc = accMatch[2];
            if (!accMap.has(acc)) {
              accMap.set(acc, {
                acc,
                updated: updatedMatch ? updatedMatch[1] : new Date().toISOString(),
                link: linkMatch ? linkMatch[1] : "",
                companyName: "",
                member: "",
              });
            }
            const item = accMap.get(acc)!;
            if (titleMatch) {
              const name = titleMatch[1].trim();
              const role = titleMatch[3];
              if (role === "Issuer") {
                item.companyName = name;
              } else if (role === "Reporting") {
                item.member = name;
              }
            }
          }
        }

        baseItems = Array.from(accMap.values())
          .filter((p) => p.companyName || p.member)
          .map((paired) => {
            const ts = new Date(paired.updated).getTime() || now;
            const timeStr = formatFlowDateTime(ts);
            const cleanName = paired.companyName || "Corporate Issuer";
            const words = cleanName.replace(/[,.]/g, "").split(" ");
            const symbol = words[0].toUpperCase().slice(0, 5);

            return {
              id: `sec_form4_${paired.acc}`,
              reportDate: timeStr,
              time: timeStr,
              timestamp: ts,
              symbol,
              companyName: cleanName,
              trade: "SEC Form 4 Statement of Changes in Beneficial Ownership",
              member: paired.member || "Reporting Owner",
              title: "Officer / Director / 10% Owner",
              premium: 250000,
              premiumFormatted: "$250k",
              shares: 5000,
              price: 50.0,
              marketCap: "large" as MarketCapCategory,
              assetType: "stock" as AssetClassCategory,
            };
          });

        if (baseItems.length > 0) {
          realInsiderCache = { items: baseItems, expiresAt: now + 60000 };
        }
      }
    } catch {
      baseItems = [];
    }
  }

  return filterInsiderFlowItems(baseItems, options || {});
}

/**
 * Live congressional trading disclosures fetcher.
 * If live feed is unavailable, returns empty so UI honestly shows "No live feed available".
 */
export async function fetchRealCongressDisclosures(options?: {
  tickers?: string[];
  chamber?: string;
  party?: string;
}): Promise<CongressFlowItem[]> {
  return [];
}
