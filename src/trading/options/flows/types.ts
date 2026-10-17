/**
 * Provenance of an options flow item (issue #119, audit F17).
 *
 * There is NO live trade-tape / print source anywhere in this product, so no
 * flow item may ever claim to be an executed print. Every item is modelled:
 * - "chain-derived": computed from a real option-chain snapshot (contract
 *   volume, open interest, last price). The chain fields are real, but the
 *   trade side, size, premium and timing are modelled estimates.
 * - "static": a row from the built-in static fixture table
 *   (RAW_LIVE_FLOW_ITEMS) — seed/demo data, not market data.
 * - "generated": a template-generated sample item
 *   (generateDynamicFlowUniverse), produced when no chain data is available.
 */
export type FlowItemProvenance = "chain-derived" | "static" | "generated";

export interface FlowProvenanceSummary {
  /** Distinct provenance values present in the item set. */
  provenances: FlowItemProvenance[];
  /** Item count per provenance value. */
  counts: Record<FlowItemProvenance, number>;
  /** Always true: this product has no trade tape, so all flow is modelled. */
  isModelled: true;
  /** Plain-language disclosure of what the flow data is and is not. */
  notice: string;
}

export type FlowOrderType = "SWEEP" | "SPLIT" | "BLOCK" | "SINGLE";
export type FlowSide = "BUY" | "SELL";
export type FlowOptionType = "calls" | "puts" | "spreads";
export type FlowSentiment = "bullish" | "bearish" | "neutral";
export type MarketCapCategory = "small" | "mid" | "large";
export type AssetClassCategory = "stock" | "etf";

export interface FlowLegDetail {
  action: "Buy" | "Sell";
  option: string;
  quantity: number;
  strike?: number;
  optionType?: "CALL" | "PUT";
  expirationDate?: string;
}

export interface LiveFlowItem {
  id: string;
  time: string;
  timestamp: number;
  /**
   * Where this item actually came from (issue #119). Required so no
   * producer can emit an unlabelled item: nothing in this service is a
   * real executed print — see FlowItemProvenance.
   */
  provenance: FlowItemProvenance;
  symbol: string;
  companyName?: string;
  underlyingPrice: number;
  strategy: string;
  strategyTitle?: string;
  expiration: string;
  dte: number;
  strike: number | string;
  premium: number;
  premiumFormatted: string;
  type: FlowOrderType;
  side: FlowSide;
  sentiment: FlowSentiment;
  volume: number;
  openInterest: number;
  volOverOi: boolean;
  isOtm: boolean;
  hasEarnings: boolean;
  abnormalActivity?: boolean;
  aboveAskBelowBid?: boolean;
  chance: number;
  isLocked?: boolean;
  marketCap: MarketCapCategory;
  assetType: AssetClassCategory;

  // Detailed trade breakdown (Screenshot 3 & 4)
  legsDetails?: FlowLegDetail[];
  totalQuantity?: number;
  isCredit?: boolean;
  creditOrDebitText?: "CREDIT" | "DEBIT";
  fillPrice?: number;
  currentContractPrice?: number;
  spotAtFill?: number;
  currentSpot?: number;
  flowTypeCategory?: "Single" | "Sweep" | "Split" | "Block";
  performanceNow?: string;
  performanceHigh?: string;
  performanceLow?: string;
  calculationText?: string;
  returnSinceFillText?: string;
  sentimentReasoning?: string;
  confidenceScore?: number;
}

export interface EvaluatedFlowSentiment {
  sentiment: FlowSentiment;
  confidence: number;
  reasoning: string;
}

export interface NewsFlowItem {
  id: string;
  time: string;
  timestamp: number;
  headline: string;
  symbols: string[];
  source: string;
  sentiment: FlowSentiment;
  url?: string;
  isLocked?: boolean;
}

export interface InsiderFlowItem {
  id: string;
  reportDate: string;
  time: string;
  timestamp: number;
  symbol: string;
  companyName: string;
  trade: string;
  member: string;
  title: string;
  premium: number;
  premiumFormatted: string;
  shares: number;
  price: number;
  marketCap: MarketCapCategory;
  assetType: AssetClassCategory;
  isLocked?: boolean;
}

export interface CongressFlowItem {
  id: string;
  filingDate: string;
  transactionDate: string;
  time: string;
  timestamp: number;
  politician: string;
  chamber: "Senate" | "House";
  party: "Democrat" | "Republican" | "Independent";
  state: string;
  symbol: string;
  assetDescription: string;
  transaction: "Purchase" | "Sale" | "Option Exercise" | "Exchange";
  amountRange: string;
  estimatedPremium: number;
  estimatedPremiumFormatted: string;
  isLocked?: boolean;
}

export interface FlowLeaderboardItem {
  symbol: string;
  tradeCount: number;
  premiumFormatted: string;
  premiumRaw: number;
  pctWidth: number;
}

export interface FlowSummary {
  /** Provenance of the items this summary was computed over (issue #119). */
  provenance: FlowProvenanceSummary;
  totalTrades: number;
  totalPremium: number;
  callPremium: number;
  putPremium: number;
  bullishSentimentRatio: number; // 0 to 100
  sweepCount: number;
  blockCount: number;
  topBullishSymbols: Array<{ symbol: string; callPremium: number; tradeCount: number }>;
  topBearishSymbols: Array<{ symbol: string; putPremium: number; tradeCount: number }>;
  bullishLeaderboard: FlowLeaderboardItem[];
  bearishLeaderboard: FlowLeaderboardItem[];
  largestTrades: LiveFlowItem[];
}

export interface FlowFilterConfig {
  tickers: string[];
  minPremium: number;
  maxDte: number; // 9999 = all
  sentiments: FlowSentiment[];
  sides: FlowSide[];
  orderTypes: FlowOrderType[];
  assetTypes: AssetClassCategory[];
  marketCaps: MarketCapCategory[];
  contractTypes: FlowOptionType[];
  isOtmOnly: boolean;
  volOverOiOnly: boolean;
  upcomingEarningsOnly: boolean;
  aboveAskBelowBidOnly: boolean;
  priceOperator: "less_than" | "greater_than";
  priceValue: number | null;
  chanceOperator: "less_than" | "greater_than";
  chanceValue: number | null;
  insiderNames: string[];
  congressChamber: "all" | "Senate" | "House";
  congressParty: "all" | "Democrat" | "Republican";
}

export interface SavedFilterPreset {
  id: string;
  name: string;
  tagline: string;
  color: "orange" | "cyan" | "magenta" | "yellow" | "purple" | "green";
  tags: string[];
  config: Partial<FlowFilterConfig>;
}
