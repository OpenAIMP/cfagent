export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  // Issue #605: R2 bucket for report PDF blobs. Optional so the #605 code is
  // safe to merge before the bucket is provisioned (falls back to DO storage).
  REPORTS_BUCKET?: R2Bucket;
  // Issue #329/#604: session + credential store — the SessionStore Durable
  // Object. Sessions, tokens and API keys live here, not in Workers KV
  // (legacy KV fallback removed in #604; the leftover KV bindings in
  // wrangler.jsonc are #606).
  SESSION_STORE?: DurableObjectNamespace;
  SEARCH_AGENT: DurableObjectNamespace;
  // PR #3 — x402 PaymentsAgent DO (issue #161)
  PAYMENTS_AGENT: DurableObjectNamespace;
  // PR #4 — ScheduledAgent DO (issue #166)
  SCHEDULED_AGENT: DurableObjectNamespace;
  // Issue #261 — ScreenerAgent DO (one agent, one UI, E*TRADE-only)
  SCREENER_AGENT: DurableObjectNamespace;
  // PR #6 — Vectorize binding for VectorMemory (issue #164)
  VECTOR_MEMORY: any; // Vectorize binding (type varies by workers-types version)
  AI_SEARCH_ENDPOINT: string;
  APP_NAME: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  // #945 Google-as-plugin — Google OAuth client credentials. Optional:
  // Google login only exists as a wired provider, and its adapter
  // fails closed when these are absent. They are owner-set secrets
  // (Cloudflare dashboard or `wrangler secret put`), NEVER committed
  // to the repo or to wrangler.jsonc. Enablement (adding "google" to
  // IAAA_ENABLED_PROVIDERS) is a separate owner step after these exist.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APP_BASE_URL: string;
  SESSION_SECRET: string;
  // #945 Wiring Phase 1 — config-gated enablement. Both optional; absence
  // means wiring is OFF and the legacy login flow runs unchanged. Rollback
  // is a config change only: unset IAAA_WIRING_ENABLED (or remove a
  // provider from IAAA_ENABLED_PROVIDERS). No code change, no secret.
  // IAAA_WIRING_ENABLED: "1" or "true" (case-insensitive) = on; anything else = off.
  IAAA_WIRING_ENABLED?: string;
  // Comma-separated provider ids. Default when wiring is on: "github".
  // An id with no registered adapter is ignored, never a fallback.
  IAAA_ENABLED_PROVIDERS?: string;
  // #945 Wiring Phase 2b-part1 — tenant for IAAA audit attribution.
  // Optional and owner-set. In Phase 2b-part1, when unset (or blank),
  // the logout audit hook was DORMANT. In the GitHub end-to-end
  // slice, the call sites resolve the tenant as IAAA_TENANT_ID when
  // set, else the documented single-tenant default "primary" (see
  // src/security/iaaaGithubEndToEnd.ts and
  // docs/iaaa-github-end-to-end-defaults.md). A multi-tenant
  // deployment must set this explicitly; "primary" is the
  // single-tenant assumption, not a multi-tenant answer.
  IAAA_TENANT_ID?: string;
  // #945 GitHub end-to-end — PDP route enforcement flag. Optional;
  // "1" or "true" (case-insensitive) = on, anything else (including
  // absence) = off. Default OFF: with no bootstrap list set,
  // turning it on would deny every wired session that holds no
  // membership, including the legitimate owner. Activation = set
  // IAAA_BOOTSTRAP_ADMINS + IAAA_TENANT_ID + this flag, redeploy;
  // rollback = unset this flag, redeploy. No code change.
  IAAA_PDP_ENABLED?: string;
  // #945 Wiring Phase 2b-part2 — bootstrap admin list for membership
  // provisioning. Optional, comma-separated. Each entry is either a
  // bare internal user id (UUID) or a provider subject in
  // issuer:subject form (resolved through the Slice 1 binding).
  // When unset, blank, or empty, ZERO members are provisioned:
  // there is no hardcoded admin, no default user, and no fallback
  // to a GitHub login. Parsed by parseBootstrapAdmins, provisioned
  // only from an admin-only setup path (never from a route or a
  // login path), and granting tenant-admin only — never
  // platform-admin. See src/security/iaaaBootstrap.ts.
  IAAA_BOOTSTRAP_ADMINS?: string;
  MAS_MAX_STEPS?: string;
  AI_MODEL?: string;
  // Payment Gateway Secrets (Stripe, PayPal, Lemon Squeezy)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
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
  ETAPI_CONFIG?: string;
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
  SLACK_WEBHOOK_URL?: string;
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
  INBOUND_NLQ_WEBHOOK_SECRET?: string;
  // Optional comma-separated domain allowlist for outbound email recipients
  // (emailTo) on webhook-triggered email paths. When set, only addresses
  // whose domain is listed are accepted. When unset, only format validation
  // applies (a warning is logged on first use). Issue #143 P0.
  EMAIL_TO_ALLOWED_DOMAINS?: string;
  // Nightly mas_messages retention window in days (issue #255, part of
  // #143). Default 90. A value <= 0 disables the retention pass entirely.
  MAS_MESSAGES_RETENTION_DAYS?: string;
  // Nightly mas_events retention window in days (issue #786). Default
  // 365. A value <= 0 disables only the mas_events prune.
  MAS_EVENTS_RETENTION_DAYS?: string;
  // Nightly mas_memory retention window in days, by updated_at (issue
  // #786). Default 365. A value <= 0 disables only the mas_memory prune.
  MAS_MEMORY_RETENTION_DAYS?: string;
  // Cloudflare Vectorize & AI Search
  VECTORIZE?: any;
  // Optional / backward-compatible bindings
  KV?: KVNamespace;
  BROWSER_AGENT?: DurableObjectNamespace;
  SLACK_AGENT?: DurableObjectNamespace;
  TASKS_AGENT?: DurableObjectNamespace;
  MEMORY_AGENT?: DurableObjectNamespace;
  RESEARCH_AGENT?: DurableObjectNamespace;
  REPORT_ASSET_AGENT?: DurableObjectNamespace;
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
  /** "simulated" marks local records of simulated agentic payments — no real payment occurred (issue #122). */
  status: "draft" | "awaiting_confirmation" | "authorized" | "completed" | "failed" | "rejected" | "simulated";
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
  // #945 Wiring Phase 1 — optional extensions, added only when IAAA wiring
  // is on. Old sessions without them keep working exactly as before.
  // internalUserId is the stable Slice 1 identity, never derived from a
  // login or email; providerSubject is the provider-stable subject
  // (GitHub numeric user id), not the login.
  internalUserId?: string;
  providerIssuer?: string;
  providerSubject?: string;
  /** Login (authentication) time in ms since epoch, for step-up freshness. */
  authTimeMs?: number;
  /**
   * #945 Wiring Phase 2a — last recorded activity in ms since epoch.
   * Set at wired login and advanced by touchSession (at most once
   * per 60s, so ±60s precision). Sessions without this field
   * (legacy sessions, Phase 1 sessions) are exempt from idle
   * expiry in getValidatedSession — see its header note.
   */
  lastActivityMs?: number;
  /** Session record version; 1 for sessions created by the wired flow. */
  sessionVersion?: number;
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

/**
 * Durable record of a claimed inbound webhook nonce, used for replay
 * protection (issue #143 P0). A nonce is provider-derived: a semantic
 * event identity when the provider supplies one (e.g. E*TRADE
 * orderId:eventType:timestamp), otherwise a SHA-256 hash over
 * (provider, signature, raw body). Stored in the `webhook_replay_nonces`
 * table; entries expire after WEBHOOK_REPLAY_TTL_MS (24h).
 */
export interface WebhookReplayNonce {
  nonce: string;
  source: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Durable record of a report generated by a scheduled run, so the AI
 * Search agent can surface it later (issue #278, owner scope addition
 * 2026-10-18). Stored in the `mas_reports` table; `body` is the full
 * report payload serialized to JSON (capped by the writer).
 */
export interface ScheduledReportRecord {
  id: string;
  runId: string;
  /** Issue #308: idempotency key for the single generate→store seam. */
  generationId?: string;
  title: string;
  source: string;
  summary: string;
  body: string;
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
  week52High?: number;
  week52Low?: number;
  high52?: number;
  low52?: number;
  rsi?: number;
  sector?: string;
  listingExchange?: string;
  source?: string;
  quoteStatus?: string;
  dateTime?: string;
  timestamp: string;
}

export interface StockScreenerFilter {
  sector?: string;
  minPrice?: number;
  maxPrice?: number;
  exchange?: "ALL" | "NASDAQ" | "NYSE" | "AMEX";
  minMarketCap?: number; // in billions or absolute
  maxPeRatio?: number;
  maxRsi?: number;
  minRsi?: number;
  gainersOnly?: boolean;
  losersOnly?: boolean;
  rsiFilter?: "oversold" | "overbought" | "neutral" | "any";
  momentum?: "bullish_breakout" | "bearish_pullback" | "high_relative_volume" | "any";
  gainersLosers?: "gainers" | "losers" | "active" | "all" | "movers";
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
    mode: "all_us_listings";
    candidateCount: number;
    listingCount: number;
    sourceCounts: Record<string, number>;
    message: string;
    error?: string;
  };
  movers?: {
    gainers: ScreenedStockItem[];
    losers: ScreenedStockItem[];
  };
}

// =========================================================================
// Dynamic Options Screener Engine Types
// =========================================================================

export type OptionScreenSortKey =
  | "volume" // highest volume first (default)
  | "spreadPct" // tightest spread first (ascending)
  | "iv" // highest implied volatility first
  | "volumeOiRatio" // highest Vol/OI (unusual activity) first
  | "dte" // nearest expiration first (ascending)
  | "strikeDistance"; // closest to the money first (ascending)

export interface OptionScreenerFilter {
  /** Explicit underlyings to screen; normalized (uppercased/deduped) and capped at MAX_SCAN_SYMBOLS. */
  underlyingSymbols?: string[];
  /** Cap on dynamically discovered underlyings (1..MAX_SCAN_SYMBOLS). Required when underlyingSymbols is absent. */
  maxUnderlyings?: number;
  /** Not supported by the all-listings discovery feed; rejected with a validationError unless "all"/"any". */
  sector?: string;
  contractType?: "CALL" | "PUT" | "BOTH";
  minVolume?: number;
  minOpenInterest?: number;
  /** Maximum bid/ask spread as a percent of the midpoint. */
  maxSpreadPct?: number;
  /** Quote-age reference in seconds used for FRESH/STALE labeling; stale rows are labeled, never discarded. */
  maxQuoteAgeSeconds?: number;
  /** Minimum delta compared against the ABSOLUTE delta (0..1); returned contracts keep their signed delta. */
  minDelta?: number;
  /** Maximum delta compared against the ABSOLUTE delta (0..1). */
  maxDelta?: number;
  minGamma?: number;
  maxGamma?: number;
  minTheta?: number;
  maxTheta?: number;
  /** Minimum vega. */
  minVega?: number;
  /** Maximum vega. */
  maxVega?: number;
  /** Minimum rho. */
  minRho?: number;
  /** Maximum rho. */
  maxRho?: number;
  /** Minimum option premium in USD, evaluated on the bid/ask midpoint. */
  minPrice?: number;
  /** Maximum option premium in USD, evaluated on the bid/ask midpoint. */
  maxPrice?: number;
  minImpliedVolatility?: number; // decimal e.g. 0.35 = 35%
  maxImpliedVolatility?: number; // decimal e.g. 1.20 = 120%
  minDte?: number; // Days to expiration min
  maxDte?: number; // Days to expiration max
  /** Optional bounded expiry bands for strategy discovery. Each band selects its earliest expirations. */
  expirationDteBands?: Array<{ minDte: number; maxDte: number; maxExpirations?: number }>;
  moneyness?: "ITM" | "OTM" | "ATM" | "ALL";
  maxStrikeDistancePct?: number; // e.g. 10 for strikes within 10% of underlying price
  /** Maximum contracts returned (clamped to MAX_RETURNED_CONTRACTS); use totalMatches for the pre-limit count. */
  limit?: number;
  /** Result ordering; defaults to "volume" (highest volume first). */
  sortBy?: OptionScreenSortKey;
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
  technicalSignal: string;
  highlightReason: string;
}

/** Machine-readable reason a contract failed screening. */
export type OptionScreenRejectionCode =
  | "ADJUSTED_CONTRACT"
  | "INVALID_QUOTE"
  | "SPREAD_TOO_WIDE"
  | "PREMIUM_OUT_OF_RANGE"
  | "DTE_OUT_OF_RANGE"
  | "DELTA_OUT_OF_RANGE"
  | "GAMMA_OUT_OF_RANGE"
  | "THETA_OUT_OF_RANGE"
  | "VEGA_OUT_OF_RANGE"
  | "RHO_OUT_OF_RANGE"
  | "IV_OUT_OF_RANGE"
  | "VOLUME_TOO_LOW"
  | "OPEN_INTEREST_TOO_LOW"
  | "MONEYNESS_MISMATCH"
  | "STRIKE_DISTANCE_TOO_WIDE";

export interface OptionScreenRejection {
  code: OptionScreenRejectionCode;
  contractSymbol: string;
  underlyingSymbol: string;
  reason: string;
  strikePrice?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  iv?: number;
  volume?: number;
  daysToExpiration?: number;
  spreadPct?: number;
  quoteAgeSeconds?: number;
}

/** A per-symbol upstream fetch failure (auth, network, rate limit, empty payload). */
export interface OptionScreenFetchError {
  symbol: string;
  reason: string;
}

export interface OptionScreenResult {
  totalUnderlyingsScanned: number;
  totalContractsEvaluated: number;
  /** Contracts returned in this payload (after `limit`). */
  matchedCount: number;
  /** Total contracts that matched the filter before `limit` truncation. */
  totalMatches?: number;
  /** Total contracts rejected across all filters (rejections[] holds at most 50 samples). */
  rejectionCount?: number;
  filterApplied: OptionScreenerFilter;
  filterSummary: string;
  contracts: ScreenedOptionContractItem[];
  scannedAt: string;
  /** Provenance of the contracts (issue #65): "live" broker data, or
   *  "calibrated-demo" generated chains served only in demo mode. */
  dataSource?: "live" | "calibrated-demo";
  quoteQuality?: {
    maxAgeSeconds?: number;
    /** Age threshold (seconds) used for FRESH/STALE labels; equals maxAgeSeconds when set, else the default reference. */
    referenceAgeSeconds?: number;
    staleContractsReturned: number;
    unknownFreshnessContracts: number;
    freshestStaleQuoteAgeSeconds?: number;
  };
  /** "error" when inputs are invalid (see validationError) or nothing could be fetched (see fetchErrors). */
  status: "matches_found" | "no_matches" | "error";
  validationError?: string;
  /** Per-symbol upstream failures; present alongside any status when live fetches failed. */
  fetchErrors?: OptionScreenFetchError[];
  /** Non-fatal notices: clamped inputs, default DTE window, truncation, skipped expirations. */
  warnings?: string[];
  rejections?: OptionScreenRejection[];
  /** Per-underlying put/call ratio and anomaly signal. */
  putCallRatios?: Record<string, { putCallRatio: number; signal: string }>;
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

export interface OptionsChainCacheRecord {
  id: string; // symbol e.g. NVDA
  symbol: string;
  expirationsJson: string; // JSON string of ETradeOptionExpireDate[]
  chainsJson: string; // JSON string of ETradeOptionChain[]
  fetchedAt: number; // timestamp in ms
  expiresAt: number; // timestamp in ms
  contractCount: number;
}

export interface ETradeOrderDraft {
  orderId: string;
  previewId?: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  orderAction: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  brokerOrderType?: "EQ" | "OPTN" | "SPREADS" | "BUY_WRITES";
  optionLegs?: Array<{
    underlyingSymbol: string;
    securityType: "EQ" | "OPTN";
    side: "BUY" | "SELL";
    quantity: number;
    optionType?: "CALL" | "PUT";
    strike?: number;
    expirationDate?: string;
  }>;
  strategyNetDebit?: number;
  orderType: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  quantity: number;
  estimatedPrice: number;
  limitPrice?: number;
  stopPrice?: number;
  term: "GOOD_FOR_DAY" | "GOOD_UNTIL_CANCEL";
  estimatedCommission: number;
  estimatedTotal: number;
  /** Issue #118: quoteStatus of the quote this preview was priced from (e.g. "REALTIME", "STATIC_FALLBACK"). */
  pricingQuoteStatus?: string;
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
  /** Broker product fields, when the source payload carries them (issue #34).
   * securityType is the broker's code (e.g. "EQ", "OPTN"); option fields are
   * populated only for option positions whose contract detail was reported. */
  securityType?: string;
  positionType?: "LONG" | "SHORT";
  optionType?: "CALL" | "PUT";
  strikePrice?: number;
  /** ISO date (yyyy-mm-dd) of option expiry, when applicable. */
  expirationDate?: string;
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

/**
 * Data provenance for every FOSS market-data object (issue #117, audit #115
 * findings F10/F11). The FOSS providers fall back to non-live data when a
 * live fetch fails; that fallback is now always labelled, never silent:
 * - "live": actually fetched from the named provider in this call.
 * - "static": served from the bundled FOSS_MARKET_UNIVERSE table.
 * - "generated": deterministically invented (hash-generated profile for an
 *   unlisted ticker, the synthetic bars generator, formula analyst targets).
 * Mirrors the betaService/correlationService labelling standard: every
 * resolution carries its source; values are labelled, never silently
 * invented. A non-live object may keep a `timestamp` for shape compatibility,
 * but it is the object's production time — `provenance` (and `note`, when
 * present) states what the data actually is.
 */
export type FossDataProvenance = "live" | "static" | "generated";

export interface FossQuote {
  symbol: string;
  provider: "yfinance" | "alpaca" | "hybrid";
  /** Truth about where this quote's values came from in this call (#117). */
  provenance: FossDataProvenance;
  /** Human-readable origin note; set whenever provenance is not "live". */
  note?: string;
  companyName?: string;
  name?: string;
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
  dayHigh?: number;
  dayLow?: number;
  previousClose: number;
  vwap?: number;
  trailingPE?: number;
  peRatio?: number;
  marketCap?: number;
  rsi14?: number;
  macdSignal?: string;
  marketState?: string;
  timestamp: string;
  currency?: string;
}

export interface FossHistoricalBar {
  /** "live" = fetched bars; "generated" = synthetic series from the FOSS profile (#117). */
  provenance: FossDataProvenance;
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
  /** Truth about where these fundamentals came from in this call (#117). */
  provenance: FossDataProvenance;
  /** Human-readable origin note; set whenever provenance is not "live". */
  note?: string;
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
  /** "live" = fetched from Alpaca in this call; otherwise the FOSS profile (#117). */
  provenance: FossDataProvenance;
  /** Human-readable origin note; set whenever provenance is not "live". */
  note?: string;
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
  /** Weakest provenance among quote, fundamentals, and bars (#117). */
  provenance: FossDataProvenance;
  quote: FossQuote;
  fundamentals: FossCompanyFundamentals;
  bars: FossHistoricalBar[];
  technicalSummary: {
    rsi14: number;
    macd: string;
    trend50vs200SMA: string;
    support: number;
    resistance: number;
    /**
     * Always true for this engine: support/resistance are price×0.94/×1.06
     * formulas and the MACD/trend labels come from a single price-vs-midpoint
     * comparison — heuristic estimates, not measured technicals (#117).
     */
    heuristic: boolean;
  };
  aiAnalysis: string;
  analystRating: string;
  agentAttestation: {
    did: string;
    signature: string;
    timestamp: string;
    /** Provenance of the attested inputs; bound into the signed payload (#117). */
    provenance: FossDataProvenance;
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
  osiKey?: string;
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
  raw?: Record<string, unknown>;
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

export interface PreTradeApprovalDraft {
  orderId: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  limitPrice?: number;
  estimatedPrice?: number | string;
  estimatedTotal?: number | string;
  commission?: number | string;
  proposerDid?: string;
  expiresAt?: string;
  notes?: string;
  channel?: string;
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
  actionType: "quote" | "screener" | "options_research" | "preview" | "approval" | "rejection" | "portfolio" | "general" | "challenge" | "ignored" | "snap";
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
  actionType: "quote" | "screener" | "options_screener" | "options_research" | "watchlist" | "preview" | "approval" | "rejection" | "portfolio" | "schedule" | "agentic_payment" | "capabilities" | "general" | "error";
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
  /**
   * Issue #122: true when this proof was produced locally by
   * ETradeAgenticPaymentService.signPaymentProof, which holds no signing key
   * and settles nothing on-chain. A simulated proof is NOT a cryptographic
   * signature and must never be presented or accepted as one;
   * verifyPayment rejects simulated proofs outright.
   */
  simulated?: boolean;
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
  /**
   * "verified" is reserved for receipts issued after an actual verification
   * (on-chain claim verification or the mppx gateway). Locally synthesised
   * records of simulated payments use "simulated" (issue #122).
   */
  status: "paid" | "verified" | "failed" | "simulated";
  /** Issue #122: true for locally synthesised records of simulated payments — no real payment was made or verified. */
  simulated?: boolean;
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
  /**
   * Issue #122: this service never reads an on-chain balance. balanceUSD is a
   * simulated local-ledger figure (see source/startingCreditUSD/note) and the
   * markers below must travel with it to every surface that renders it.
   */
  simulated: boolean;
  source: "local-ledger";
  startingCreditUSD: number;
  note: string;
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
  /**
   * Provenance of `screenshotBase64` (issue #120): "capture" only when the
   * image really came from Cloudflare Browser Rendering of the page;
   * "placeholder" when it is a locally generated illustration produced
   * because no browser capture was available. A placeholder contains no
   * page content and must never be presented as a screenshot of the page.
   */
  screenshotKind?: "capture" | "placeholder";
  error?: string;
  timestamp: string;
}

export interface TransactionSnapData {
  transactionId: string;
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_OPEN" | "SELL_TO_CLOSE" | "BUY_TO_CLOSE" | "SELL_TO_OPEN" | string;
  quantity: number;
  price?: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | string;
  status: "previewed" | "executed" | "filled" | "rejected" | "expired" | "cancelled" | string;
  totalValue?: number;
  environment?: string;
  accountKey?: string;
  commission?: number;
  timestamp?: string;
  /**
   * Issue #120: set ONLY by a flow that recorded an actual human approval
   * for this transaction (e.g. a Slack approve interaction, a conversational
   * approval, or the HITL authorize/execute call). The generated receipt
   * prints "Human-in-the-Loop Verified" only when this is true; otherwise
   * the receipt states that no human approval was recorded.
   */
  humanApproved?: boolean;
  notes?: string;
  legs?: Array<{
    action: string;
    symbol: string;
    strike?: number;
    expiry?: string;
    type?: string;
  }>;
}

export interface BrowserAgentSnapResult {
  success: boolean;
  transactionId?: string;
  symbol?: string;
  url?: string;
  slackWebhookUrl?: string;
  channel?: string;
  caption?: string;
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
  /**
   * Issue #121 (audit F6): true only when a real container backend handled
   * the request (its `error` field reports backend failures). False means
   * NO backend is bound in this environment and the command was NOT run —
   * in that case `exitCode` is null and `stdout`/`stderr` are empty, because
   * this service never emulates shell execution or fabricates output.
   */
  executed: boolean;
  /** Process exit code from the real backend; null when nothing ran. */
  exitCode: number | null;
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
  /**
   * Issue #121 (audit F7): the price series is generated in code, never
   * historical market data. Metrics are genuinely computed from that
   * synthetic series; a metric that cannot be computed from the run
   * (e.g. win rate with no closed trades) is null, never default-filled.
   */
  dataSource: "synthetic";
  totalTrades: number;
  winRate: number | null;
  profitFactor: number | null;
  sharpeRatio: number | null;
  maxDrawdownPct: number | null;
  netReturnPct: number | null;
  codeExecuted: string;
  logs: string;
  /** Plain-language statement of what this result is and is not. */
  note: string;
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

/** Where a guardrail input actually came from (issue #37). */
export type ThinkInputSource = "provided" | "live" | "unavailable";

export interface ThinkTradeValidationResult {
  approved: boolean;
  overallConfidence: number;
  recommendation: "PROCEED_TO_HITL" | "REVISE_PARAMETERS" | "REJECT_RISK_LIMIT" | "INPUTS_UNAVAILABLE";
  /** Provenance of every input the decision rested on — a decision made
   *  without live state must say so, and unavailable inputs fail closed. */
  inputSources: { price: ThinkInputSource; accountBalance: ThinkInputSource; spread: ThinkInputSource };
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

export type AsyncJobStatus = "queued" | "running" | "completed" | "failed";

export interface AsyncJobRecord {
  jobId: string;
  sessionId: string;
  capability: string;
  label: string;
  status: AsyncJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: unknown;
  responseStatus?: number;
}

export interface AsyncJobPayload {
  jobId: string;
}

export type AsyncJobSubmission =
  | {
      capability: "http.request";
      payload: {
        pathAndQuery: string;
        method: string;
        headers: Record<string, string>;
        body: string;
      };
    }
  | {
      capability: "mcp.tool";
      payload: { toolName: string; arguments: Record<string, unknown> };
    }
  | {
      capability: "nlq.execute";
      payload: { query: string; userLogin: string };
    }
  | {
      capability: "task.draft";
      payload: {
        title: string;
        dueDate?: string;
        priority?: "low" | "medium" | "high" | "urgent";
        assignee?: string;
      };
    };

export interface TWAPOrderConfig {
  symbol: string;
  action: "BUY" | "SELL";
  totalQuantity: number;
  slices: number;
  intervalSeconds: number;
  maxPrice?: number;
}
