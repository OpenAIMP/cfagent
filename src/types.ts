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
  ALPACA_API_KEY?: string;
  ALPACA_SECRET_KEY?: string;
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_BASE_URL?: string;
  ALPACA_DATA_URL?: string;
  YFINANCE_API_ENDPOINT?: string;
  FOSS_MARKET_DATA_PROVIDER?: "alpaca" | "yfinance" | "hybrid";
  // Cloudflare Email Service & Email Agent Configuration
  EMAIL?: any;
  EMAIL_SECRET?: string;
  EMAIL_AGENT_ADDRESS?: string;
  // Cloudflare Slack Agent Configuration
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  // Cloudflare Voice Agent Configuration
  DEEPGRAM_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  VOICE_AGENT_MODEL?: string;
  // Cloudflare Agentic Payments (x402 & Machine Payments Protocol - MPP)
  X402_NETWORK?: string;
  X402_RECIPIENT_ADDRESS?: string;
  X402_FACILITATOR_URL?: string;
  X402_AUTO_APPROVE_LIMIT?: string;
  X402_AGENT_WALLET_KEY?: string;
  MPP_SECRET_KEY?: string;
  // Cloudflare Wallets — native paidTool / withX402 binding for OptionsScannerMCP
  // https://blog.cloudflare.com/wallets/
  CF_WALLET_RECIPIENT?: string;    // 0x... USDC recipient address
  CF_WALLET_NETWORK?: string;      // "base-sepolia" (test) | "base" (prod)
  CF_WALLET_FACILITATOR?: string;  // https://x402.org/facilitator (default)
  // Cloudflare Browser Rendering & Puppeteer
  BROWSER?: Fetcher;
  // Webhooks Configuration (TradingView, E*TRADE Alerts, Outbound)
  TRADINGVIEW_WEBHOOK_SECRET?: string;
  ETRADE_WEBHOOK_SECRET?: string;
  OUTBOUND_WEBHOOK_URL?: string;
  OUTBOUND_WEBHOOK_SECRET?: string;
  // Cloudflare Vectorize & AI Search
  VECTORIZE?: any;
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
  action: "charge" | "refund" | "invoice" | "payout" | "micropayment" | "agentic_payment";
  amount: number;
  currency: string;
  customer: string;
  gateway: "stripe" | "paypal" | "lemonsqueezy" | "sandbox" | "x402" | "mpp";
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

export type AgentName = "search" | "payments" | "tasks" | "memory" | "general" | "trading" | "research" | "browser" | "sandbox" | "think" | "webhook" | "broker_webhook" | "durable_execution";

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
  status: "draft" | "previewed" | "submitted" | "executed" | "rejected" | "cancelled" | "expired";
  orderRef?: string;
  proposerDid: string;
  authorizerDid?: string;
  proofSignature: string;
  previewNotes?: string;
  expirationScheduleId?: string;
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
  averageVolume?: number;
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
  rsi14?: number;
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
  discovery?: {
    mode: "search" | "market_movers_and_watchlists";
    candidateCount: number;
    quoteCount: number;
    sourceCounts: Record<string, number>;
    message: string;
    error?: string;
  };
}

// =========================================================================
// Dynamic Options Screener Engine Types
// =========================================================================

export interface OptionScreenerFilter {
  underlyingSymbols?: string[];
  sector?: string;
  contractType?: "CALL" | "PUT" | "BOTH";
  minVolume?: number;
  minOpenInterest?: number;
  maxSpreadPct?: number;
  maxQuoteAgeSeconds?: number;
  minDelta?: number;
  maxDelta?: number;
  minGamma?: number;
  maxGamma?: number;
  minTheta?: number;
  maxTheta?: number;
  minImpliedVolatility?: number; // decimal e.g. 0.35 = 35%
  maxImpliedVolatility?: number; // decimal e.g. 1.20 = 120%
  minDte?: number; // Days to expiration min
  maxDte?: number; // Days to expiration max
  moneyness?: "ITM" | "OTM" | "ATM" | "ALL";
  maxStrikeDistancePct?: number; // e.g. 10 for strikes within 10% of underlying price
  limit?: number;
}

export interface ScreenedOptionContractItem extends ETradeOptionChainContract {
  underlyingSymbol: string;
  underlyingPrice: number;
  daysToExpiration: number;
  expirationDate: string; // YYYY-MM-DD
  moneyness: "ITM" | "OTM" | "ATM";
  strikeDistancePct: number;
  spreadPct: number;
  quoteAgeSeconds?: number;
  quoteTimestamp?: string;
  quoteFreshness?: "FRESH" | "STALE" | "UNKNOWN";
  volumeOiRatio?: number;
  ivRankEstimated?: number;
  technicalSignal: string;
  highlightReason: string;
  validationStatus?: "PASS_CONFIRMED" | "FAIL_MISMATCH";
}

export interface OptionScreenRejection {
  contractSymbol: string;
  underlyingSymbol: string;
  reason: string;
  strikePrice?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  iv?: number;
  volume?: number;
  daysToExpiration?: number;
  spreadPct?: number;
  quoteAgeSeconds?: number;
}

export interface OptionScreenResult {
  totalUnderlyingsScanned: number;
  totalContractsEvaluated: number;
  matchedCount: number;
  filterApplied: OptionScreenerFilter;
  filterSummary: string;
  contracts: ScreenedOptionContractItem[];
  scannedAt: string;
  quoteQuality?: {
    maxAgeSeconds?: number;
    staleContractsReturned: number;
    unknownFreshnessContracts: number;
    freshestStaleQuoteAgeSeconds?: number;
  };
  status: "matches_found" | "no_matches" | "error";
  rejections?: OptionScreenRejection[];
}

// =========================================================================
// E*TRADE Watchlist Models & Persistence Types
// =========================================================================

export interface ETradeWatchlistItem {
  symbol: string;
  ordered?: number;
  price?: number;
  change?: number;
  changePercent?: number;
  volume?: number;
  companyName?: string;
  sector?: string;
  addedAt?: string;
}

export interface ETradeWatchlist {
  watchlistId: string | number;
  name: string;
  symbols: string[];
  items?: ETradeWatchlistItem[];
  createdTimestamp?: number;
  updatedTimestamp?: number;
  source?: "etrade_api" | "local_durable_sqlite";
}

export interface SaveWatchlistResult {
  success: boolean;
  watchlistId: string | number;
  name: string;
  symbolCount: number;
  symbols: string[];
  source: "etrade_api" | "local_durable_sqlite";
  message: string;
  timestamp: string;
}

export interface WatchlistRecord {
  id: string;
  name: string;
  userLogin: string;
  symbolsJson: string; // JSON string array of ticker symbols
  itemsJson?: string; // Optional detailed cached quote metadata
  source: string;
  createdAt: string;
  updatedAt: string;
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
  status: "draft" | "previewed" | "submitted" | "executed" | "rejected" | "cancelled" | "expired";
  proposerDid: string;
  authorizerDid: string;
  proofSignature: string;
  previewMessage: string;
  previewNotes?: string;
  safetyNotice?: string;
  expirationScheduleId?: string;
  expiresAt?: string;
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

// --- Omnichannel Trading Agent Communication Channels (Email & Slack) ---

export interface InboundEmailPayload {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  messageId?: string;
}

export interface EmailTradingResult {
  success: boolean;
  actionType: "quote" | "screener" | "preview" | "approval" | "rejection" | "portfolio" | "general" | "error";
  from: string;
  to: string;
  responseSubject: string;
  responseHtml: string;
  responseText: string;
  orderId?: string;
  orderStatus?: string;
  proposerDid: string;
  authorizerDid?: string;
  timestamp: string;
}

export interface SlackBlockKitPayload {
  channel?: string;
  text: string;
  blocks?: any[];
  thread_ts?: string;
  replace_original?: boolean;
}

export interface SlackEventResult {
  handled: boolean;
  actionType: "quote" | "screener" | "preview" | "approval" | "rejection" | "portfolio" | "general" | "challenge" | "ignored";
  response?: SlackBlockKitPayload;
  orderId?: string;
  challenge?: string;
  proposerDid?: string;
  authorizerDid?: string;
  timestamp: string;
}

export interface SlackInteractionResult {
  success: boolean;
  actionId: string;
  orderId?: string;
  status: "executed" | "rejected" | "error";
  message: string;
  replacementBlocks?: any[];
  proposerDid?: string;
  authorizerDid?: string;
  timestamp: string;
}

// --- Cloudflare Voice Trading Agent Domain Models ---

export interface VoiceTranscriptMessage {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: string;
  actionType?: string;
  orderId?: string;
  tradeDraft?: ETradeOrderDraft;
}

export interface VoiceTradingTurnRequest {
  transcript?: string;
  rawTranscript?: string;
  audioBase64?: string;
  audioFormat?: "pcm16" | "wav" | "mp3" | "opus";
  sampleRate?: number;
  sessionId?: string;
  userLogin?: string;
}

export interface VoiceTradingTurnResponse {
  success: boolean;
  spokenText: string;
  displayMarkdown: string;
  actionType: "quote" | "screener" | "options_screener" | "watchlist" | "preview" | "approval" | "rejection" | "portfolio" | "schedule" | "agentic_payment" | "general" | "error";
  orderId?: string;
  orderDraft?: ETradeOrderDraft;
  orderStatus?: "previewed" | "executed" | "rejected" | "not_found";
  brokerOrderRef?: string;
  marketQuote?: ETradeQuote;
  screenedStocks?: ScreenedStockItem[];
  audioBase64?: string;
  audioFormat?: string;
  metrics?: {
    sttMs?: number;
    llmMs?: number;
    ttsMs?: number;
  };
  proposerDid: string;
  authorizerDid?: string;
  timestamp: string;
}

export interface VoiceSessionState {
  status: "idle" | "listening" | "thinking" | "speaking";
  transcript: VoiceTranscriptMessage[];
  interimTranscript: string | null;
  audioLevel: number;
  isMuted: boolean;
  connected: boolean;
}

// ==========================================
// Cloudflare Agents Task Scheduling Models
// ==========================================

export type ScheduleExecutionType = "scheduled" | "delayed" | "cron" | "interval";

export interface AgentScheduleItem {
  id: string;
  callback: string;
  type: ScheduleExecutionType;
  time?: number;
  cron?: string;
  delayInSeconds?: number;
  intervalSeconds?: number;
  payload?: any;
}

export interface ScheduledTaskPayload {
  taskType: "etrade_token_renewal" | "market_screen" | "order_expiration" | "reminder" | string;
  userLogin?: string;
  orderId?: string;
  reminderId?: string;
  message?: string;
  sector?: string;
  environment?: string;
  maxItems?: number;
  broadcast?: boolean;
  [key: string]: unknown;
}

export interface ScheduledTaskResult<T = unknown> {
  success: boolean;
  taskType: string;
  data?: T;
  error?: string;
  timestamp: string;
}

// ==========================================
// Cloudflare Agentic Payments (x402 & MPP)
// ==========================================

export type AgenticPaymentProtocol = "x402" | "mpp";

export interface X402PaymentChallenge {
  version: string;
  network: "base" | "base-sepolia" | "ethereum" | "solana" | string;
  recipient: string;
  amount: number;
  currency: "USDC" | "USD" | string;
  facilitator: string;
  description: string;
  resource: string;
  nonce: string;
  expiresAt: number;
}

export interface X402PaymentProof {
  signature: string;
  payer: string;
  txHash?: string;
  nonce: string;
  timestamp: number;
  facilitatorToken?: string;
}

export interface MppChallenge {
  protocol: "mpp";
  method: "tempo" | "card" | "stablecoin" | string;
  amount: string;
  currency: string;
  recipient: string;
  description: string;
  realm?: string;
  testnet?: boolean;
}

export interface MppPaymentProof {
  authorization: string;
  method: string;
  payer: string;
  receipt?: string;
}

export interface AgenticPaymentReceipt {
  receiptId: string;
  protocol: AgenticPaymentProtocol;
  resource: string;
  amount: number;
  currency: string;
  network: string;
  payer: string;
  recipient: string;
  status: "paid" | "verified" | "failed";
  txHash?: string;
  signature?: string;
  timestamp: string;
  proposerDid: string;
  authorizerDid?: string;
  note?: string;
}

export interface AgenticWalletStatus {
  walletAddress: string;
  network: string;
  balanceUSD: number;
  autoApproveLimitUSD: number;
  facilitatorUrl: string;
  protocol: "x402" | "mpp" | "hybrid";
  totalSpentUSD: number;
  totalEarnedUSD: number;
  transactionCount: number;
}

export interface AgenticPaymentConfig {
  network?: string;
  recipient?: string;
  facilitatorUrl?: string;
  autoApproveLimitUSD?: number;
  walletKey?: string;
  mppSecretKey?: string;
}

export interface PaidTradingServiceTier {
  id: string;
  resource: string;
  name: string;
  description: string;
  priceUSD: number;
  rateLimitPerMin?: number;
}

export type PaymentRequiredCallback = (challenge: X402PaymentChallenge | MppChallenge) => Promise<boolean>;

// =========================================================================
// 1. Cloudflare Browser Agent & Rendering Models
// =========================================================================

export interface BrowserInspectOptions {
  url: string;
  selector?: string;
  waitForTimeoutMs?: number;
  screenshot?: boolean;
}

export interface BrowserInspectResult {
  success: boolean;
  url: string;
  title?: string;
  text?: string;
  tables?: Array<Array<string>>;
  screenshotBase64?: string;
  error?: string;
  timestamp: string;
}

// =========================================================================
// 2. Trading Webhook Channels (TradingView, E*TRADE, Generic)
// =========================================================================

export interface TradingViewWebhookPayload {
  ticker: string;
  action: "BUY" | "SELL";
  orderType?: "MARKET" | "LIMIT";
  quantity: number;
  price?: number;
  strategyName?: string;
  alertMessage?: string;
  passphrase?: string;
  timestamp?: string;
}

export interface ETradeWebhookPayload {
  eventType: "ORDER_FILLED" | "ORDER_CANCELLED" | "ORDER_REJECTED" | "ACCOUNT_UPDATE";
  orderId?: string;
  symbol?: string;
  filledQuantity?: number;
  avgPrice?: number;
  accountId?: string;
  timestamp: string;
}

export interface TradingWebhookEvent {
  id: string;
  provider: "tradingview" | "etrade" | "stripe" | "generic";
  eventType: string;
  payload: any;
  signature?: string;
  status: "received" | "processed" | "failed" | "rejected";
  receivedAt: string;
  processedAt?: string;
  orderRef?: string;
}

export interface OutboundWebhookConfig {
  url: string;
  secret?: string;
  events: string[];
  enabled: boolean;
}

// =========================================================================
// 3. Cloudflare Sandbox (Containers & Quantitative Code Execution)
// =========================================================================

export interface SandboxExecutionRequest {
  command: string;
  timeoutMs?: number;
  envVars?: Record<string, string>;
  workingDir?: string;
}

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface QuantBacktestRequest {
  symbol: string;
  strategy: "sma_crossover" | "rsi_reversal" | "mean_reversion" | "breakout";
  startBars?: number;
  params?: Record<string, number>;
}

export interface QuantBacktestResult {
  symbol: string;
  strategy: string;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  netReturnPct: number;
  codeExecuted: string;
  logs: string;
}

// =========================================================================
// 4. Think Harness for Deep Trade Validation
// =========================================================================

export type ThinkValidationPhase =
  | "market_condition"
  | "risk_limits"
  | "regulatory_rules"
  | "execution_feasibility"
  | "attestation";

export interface ThinkStepLog {
  phase: ThinkValidationPhase;
  status: "PASS" | "WARN" | "FAIL";
  reasoning: string;
  metricName?: string;
  metricValue?: any;
  threshold?: any;
}

export interface ThinkTradeValidationResult {
  approved: boolean;
  overallConfidence: number;
  recommendation: "PROCEED_TO_HITL" | "REVISE_PARAMETERS" | "REJECT_RISK_LIMIT";
  steps: ThinkStepLog[];
  proposedDraft?: any;
  reason: string;
  attestationDid: string;
  timestamp: string;
}

// =========================================================================
// 5. Durable Execution & Fibers
// =========================================================================

export interface FiberExecutionRecord {
  fiberId: string;
  name: string;
  status: "running" | "completed" | "failed" | "recovered";
  currentStep: number;
  totalSteps: number;
  stashedData: Record<string, any>;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export interface TWAPOrderConfig {
  symbol: string;
  action: "BUY" | "SELL";
  totalQuantity: number;
  slices: number;
  intervalSeconds: number;
  maxPrice?: number;
}



