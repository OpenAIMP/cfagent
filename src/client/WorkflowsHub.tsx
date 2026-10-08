import React, { useState, useMemo } from "react";
import "./workflowsHub.css";
import {
  FAQ_QUESTIONS,
  WORKFLOW_IMPROVEMENTS,
  CAPABILITY_MATRIX,
  DECISIONING_SECTIONS,
  type FaqQuestionItem,
  type WorkflowImprovementItem,
  type CapabilityMatrixRow,
  type DecisioningSection,
  type DecisioningRule,
  type DecisioningMatrixRow,
  type ParameterBadge,
} from "./workflowsFaqData";

export interface WorkflowItem {
  id: string;
  codeId: string;
  number: number;
  track: "analysis" | "execution";
  trackLabel: string;
  title: string;
  category: "stocks" | "options" | "flows" | "brokerage" | "scheduled" | "nlq" | "payments" | "research" | "audit" | "risk";
  categoryLabel: string;
  badge: string;
  badgeColor: "green" | "blue" | "purple" | "orange" | "cyan";
  subtitle: string;
  overview: string;
  apiEndpoint: string;
  targetTab: string;
  keyParameters?: string;
  governingDecisionRuleId?: string;
  steps: Array<{
    step: string;
    title: string;
    description: string;
  }>;
  keyFeatures: string[];
  dataSources: string[];
  apiMetrics?: Array<{
    host: string;
    status2xx: number | string;
    status4xx: number | string;
    avgDuration: string;
    role: string;
    usageDetails: string;
    nuanceExplanation: string;
  }>;
  faq: {
    question: string;
    answer: string;
  };
  sampleQueryOrAction: string;
}

export const PLATFORM_WORKFLOWS: WorkflowItem[] = [
  // =========================================================================
  // ANALYSIS TRACK (A1 - A8)
  // =========================================================================
  {
    id: "stock-screener",
    codeId: "A1",
    number: 1,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Stock Screener & Multi-Exchange Equity Discovery",
    category: "stocks",
    categoryLabel: "Equities",
    badge: "Dual-Engine (Nasdaq & Yahoo)",
    badgeColor: "green",
    subtitle: "Screen 8,000+ US equities dynamically across NASDAQ, NYSE, and AMEX with technical indicators and auditable scan ledgers.",
    overview: "The Stock Screener allows filtering across all active US equities by price, market cap, exchange, 14-period daily RSI, MACD momentum, and daily gainers/losers. It queries official Nasdaq multi-exchange listings (api.nasdaq.com) across 8,000+ active tickers, with resilient automatic fallback to the externalized curated universe (src/config/curatedStockUniverse.json) or Yahoo Finance FOSS feeds if upstream APIs are rate-limited. Downstream workflows (including Options Flow) query this screener first as their primary dynamic market underlyings engine.",
    apiEndpoint: "POST /api/etrade/screen · POST /api/foss/screen",
    targetTab: "trading",
    keyParameters: "exchange: ALL, minPrice: $3.00, marketCapTier: Large/Mid/Small, rsiPeriod: 14",
    governingDecisionRuleId: "stock-screener-logic",
    steps: [
      {
        step: "Step 1",
        title: "Filter Configuration",
        description: "User configures exchange (NASDAQ, NYSE, AMEX, or ALL), price boundaries, market capitalization, sector, and trend (Gainers, Losers, Most Active).",
      },
      {
        step: "Step 2",
        title: "Dynamic Exchange Ingestion & Fallback Decision",
        description: "The engine queries the official Nasdaq Screener API (api.nasdaq.com) across 8,000+ active tickers. If rate-limited, throttled, or unreachable, DynamicMarketScreener autonomously falls back to the curated universe or Yahoo FOSS feeds.",
      },
      {
        step: "Step 3",
        title: "Indicator Computation",
        description: "Calculates 14-Period Daily RSI and MACD (12, 26, 9 EMA) exponential moving averages to categorize momentum into Overbought, Oversold Bounce, Bullish, or Range-Bound.",
      },
      {
        step: "Step 4",
        title: "Auditable Scan Ledger",
        description: "Compiles a complete audit ledger recording total evaluated tickers, passed candidates, and exact failure reasons for every rejected security.",
      },
    ],
    keyFeatures: [
      "Dynamic all-exchange discovery with live Nasdaq, NYSE, and AMEX support.",
      "Autonomous fallback decision tree: prioritizes remote Nasdaq/Yahoo listings before gracefully falling back to externalized curated universe.",
      "Single Source of Truth for Options Flow: Options Flow queries this screener first to resolve active, liquid market underlyings partitioned by market cap rather than defaulting to a static list.",
      "Dual provider flexibility: E*TRADE broker mode or 100% zero-credential Yahoo Finance FOSS mode.",
      "Auditable scan ledger detailing why each security matched or failed criteria.",
      "Sortable results by 1D change %, volume, market cap, and RSI momentum.",
    ],
    dataSources: [
      "Nasdaq Official Screener API (api.nasdaq.com/api/screener/stocks)",
      "Externalized Curated Stock Universe (src/config/curatedStockUniverse.json)",
      "Yahoo Finance Chart & Summary API (query1/query2.finance.yahoo.com)",
      "Yahoo Finance Cookie Crumb Handshake (fc.yahoo.com)",
      "E*TRADE Market Quote & Orders API (api.etrade.com/v1/market/quote)",
    ],
    apiMetrics: [
      {
        host: "api.nasdaq.com",
        status2xx: 33,
        status4xx: 0,
        avgDuration: "2.17s",
        role: "Nasdaq Official All-Exchange Screener",
        usageDetails: "Ingests dynamic listing tables across NASDAQ, NYSE, and AMEX (~8,500 active securities) in 5,000-row paginated batches.",
        nuanceExplanation: "33 total requests reflect 3 exchange partitions paginated across 5,000 rows. The 2.17s latency reflects Nasdaq enterprise database queries.",
      },
      {
        host: "query1.finance.yahoo.com",
        status2xx: 945,
        status4xx: 46,
        avgDuration: "257.6ms",
        role: "Yahoo Finance Chart, Indicators & Session Crumb",
        usageDetails: "Retrieves 1-month daily and intraday historical OHLCV chart bars (/v8/finance/chart/{symbol}) to compute 14-period RSI and MACD.",
        nuanceExplanation: "The 46 4xx responses represent unlisted OTC tickers or transient Yahoo rate throttles. Resilient fallback mechanisms handle retries seamlessly.",
      },
      {
        host: "query2.finance.yahoo.com",
        status2xx: 940,
        status4xx: 7,
        avgDuration: "70.9ms",
        role: "Yahoo Finance Quote Summary & Options Feed",
        usageDetails: "Secondary load-balanced endpoint querying detailed valuation metrics (/v10/finance/quoteSummary/{symbol}?modules=price,summaryDetail).",
        nuanceExplanation: "Extremely fast 70.9ms average latency. The 7 4xx responses reflect non-optionable ticker queries or invalid symbol symbols.",
      },
      {
        host: "fc.yahoo.com",
        status2xx: 0,
        status4xx: 70,
        avgDuration: "30.3ms",
        role: "Yahoo Finance Cookie Crumb Handshake",
        usageDetails: "Initial cookie handshake request for the open-source Yahoo Finance session protocol.",
        nuanceExplanation: "100% 4xx (HTTP 404/401) is expected by design: Yahoo intentionally responds with 4xx while setting the session cookie header.",
      },
    ],
    faq: {
      question: "Why does the screener not show penny stocks or low-liquidity OTC stocks?",
      answer: "The screener defaults to a minimum price floor of $3.00 and requires major exchange listing (NASDAQ/NYSE/AMEX) to ensure optionability and prevent illiquid OTC slippage.",
    },
    sampleQueryOrAction: "Screen NASDAQ stocks with price > $50, market cap > $10B, and RSI < 35",
  },

  {
    id: "options-discovery",
    codeId: "A2",
    number: 2,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Options Strategy Discovery, Greeks Modeling & EV Scoring",
    category: "options",
    categoryLabel: "Options",
    badge: "72-Strategy Catalog",
    badgeColor: "blue",
    subtitle: "Calibrates synthetic option pricing, computes analytical Black-Scholes Greeks, POP, and EV across 72 catalog structures.",
    overview: "Evaluates multi-leg options structures (Iron Condors, Vertical Spreads, Butterflies, Calendars, Diagonals, Straddles, Strangles) against live calibrated option chains. Calculates Delta, Gamma, Theta, Vega, IV Rank, Probability of Profit (POP = N(d2)), and Expected Value (EV). Supports strict user budget and risk filtering (e.g. Max Loss <= $30, Max Profit > $0).",
    apiEndpoint: "POST /api/etrade/options/strategy · POST /api/trading/options/unified",
    targetTab: "trading",
    keyParameters: "symbol: NVDA, bias: 50 (Balanced EV), budget: $300, minRR: 1.0, maxLoss: $30",
    governingDecisionRuleId: "multivariate-scoring-criteria",
    steps: [
      {
        step: "Step 1",
        title: "Chain Ingestion & Synthetic Calibration",
        description: "Fetches live option chains from E*TRADE or FOSS feeds. Mid-market prices are calibrated to eliminate spread distortions.",
      },
      {
        step: "Step 2",
        title: "Combinatorial Strike Ladder Generation",
        description: "Generates candidate leg combinations across 72 catalog strategies, shifting strikes dynamically based on Optimization Bias (0=Max Return, 50=Balanced, 100=Max Chance).",
      },
      {
        step: "Step 3",
        title: "Analytical Black-Scholes Greeks & POP",
        description: "Computes Delta, Gamma, Theta, Vega, and Probability of Profit (N(d2)) for every candidate structure using continuous dividend and risk-free rates.",
      },
      {
        step: "Step 4",
        title: "Multivariate 6-Factor Composite Scoring",
        description: "Ranks setups using the institutional dot-product score: S = w_thesis*S_thesis + w_RR*S_RR + w_liq*S_liq + w_fresh*S_fresh + w_iv*S_iv + w_theta*S_theta.",
      },
    ],
    keyFeatures: [
      "72 distinct options strategies spanning directional, neutral, volatility, and income plays.",
      "Strict parameter filtering: max loss, max profit, min win rate, strike bounds, and expiration windows.",
      "Black-Scholes analytical Greeks engine with continuous dividend and risk-free rate calibration.",
      "Expected Value (EV) calculation: EV = (POP * MaxProfit) - ((1 - POP) * MaxLoss) / Collateral.",
      "Visual 2D interactive payoff curve with breakevens, max gain, and max capital at risk.",
    ],
    dataSources: [
      "E*TRADE Option Chains API (api.etrade.com/v1/market/optionchains)",
      "E*TRADE Option Expirations API (api.etrade.com/v1/market/optionexpiredate)",
      "Calibrated Synthetic Pricing Engine (src/trading/options/calibratedOptionChains.ts)",
    ],
    faq: {
      question: "How does the Optimization Bias slider affect strike selection?",
      answer: "Bias 0 shifts strikes +3 steps OTM for maximum percentage return multiple. Bias 50 centers strikes ATM for balanced EV. Bias 100 shifts strikes -3 steps ITM for maximum probability of profit (POP > 75%).",
    },
    sampleQueryOrAction: "Find bullish call spreads on NVDA with max loss <= $30 and max profit > $0",
  },

  {
    id: "options-raw-screener",
    codeId: "A3",
    number: 3,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Raw Options Contract Screener & Chain Filtering",
    category: "options",
    categoryLabel: "Options",
    badge: "15-Gate Contract Filter",
    badgeColor: "purple",
    subtitle: "Granular contract-level filtering of raw option strikes with moneyness bounds, Greek filters, and 15 rejection code gates.",
    overview: "Direct, granular contract-level filtering of raw option strikes across calls and puts. Applies 15 rejection code gates (e.g. SPREAD_TOO_WIDE, MIN_VOLUME_FAIL, OUTSIDE_DELTA_RANGE, STALE_QUOTE). Sanitization normalizes user inputs, clamps negative bounds, and computes auditable rejection ledgers detailing exactly why each non-qualifying contract was omitted.",
    apiEndpoint: "POST /api/trading/options/screen · POST /api/premium/options-scan",
    targetTab: "trading",
    keyParameters: "minVol: 500, minOI: 1000, maxSpreadPct: 5.0%, atmBandPct: 0.02, dte: 14-45d",
    governingDecisionRuleId: "options-screener-logic",
    steps: [
      {
        step: "Step 1",
        title: "Raw Chain Retrieval",
        description: "Retrieves complete strike ladder for the selected underlying across weekly and monthly expiration cycles.",
      },
      {
        step: "Step 2",
        title: "Boundary Sanitization & Clamping",
        description: "Validates bid/ask quotes, omits inverted quotes (bid > ask or bid <= 0), and verifies quote age under 60 seconds.",
      },
      {
        step: "Step 3",
        title: "15-Gate Exclusion Filter",
        description: "Applies volume floors, open interest depth, spread percentage ceilings, and Delta/Gamma/Theta/Vega tolerances.",
      },
      {
        step: "Step 4",
        title: "Heuristic Signal Tagging",
        description: "Tags passing contracts with market condition signals: Unusual Volume Spike (Vol/OI > 1.5x), High Delta Momentum, or High IV Expansion.",
      },
    ],
    keyFeatures: [
      "15 explicit rejection codes for 100% auditability.",
      "Bid-ask spread percentage filtering relative to midpoint to eliminate wide illiquid options.",
      "At-The-Money (ATM) ±2% moneyness band classification into ITM, ATM, and OTM.",
      "Support for x402 pay-per-query micropayments via external MCP tool integration.",
    ],
    dataSources: [
      "E*TRADE Option Chains API (api.etrade.com/v1/market/optionchains)",
      "Synthetic Midpoint & Spread Ratio Solvers",
    ],
    faq: {
      question: "What rejection code is triggered if a quote is stale or inverted?",
      answer: "Inverted quotes trigger INVALID_QUOTE. Quotes older than maxQuoteAgeSeconds (default 60s) trigger STALE_QUOTE and degrade confidence.",
    },
    sampleQueryOrAction: "Screen NVDA call contracts with volume > 500, spread < 4%, and DTE between 14 and 45 days",
  },

  {
    id: "options-flows",
    codeId: "A4",
    number: 4,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Real-Time Options Flow & Institutional Activity Tracker",
    category: "flows",
    categoryLabel: "Market Flows",
    badge: "Institutional Smart Money",
    badgeColor: "blue",
    subtitle: "Tracks unusual options volume, sweeps (≥$100k executed aggressively at ask), blocks, splits, and dynamic sentiment leaderboards.",
    overview: "Monitors options flow in real time across the market. Filters by trade type (SWEEP, BLOCK, SPLIT), sentiment (BULLISH, BEARISH), moneyness (ITM, ATM, OTM), and minimum premium. Dynamically screens underlying equities using the Stock Screener first (with fallback to curated universe), computes Bull/Bear volume ratios, and aggregates top institutional ticker leaderboards.",
    apiEndpoint: "GET /api/options/flows/live · GET /api/options/flows/summary",
    targetTab: "options-flows",
    keyParameters: "minPremium: $100k, volOiRatio: > 1.5x, tradeType: SWEEP | BLOCK, aggression: ASK",
    governingDecisionRuleId: "stock-screener-logic",
    steps: [
      {
        step: "Step 1",
        title: "Dynamic Universe Resolution",
        description: "Queries DynamicMarketScreener to obtain active, liquid underlyings partitioned by mega/large/mid caps rather than using a static list.",
      },
      {
        step: "Step 2",
        title: "Flow Ingestion & Normalization",
        description: "Ingests raw option trade prints, normalizing strikes, expirations, spot prices, bid/ask sizes, and executed premiums.",
      },
      {
        step: "Step 3",
        title: "Anomaly & Sweep Classification",
        description: "Flags prints where Volume exceeds Open Interest (>1.5x) or single order premium exceeds $100k+ executed aggressively at the ask (Sweeps).",
      },
      {
        step: "Step 4",
        title: "Sentiment Aggregation & Leaderboards",
        description: "Computes net premium delta and ranks top bullish and bearish tickers in live visual leaderboards.",
      },
    ],
    keyFeatures: [
      "Integrated directly with Stock Screener as single source of truth for dynamic underlyings.",
      "Sweep vs Block trade discrimination with aggression tags (Above Ask, At Ask, Below Bid).",
      "Dynamic Bull/Bear sentiment ratios and institutional volume leaderboards.",
      "Live audio/visual alert badges for whale prints ($500k+ premium).",
      "Integrated 🛡️ Risk Analysis modal on every flow print for instant defense playbooks.",
    ],
    dataSources: [
      "Stock Screener Dynamic Listings (api.nasdaq.com + Yahoo FOSS)",
      "Live Options Trade Prints & Quotes Feed",
      "Historical Open Interest & Implied Volatility Surface",
    ],
    faq: {
      question: "What makes a trade print a 'Sweep'?",
      answer: "A Sweep is an order executed across multiple option exchanges simultaneously at or above the ask with ≥$100,000 premium, indicating institutional urgency.",
    },
    sampleQueryOrAction: "Show unusual bullish options sweeps over $100k premium today",
  },

  {
    id: "strategy-builder",
    codeId: "A5",
    number: 5,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Visual Multi-Leg Strategy Builder & Expiration Payoff",
    category: "options",
    categoryLabel: "Options",
    badge: "Interactive Payoff Modeler",
    badgeColor: "cyan",
    subtitle: "Construct custom 1-to-4 leg positions with real-time expiration & T+0 curves, breakevens, and LLM comparison.",
    overview: "Construct custom 1-to-4 leg options positions with real-time expiration and pre-expiration (T+0) payoff diagrams. Automatically computes upper and lower breakeven points, maximum theoretical profit, maximum capital at risk, return on risk (RoR), and aggregate portfolio Greeks. Includes LLM-powered multi-strategy comparison and idea generation.",
    apiEndpoint: "POST /api/trading/options/compare · POST /api/trading/options/llm-ideas",
    targetTab: "trading",
    keyParameters: "legs: 1-4, payoffModel: Expiration + T+0, breakevenSolver: true, targetPrice: spot*1.05",
    governingDecisionRuleId: "strategy-selection-rules",
    steps: [
      {
        step: "Step 1",
        title: "Leg Assembly",
        description: "Add up to 4 options or stock legs specifying action (BUY/SELL), type (CALL/PUT/STOCK), strike, quantity, and expiration.",
      },
      {
        step: "Step 2",
        title: "2D Payoff Curve Modeling",
        description: "Computes expiration curve PnL(S) = sum(leg_pnl(S)) across underlying prices from 0.5x to 1.5x spot, plus intermediate T+0 Black-Scholes curve.",
      },
      {
        step: "Step 3",
        title: "Boundary & Greeks Rollup",
        description: "Solves for upper and lower breakeven points, max gain, max loss, and rolls up aggregate Net Delta, Gamma, Theta, and Vega.",
      },
      {
        step: "Step 4",
        title: "Staged Execution & Risk Analysis",
        description: "One-click transition to 🛡️ Risk Analysis or E*TRADE order preview draft.",
      },
    ],
    keyFeatures: [
      "Dynamic payoff diagram rendering at expiration and pre-expiration (T+0).",
      "Automatic calculation of exact breakeven points and maximum theoretical drawdown.",
      "Multi-leg Greeks aggregation: Net Delta, Net Gamma, Net Theta, Net Vega.",
      "One-click transition from visual builder to E*TRADE order preview or Risk Modal.",
    ],
    dataSources: [
      "Live Option Chain Pricing (E*TRADE & Yahoo FOSS)",
      "Black-Scholes Analytical Pricing & Payoff Math Models",
      "Cloudflare Workers AI (@cloudflare/ai-chat / Llama 3.3 70B)",
    ],
    faq: {
      question: "Can I simulate multi-expiration diagonal spreads in the builder?",
      answer: "Yes. Each leg supports independent expiration selection, allowing calendar and diagonal spread evaluation with time decay progression.",
    },
    sampleQueryOrAction: "Build an Iron Condor on SPY with 45 DTE and $5 wide wings",
  },

  {
    id: "institutional-risk",
    codeId: "A6",
    number: 6,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Institutional Risk Management, Defense Playbooks & Portfolio Exposure",
    category: "risk",
    categoryLabel: "Risk & Hedging",
    badge: "Institutional Risk Matrix",
    badgeColor: "orange",
    subtitle: "Anatomy of risk across all strategies and trades: NAV position sizing (2-5%), 50% profit-taking, 2x stop-loss, and multi-point stress testing.",
    overview: "Provides institutional-grade risk management and defense playbooks across all strategies, contracts, flows, and trades in the platform. Formulates risk anatomy (Capital at Risk, Dollar Delta, Gamma risk, Vega exposure, POP, Probability of Touch, Breakeven cushions, Dividend/Early assignment hazard, Stress tests) and defense playbooks (NAV sizing, 50% profit rule, 2x stop-loss, roll out in time, roll untested wing, invert spreads). Integrates universal '🛡️ Risk Analysis' buttons and 1-click dispatch to multi-agent chat.",
    apiEndpoint: "GET /api/etrade/positions · GET /api/etrade/accounts",
    targetTab: "trading",
    keyParameters: "capitalBudgetPct: 2-5%, profitTargetPct: 50%, stopLossMultiplier: 2.0x, stressTest: -20% to +20%",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Risk Anatomy Decomposition",
        description: "Decomposes candidate or active position into max loss, capital at risk, full Greeks matrix, directional drift sensitivity, and probability of touch.",
      },
      {
        step: "Step 2",
        title: "NAV Position Sizing Audit",
        description: "Calculates conservative (2%), standard (3%), and aggressive (5%) maximum contract sizing based on account NAV purchasing power.",
      },
      {
        step: "Step 3",
        title: "Defense Rule Playbook",
        description: "Formulates explicit exit rules: 50% profit rule for credit spreads, 75-100% for debits, and 2x credit received stop-loss preservation.",
      },
      {
        step: "Step 4",
        title: "Tactical Defensive Adjustments & AI Dispatch",
        description: "Recommends rolling out in time for credit, rolling untested wings closer to spot, inverting strikes, or delta-hedging with 1-click AI prompt handoff.",
      },
    ],
    keyFeatures: [
      "Universal '🛡️ Risk Analysis' button present on every strategy card, builder, screener, flow print, and order ticket.",
      "NAV-based capital budget calculations ensuring traders never over-allocate capital.",
      "Multi-point stress test scenario matrix simulating -20%, -10%, -5%, +5%, +10%, and +20% market shocks.",
      "Early assignment & dividend ex-date risk audit for short American options.",
    ],
    dataSources: [
      "E*TRADE Accounts & Positions API (api.etrade.com/v1/accounts/{accountIdKey}/portfolio)",
      "RiskManagementEngine (src/client/options/riskManagementEngine.ts)",
      "Normal Cumulative Distribution Function (CDF) and Black-Scholes Greeks Math",
    ],
    faq: {
      question: "What is the 50% profit rule for credit spreads?",
      answer: "Institutional traders routinely close credit spreads when 50% of maximum credit is captured. This dramatically increases win rate and frees capital from diminishing theta returns.",
    },
    sampleQueryOrAction: "Evaluate risk anatomy and defense rules for NVDA 120/115 Put Credit Spread",
  },

  {
    id: "foss-research",
    codeId: "A7",
    number: 7,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Zero-Credential FOSS Equity & Crypto Research",
    category: "research",
    categoryLabel: "FOSS Research",
    badge: "Zero-Credential FOSS",
    badgeColor: "green",
    subtitle: "100% free fundamental ratios (P/E, PEG, EV/EBITDA), analyst consensus, historical OHLCV chart bars, and crypto NBBO quotes.",
    overview: "100% free, credential-less equity and cryptocurrency research powered by Yahoo Finance open-source endpoints and Alpaca free data APIs. Ingests valuation metrics (P/E, forward P/E, PEG, Price-to-Book, EV/EBITDA), analyst consensus price targets, historical OHLCV chart bars (daily, hourly, 5-minute), and crypto Level 1 NBBO bid/ask quotes without requiring brokerage API keys.",
    apiEndpoint: "GET /api/foss/quote · GET /api/foss/fundamentals · GET /api/foss/bars",
    targetTab: "research",
    keyParameters: "symbol: NVDA | BTC/USD, modules: price,summaryDetail, interval: 1d, range: 1mo",
    governingDecisionRuleId: "stock-screener-logic",
    steps: [
      {
        step: "Step 1",
        title: "Session Cookie Handshake",
        description: "Exchanges session handshake headers with fc.yahoo.com to obtain crumb authorization tokens autonomously.",
      },
      {
        step: "Step 2",
        title: "Fundamentals & Valuation Ingestion",
        description: "Queries quoteSummary modules for market cap, enterprise value, trailing/forward P/E, PEG, and analyst consensus.",
      },
      {
        step: "Step 3",
        title: "Historical OHLCV Chart Aggregation",
        description: "Retrieves 1-month daily or intraday candle bars to plot price action and compute moving averages.",
      },
      {
        step: "Step 4",
        title: "Crypto NBBO Tape Integration",
        description: "Ingests live cryptocurrency bid/ask quotes from Alpaca crypto market data feeds for digital asset pairs.",
      },
    ],
    keyFeatures: [
      "Zero API keys, zero authentication credentials required.",
      "Comprehensive valuation fundamentals: P/E, Forward P/E, PEG, Price/Book, EV/EBITDA.",
      "High-resolution historical chart bars with volume histogram.",
      "Seamless integration with FOSS Alpaca order execution for trading.",
    ],
    dataSources: [
      "Yahoo Finance Quote Summary (query1.finance.yahoo.com/v10/finance/quoteSummary)",
      "Yahoo Finance Chart Bars (query1.finance.yahoo.com/v8/finance/chart)",
      "Alpaca Market Data API (data.alpaca.markets/v2/stocks & crypto)",
    ],
    faq: {
      question: "Can I use FOSS research if I do not have an E*TRADE account?",
      answer: "Yes. FOSS research is completely independent and operates with 100% free zero-credential public endpoints.",
    },
    sampleQueryOrAction: "Get fundamental valuation ratios and analyst consensus target for NVDA",
  },

  {
    id: "nlq-chat",
    codeId: "A8",
    number: 8,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Conversational Financial Intelligence & NLQ Analytics",
    category: "nlq",
    categoryLabel: "NLQ & Chat",
    badge: "LLM Judge & RAG",
    badgeColor: "purple",
    subtitle: "Natural language query planner and LLM Judge router converting plain queries into parameter-bound scans, RAG retrievals, and memory updates.",
    overview: "Natural Language Query (NLQ) engine converting user questions into parameter-bound SQLite queries, market scans, and options evaluations. Integrates the LLM Judge router to classify intents (search, trading, research, payments, tasks, memory) with confidence scoring. Backed by Cloudflare Workers AI and Vectorize RAG knowledge retrieval.",
    apiEndpoint: "POST /api/nlq · POST /api/chat · POST /nlq/webhook",
    targetTab: "chat",
    keyParameters: "model: glm-4.7-flash, judgeRouting: true, vectorSearch: true, memoryVault: DO SQLite",
    governingDecisionRuleId: "pickbesttrades-engine",
    steps: [
      {
        step: "Step 1",
        title: "Intent Classification & LLM Judge",
        description: "Classifies user query across 6 domains (search, trading, research, payments, tasks, memory) with confidence grading.",
      },
      {
        step: "Step 2",
        title: "Sub-Agent Tool Coordination",
        description: "Routes query to specialized sub-agents: options scanner, FOSS equity research, RAG knowledge search, or payment intent drafter.",
      },
      {
        step: "Step 3",
        title: "Transactional Memory & Knowledge Retrieval",
        description: "Queries Durable Object SQLite tables (mas_messages, mas_events, mas_memory) and Vectorize indexes for relevant facts.",
      },
      {
        step: "Step 4",
        title: "Streaming Synthesis & UI Action Cards",
        description: "Streams response via WebSocket, rendering interactive trade cards, payoff graphs, and 1-click execution tickets.",
      },
    ],
    keyFeatures: [
      "Natural language understanding mapped directly to 72-strategy catalog.",
      "Dual-engine AI routing: Cloudflare Workers AI (glm-4.7-flash) with deterministic screener fallback.",
      "Durable memory vault storing user preferences and facts across sessions.",
      "Omnichannel support: Web chat, Slack events, inbound email, and WebRTC voice.",
    ],
    dataSources: [
      "Cloudflare Workers AI (glm-4.7-flash / Llama 3.3 70B)",
      "Cloudflare AI Search RAG (Vectorize index retrieval)",
      "Durable Object transactional SQLite storage (mas_messages, mas_events, mas_memory)",
    ],
    faq: {
      question: "What happens if Workers AI daily neuron allocation is exhausted?",
      answer: "The orchestrator automatically detects Error 4006 and engages deterministic rule-based screening fallbacks with full diagnostic remediation cards in chat.",
    },
    sampleQueryOrAction: "Find top scoring options opportunities on TSLA with balanced risk",
  },

  // =========================================================================
  // EXECUTION TRACK (E1 - E6)
  // =========================================================================
  {
    id: "etrade-trading",
    codeId: "E1",
    number: 9,
    track: "execution",
    trackLabel: "Execution · HITL Guarded",
    title: "Brokerage Order Preview & Human-in-the-Loop (HITL) Execution (E*TRADE)",
    category: "brokerage",
    categoryLabel: "Brokerage",
    badge: "DID-Attested HITL Guardrails",
    badgeColor: "orange",
    subtitle: "Safe order placement with mandatory two-phase commit: agent previews commissions and margins, signs with DID, and requires user approval.",
    overview: "Enforces strict safety guardrails for real-world trading. The AI agent NEVER places orders autonomously without explicit human authorization. Orders are first prepared as an order preview draft (signed with Decentralized Identifier did:agent:openaimp:trading), showing estimated total, commission, and margin impact. Execution only proceeds when the user explicitly approves the proposal in the UI or chat.",
    apiEndpoint: "POST /api/etrade/order/preview · POST /api/etrade/order/execute",
    targetTab: "trading",
    keyParameters: "previewId: required, didStamp: 'did:agent:openaimp:trading', humanConfirmation: true",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Order Proposal Drafting",
        description: "Agent or user drafts an order ticket with symbol, action (BUY/SELL), quantity, order type (LIMIT/MARKET), and price.",
      },
      {
        step: "Step 2",
        title: "E*TRADE Preview Handshake",
        description: "Calls E*TRADE Preview API to validate account buying power, calculate exact commissions/fees, and obtain a previewId.",
      },
      {
        step: "Step 3",
        title: "DID Attestation & Human Review",
        description: "Signs proposal with Agent DID and displays draft modal in UI. Requires user to review details and click 'Confirm & Execute'.",
      },
      {
        step: "Step 4",
        title: "Authorized Execution & Audit Logging",
        description: "Submits previewId to E*TRADE Place Order API and commits transaction receipt to the persistent SQLite order ledger.",
      },
    ],
    keyFeatures: [
      "Zero unconfirmed live executions: 100% Human-in-the-Loop guaranteed.",
      "Cryptographic proposal signing with W3C Decentralized Identifier (did:agent:openaimp:trading).",
      "Two-phase commit protocol: Preview Handshake -> Human Approval -> Place Execution.",
      "Automatic token renewal via background cron before midnight expiration.",
    ],
    dataSources: [
      "E*TRADE Order Preview API (api.etrade.com/v1/accounts/{accountIdKey}/orders/preview)",
      "E*TRADE Place Order API (api.etrade.com/v1/accounts/{accountIdKey}/orders/place)",
      "W3C DID Cryptographic Attestation Service (src/agents/did.ts)",
    ],
    faq: {
      question: "Can an AI agent place a live trade without me clicking Confirm?",
      answer: "No. The system enforces zero autonomous trading. Orders remain in 'preview' status until an authenticated human clicks Confirm or submits an approved approval token.",
    },
    sampleQueryOrAction: "Preview buy order for 1x NVDA 130 Call expiring next month",
  },

  {
    id: "alpaca-trading",
    codeId: "E2",
    number: 10,
    track: "execution",
    trackLabel: "Execution · HITL Guarded",
    title: "Direct Equities & Crypto Order Placement (Alpaca Broker API)",
    category: "brokerage",
    categoryLabel: "Brokerage",
    badge: "Direct Broker API",
    badgeColor: "blue",
    subtitle: "Places equity and cryptocurrency market, limit, and stop orders with fractional shares and extended-hours execution.",
    overview: "Places equity and cryptocurrency market, limit, and stop orders through Alpaca Securities. Supports fractional share buying, crypto trading pairs (BTC/USD, ETH/USD, SOL/USD), extended-hours session execution, and real-time buying power validation.",
    apiEndpoint: "POST /api/trading/alpaca/order · GET /api/trading/alpaca/orders",
    targetTab: "research",
    keyParameters: "side: buy|sell, type: limit|market, timeInForce: day|gtc, fractional: true",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Account & Buying Power Verification",
        description: "Checks Alpaca account status, available cash, and margin buying power before staging orders.",
      },
      {
        step: "Step 2",
        title: "Order Staging & Route Selection",
        description: "Configures fractional shares, limit prices, stop triggers, and extended-hours flags.",
      },
      {
        step: "Step 3",
        title: "Broker API Submission",
        description: "Submits order payload to Alpaca Trading API endpoint with client order identifier for idempotency.",
      },
      {
        step: "Step 4",
        title: "Fill Confirmation & Position Update",
        description: "Monitors execution fills and synchronizes new position quantities in the portfolio ledger.",
      },
    ],
    keyFeatures: [
      "Direct equity and cryptocurrency execution via Alpaca Securities.",
      "Fractional share support allowing dollar-based allocations.",
      "Extended-hours execution (pre-market and after-hours).",
      "Idempotent order placement preventing duplicate order submissions.",
    ],
    dataSources: [
      "Alpaca Orders API (api.alpaca.markets/v2/orders)",
      "Alpaca Account API (api.alpaca.markets/v2/account)",
      "Alpaca Positions API (api.alpaca.markets/v2/positions)",
    ],
    faq: {
      question: "Does Alpaca support fractional share orders?",
      answer: "Yes. Equity market orders support fractional shares by specifying notional dollar amounts (e.g. buy $50 of NVDA).",
    },
    sampleQueryOrAction: "Place market order to buy $100 of NVDA via Alpaca",
  },

  {
    id: "schedulers",
    codeId: "E3",
    number: 11,
    track: "execution",
    trackLabel: "Execution · Autonomous Daemon",
    title: "Autonomous Background Cron, Interval Alarms & Token Lifecycle",
    category: "scheduled",
    categoryLabel: "Automation",
    badge: "Cloudflare DO Alarms",
    badgeColor: "purple",
    subtitle: "24/7 background automation: auto-renews E*TRADE OAuth access tokens daily at 23:00 ET, runs scans every 5 min, and broadcasts WebSocket alerts.",
    overview: "24/7 background automation powered by Cloudflare Durable Object Alarms. Automatically renews E*TRADE OAuth access tokens daily at 23:00 ET before midnight expiration, triggers market screening scans every 5 minutes (300 seconds), processes queued async jobs, and broadcasts live alerts over WebSockets.",
    apiEndpoint: "POST /api/schedules/trigger-renew · POST /api/schedules/trigger-screen",
    targetTab: "trading",
    keyParameters: "cron: '0 23 * * *' (renew), interval: 300s (screen), keepAliveWhile: active",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Alarm Registration",
        description: "Schedules recurring Durable Object alarms using schedule() and scheduleEvery() lifecycle methods.",
      },
      {
        step: "Step 2",
        title: "OAuth Token Renewal Daemon",
        description: "Executes daily at 23:00 ET. Calls E*TRADE renew_access_token API to prevent session expiration at midnight.",
      },
      {
        step: "Step 3",
        title: "Autonomous Opportunity Scanner",
        description: "Fires every 5 minutes. Evaluates symbol baskets, filters by composite score threshold, and flags breakout candidates.",
      },
      {
        step: "Step 4",
        title: "WebSocket Broadcast & Async Job Ledger",
        description: "Pushes scan notifications over WebSockets and records execution results in mas_async_jobs.",
      },
    ],
    keyFeatures: [
      "Zero-downtime E*TRADE OAuth session maintenance without requiring re-login.",
      "Unattended market scanning across customizable ticker baskets.",
      "Fault-tolerant async job processing with automatic retry policies.",
      "Live WebSocket notifications pushed directly to active client sessions.",
    ],
    dataSources: [
      "E*TRADE OAuth Token Renewal (api.etrade.com/oauth/renew_access_token)",
      "Cloudflare Durable Object Alarm Engine",
      "Durable Async Job Ledger (mas_async_jobs)",
    ],
    faq: {
      question: "What happens if the token renewal cron misses a cycle?",
      answer: "The scheduler logs an audit alert and falls back to a 15-minute retry loop. If the token expires past midnight, the UI prompts for a fresh PIN handshake.",
    },
    sampleQueryOrAction: "Trigger manual token renewal and run autonomous options analysis",
  },

  {
    id: "omnichannel-trading",
    codeId: "E4",
    number: 12,
    track: "execution",
    trackLabel: "Execution · Multi-Gateway",
    title: "Omnichannel Execution & One-Click Approvals (Slack, Email, Voice)",
    category: "brokerage",
    categoryLabel: "Omnichannel",
    badge: "Slack, Email & Voice",
    badgeColor: "green",
    subtitle: "Interact anywhere: Slack Block Kit buttons, inbound email with .xlsx workbooks, HMAC-signed 1-click mobile approval URLs, and duplex WebSockets.",
    overview: "Multi-channel execution gateway allowing traders to interact with the platform from anywhere: Slack mentions with Block Kit visual cards, inbound email parsing with attached .xlsx workbooks, secure HMAC-signed 1-click mobile trade approval links (/trade/approve), and full-duplex WebRTC voice sessions.",
    apiEndpoint: "POST /slack/events · GET /trade/approve · POST /api/trading/reports/email",
    targetTab: "trading",
    keyParameters: "hmacSignature: sha256, approvalTtl: 300s, voiceProtocol: audio/pcm",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Channel Ingestion",
        description: "Ingests messages from Slack webhooks, Cloudflare Worker inbound email, or audio voice WebSockets.",
      },
      {
        step: "Step 2",
        title: "NLQ Intent Mapping",
        description: "The shared NLQ planner parses trade parameters and formats structured visual cards.",
      },
      {
        step: "Step 3",
        title: "Cryptographic Approval Link",
        description: "Generates tamper-proof HMAC-SHA256 one-click approval links (/trade/approve?orderId=...&sig=...).",
      },
      {
        step: "Step 4",
        title: "Omnichannel Execution & Receipt",
        description: "User clicks approval link on mobile; broker executes order and dispatches confirmation back to the channel.",
      },
    ],
    keyFeatures: [
      "Slack Block Kit cards with interactive 'Approve Trade' buttons.",
      "Email quantitative workbooks in native .xlsx format.",
      "HMAC-SHA256 signed one-click trade approval links with 5-minute expiry.",
      "Real-time voice trading over full-duplex WebSocket audio sessions.",
    ],
    dataSources: [
      "Slack Web API (chat.postMessage)",
      "Cloudflare EMAIL Worker Binding",
      "Outbound HMAC-SHA256 Webhooks (OUTBOUND_WEBHOOK_URL)",
    ],
    faq: {
      question: "How are one-click trade approval links secured against replay attacks?",
      answer: "Each approval link is signed with an HMAC-SHA256 secret, contains a unique order draft nonce, and strictly expires after 300 seconds (5 minutes).",
    },
    sampleQueryOrAction: "Dispatch trade report with .xlsx attachment to analyst@example.com",
  },

  {
    id: "micropayments",
    codeId: "E5",
    number: 13,
    track: "execution",
    trackLabel: "Execution · Settlement",
    title: "Agentic Micropayments, Gateways & x402 Protocol Settlement",
    category: "payments",
    categoryLabel: "Payments",
    badge: "HTTP 402 & Gateways",
    badgeColor: "orange",
    subtitle: "Payment intent drafting across Stripe, PayPal, Lemon Squeezy, plus HTTP 402 pay-per-query access to compute-heavy MCP tools with on-chain receipts.",
    overview: "Multi-processor payment intent drafting and execution with human confirmation across traditional gateways (Stripe, PayPal, Lemon Squeezy) and next-generation HTTP 402 (x402) pay-per-use micropayments. Enables external MCP clients to access premium scanning tools by paying $0.05 USDC per query with verifiable cryptographic receipts.",
    apiEndpoint: "POST /api/payments/create · POST /mcp/scanner (x402)",
    targetTab: "payments",
    keyParameters: "amount: $0.05 USDC, protocol: x402, chains: Base|Ethereum|Solana",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Payment Intent Drafting",
        description: "Agent creates draft payment intent with amount, currency, and recipient. Never executes without human confirmation.",
      },
      {
        step: "Step 2",
        title: "x402 Challenge Generation",
        description: "For MCP tools, responds with HTTP 402 Payment Required containing destination wallet address and price.",
      },
      {
        step: "Step 3",
        title: "Cryptographic Proof Verification",
        description: "x402Verifier verifies transaction signature on Base, Ethereum, or Solana blockchains.",
      },
      {
        step: "Step 4",
        title: "Resource Settlement & Ledgering",
        description: "Grants access to premium query and writes receipt to immutable payment ledger.",
      },
    ],
    keyFeatures: [
      "Traditional payment gateway integration: Stripe, PayPal, Lemon Squeezy.",
      "HTTP 402 pay-per-query access to compute-heavy Model Context Protocol (MCP) tools.",
      "Cryptographic ledger recording receipts and verifiable payment proofs.",
      "Human confirmation required for all outgoing payment drafts.",
    ],
    dataSources: [
      "x402 Payment Protocol & Challenge Verifier Service",
      "Decentralized blockchain RPC nodes (Base, Ethereum, Solana)",
      "W3C Decentralized Identifier (DID) cryptographic registries",
    ],
    faq: {
      question: "Can I use the platform without crypto micropayments?",
      answer: "Yes. All standard screening, options discovery, research, and brokerage features include free tiers. The x402 protocol is reserved for premium external MCP tool calls.",
    },
    sampleQueryOrAction: "View active DID credentials and test HTTP 402 payment challenge",
  },

  {
    id: "observability-audit",
    codeId: "E6",
    number: 14,
    track: "execution",
    trackLabel: "Execution · Immutable Ledger",
    title: "Enterprise Observability & Cryptographic Audit Ledger Execution",
    category: "audit",
    categoryLabel: "Audit & Telemetry",
    badge: "Cryptographic WAL",
    badgeColor: "cyan",
    subtitle: "Records immutable audit events for every system action, judge evaluation, payment lifecycle transition, order preview, and execution to SQLite WAL.",
    overview: "Records immutable audit events for every system action: routing decisions, judge evaluations, payment lifecycle transitions, order previews, and executions. Publishes events to the SQLite event store and streams telemetry to external observability collectors.",
    apiEndpoint: "GET /api/audit · POST /api/audit/event",
    targetTab: "audit",
    keyParameters: "storage: mas_events (SQLite WAL), hashChain: SHA-256, retention: 90d",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Event Interception",
        description: "Aspect-oriented logging aspects intercept function execution, recording timing, inputs, and outcomes.",
      },
      {
        step: "Step 2",
        title: "Cryptographic Hash Chaining",
        description: "Each event is hashed with SHA-256 and chained to previous event hashes to guarantee immutability.",
      },
      {
        step: "Step 3",
        title: "SQLite WAL Commitment",
        description: "Writes event records to mas_events transactional table in Durable Object SQLite storage.",
      },
      {
        step: "Step 4",
        title: "Telemetry Stream & UI Ledger",
        description: "Streams events to UI audit viewer and external log telemetry endpoints in real time.",
      },
    ],
    keyFeatures: [
      "Cryptographically verifiable audit log of all agent routing decisions and order previews.",
      "Aspect-oriented error logging with externalized error codes and remediation guides.",
      "Real-time event streaming over WebSockets to client UI.",
      "Zero data loss with Durable Object SQLite Write-Ahead Logging (WAL).",
    ],
    dataSources: [
      "SQLite Transactional WAL Store (mas_events)",
      "Cloudflare Workers Telemetry & Metrics",
      "Aspect-Oriented Logging Engine (src/aspects/loggingAspect.ts)",
    ],
    faq: {
      question: "Are audit events preserved if the browser disconnects?",
      answer: "Yes. All audit events are stored persistently in the server-side Cloudflare Durable Object SQLite database and survive browser reloads.",
    },
    sampleQueryOrAction: "Inspect recent audit logs for order preview and judge routing events",
  },
];

export interface WorkflowsHubProps {
  onNavigateTab?: (tab: string) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

export function WorkflowsHub({ onNavigateTab, onSendPrompt }: WorkflowsHubProps) {
  // Primary Navigation
  const [activeTab, setActiveTab] = useState<"faq" | "workflows" | "decisioning" | "matrix" | "improvements">("faq");

  // Workflows Tab State
  const [trackFilter, setTrackFilter] = useState<"all" | "analysis" | "execution">("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string>("stock-screener");

  // FAQs Tab State
  const [faqCategory, setFaqCategory] = useState<string>("all");
  const [faqSearchQuery, setFaqSearchQuery] = useState<string>("");
  const [expandedFaqId, setExpandedFaqId] = useState<string>("best-opportunities");

  // Decisioning Logic Tab State
  const [decisioningSearchQuery, setDecisioningSearchQuery] = useState<string>("");
  const [expandedDecisioningId, setExpandedDecisioningId] = useState<string>("stock-screener-logic");

  // Capability Matrix Search
  const [matrixSearchQuery, setMatrixSearchQuery] = useState<string>("");

  const categories = [
    { id: "all", label: "All Categories" },
    { id: "stocks", label: "📈 Equities" },
    { id: "options", label: "🎯 Options" },
    { id: "flows", label: "🌊 Market Flows" },
    { id: "risk", label: "🛡️ Risk & Hedging" },
    { id: "research", label: "🔬 FOSS Research" },
    { id: "brokerage", label: "🤖 Brokerage" },
    { id: "scheduled", label: "⏰ Automation" },
    { id: "nlq", label: "💬 NLQ & Chat" },
    { id: "payments", label: "💳 Payments" },
    { id: "audit", label: "📋 Audit" },
  ];

  const faqCategories = [
    { id: "all", label: "All Questions (8)" },
    { id: "opportunities", label: "🏆 Opportunities" },
    { id: "budget-risk", label: "💰 Budget & Max Loss" },
    { id: "chance-return", label: "🎯 Chance vs Return" },
    { id: "combinations", label: "🦋 Combinations" },
    { id: "liquidity", label: "💧 Volatility & Liquidity" },
    { id: "directional", label: "🚀 Bullish & Bearish" },
    { id: "defined-risk", label: "🛡️ Defined Risk" },
    { id: "least-risk", label: "🔒 Least Risk" },
  ];

  const filteredWorkflows = useMemo(() => {
    return PLATFORM_WORKFLOWS.filter((wf) => {
      const matchesTrack = trackFilter === "all" || wf.track === trackFilter;
      const matchesCategory = selectedCategory === "all" || wf.category === selectedCategory;
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        wf.codeId.toLowerCase().includes(q) ||
        wf.title.toLowerCase().includes(q) ||
        wf.subtitle.toLowerCase().includes(q) ||
        wf.overview.toLowerCase().includes(q) ||
        (wf.keyParameters && wf.keyParameters.toLowerCase().includes(q)) ||
        wf.keyFeatures.some((f) => f.toLowerCase().includes(q)) ||
        wf.steps.some((s) => s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) ||
        wf.faq.question.toLowerCase().includes(q) ||
        wf.faq.answer.toLowerCase().includes(q);

      return matchesTrack && matchesCategory && matchesSearch;
    });
  }, [trackFilter, selectedCategory, searchQuery]);

  const filteredFaqs = useMemo(() => {
    return FAQ_QUESTIONS.filter((faq) => {
      const matchesCategory = faqCategory === "all" || faq.category === faqCategory;
      const q = faqSearchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        faq.question.toLowerCase().includes(q) ||
        faq.summary.toLowerCase().includes(q) ||
        (faq.quickTakeaway && faq.quickTakeaway.toLowerCase().includes(q)) ||
        faq.theoreticalContext.toLowerCase().includes(q) ||
        faq.keyParameters.toLowerCase().includes(q) ||
        (faq.parameterBadges && faq.parameterBadges.some((p) => p.label.toLowerCase().includes(q) || p.value.toLowerCase().includes(q))) ||
        faq.methods.some((m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));

      return matchesCategory && matchesSearch;
    });
  }, [faqCategory, faqSearchQuery]);

  const filteredDecisioning = useMemo(() => {
    return DECISIONING_SECTIONS.filter((sec) => {
      const q = decisioningSearchQuery.toLowerCase().trim();
      if (!q) return true;
      return (
        sec.title.toLowerCase().includes(q) ||
        sec.subtitle.toLowerCase().includes(q) ||
        sec.overview.toLowerCase().includes(q) ||
        (sec.governedWorkflows && sec.governedWorkflows.some((gw) => gw.toLowerCase().includes(q))) ||
        sec.rules.some(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.description.toLowerCase().includes(q) ||
            (r.formulaOrCode && r.formulaOrCode.toLowerCase().includes(q)) ||
            (r.parametersOrGates && r.parametersOrGates.some((p) => p.toLowerCase().includes(q)))
        ) ||
        (sec.matrixOrWeights && sec.matrixOrWeights.some((m) => m.dimension.toLowerCase().includes(q) || m.details.toLowerCase().includes(q))) ||
        (sec.concreteExample && (sec.concreteExample.title.toLowerCase().includes(q) || sec.concreteExample.evaluation.toLowerCase().includes(q)))
      );
    });
  }, [decisioningSearchQuery]);

  const filteredMatrix = useMemo(() => {
    const q = matrixSearchQuery.toLowerCase().trim();
    if (!q) return CAPABILITY_MATRIX;
    return CAPABILITY_MATRIX.filter(
      (row) =>
        row.question.toLowerCase().includes(q) ||
        row.primaryWorkflow.toLowerCase().includes(q) ||
        row.secondaryWorkflow.toLowerCase().includes(q) ||
        row.keyInputParameter.toLowerCase().includes(q) ||
        row.optimalOutputStructure.toLowerCase().includes(q)
    );
  }, [matrixSearchQuery]);

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? "" : id));
  };

  const toggleExpandFaq = (id: string) => {
    setExpandedFaqId((prev) => (prev === id ? "" : id));
  };

  const toggleExpandDecisioning = (id: string) => {
    setExpandedDecisioningId((prev) => (prev === id ? "" : id));
  };

  const jumpToDecisionRule = (ruleId: string) => {
    setActiveTab("decisioning");
    setExpandedDecisioningId(ruleId);
  };

  return (
    <div className="workflows-hub-container">
      {/* Hero Header */}
      <div className="workflows-hero">
        <div className="workflows-hero-top">
          <div className="workflows-hero-title-group">
            <div className="workflows-hero-icon">🧭</div>
            <div>
              <h1 className="workflows-hero-title">Platform Workflows, Playbooks &amp; Solutions Hub</h1>
              <p className="workflows-hero-subtitle">
                Authoritative architectural specification of all 14 operational workflows (8 Analysis · 6 Execution), step-by-step playbooks for the 8 core quantitative scenarios, algorithmic decision rules, and capability lookup matrix.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Metrics Bar */}
      <div className="workflows-stats-bar">
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Core Workflows</span>
          <span className="workflows-stat-value">14 End-to-End</span>
          <span className="workflows-stat-desc">8 Analysis (A1–A8) · 6 Execution (E1–E6)</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Quantitative Playbooks</span>
          <span className="workflows-stat-value">8 Scenarios</span>
          <span className="workflows-stat-desc">24 Step-by-Step Multi-Path Solutions</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Decisioning Engines</span>
          <span className="workflows-stat-value">6 Deterministic Models</span>
          <span className="workflows-stat-desc">Mathematical formulations &amp; 15 rejection gates</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Execution Guardrails</span>
          <span className="workflows-stat-value">100% HITL Safe</span>
          <span className="workflows-stat-desc">W3C DID attestation &amp; mandatory confirmation</span>
        </div>
      </div>

      {/* Primary Sub-Navigation Tabs */}
      <div className="workflows-subnav-bar" style={{ display: "flex", gap: "0.5rem", margin: "1rem 0 1.5rem", borderBottom: "1px solid rgba(255, 255, 255, 0.1)", paddingBottom: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          className={`workflows-nav-tab ${activeTab === "faq" ? "active" : ""}`}
          onClick={() => setActiveTab("faq")}
        >
          💡 Quantitative Playbooks (8 Core FAQs)
        </button>
        <button
          type="button"
          className={`workflows-nav-tab ${activeTab === "workflows" ? "active" : ""}`}
          onClick={() => setActiveTab("workflows")}
        >
          🧭 Platform Workflows (14 Track A &amp; E)
        </button>
        <button
          type="button"
          className={`workflows-nav-tab ${activeTab === "decisioning" ? "active" : ""}`}
          onClick={() => setActiveTab("decisioning")}
        >
          ⚖️ Algorithmic Decisioning Rules (6 Engines)
        </button>
        <button
          type="button"
          className={`workflows-nav-tab ${activeTab === "matrix" ? "active" : ""}`}
          onClick={() => setActiveTab("matrix")}
        >
          📋 Capability &amp; Lookup Matrix
        </button>
        <button
          type="button"
          className={`workflows-nav-tab ${activeTab === "improvements" ? "active" : ""}`}
          onClick={() => setActiveTab("improvements")}
        >
          🚀 Optimization Roadmap (6 Enhancements)
        </button>
      </div>

      {/* VIEW 1: QUANTITATIVE PLAYBOOKS & FAQS (THE 8 CORE QUESTIONS) */}
      {activeTab === "faq" && (
        <div className="faq-section-container" style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* FAQ Search & Category Filter */}
          <div className="workflows-filter-strip">
            <div className="workflows-search-box">
              <span className="workflows-search-icon">🔍</span>
              <input
                type="text"
                className="workflows-search-input"
                placeholder="Search scenarios, parameters, execution methods, formulas, or tickers…"
                value={faqSearchQuery}
                onChange={(e) => setFaqSearchQuery(e.target.value)}
              />
            </div>
            <div className="workflows-category-chips">
              {faqCategories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className={`workflows-cat-chip ${faqCategory === cat.id ? "active" : ""}`}
                  onClick={() => setFaqCategory(cat.id)}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Accordion List of the 8 Core Questions */}
          <div className="workflows-grid">
            {filteredFaqs.map((faq) => {
              const isOpen = expandedFaqId === faq.id;
              return (
                <div key={faq.id} className={`faq-accordion-card ${isOpen ? "open" : ""}`}>
                  <div className="faq-card-header" onClick={() => toggleExpandFaq(faq.id)}>
                    <div className="workflow-header-left">
                      <div className="workflow-number-badge" style={{ background: "rgba(56, 189, 248, 0.15)", color: "#38bdf8", border: "1px solid rgba(56, 189, 248, 0.3)" }}>
                        Q0{faq.number}
                      </div>
                      <div className="workflow-header-titles">
                        <h3 className="workflow-title" style={{ fontSize: "1.05rem" }}>
                          &ldquo;{faq.question}&rdquo;
                          <span className="workflow-tag-badge blue">{faq.categoryLabel}</span>
                        </h3>
                        <p className="workflow-subtitle">{faq.summary}</p>
                      </div>
                    </div>
                    <div className="workflow-header-right">
                      <span className="workflow-expand-caret">{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="faq-card-body">
                      {/* Quick Takeaway Banner */}
                      {faq.quickTakeaway && (
                        <div className="faq-quick-takeaway">
                          <span className="faq-quick-takeaway-label">
                            <span>⚡</span> Quick Solution &amp; Recommended Action (TL;DR)
                          </span>
                          <span className="faq-quick-takeaway-text">{faq.quickTakeaway}</span>
                        </div>
                      )}

                      {/* Key Parameter Badges Row */}
                      {faq.parameterBadges && faq.parameterBadges.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                          <span style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#94a3b8", fontWeight: 700 }}>
                            ⚙️ Key Input Parameters &amp; Filter Settings
                          </span>
                          <div className="faq-param-badges">
                            {faq.parameterBadges.map((badge, bIdx) => (
                              <div key={bIdx} className="faq-param-badge" title={badge.hint}>
                                <span className="faq-param-badge-label">{badge.label}:</span>
                                <span className="faq-param-badge-val">{badge.value}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 3 Distinct Execution Methods */}
                      <div>
                        <h4 style={{ fontSize: "0.82rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#38bdf8", margin: "0 0 0.75rem 0" }}>
                          🚀 Multi-Method Execution Paths (3 Ways to Run)
                        </h4>
                        <div className="faq-methods-grid">
                          {faq.methods.map((method, mIdx) => (
                            <div key={mIdx} className="faq-method-card">
                              <div className="faq-method-header">
                                <span className="faq-method-title">{method.name}</span>
                                <span className={`workflow-tag-badge ${method.badgeColor}`}>{method.badge}</span>
                              </div>
                              <p className="faq-method-desc">{method.description}</p>
                              <ul className="faq-method-steps">
                                {method.actionSteps.map((step, sIdx) => (
                                  <li key={sIdx}>
                                    <span className="bullet">▸</span>
                                    <span>{step}</span>
                                  </li>
                                ))}
                              </ul>
                              {method.samplePayloadOrCommand && (
                                <div className="faq-method-code">
                                  {method.samplePayloadOrCommand}
                                </div>
                              )}
                              <div style={{ marginTop: "auto", paddingTop: "0.5rem", display: "flex", gap: "0.4rem" }}>
                                {method.targetTab && onNavigateTab && method.targetTab !== "chat" && (
                                  <button
                                    type="button"
                                    className="workflow-cta-btn"
                                    style={{ padding: "0.25rem 0.55rem", fontSize: "0.74rem" }}
                                    onClick={() => onNavigateTab(method.targetTab!)}
                                  >
                                    Open Tab →
                                  </button>
                                )}
                                {onSendPrompt && (
                                  <button
                                    type="button"
                                    className="workflow-cta-btn"
                                    style={{ padding: "0.25rem 0.55rem", fontSize: "0.74rem", background: "rgba(30, 41, 59, 0.8)", border: "1px solid rgba(56, 189, 248, 0.4)", color: "#38bdf8" }}
                                    onClick={() => onSendPrompt(method.samplePayloadOrCommand || faq.samplePrompt, faq.question)}
                                  >
                                    Ask Agent 💬
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Optimal Output Structure Callout */}
                      <div style={{ background: "rgba(15, 23, 42, 0.7)", border: "1px solid rgba(255, 255, 255, 0.08)", borderRadius: "8px", padding: "0.85rem 1rem", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
                        <div>
                          <div style={{ fontSize: "0.72rem", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>
                            🎯 Expected Visual Output Structure
                          </div>
                          <div style={{ fontSize: "0.85rem", color: "#f8fafc", marginTop: "0.2rem" }}>
                            {faq.optimalOutputStructure}
                          </div>
                        </div>
                        {faq.relatedDecisionRuleId && (
                          <button
                            type="button"
                            className="workflow-rule-link"
                            onClick={() => jumpToDecisionRule(faq.relatedDecisionRuleId!)}
                          >
                            <span>⚖️</span> View Governing Decision Rule →
                          </button>
                        )}
                      </div>

                      {/* Collapsible Theoretical & Mathematical Deep-Dive */}
                      <details className="faq-theory-accordion">
                        <summary className="faq-theory-summary">
                          <span>📐 Quantitative Theory &amp; Mathematical Formulation (Expand / Collapse)</span>
                          <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>▼</span>
                        </summary>
                        <div className="faq-theory-inner">
                          <div className="faq-theory-content">
                            {faq.theoreticalContext}
                          </div>
                          {faq.mathematicalBasis && (
                            <div className="faq-formula-badge">
                              Exact Formula: {faq.mathematicalBasis}
                            </div>
                          )}
                        </div>
                      </details>

                      {/* Action Footer */}
                      <div className="workflow-action-footer">
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                          <span style={{ fontSize: "0.78rem", color: "#94a3b8" }}>Primary Workflow:</span>
                          <span className="workflow-tag-badge green">{faq.primaryWorkflow}</span>
                          <span style={{ fontSize: "0.78rem", color: "#94a3b8" }}>Secondary:</span>
                          <span className="workflow-tag-badge blue">{faq.secondaryWorkflow}</span>
                        </div>

                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button
                            type="button"
                            className="workflow-cta-btn"
                            onClick={() => {
                              if (onNavigateTab) {
                                onNavigateTab(faq.targetTab);
                              }
                            }}
                          >
                            Open in Platform →
                          </button>

                          {onSendPrompt && (
                            <button
                              type="button"
                              className="workflow-cta-btn"
                              style={{ background: "rgba(30, 41, 59, 0.8)", border: "1px solid rgba(56, 189, 248, 0.4)", color: "#38bdf8" }}
                              onClick={() => {
                                onSendPrompt(faq.samplePrompt, faq.question);
                              }}
                              title="Ask AI Agent in chat"
                            >
                              Ask AI Agent 💬
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* VIEW 2: PLATFORM WORKFLOWS (ALL 14 ANALYSIS & EXECUTION WORKFLOWS) */}
      {activeTab === "workflows" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* Track Filter Tabs */}
          <div className="workflow-track-tabs">
            <span style={{ fontSize: "0.8rem", color: "#94a3b8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginRight: "0.3rem" }}>
              Operational Track:
            </span>
            <button
              type="button"
              className={`workflow-track-btn ${trackFilter === "all" ? "active" : ""}`}
              onClick={() => setTrackFilter("all")}
            >
              All Workflows (14)
            </button>
            <button
              type="button"
              className={`workflow-track-btn ${trackFilter === "analysis" ? "active" : ""}`}
              onClick={() => setTrackFilter("analysis")}
            >
              📊 Analysis Track (A1–A8)
            </button>
            <button
              type="button"
              className={`workflow-track-btn ${trackFilter === "execution" ? "active" : ""}`}
              onClick={() => setTrackFilter("execution")}
            >
              ⚡ Execution Track (E1–E6)
            </button>
          </div>

          {/* Search & Category Filter Strip */}
          <div className="workflows-filter-strip">
            <div className="workflows-search-box">
              <span className="workflows-search-icon">🔍</span>
              <input
                type="text"
                className="workflows-search-input"
                placeholder="Search workflows by code (A1..E6), name, APIs, endpoints, or parameters…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="workflows-category-chips">
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className={`workflows-cat-chip ${selectedCategory === cat.id ? "active" : ""}`}
                  onClick={() => setSelectedCategory(cat.id)}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Workflow Accordion List */}
          <div className="workflows-grid">
            {filteredWorkflows.map((wf) => {
              const isOpen = expandedId === wf.id;

              return (
                <div key={wf.id} className={`workflow-card ${isOpen ? "open" : ""}`}>
                  {/* Card Header (Click to toggle) */}
                  <div className="workflow-card-header" onClick={() => toggleExpand(wf.id)}>
                    <div className="workflow-header-left">
                      <div className={`workflow-code-badge ${wf.track}`}>
                        {wf.codeId}
                      </div>
                      <div className="workflow-header-titles">
                        <h3 className="workflow-title">
                          {wf.title}
                          <span className={`workflow-track-pill ${wf.track}`}>{wf.trackLabel}</span>
                          <span className={`workflow-tag-badge ${wf.badgeColor}`}>{wf.badge}</span>
                        </h3>
                        <p className="workflow-subtitle">{wf.subtitle}</p>
                      </div>
                    </div>

                    <div className="workflow-header-right">
                      <span className="workflow-expand-caret">{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  {/* Card Body (Expanded view) */}
                  {isOpen && (
                    <div className="workflow-card-body">
                      {/* Overview text */}
                      <p style={{ fontSize: "0.86rem", color: "#cbd5e1", lineHeight: 1.5, margin: 0 }}>
                        {wf.overview}
                      </p>

                      {/* Key Parameters Banner */}
                      {wf.keyParameters && (
                        <div style={{ background: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(56, 189, 248, 0.2)", borderRadius: "6px", padding: "0.6rem 0.9rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
                          <span style={{ fontSize: "0.78rem", color: "#94a3b8" }}>
                            ⚙️ <strong style={{ color: "#38bdf8" }}>Primary Parameters:</strong> <code style={{ color: "#f8fafc" }}>{wf.keyParameters}</code>
                          </span>
                          {wf.governingDecisionRuleId && (
                            <button
                              type="button"
                              className="workflow-rule-link"
                              onClick={() => jumpToDecisionRule(wf.governingDecisionRuleId!)}
                            >
                              <span>⚖️</span> Governing Decision Rule →
                            </button>
                          )}
                        </div>
                      )}

                      {/* Flowchart Timeline */}
                      <div>
                        <h4 style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#38bdf8", margin: "0 0 0.75rem 0" }}>
                          ⚡ Step-by-Step Execution Pipeline
                        </h4>
                        <div className="workflow-timeline">
                          {wf.steps.map((step, idx) => (
                            <div key={idx} className="workflow-step-node">
                              <span className="workflow-step-num">{step.step}</span>
                              <span className="workflow-step-title">{step.title}</span>
                              <p className="workflow-step-desc">{step.description}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Details Grid: Features & Data Sources */}
                      <div className="workflow-details-grid">
                        <div className="workflow-subpanel">
                          <h5 className="workflow-subpanel-title">
                            <span>✨</span> Architectural Highlights
                          </h5>
                          <ul className="workflow-feature-list">
                            {wf.keyFeatures.map((feat, idx) => (
                              <li key={idx}>
                                <span className="workflow-feature-bullet">▸</span>
                                <span>{feat}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        <div className="workflow-subpanel">
                          <h5 className="workflow-subpanel-title">
                            <span>🌐</span> Upstream Sites &amp; APIs Queried
                          </h5>
                          <ul className="workflow-feature-list">
                            {wf.dataSources.map((ds, idx) => (
                              <li key={idx}>
                                <span className="workflow-feature-bullet">🔗</span>
                                <span>{ds}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      {/* Upstream APIs & Cloudflare Metrics Breakdown */}
                      {wf.apiMetrics && wf.apiMetrics.length > 0 && (
                        <div className="workflow-api-metrics-panel" style={{ marginTop: "0.5rem", background: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(56, 189, 248, 0.25)", borderRadius: "8px", padding: "1rem" }}>
                          <h5 style={{ margin: "0 0 0.75rem", color: "#38bdf8", fontSize: "0.85rem", textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <span>📊</span> Upstream Subrequests &amp; Cloudflare Worker API Metrics
                          </h5>
                          <div style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse", color: "#e2e8f0" }}>
                              <thead>
                                <tr style={{ borderBottom: "1px solid rgba(255, 255, 255, 0.12)", textAlign: "left", color: "#94a3b8" }}>
                                  <th style={{ padding: "0.4rem 0.6rem" }}>Host / Endpoint</th>
                                  <th style={{ padding: "0.4rem 0.6rem" }}>2xx</th>
                                  <th style={{ padding: "0.4rem 0.6rem" }}>4xx</th>
                                  <th style={{ padding: "0.4rem 0.6rem" }}>Latency</th>
                                  <th style={{ padding: "0.4rem 0.6rem" }}>Role &amp; How It Is Used</th>
                                </tr>
                              </thead>
                              <tbody>
                                {wf.apiMetrics.map((metric, mIdx) => (
                                  <tr key={mIdx} style={{ borderBottom: "1px solid rgba(255, 255, 255, 0.05)" }}>
                                    <td style={{ padding: "0.5rem 0.6rem", fontFamily: "monospace", color: "#38bdf8", fontWeight: 600 }}>{metric.host}</td>
                                    <td style={{ padding: "0.5rem 0.6rem", color: "#4ade80", fontWeight: 600 }}>{metric.status2xx}</td>
                                    <td style={{ padding: "0.5rem 0.6rem", color: metric.status4xx ? "#f87171" : "#94a3b8" }}>{metric.status4xx}</td>
                                    <td style={{ padding: "0.5rem 0.6rem", color: "#cbd5e1" }}>{metric.avgDuration}</td>
                                    <td style={{ padding: "0.5rem 0.6rem" }}>
                                      <div style={{ fontWeight: 600, color: "#f8fafc", marginBottom: "0.2rem" }}>{metric.role}</div>
                                      <div style={{ color: "#94a3b8", fontSize: "0.76rem", lineHeight: 1.4 }}>{metric.usageDetails}</div>
                                      <div style={{ color: "#fbbf24", fontSize: "0.73rem", marginTop: "0.25rem", fontStyle: "italic" }}>💡 {metric.nuanceExplanation}</div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* FAQ & Gotchas Callout Box */}
                      <div className="workflow-faq-box">
                        <div className="workflow-faq-question">💡 Key Nuance: {wf.faq.question}</div>
                        <p className="workflow-faq-answer">{wf.faq.answer}</p>
                      </div>

                      {/* Action Footer */}
                      <div className="workflow-action-footer">
                        <div className="workflow-api-path">
                          API: <code>{wf.apiEndpoint}</code>
                        </div>

                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button
                            type="button"
                            className="workflow-cta-btn"
                            onClick={() => {
                              if (onNavigateTab) {
                                onNavigateTab(wf.targetTab);
                              }
                            }}
                          >
                            Open in Platform →
                          </button>

                          {onSendPrompt && (
                            <button
                              type="button"
                              className="workflow-cta-btn"
                              style={{ background: "rgba(30, 41, 59, 0.8)", border: "1px solid rgba(56, 189, 248, 0.4)", color: "#38bdf8" }}
                              onClick={() => {
                                onSendPrompt(wf.sampleQueryOrAction, wf.title);
                              }}
                              title="Send sample query to AI agent in chat"
                            >
                              Ask AI Agent 💬
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {filteredWorkflows.length === 0 && (
              <div style={{ textAlign: "center", padding: "3rem 1rem", color: "#64748b" }}>
                <p style={{ fontSize: "1.2rem", margin: "0 0 0.5rem 0" }}>🔍 No workflows match your search query.</p>
                <p style={{ fontSize: "0.85rem", margin: 0 }}>Try clearing filters or search for terms like &quot;A1&quot;, &quot;E1&quot;, &quot;options&quot;, &quot;screener&quot;, &quot;hitl&quot;, or &quot;nasdaq&quot;.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* VIEW 3: ALGORITHMIC DECISIONING RULES (6 ENGINES) */}
      {activeTab === "decisioning" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* Decisioning Hero Note */}
          <div style={{ background: "rgba(6, 182, 212, 0.08)", border: "1px solid rgba(6, 182, 212, 0.3)", borderRadius: "10px", padding: "1.25rem 1.5rem" }}>
            <h4 style={{ margin: "0 0 0.5rem", color: "#22d3ee", fontSize: "1.05rem" }}>
              📐 Deterministic Decision Logic, Scoring Equations &amp; Selection Gates (6 Engines)
            </h4>
            <p style={{ margin: 0, color: "#cbd5e1", fontSize: "0.86rem", lineHeight: 1.55 }}>
              Comprehensive documentation of the mathematical formulas, boundary constraints, sorting comparators, and automated safety gates powering the Stock Screener (A1), Options Screener (A3), Strategy Engine (A2), Recommendation Agent (<code>pickBestTrades</code>), and live Brokerage Handshake (E1).
            </p>
          </div>

          {/* Search Strip */}
          <div className="workflows-filter-strip">
            <div className="workflows-search-box">
              <span className="workflows-search-icon">🔍</span>
              <input
                type="text"
                className="workflows-search-input"
                placeholder="Search decision rules, scoring weights, formulas, or rejection codes…"
                value={decisioningSearchQuery}
                onChange={(e) => setDecisioningSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {/* Decisioning Sections Grid */}
          <div className="workflows-grid">
            {filteredDecisioning.map((sec) => {
              const isOpen = expandedDecisioningId === sec.id;
              return (
                <div key={sec.id} className={`workflow-card ${isOpen ? "open" : ""}`}>
                  <div className="workflow-card-header" onClick={() => toggleExpandDecisioning(sec.id)}>
                    <div className="workflow-header-left">
                      <div className="workflow-number-badge" style={{ background: "rgba(6, 182, 212, 0.15)", color: "#22d3ee", border: "1px solid rgba(6, 182, 212, 0.3)" }}>
                        0{sec.number}
                      </div>
                      <div className="workflow-header-titles">
                        <h3 className="workflow-title">
                          {sec.title}
                          <span className={`workflow-tag-badge ${sec.badgeColor}`}>{sec.badge}</span>
                          {sec.governedWorkflows && (
                            <span style={{ fontSize: "0.7rem", fontFamily: "monospace", color: "#22d3ee", background: "rgba(6, 182, 212, 0.15)", padding: "0.15rem 0.45rem", borderRadius: "4px" }}>
                              Governs: {sec.governedWorkflows.join(", ")}
                            </span>
                          )}
                        </h3>
                        <p className="workflow-subtitle">{sec.subtitle}</p>
                      </div>
                    </div>
                    <div className="workflow-header-right">
                      <span className="workflow-expand-caret">{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="workflow-card-body">
                      {/* Overview Box */}
                      <p style={{ fontSize: "0.88rem", color: "#cbd5e1", lineHeight: 1.55, margin: 0 }}>
                        {sec.overview}
                      </p>

                      {/* Rules Grid */}
                      <div>
                        <h4 style={{ fontSize: "0.82rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#22d3ee", margin: "0 0 0.75rem 0" }}>
                          ⚙️ Mathematical Rules, Constraints &amp; Algorithmic Gates
                        </h4>
                        <div className="decisioning-rules-grid">
                          {sec.rules.map((rule, rIdx) => (
                            <div key={rIdx} className="decisioning-rule-card">
                              <div className="decisioning-rule-title">
                                <span>⚡</span> {rule.name}
                              </div>
                              <p className="decisioning-rule-desc">{rule.description}</p>
                              
                              {rule.formulaOrCode && (
                                <div className="decisioning-code-block">
                                  {rule.formulaOrCode}
                                </div>
                              )}

                              {rule.parametersOrGates && rule.parametersOrGates.length > 0 && (
                                <div className="decisioning-param-list">
                                  {rule.parametersOrGates.map((param, pIdx) => (
                                    <div key={pIdx} className="decisioning-param-item">
                                      <span style={{ color: "#22d3ee" }}>▸</span>
                                      <span>{param}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Matrix / Weights Table (if present) */}
                      {sec.matrixOrWeights && sec.matrixOrWeights.length > 0 && (
                        <div style={{ background: "rgba(15, 23, 42, 0.8)", border: "1px solid rgba(255, 255, 255, 0.08)", borderRadius: "8px", padding: "1rem" }}>
                          <h4 style={{ margin: "0 0 0.6rem", color: "#38bdf8", fontSize: "0.84rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            📊 Dimension Weightings &amp; Profile Matrix
                          </h4>
                          <div style={{ overflowX: "auto" }}>
                            <table className="faq-matrix-table" style={{ fontSize: "0.78rem" }}>
                              <thead>
                                <tr>
                                  <th>Profile / Dimension</th>
                                  <th>Weight Distribution / Formula</th>
                                  <th>Strategic Behavior &amp; Tradeoff</th>
                                </tr>
                              </thead>
                              <tbody>
                                {sec.matrixOrWeights.map((row, mIdx) => (
                                  <tr key={mIdx}>
                                    <td style={{ fontWeight: 600, color: "#ffffff" }}>{row.dimension}</td>
                                    <td style={{ fontFamily: "monospace", color: "#38bdf8" }}>{row.weightOrValue}</td>
                                    <td style={{ color: "#cbd5e1" }}>{row.details}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* Concrete Example Box */}
                      {sec.concreteExample && (
                        <div className="decisioning-example-box">
                          <div className="decisioning-example-header">
                            <span>🧪</span> Real Production Example: {sec.concreteExample.title}
                          </div>
                          <div className="decisioning-example-step">
                            <span className="label">📥 Input:</span>
                            <span className="val">{sec.concreteExample.input}</span>
                          </div>
                          <div className="decisioning-example-step">
                            <span className="label">⚙️ Engine:</span>
                            <span className="val">{sec.concreteExample.evaluation}</span>
                          </div>
                          <div className="decisioning-example-step">
                            <span className="label" style={{ color: "#4ade80" }}>🎯 Verdict:</span>
                            <span className="val" style={{ color: "#86efac", fontWeight: 600 }}>{sec.concreteExample.verdict}</span>
                          </div>
                        </div>
                      )}

                      {/* Action Footer */}
                      <div className="workflow-action-footer">
                        <div className="workflow-api-path">
                          Architecture: <code>src/trading/options/ · src/client/options/</code>
                        </div>

                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          {onSendPrompt && (
                            <button
                              type="button"
                              className="workflow-cta-btn"
                              style={{ background: "rgba(30, 41, 59, 0.8)", border: "1px solid rgba(6, 182, 212, 0.4)", color: "#22d3ee" }}
                              onClick={() => {
                                onSendPrompt(`Explain the decision logic and scoring for ${sec.title}`, sec.title);
                              }}
                            >
                              Ask AI Agent 💬
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* VIEW 4: CAPABILITY & LOOKUP MATRIX */}
      {activeTab === "matrix" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* Matrix Header Callout */}
          <div style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.3)", borderRadius: "10px", padding: "1.25rem 1.5rem" }}>
            <h4 style={{ margin: "0 0 0.5rem", color: "#38bdf8", fontSize: "1.05rem" }}>
              📊 Interactive Capability &amp; Lookup Matrix
            </h4>
            <p style={{ margin: 0, color: "#cbd5e1", fontSize: "0.86rem", lineHeight: 1.55 }}>
              Quick architectural reference showing which platform workflow is best suited to answer each question, key input parameters, and ideal visual output structures. Click &quot;Try Now&quot; to jump directly into the target platform tab.
            </p>
          </div>

          {/* Matrix Search */}
          <div className="workflows-filter-strip">
            <div className="workflows-search-box">
              <span className="workflows-search-icon">🔍</span>
              <input
                type="text"
                className="workflows-search-input"
                placeholder="Search capability matrix by question, workflow, or parameter…"
                value={matrixSearchQuery}
                onChange={(e) => setMatrixSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {/* Matrix Table */}
          <div className="faq-matrix-container" style={{ marginTop: 0 }}>
            <div style={{ overflowX: "auto" }}>
              <table className="faq-matrix-table">
                <thead>
                  <tr>
                    <th>User Question / Scenario</th>
                    <th>Primary Workflow</th>
                    <th>Secondary Workflow</th>
                    <th>Key Input Parameter</th>
                    <th>Optimal Output Structure</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMatrix.map((row, rIdx) => (
                    <tr key={rIdx}>
                      <td style={{ fontWeight: 600, color: "#ffffff" }}>&ldquo;{row.question}&rdquo;</td>
                      <td><span className="workflow-tag-badge green">{row.primaryWorkflow}</span></td>
                      <td><span className="workflow-tag-badge blue">{row.secondaryWorkflow}</span></td>
                      <td style={{ fontFamily: "monospace", color: "#38bdf8", fontSize: "0.76rem" }}>{row.keyInputParameter}</td>
                      <td style={{ color: "#cbd5e1" }}>{row.optimalOutputStructure}</td>
                      <td>
                        <button
                          type="button"
                          className="workflow-cta-btn"
                          style={{ padding: "0.25rem 0.6rem", fontSize: "0.74rem" }}
                          onClick={() => {
                            if (onNavigateTab) {
                              onNavigateTab(row.targetTab);
                            }
                          }}
                        >
                          Try Now →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 5: WORKFLOW IMPROVEMENTS & ARCHITECTURAL ROADMAP */}
      {activeTab === "improvements" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* Architectural Analysis Hero Note */}
          <div style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.3)", borderRadius: "10px", padding: "1.25rem 1.5rem" }}>
            <h4 style={{ margin: "0 0 0.5rem", color: "#38bdf8", fontSize: "1.05rem" }}>
              🏗️ Architectural Optimization Roadmap (Pure Analysis &amp; Design)
            </h4>
            <p style={{ margin: 0, color: "#cbd5e1", fontSize: "0.86rem", lineHeight: 1.55 }}>
              To elevate the platform from a single-symbol screener to an institutional-grade algorithmic execution system that answers complex multi-constraint questions optimally, the following 6 architectural enhancements have been formulated. These recommendations analyze cross-sectional batching, Pareto multi-objective optimization, declarative constraint solvers, and volatility surface modeling.
            </p>
          </div>

          {/* Styled Architecture Flowchart Diagram */}
          <div style={{ background: "rgba(15, 23, 42, 0.8)", border: "1px solid rgba(255, 255, 255, 0.08)", borderRadius: "10px", padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#38bdf8", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              📐 System Optimization Flowchart
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem", padding: "0.5rem 0" }}>
              <div style={{ background: "rgba(30, 41, 59, 0.8)", padding: "0.6rem 0.9rem", borderRadius: "8px", border: "1px solid rgba(56, 189, 248, 0.3)", fontSize: "0.8rem", color: "#f8fafc" }}>
                1. Natural Language / Multi-Constraint Query
              </div>
              <span style={{ color: "#38bdf8", fontSize: "1.2rem" }}>➔</span>
              <div style={{ background: "rgba(30, 41, 59, 0.8)", padding: "0.6rem 0.9rem", borderRadius: "8px", border: "1px solid rgba(56, 189, 248, 0.3)", fontSize: "0.8rem", color: "#f8fafc" }}>
                2. Cross-Sectional Constraint Compiler
              </div>
              <span style={{ color: "#38bdf8", fontSize: "1.2rem" }}>➔</span>
              <div style={{ background: "rgba(30, 41, 59, 0.8)", padding: "0.6rem 0.9rem", borderRadius: "8px", border: "1px solid rgba(56, 189, 248, 0.3)", fontSize: "0.8rem", color: "#f8fafc" }}>
                3. High-Performance Pricing &amp; SVI Vol Engine
              </div>
              <span style={{ color: "#38bdf8", fontSize: "1.2rem" }}>➔</span>
              <div style={{ background: "rgba(30, 41, 59, 0.8)", padding: "0.6rem 0.9rem", borderRadius: "8px", border: "1px solid rgba(56, 189, 248, 0.3)", fontSize: "0.8rem", color: "#f8fafc" }}>
                4. Multi-Objective Pareto Frontier Solver
              </div>
              <span style={{ color: "#38bdf8", fontSize: "1.2rem" }}>➔</span>
              <div style={{ background: "rgba(2, 132, 199, 0.3)", padding: "0.6rem 0.9rem", borderRadius: "8px", border: "1px solid #38bdf8", fontSize: "0.8rem", color: "#38bdf8", fontWeight: 700 }}>
                5. Interactive 2D Payoff &amp; Order Staging
              </div>
            </div>
          </div>

          {/* The 6 Improvement Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "1.25rem" }}>
            {WORKFLOW_IMPROVEMENTS.map((imp) => (
              <div key={imp.id} className="improvement-card">
                <div className="improvement-header">
                  <div className="improvement-title">
                    <span className="improvement-num">0{imp.number}</span>
                    <span>{imp.title}</span>
                  </div>
                </div>

                <div className="improvement-block">
                  <span className="improvement-block-label limitation">⚠️ Current System Limitation:</span>
                  <p className="improvement-block-desc">{imp.currentLimitation}</p>
                </div>

                <div className="improvement-block">
                  <span className="improvement-block-label enhancement">💡 Proposed Architectural Enhancement:</span>
                  <p className="improvement-block-desc">{imp.proposedEnhancement}</p>
                </div>

                <div className="improvement-block">
                  <span className="improvement-block-label impact">🚀 Expected Impact:</span>
                  <p className="improvement-block-desc" style={{ color: "#4ade80" }}>{imp.impact}</p>
                </div>

                <div style={{ marginTop: "0.35rem", display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: "0.72rem", color: "#94a3b8" }}>Target Components:</span>
                  {imp.targetComponents.map((comp, cIdx) => (
                    <span key={cIdx} style={{ fontSize: "0.72rem", fontFamily: "monospace", background: "rgba(0,0,0,0.3)", color: "#38bdf8", padding: "0.15rem 0.4rem", borderRadius: "4px" }}>
                      {comp}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
