export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  SESSIONS: KVNamespace;
  SEARCH_AGENT: DurableObjectNamespace;
  AI_SEARCH_ENDPOINT: string;
  APP_NAME: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  APP_BASE_URL: string;
  SESSION_SECRET: string;
  MAS_MAX_STEPS?: string;
  AI_MODEL?: string;
  // Payment Gateway Secrets (Stripe, PayPal, Lemon Squeezy)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_ENVIRONMENT?: "sandbox" | "live";
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_STORE_ID?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  // External Payment Service MCP Server Endpoints (Remote MCP over JSON-RPC 2.0 / SSE)
  STRIPE_MCP_SERVER_URL?: string;
  PAYPAL_MCP_SERVER_URL?: string;
  LEMONSQUEEZY_MCP_SERVER_URL?: string;
  EXTERNAL_PAYMENTS_MCP_URL?: string;
  // Externalized Environment Configuration (TEST / PROD)
  APP_ENV?: string;
  ENVIRONMENT?: string;
  // E*TRADE Trading API & Remote MCP Configuration
  ET_API_KEY?: string;
  ET_API_SECRET?: string;
  ET_PROD_API_KEY?: string;
  ET_PROD_API_SECRET?: string;
  ET_SANDBOX_API_KEY?: string;
  ET_SANDBOX_API_SECRET?: string;
  ET_BASE_URL?: string;
  ETRADE_CONSUMER_KEY?: string;
  ETRADE_CONSUMER_SECRET?: string;
  ETRADE_OAUTH_TOKEN?: string;
  ETRADE_OAUTH_TOKEN_SECRET?: string;
  ETRADE_ACCOUNT_ID_KEY?: string;
  ETRADE_ENVIRONMENT?: "sandbox" | "live";
  ETRADE_MCP_SERVER_URL?: string;
  // FOSS Market Data & Research Configuration (yfinance & Alpaca)
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_BASE_URL?: string;
  ALPACA_DATA_URL?: string;
  YFINANCE_API_ENDPOINT?: string;
  FOSS_MARKET_DATA_PROVIDER?: "alpaca" | "yfinance" | "hybrid";
  // Optional / backward-compatible bindings
  KV?: KVNamespace;
  ETRADE_KV?: KVNamespace;
  PAYMENTS_AGENT?: DurableObjectNamespace;
  TASKS_AGENT?: DurableObjectNamespace;
  MEMORY_AGENT?: DurableObjectNamespace;
  RESEARCH_AGENT?: DurableObjectNamespace;
}

export interface TransactionRecord {
  id: string;
  sessionId: string;
  action: "charge" | "refund" | "invoice" | "payout";
  amount: number;
  currency: string;
  customer: string;
  gateway: "stripe" | "paypal" | "lemonsqueezy" | "sandbox";
  gatewayRef?: string;
  status: "draft" | "awaiting_confirmation" | "authorized" | "completed" | "failed" | "rejected";
  checkoutUrl?: string;
  proposerDid: string;
  authorizerDid?: string;
  proofSignature: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionData {
  githubLogin: string;
  githubAvatar: string;
  githubName: string;
  createdAt: number;
}

export type AgentName = "search" | "payments" | "tasks" | "memory" | "general" | "trading" | "research";

export interface AuditEvent {
  id: string;
  sessionId: string;
  type: string;
  agent: AgentName | "judge" | "nlq" | "orchestrator";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  agent: AgentName | "orchestrator";
  createdAt: string;
}

export interface MemoryRecord {
  key: string;
  value: string;
  updatedAt: string;
}

export interface RouteDecision {
  agent: AgentName;
  confidence: number;
  reason: string;
  needsConfirmation: boolean;
}

export interface QualityDecision {
  score: number;
  grounded: boolean;
  safe: boolean;
  issues: string[];
}

export interface ReferralRecord {
  id: string;
  userLogin: string;
  title: string;
  url: string;
  category: string;
  rewardText: string;
  clicks: number;
  signups: number;
  createdAt: string;
}

export interface AdRecord {
  id: string;
  title: string;
  tagline: string;
  sponsor: string;
  badge: string;
  url: string;
  ctaText: string;
  accentColor: string;
  impressions: number;
  clicks: number;
  createdAt: string;
}

export interface CategoryRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAdRecord {
  id: string;
  name: string;
  network: "direct" | "ethicalads" | "carbon" | "adsense" | "google";
  placement: "header_leaderboard" | "in_stream" | "footer_deck" | "sidebar";
  title: string;
  tagline: string;
  ctaText: string;
  targetUrl: string;
  bannerImageUrl?: string;
  cpmRate: number;
  cpcRate: number;
  impressions: number;
  clicks: number;
  earnings: number;
  isActive: boolean;
  createdAt: string;
}

export interface RevenueSummary {
  grossRevenue: number;
  adNetworkRevenue: number;
  marketplaceRevenue: number;
  paymentPlatformFees: number;
  referralPayouts: number;
  netRevenue: number;
  totalImpressions: number;
  totalAdClicks: number;
  averageRPM: number;
}

// ==========================================
// E*TRADE Trading & Screening Domain Models
// ==========================================

export interface TradeRecord {
  id: string;
  sessionId: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  quantity: number;
  price: number;
  totalValue: number;
  status: "draft" | "previewed" | "submitted" | "executed" | "rejected" | "cancelled";
  orderRef?: string;
  proposerDid: string;
  authorizerDid?: string;
  proofSignature: string;
  previewNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ETradeQuote {
  symbol: string;
  companyName: string;
  lastPrice: number;
  price?: number;
  change: number;
  changePercent: number;
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  previousClose?: number;
  peRatio?: number;
  marketCap?: number;
  week52High: number;
  week52Low: number;
  high52?: number;
  low52?: number;
  rsi?: number;
  sector?: string;
  source?: string;
  quoteStatus?: string;
  dateTime?: string;
  timestamp: string;
}

export interface StockScreenerFilter {
  sector?: string;
  minMarketCap?: number; // in billions or absolute
  maxPeRatio?: number;
  maxRsi?: number;
  minRsi?: number;
  gainersOnly?: boolean;
  losersOnly?: boolean;
  rsiFilter?: "oversold" | "overbought" | "neutral" | "any";
  momentum?: "bullish_breakout" | "bearish_pullback" | "high_relative_volume" | "any";
  gainersLosers?: "gainers" | "losers" | "active" | "all";
  minVolume?: number;
  search?: string;
  limit?: number;
}

export interface StockScreenRejection {
  symbol: string;
  reason: string;
  changePercent?: number;
  price?: number;
  rsi?: number;
}

export interface StockScreenLedger {
  universeSymbols: string[];
  totalEvaluated: number;
  passedCount: number;
  rejectedCount: number;
  rejections: StockScreenRejection[];
}

export interface ScreenedStockItem extends ETradeQuote {
  price: number;
  rsi14: number;
  macdSignal: string;
  signal: "BULLISH_MOMENTUM" | "OVERSOLD_BOUNCE" | "RANGE_BOUND" | "OVERBOUGHT";
  technicalSignal: string;
  momentumScore: number;
  highlightReason: string;
  previousClose?: number;
  changePeriod?: string;
  rsiLookback?: string;
  macdIndicatorVersion?: string;
  validationStatus?: "PASS_CONFIRMED" | "FAIL_MISMATCH" | "UNVERIFIED";
}

export interface StockScreenResult {
  totalScanned: number;
  totalScreened: number;
  matchedCount: number;
  filterApplied: StockScreenerFilter;
  filterSummary: string;
  stocks: ScreenedStockItem[];
  scannedAt: string;
  status?: "matches_found" | "no_matches" | "SCAN_INVALID_DATA_MISMATCH" | "no_universe";
  ledger?: StockScreenLedger;
  validationError?: string;
}

export interface ETradeOrderDraft {
  orderId: string;
  previewId?: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderAction: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  quantity: number;
  estimatedPrice: number;
  limitPrice?: number;
  stopPrice?: number;
  term: "GOOD_FOR_DAY" | "GOOD_UNTIL_CANCEL";
  estimatedCommission: number;
  estimatedTotal: number;
  status: "draft" | "previewed" | "submitted" | "executed" | "rejected" | "cancelled";
  proposerDid: string;
  authorizerDid: string;
  proofSignature: string;
  previewMessage: string;
  safetyNotice?: string;
  placedAt?: string;
}

export interface ETradeOrderExecutionResult {
  success: boolean;
  orderId: string;
  executionId: string;
  brokerOrderRef: string;
  authorizerDid?: string;
  status: "executed" | "submitted" | "rejected" | "failed";
  symbol: string;
  action: string;
  quantity: number;
  executionPrice: number;
  totalSettled: number;
  didAttestation?: {
    proposerDid: string;
    authorizerDid: string;
    signature: string;
  };
  message: string;
  timestamp: string;
}

export interface ETradePosition {
  symbol: string;
  description: string;
  quantity: number;
  pricePaid: number;
  costBasis: number;
  currentPrice: number;
  marketPrice: number;
  marketValue: number;
  totalGain: number;
  unrealizedGainLoss: number;
  totalGainPercent: number;
  unrealizedGainLossPercent: number;
  daysGain: number;
  daysGainPercent: number;
}

export interface ETradeAccount {
  accountId: string;
  accountKey: string;
  accountIdKey?: string;
  accountDesc: string;
  accountName?: string;
  accountType: string;
  accountMode?: string;
  accountStatus?: string;
  institutionType?: string;
  shareWorksAccount?: boolean;
  fcCheckMkt?: boolean;
  lineOfCredit?: boolean;
  openDate?: number;
  closedDate?: number;
  netAccountValue: number;
  totalAccountValue: number;
  cashAvailableForInvestment: number;
  marginBuyingPower?: number;
  dayTraderStatus: boolean;
}

export interface ETradePositionLot {
  positionId?: number | string;
  positionLotId?: number | string;
  price?: number;
  termCode?: number;
  daysGain?: number;
  daysGainPct?: number;
  marketValue?: number;
  totalCost?: number;
  totalCostForGainPct?: number;
  totalGain?: number;
  totalGainPct?: number;
  lotSourceCode?: number;
  originalQty?: number;
  remainingQty?: number;
  availableQty?: number;
  orderNo?: number;
  legNo?: number;
  acquiredDate?: number;
  locationCode?: number;
  exchangeRate?: number;
  settlementCurrency?: string;
  paymentCurrency?: string;
  adjPrice?: number;
  commPerShare?: number;
  feesPerShare?: number;
  adjustedPrice?: number;
}

export interface ETradeBrokerStatus {
  broker: "etrade";
  name: string;
  configured: boolean;
  mode: "live_oauth" | "sandbox_api" | "mcp_remote" | "simulated_engine";
  protocol: "mcp_json_rpc" | "etrade_oauth_rest" | "sandbox_simulated";
  mcpServerUrl?: string;
  environment: "sandbox" | "live";
  activeEnvironment?: "TEST" | "PROD" | string;
  apiUrl?: string;
  hasApiKey?: boolean;
  oauthAuthenticated?: boolean;
  oauthExpiresAtEt?: string;
  oauthRenewable?: boolean;
  capabilities: string[];
}

export interface FossQuote {
  symbol: string;
  provider: "yfinance" | "alpaca" | "hybrid";
  companyName?: string;
  price: number;
  lastPrice?: number;
  change: number;
  changePercent: number;
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  vwap?: number;
  trailingPE?: number;
  marketCap?: number;
  rsi14?: number;
  macdSignal?: string;
  timestamp: string;
  currency?: string;
}

export interface FossHistoricalBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  tradeCount?: number;
}

export interface FossCompanyFundamentals {
  symbol: string;
  companyName: string;
  sector: string;
  industry: string;
  description: string;
  marketCap: number;
  enterpriseValue?: number;
  peTrailing?: number;
  peForward?: number;
  pegRatio?: number;
  priceToBook?: number;
  beta?: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  targetMeanPrice?: number;
  targetHighPrice?: number;
  targetLowPrice?: number;
  recommendationKey?: "strong_buy" | "buy" | "hold" | "underperform" | "sell";
  recommendationMean?: number;
  numberOfAnalystOpinions?: number;
  dividendYield?: number;
  profitMargins?: number;
  operatingMargins?: number;
  returnOnEquity?: number;
  revenue?: number;
  grossProfits?: number;
  ebitda?: number;
  freeCashflow?: number;
}

export interface AlpacaMarketSnapshot {
  symbol: string;
  assetClass: "us_equity" | "crypto";
  latestTrade: {
    price: number;
    size: number;
    timestamp: string;
  };
  latestQuote: {
    bidPrice: number;
    bidSize: number;
    askPrice: number;
    askSize: number;
    timestamp: string;
  };
  nbboSpread?: number;
  dailyBar: FossHistoricalBar;
  prevDailyBar: FossHistoricalBar;
  minuteBar?: FossHistoricalBar;
}

export interface FossResearchReport {
  symbol: string;
  provider: "yfinance" | "alpaca" | "hybrid";
  quote: FossQuote;
  fundamentals: FossCompanyFundamentals;
  bars: FossHistoricalBar[];
  technicalSummary: {
    rsi14: number;
    macd: string;
    trend50vs200SMA: string;
    support: number;
    resistance: number;
  };
  aiAnalysis: string;
  analystRating: string;
  agentAttestation: {
    did: string;
    signature: string;
    timestamp: string;
  };
}

export interface FossProviderStatus {
  provider: "yfinance" | "alpaca" | "hybrid";
  name: string;
  configured: boolean;
  mode: "live_api" | "foss_open_data" | "simulated_engine";
  capabilities: string[];
}

// =========================================================================
// Official E*TRADE API Models & Endpoints Contracts (Full Specification)
// =========================================================================

export interface ETradeTransaction {
  transactionId: string;
  accountId: string;
  transactionDate: number;
  postDate?: number;
  amount: number;
  description: string;
  transactionType: string;
  memo?: string;
  imageFlag?: boolean;
  instType?: string;
  detailsURI?: string;
}

export interface ETradeTransactionDetails {
  transactionId: string;
  accountId: string;
  transactionDate: number;
  amount: number;
  description: string;
  category?: {
    categoryId: string;
    categoryName: string;
    parentName?: string;
  };
  brokerage?: {
    product?: {
      symbol: string;
      securityType: string;
    };
    quantity?: number;
    price?: number;
    settlementDate?: number;
    fee?: number;
    memo?: string;
  };
}

export interface ETradeAlert {
  id: number | string;
  createTime: number;
  subject: string;
  status: "READ" | "UNREAD" | "DELETED";
  msgText?: string;
  readTime?: number;
  deleteTime?: number;
}

export interface ETradeAlertDetails {
  id: number | string;
  createTime: number;
  subject: string;
  msgText: string;
  readTime?: number;
  deleteTime?: number;
  symbol?: string;
  next?: string;
  prev?: string;
}

export interface ETradeProductLookup {
  symbol: string;
  description: string;
  type: string;
}

export interface ETradeOptionChainContract {
  optionCategory?: string;
  optionRootSymbol?: string;
  timeStamp?: number;
  adjustedFlag?: boolean;
  displaySymbol?: string;
  optionType: "CALL" | "PUT";
  strikePrice: number;
  symbol: string;
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
  lastPrice: number;
  volume?: number;
  openInterest?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  impliedVolatility?: number;
}

export interface ETradeOptionChain {
  symbol: string;
  underlyingPrice: number;
  selectedExpiry?: {
    year: number;
    month: number;
    day: number;
  };
  pairs: Array<{
    call?: ETradeOptionChainContract;
    put?: ETradeOptionChainContract;
  }>;
}

export interface ETradeOptionExpireDate {
  year: number;
  month: number;
  day: number;
  expiryType?: string;
}

export interface ETradeRemoteOrder {
  orderId: number | string;
  details?: string;
  orderType: string;
  orderValue?: number;
  status: "OPEN" | "EXECUTED" | "CANCELLED" | "INDIVIDUAL_FILLS" | "REJECTED";
  placedTime?: number;
  executedTime?: number;
  orderTerm?: string;
  priceType?: string;
  limitPrice?: number;
  stopPrice?: number;
  orderAction?: string;
  quantity?: number;
  symbol?: string;
}

export interface ETradeCancelOrderResult {
  success: boolean;
  orderId: string;
  message: string;
  timestamp: string;
}


