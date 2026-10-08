import React, { useState, useMemo } from "react";
import "./workflowsHub.css";
import {
  FAQ_QUESTIONS,
  WORKFLOW_IMPROVEMENTS,
  CAPABILITY_MATRIX,
  type FaqQuestionItem,
  type WorkflowImprovementItem,
  type CapabilityMatrixRow,
} from "./workflowsFaqData";

export interface WorkflowItem {
  id: string;
  number: number;
  title: string;
  category: "stocks" | "options" | "flows" | "brokerage" | "scheduled" | "nlq" | "payments";
  categoryLabel: string;
  badge: string;
  badgeColor: "green" | "blue" | "purple" | "orange";
  subtitle: string;
  overview: string;
  apiEndpoint: string;
  targetTab: string;
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
  {
    id: "stock-screener",
    number: 1,
    title: "Stock Screener & Multi-Exchange Equity Discovery",
    category: "stocks",
    categoryLabel: "Stocks",
    badge: "Dual-Engine (Nasdaq & Yahoo)",
    badgeColor: "green",
    subtitle: "Screen 8,000+ US equities dynamically across NASDAQ, NYSE, and AMEX with technical indicators and auditable scan ledgers.",
    overview: "The Stock Screener allows filtering across all active US equities by price, market cap, exchange, 14-period daily RSI, MACD momentum, and daily gainers/losers. It operates either via official Nasdaq multi-exchange batch listings or live Yahoo Finance FOSS feeds.",
    apiEndpoint: "POST /api/etrade/screen · POST /api/foss/screen",
    targetTab: "trading",
    steps: [
      {
        step: "Step 1",
        title: "Filter Configuration",
        description: "User configures exchange (NASDAQ, NYSE, AMEX, or ALL), price boundaries, market capitalization, sector, and trend (Gainers, Losers, Most Active).",
      },
      {
        step: "Step 2",
        title: "Dynamic Exchange Ingestion",
        description: "The engine queries the official Nasdaq Screener API (api.nasdaq.com) across 8,000+ active tickers or fetches 1-month daily historical closes via Yahoo Finance FOSS.",
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
      "Externalized curated stock universe (src/config/curatedStockUniverse.json) with sector, exchange, and market-cap tags as a resilient alternative to upstream Nasdaq API rate limits.",
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
        usageDetails: "Ingests dynamic listing tables across NASDAQ, NYSE, and AMEX (~8,500 active securities) in 5,000-row paginated batches. Provides ticker symbols, company names, exchanges, last sale prices, and market caps.",
        nuanceExplanation: "33 total requests reflect 3 exchange partitions paginated across 5,000 rows. The 2.17s latency reflects Nasdaq enterprise database queries.",
      },
      {
        host: "query1.finance.yahoo.com",
        status2xx: 945,
        status4xx: 46,
        avgDuration: "257.6ms",
        role: "Yahoo Finance Chart, Indicators & Session Crumb",
        usageDetails: "Retrieves 1-month daily and intraday historical OHLCV chart bars (/v8/finance/chart/{symbol}) to compute 14-period RSI and MACD (12, 26, 9 EMA), and exchanges session cookies for crumb tokens (/v1/test/getcrumb).",
        nuanceExplanation: "The 46 4xx responses represent unlisted OTC tickers or transient Yahoo rate throttles. Resilient fallback mechanisms handle retries seamlessly.",
      },
      {
        host: "query2.finance.yahoo.com",
        status2xx: 940,
        status4xx: 7,
        avgDuration: "70.9ms",
        role: "Yahoo Finance Quote Summary & Options Feed",
        usageDetails: "Secondary load-balanced endpoint querying detailed valuation metrics (/v10/finance/quoteSummary/{symbol}?modules=price,summaryDetail) and live options chain flow snapshots (/v7/finance/options/{symbol}).",
        nuanceExplanation: "Extremely fast 70.9ms average latency. The 7 4xx responses reflect non-optionable ticker queries or invalid symbol symbols.",
      },
      {
        host: "fc.yahoo.com",
        status2xx: 0,
        status4xx: 70,
        avgDuration: "30.3ms",
        role: "Yahoo Finance Cookie Crumb Handshake",
        usageDetails: "Initial cookie handshake request for the open-source Yahoo Finance session protocol. Captures the 'set-cookie: A3=...' header needed to retrieve authorization crumbs.",
        nuanceExplanation: "100% 4xx (HTTP 404/401) is expected by design: Yahoo intentionally responds with 4xx while setting the session cookie. The platform captures this cookie header and exchanges it for a crumb on query1.",
      },
      {
        host: "api.etrade.com",
        status2xx: 501,
        status4xx: 1000,
        avgDuration: "167.7ms",
        role: "Official E*TRADE Broker REST API",
        usageDetails: "Direct broker integration querying live equity quotes (/v1/market/quote), option expiration dates (/v1/market/optionexpiredate), option chains (/v1/market/optionchains), accounts, and order previews.",
        nuanceExplanation: "501 2xx responses reflect active authenticated broker sessions. The 1,000 4xx responses reflect expired daily OAuth 1.0a access tokens (which reset at midnight ET) or unauthenticated preview attempts gracefully trapped by the fallback layer.",
      },
    ],
    faq: {
      question: "Why do screener prices sometimes differ from my real-time brokerage app?",
      answer: "Public market feeds (Nasdaq Screener web feed and unauthenticated Yahoo Finance) are subject to mandatory 15-minute exchange delays under CTA/UTP rules. Furthermore, screener feeds capture static batch snapshots at regular market close (4:00 PM ET) and do not reflect after-hours or pre-market extended trading ticks.",
    },
    sampleQueryOrAction: "Screen tech stocks with RSI < 35 and market cap > $50B",
  },
  {
    id: "options-discovery",
    number: 2,
    title: "Options Strategy Discovery & 2D Payoff Analyzer",
    category: "options",
    categoryLabel: "Options",
    badge: "72 Strategies · Auto-Refresh",
    badgeColor: "blue",
    subtitle: "OptionStrat-grade strategy scanner, visual payoff graphs, Black-Scholes Greeks, 2D P&L date matrix, and auto-refresh.",
    overview: "Discovers and evaluates multi-leg options combinations based on target prices, risk/reward constraints, and market sentiment. Includes an optimization bias slider balancing Probability of Profit (POP) against Return-on-Risk (RoR%), plus configurable background auto-refreshing.",
    apiEndpoint: "POST /api/trading/options/llm-ideas · GET /api/foss/quote",
    targetTab: "trading",
    steps: [
      {
        step: "Step 1",
        title: "Target Price & Bias Setting",
        description: "Set underlying target price (defaults to ±1x or ±2x market implied move) and adjust the Optimization Bias slider (Max Return ↔ Balanced EV ↔ Max Chance).",
      },
      {
        step: "Step 2",
        title: "Algorithmic Discovery Scan",
        description: "Scans candidate legs using Black-Scholes models to compute net debit/credit, max profit, max loss, collateral requirements, breakevens, and win probability (POP).",
      },
      {
        step: "Step 3",
        title: "Multi-Leg Builder & Payoff Graph",
        description: "Loads candidates into an interactive payoff chart with symmetric strike shifts (Expand Wings) and multi-expiration diagonal configuration.",
      },
      {
        step: "Step 4",
        title: "2D P&L Date Matrix & Greeks",
        description: "Simulates strategy P&L across a 2-dimensional grid of price steps vs calendar dates to expiration, accounting for theta decay and IV crush/surge.",
      },
    ],
    keyFeatures: [
      "72 Pre-made strategies: Butterflies, Diagonals, Iron Condors, Straddles, Broken Wing Butterflies, and Collars.",
      "Configurable Auto-Refresh (10s, 15s, 30s, 1m, 2m, 5m) with persistent localStorage storage.",
      "Defined vs Undefined vs Covered risk tagging with explicit Max Loss caps.",
      "Interactive IV Crush (-25%) and IV Spike (+25%) scenario simulation.",
    ],
    dataSources: [
      "Black-Scholes analytic pricing engine with cumulative normal distribution CDF",
      "Live E*TRADE options chains & Level 1 market feeds",
      "OptionStrat HTML strategy templates & SVG mini-curve generators",
    ],
    faq: {
      question: "How does the optimizer balance Max Chance vs Max Return?",
      answer: "When set to Max Return, the engine targets asymmetric leverage by selecting out-of-the-money strikes with high payout multiples (3:1+). When set to Max Chance, it selects deep in-the-money or wide credit structures with high win probabilities (POP > 70%) and large breakeven cushion buffers.",
    },
    sampleQueryOrAction: "Find defined risk credit spreads on NVDA with max loss under $30",
  },
  {
    id: "raw-contracts-screener",
    number: 3,
    title: "Raw Contracts Screener & Chain Filtering",
    category: "options",
    categoryLabel: "Options",
    badge: "Direct Broker Chains · Full Greeks",
    badgeColor: "blue",
    subtitle: "Screen single-leg calls and puts across multivariate constraints (bid/ask spread %, volume, open interest, DTE, Delta, moneyness).",
    overview: "Directly queries and screens raw options contract chains across select DTE horizons. Enforces multivariate liquidity and spread filters, extracts Black-Scholes Greeks, and provides 1-click order ticket staging.",
    apiEndpoint: "POST /api/trading/options/screen",
    targetTab: "trading",
    steps: [
      {
        step: "Step 1",
        title: "Chain Retrieval",
        description: "Direct ingestion of full broker option chains across selected DTE horizons (up to 10,000 contracts).",
      },
      {
        step: "Step 2",
        title: "Multivariate Boundary Screening",
        description: "Enforces constraints on bid/ask spread %, minimum volume, open interest, and strike distance.",
      },
      {
        step: "Step 3",
        title: "Live Greeks Extraction",
        description: "Calculates or extracts live Delta (Δ), Gamma (Γ), Theta (Θ), Vega (ν), and moneyness flags (ITM, ATM, OTM).",
      },
      {
        step: "Step 4",
        title: "Sort & Staging",
        description: "Orders by volume, open interest, or spread tightness with 1-click trade ticket integration.",
      },
    ],
    keyFeatures: [
      "Direct E*TRADE option chains screening with calibrated market feed fallback.",
      "Fine-grained liquidity filters: min volume, min open interest, max bid-ask spread %.",
      "Complete Greeks breakdown: Delta, Gamma, Theta, Vega, and Implied Volatility.",
      "One-click staging of selected contract into order preview ticket.",
    ],
    dataSources: [
      "E*TRADE Option Chains API (v1/market/optionchains)",
      "E*TRADE Expiration Dates API (v1/market/optionexpiredate)",
      "Black-Scholes analytic pricing engine",
    ],
    faq: {
      question: "Why does the screener show 0 contracts if I don't set filters carefully?",
      answer: "Tight bid-ask spread filters (e.g. < 2%) or high volume thresholds will prune illiquid contracts. If live broker OAuth is unauthenticated, the engine seamlessly provides calibrated market option chains.",
    },
    sampleQueryOrAction: "Screen NVDA calls between 14 and 45 DTE with volume > 500 and spread < 5%",
  },
  {
    id: "options-flows",
    number: 4,
    title: "Institutional Options Flows & Unusual Activity",
    category: "flows",
    categoryLabel: "Flows",
    badge: "Sweeps & Blocks · Net Sentiment",
    badgeColor: "purple",
    subtitle: "Real-time institutional sweeps, block orders, dark pool prints, insider SEC filings, and congressional disclosures.",
    overview: "Monitors institutional options order flow to identify 'smart money' positioning. Computes aggregate Net Bullish vs Net Bearish premium leaderboards and flags Volume-to-Open-Interest (Vol/OI) spikes indicative of directional conviction.",
    apiEndpoint: "GET /api/trading/options/flows · GET /api/trading/options/flow-summary",
    targetTab: "options-flows",
    steps: [
      {
        step: "Step 1",
        title: "Order Flow Ingestion",
        description: "Ingests options trade prints across all exchanges, filtering for multi-exchange sweeps, single-venue blocks, and dark pool executions.",
      },
      {
        step: "Step 2",
        title: "Anomaly Scoring & Vol/OI",
        description: "Flags aggressive trades executed above the ask price with trade volume exceeding total existing open interest (Vol/OI > 1.0).",
      },
      {
        step: "Step 3",
        title: "Net Premium Sentiment",
        description: "Aggregates total dollar premium across calls bought at ask / puts sold at bid (Bullish) versus puts bought at ask / calls sold at bid (Bearish).",
      },
      {
        step: "Step 4",
        title: "Cross-Asset Intelligence",
        description: "Correlates options flow with corporate insider SEC Form 4 filings and congressional trading disclosures.",
      },
    ],
    keyFeatures: [
      "Real-time institutional flow feed with filterable trade sizes ($50K+, $250K+, $1M+).",
      "Dual Leaderboards: Top 10 Net Bullish Tickers vs Top 10 Net Bearish Tickers.",
      "Volume-to-Open-Interest (Vol/OI) anomaly flags highlighting unusual contract activity.",
      "Integrated Congressional stock disclosures and corporate insider purchases.",
    ],
    dataSources: [
      "Institutional Options Consolidated Tape feeds (CTA / OPRA)",
      "SEC EDGAR Form 4 corporate insider transaction filings",
      "US House & Senate financial disclosure reports",
    ],
    faq: {
      question: "What makes an option trade classified as an institutional 'Sweep'?",
      answer: "A sweep order occurs when an institutional buyer splits a massive order across multiple exchanges simultaneously to fill as quickly as possible, intentionally taking out the best ask prices before market makers can adjust quotes.",
    },
    sampleQueryOrAction: "View live options flow for tickers with >$500K net bullish premium",
  },
  {
    id: "agentic-brokerage",
    number: 5,
    title: "Agentic Brokerage & Human-in-the-Loop (HITL) Execution",
    category: "brokerage",
    categoryLabel: "Brokerage",
    badge: "OAuth 1.0a · HITL Safe",
    badgeColor: "orange",
    subtitle: "Two-phase order preview, Human-in-the-Loop authorization guards, E*TRADE OAuth lifecycle, and omnichannel execution.",
    overview: "Enables autonomous agents to formulate trade ideas while enforcing strict Human-in-the-Loop (HITL) safety. Orders are first previewed with the broker to verify buying power, commissions, and margin before requiring explicit human authorization prior to live placement.",
    apiEndpoint: "POST /api/etrade/preview · POST /api/etrade/place-order",
    targetTab: "trading",
    steps: [
      {
        step: "Step 1",
        title: "OAuth 1.0a Handshake",
        description: "Authenticates with E*TRADE via 3-legged OAuth, storing access tokens securely in Cloudflare KV with automated midnight ET renewals.",
      },
      {
        step: "Step 2",
        title: "Phase 1: Broker Preview",
        description: "The AI agent or user submits an order preview request to E*TRADE REST API. The broker returns an exact previewId, estimated commission, and margin impact.",
      },
      {
        step: "Step 3",
        title: "Human-in-the-Loop (HITL) Guard",
        description: "The platform halts execution and presents an explicit visual trade card. NO SHARES OR CONTRACTS ARE BOUGHT until the human clicks 'Authorize Order'.",
      },
      {
        step: "Step 4",
        title: "Phase 2: Live Placement",
        description: "Upon human approval, the platform submits the verified previewId with a fresh clientOrderId, confirming order execution with the broker.",
      },
    ],
    keyFeatures: [
      "Aspect-Oriented Security Guards ensuring no unapproved trades ever execute.",
      "Omnichannel execution: Review and authorize trades via Web UI, Slack Block Kit, or Cloudflare Email.",
      "Seamless environment switching between Sandboxed TEST (apisb.etrade.com) and Live PROD (api.etrade.com).",
      "Automatic timeout recovery with unique clientOrderId regeneration.",
    ],
    dataSources: [
      "E*TRADE Accounts & Order Preview API (v1/accounts/{key}/orders/preview)",
      "E*TRADE Order Placement API (v1/accounts/{key}/orders/place)",
      "Cloudflare KV encrypted token and OAuth state storage",
    ],
    faq: {
      question: "Can an AI agent execute a trade on my brokerage without my knowledge?",
      answer: "No. The platform implements an uncompromising Aspect-Oriented Human-in-the-Loop (HITL) guard. The agent can only generate previews. Live order submission requires an explicit cryptographic human click in the UI or interactive Slack card.",
    },
    sampleQueryOrAction: "Preview buy 10 NVDA limit $125.00 via E*TRADE",
  },
  {
    id: "scheduled-screening",
    number: 6,
    title: "Durable Timers & Scheduled Screening Schedulers",
    category: "scheduled",
    categoryLabel: "Schedulers",
    badge: "Cloudflare Durable Objects",
    badgeColor: "blue",
    subtitle: "Recurring options screens powered by Durable Objects with automated Slack & Email notifications.",
    overview: "Allows users to set up persistent, unattended market screening schedules. Powered by Cloudflare Durable Timers, the system executes periodic screens across target symbols and dispatches alerts when predefined win-probability or return thresholds are met.",
    apiEndpoint: "GET /api/trading/options/schedules · POST /api/trading/options/schedules",
    targetTab: "trading",
    steps: [
      {
        step: "Step 1",
        title: "Schedule Creation",
        description: "Define monitored symbols (e.g., NVDA, TSLA, AAPL), screening intervals (hourly, market open, daily), and strategy criteria (e.g. credit spreads with POP > 75%).",
      },
      {
        step: "Step 2",
        title: "Durable Timer Alarm",
        description: "Cloudflare Durable Objects register persistent timer alarms that wake up autonomously across global edge runtimes.",
      },
      {
        step: "Step 3",
        title: "Autonomous Background Screen",
        description: "The scheduled task fetches updated option chains, evaluates candidate strategies against user criteria, and records audit logs.",
      },
      {
        step: "Step 4",
        title: "Omnichannel Dispatch",
        description: "If viable strategies match user criteria, the task dispatches rich notification cards to configured Slack webhooks and email inboxes.",
      },
    ],
    keyFeatures: [
      "Serverless persistence: schedules survive worker restarts via Durable Object storage.",
      "Multi-symbol rotation: screens baskets of tickers sequentially to respect broker rate limits.",
      "Omnichannel dispatch: instant alerts via Slack Block Kit and Cloudflare Email Worker.",
      "Full audit trail: view past execution timestamps, matched opportunities, and error states.",
    ],
    dataSources: [
      "Cloudflare Durable Object Alarms API",
      "E*TRADE Automated Option Chain Screening Pipeline",
      "Slack Incoming Webhooks & Cloudflare Email Workers",
    ],
    faq: {
      question: "Do I need to keep my browser open for scheduled screening to run?",
      answer: "No. Schedulers run entirely in the cloud on Cloudflare Durable Objects. They execute autonomously even when all browser tabs are closed.",
    },
    sampleQueryOrAction: "Schedule a daily market-open credit spread scan for NVDA and TSLA",
  },
  {
    id: "nlq-voice",
    number: 7,
    title: "Natural Language Query (NLQ) & Voice Trading",
    category: "nlq",
    categoryLabel: "AI & Voice",
    badge: "Multi-Agent LLM · Voice",
    badgeColor: "green",
    subtitle: "Conversational market screening, LLM strategy validation, and verbal speech-to-trade interaction.",
    overview: "Translates plain English queries into structured market screening parameters, options trade setups, and database searches. Includes a voice recognition engine allowing verbal order previews and spoken trade confirmations.",
    apiEndpoint: "POST /api/trading/options/nlq · POST /api/chat",
    targetTab: "chat",
    steps: [
      {
        step: "Step 1",
        title: "Natural Language Input",
        description: "User types or speaks a query: 'Find me bullish options on NVDA with max loss under $30' or 'Screen oversold tech stocks'.",
      },
      {
        step: "Step 2",
        title: "Intent Parsing & Routing",
        description: "The Multi-Agent Orchestrator classifies intent, extracts symbol, risk caps, expiration targets, and maps to the appropriate tool command.",
      },
      {
        step: "Step 3",
        title: "LLM Strategy Validation",
        description: "Validates candidate strategies against current macroeconomic factors and historical volatility using Cloudflare Workers AI.",
      },
      {
        step: "Step 4",
        title: "Interactive Card & Spoken Confirmation",
        description: "Renders an actionable visual trade card and speaks the confirmation aloud using browser speech synthesis.",
      },
    ],
    keyFeatures: [
      "Understands complex constraint prompts (budget limits, sentiment, DTE ranges, reward/risk).",
      "Web Speech API integration for verbal voice trading and audible trade readouts.",
      "Direct handoff from chat dialogue to E*TRADE order preview ticket.",
      "Multi-turn agent memory maintaining conversational context across queries.",
    ],
    dataSources: [
      "Cloudflare Workers AI LLM models (@cf/meta/llama-3.1-8b-instruct)",
      "Web Speech API (SpeechRecognition & SpeechSynthesis)",
      "Agent Context Memory & Vector Knowledge bases",
    ],
    faq: {
      question: "What kind of options questions can the NLQ agent answer?",
      answer: "The NLQ engine handles constraint screening ('maxloss <= 30', 'max return vs max chance'), strategy combinations ('butterflies and diagonals'), volatility scenarios ('post-earnings crush'), and portfolio questions.",
    },
    sampleQueryOrAction: "Find me combinations of options like butterflies and diagonals on TSLA",
  },
  {
    id: "payments-mcp",
    number: 8,
    title: "x402 Micropayments, DIDs & Paid MCP Tools",
    category: "payments",
    categoryLabel: "Micropayments",
    badge: "HTTP 402 · USDC Cryptographic",
    badgeColor: "purple",
    subtitle: "Autonomous agent micropayments, Decentralized Identifiers (DIDs), and pay-per-query Model Context Protocol tools.",
    overview: "Implements the emerging HTTP 402 Payment Required web standard. Enables AI agents and human users to pay per query using decentralized USDC transfers with cryptographic DID signatures to unlock high-compute options scans and proprietary MCP tools.",
    apiEndpoint: "POST /api/premium/options-scan · POST /api/mcp",
    targetTab: "payments",
    steps: [
      {
        step: "Step 1",
        title: "HTTP 402 Challenge",
        description: "When an agent requests a premium computation, the server returns HTTP 402 Payment Required with an x402 payment challenge specifying exact amount and token.",
      },
      {
        step: "Step 2",
        title: "Decentralized Settlement",
        description: "The client or agent wallet submits a micro-transfer on the configured network (Base, Arbitrum, or Solana).",
      },
      {
        step: "Step 3",
        title: "Cryptographic DID Signature",
        description: "A cryptographic proof and payment signature are generated tying the transaction hash to the requester's Decentralized Identifier (DID).",
      },
      {
        step: "Step 4",
        title: "Instant Verification & Service Fulfillment",
        description: "The server verifies the on-chain receipt, fulfills the compute request, and issues the premium options scan results.",
      },
    ],
    keyFeatures: [
      "Standard-compliant HTTP 402 header exchange and automated retry loop.",
      "Decentralized Identifiers (W3C DID standard) for autonomous agent identity.",
      "Pay-per-query access to compute-heavy Model Context Protocol (MCP) tool endpoints.",
      "Cryptographic ledger recording receipts and verifiable payment proofs.",
    ],
    dataSources: [
      "x402 Payment Protocol & Challenge Verifier Service",
      "Decentralized blockchain RPC nodes (Base, Ethereum, Solana)",
      "W3C Decentralized Identifier (DID) cryptographic registries",
    ],
    faq: {
      question: "Can I use the platform without paying crypto micropayments?",
      answer: "Yes. All standard screening, options discovery, research, and brokerage features include free tiers. The x402 protocol is reserved for premium heavy compute and paid external MCP tools.",
    },
    sampleQueryOrAction: "View active DID credentials and test HTTP 402 payment challenge",
  },
];

export interface WorkflowsHubProps {
  onNavigateTab?: (tab: string) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

export function WorkflowsHub({ onNavigateTab, onSendPrompt }: WorkflowsHubProps) {
  const [activeTab, setActiveTab] = useState<"workflows" | "faq" | "improvements">("faq");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string>("stock-screener");

  // FAQs Tab State
  const [faqCategory, setFaqCategory] = useState<string>("all");
  const [faqSearchQuery, setFaqSearchQuery] = useState<string>("");
  const [expandedFaqId, setExpandedFaqId] = useState<string>("best-opportunities");

  const categories = [
    { id: "all", label: "All Workflows (8)" },
    { id: "stocks", label: "📈 Stock Screener" },
    { id: "options", label: "🎯 Options Research" },
    { id: "flows", label: "🌊 Options Flows" },
    { id: "brokerage", label: "🤖 Agentic Brokerage" },
    { id: "scheduled", label: "⏰ Schedulers" },
    { id: "nlq", label: "💬 NLQ & Voice" },
    { id: "payments", label: "💳 Micropayments" },
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
      const matchesCategory = selectedCategory === "all" || wf.category === selectedCategory;
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        wf.title.toLowerCase().includes(q) ||
        wf.subtitle.toLowerCase().includes(q) ||
        wf.overview.toLowerCase().includes(q) ||
        wf.keyFeatures.some((f) => f.toLowerCase().includes(q)) ||
        wf.steps.some((s) => s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) ||
        wf.faq.question.toLowerCase().includes(q) ||
        wf.faq.answer.toLowerCase().includes(q);

      return matchesCategory && matchesSearch;
    });
  }, [selectedCategory, searchQuery]);

  const filteredFaqs = useMemo(() => {
    return FAQ_QUESTIONS.filter((faq) => {
      const matchesCategory = faqCategory === "all" || faq.category === faqCategory;
      const q = faqSearchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        faq.question.toLowerCase().includes(q) ||
        faq.summary.toLowerCase().includes(q) ||
        faq.theoreticalContext.toLowerCase().includes(q) ||
        faq.keyParameters.toLowerCase().includes(q) ||
        faq.methods.some((m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));

      return matchesCategory && matchesSearch;
    });
  }, [faqCategory, faqSearchQuery]);

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? "" : id));
  };

  const toggleExpandFaq = (id: string) => {
    setExpandedFaqId((prev) => (prev === id ? "" : id));
  };

  return (
    <div className="workflows-hub-container">
      {/* Hero Header */}
      <div className="workflows-hero">
        <div className="workflows-hero-top">
          <div className="workflows-hero-title-group">
            <div className="workflows-hero-icon">🧭</div>
            <div>
              <h1 className="workflows-hero-title">Platform Workflows, Playbooks &amp; Solutions FAQ</h1>
              <p className="workflows-hero-subtitle">
                Complete architectural documentation, step-by-step pipeline workflows, solutions to the 8 core quantitative scenarios, and architectural optimization proposals.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Metrics Bar */}
      <div className="workflows-stats-bar">
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Core Workflows</span>
          <span className="workflows-stat-value">8 End-to-End</span>
          <span className="workflows-stat-desc">Stocks, Strategy Discovery, Raw Screener, Flows, Brokerage, Timers, NLQ, x402</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Core Scenarios (FAQs)</span>
          <span className="workflows-stat-value">8 Quantitative Guides</span>
          <span className="workflows-stat-desc">24 Step-by-Step Execution Methods with mathematical models</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Strategy Library</span>
          <span className="workflows-stat-value">72 Pre-Built Setups</span>
          <span className="workflows-stat-desc">Butterflies, Diagonals, Condors, Vertical Spreads, and Collars</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Safety &amp; Compliance</span>
          <span className="workflows-stat-value">100% HITL Safe</span>
          <span className="workflows-stat-desc">Aspect-Oriented guards prevent unverified execution</span>
        </div>
      </div>

      {/* Primary Sub-Navigation Tabs */}
      <div className="workflows-subnav-bar" style={{ display: "flex", gap: "0.5rem", margin: "1rem 0 1.5rem", borderBottom: "1px solid rgba(255, 255, 255, 0.1)", paddingBottom: "0.75rem", flexWrap: "wrap" }}>
        <button
          type="button"
          className={`workflows-nav-tab ${activeTab === "faq" ? "active" : ""}`}
          onClick={() => setActiveTab("faq")}
        >
          ❓ Questions, FAQs &amp; Solutions (8 Core Scenarios)
        </button>
        <button
          type="button"
          className={`workflows-nav-tab ${activeTab === "workflows" ? "active" : ""}`}
          onClick={() => setActiveTab("workflows")}
        >
          🧭 Platform Workflows (8)
        </button>
        <button
          type="button"
          className={`workflows-nav-tab ${activeTab === "improvements" ? "active" : ""}`}
          onClick={() => setActiveTab("improvements")}
        >
          🚀 Workflow Improvements &amp; Analysis
        </button>
      </div>

      {/* VIEW 1: QUESTIONS, FAQS & SOLUTIONS (THE 8 CORE QUESTIONS) */}
      {activeTab === "faq" && (
        <div className="faq-section-container" style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* FAQ Search & Category Filter */}
          <div className="workflows-filter-strip">
            <div className="workflows-search-box">
              <span className="workflows-search-icon">🔍</span>
              <input
                type="text"
                className="workflows-search-input"
                placeholder="Search questions, mathematical formulas, execution methods, or tickers…"
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
                      {/* Theoretical & Mathematical Formulation Box */}
                      <div className="faq-theory-box">
                        <div className="faq-theory-title">
                          <span>📐</span> Quantitative Theory &amp; Mathematical Formulation
                        </div>
                        <div className="faq-theory-content">
                          {faq.theoreticalContext}
                        </div>
                        {faq.mathematicalBasis && (
                          <div className="faq-formula-badge">
                            Formula: {faq.mathematicalBasis}
                          </div>
                        )}
                      </div>

                      {/* 3 Distinct Execution Methods */}
                      <div>
                        <h4 style={{ fontSize: "0.82rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#38bdf8", margin: "0 0 0.75rem 0" }}>
                          ⚡ Multi-Method Platform Solutions (3 Execution Paths)
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
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Optimal Output Structure Callout */}
                      <div style={{ background: "rgba(15, 23, 42, 0.7)", border: "1px solid rgba(255, 255, 255, 0.08)", borderRadius: "8px", padding: "0.85rem 1rem", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
                        <div>
                          <div style={{ fontSize: "0.72rem", color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>
                            🎯 Optimal Output Structure
                          </div>
                          <div style={{ fontSize: "0.85rem", color: "#f8fafc", marginTop: "0.2rem" }}>
                            {faq.optimalOutputStructure}
                          </div>
                        </div>
                        <div style={{ fontSize: "0.78rem", color: "#38bdf8", fontFamily: "monospace", background: "rgba(0,0,0,0.3)", padding: "0.3rem 0.6rem", borderRadius: "4px" }}>
                          Key Parameters: {faq.keyParameters}
                        </div>
                      </div>

                      {/* Action Footer */}
                      <div className="workflow-action-footer">
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
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

          {/* Capability vs Workflows Summary Matrix */}
          <div className="faq-matrix-container">
            <h4 style={{ margin: "0 0 0.5rem", color: "#38bdf8", fontSize: "0.98rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span>📊</span> Capability Matrix: Question vs Primary Workflows
            </h4>
            <p style={{ margin: "0 0 1rem", color: "#94a3b8", fontSize: "0.82rem" }}>
              Quick architectural reference showing which platform workflow is best suited to answer each question, key input parameters, and ideal visual output structures.
            </p>
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
                  {CAPABILITY_MATRIX.map((row, rIdx) => (
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
                          Try →
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

      {/* VIEW 2: WORKFLOWS PLAYBOOK (THE 8 PLATFORM WORKFLOWS) */}
      {activeTab === "workflows" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* Search & Filter Strip */}
          <div className="workflows-filter-strip">
            <div className="workflows-search-box">
              <span className="workflows-search-icon">🔍</span>
              <input
                type="text"
                className="workflows-search-input"
                placeholder="Search workflows, indicators, delay rules, APIs, or strategies…"
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
                      <div className="workflow-number-badge">0{wf.number}</div>
                      <div className="workflow-header-titles">
                        <h3 className="workflow-title">
                          {wf.title}
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
                      <p style={{ fontSize: "0.86rem", color: "#cbd5e1", lineHeight: 1.5, margin: 0 }}>
                        {wf.overview}
                      </p>

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
                        <div className="workflow-api-metrics-panel" style={{ marginTop: "1rem", background: "rgba(15, 23, 42, 0.75)", border: "1px solid rgba(56, 189, 248, 0.25)", borderRadius: "8px", padding: "1rem" }}>
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
                <p style={{ fontSize: "0.85rem", margin: 0 }}>Try clearing filters or search for terms like &quot;options&quot;, &quot;screener&quot;, &quot;hitl&quot;, or &quot;nasdaq&quot;.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* VIEW 3: WORKFLOW IMPROVEMENTS & ARCHITECTURAL ANALYSIS */}
      {activeTab === "improvements" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* Architectural Analysis Hero Note */}
          <div style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.3)", borderRadius: "10px", padding: "1.25rem 1.5rem" }}>
            <h4 style={{ margin: "0 0 0.5rem", color: "#38bdf8", fontSize: "1.05rem" }}>
              🏗️ Architectural Optimization Analysis (Pure Analysis — No Implementation)
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

          {/* Capability Matrix in Improvements View too */}
          <div className="faq-matrix-container">
            <h4 style={{ margin: "0 0 0.5rem", color: "#38bdf8", fontSize: "0.98rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span>📊</span> Optimization Mapping: Questions vs Workflows
            </h4>
            <div style={{ overflowX: "auto" }}>
              <table className="faq-matrix-table">
                <thead>
                  <tr>
                    <th>User Question / Scenario</th>
                    <th>Primary Workflow</th>
                    <th>Secondary Workflow</th>
                    <th>Key Input Parameter</th>
                    <th>Optimal Output Structure</th>
                  </tr>
                </thead>
                <tbody>
                  {CAPABILITY_MATRIX.map((row, rIdx) => (
                    <tr key={rIdx}>
                      <td style={{ fontWeight: 600, color: "#ffffff" }}>&ldquo;{row.question}&rdquo;</td>
                      <td><span className="workflow-tag-badge green">{row.primaryWorkflow}</span></td>
                      <td><span className="workflow-tag-badge blue">{row.secondaryWorkflow}</span></td>
                      <td style={{ fontFamily: "monospace", color: "#38bdf8", fontSize: "0.76rem" }}>{row.keyInputParameter}</td>
                      <td style={{ color: "#cbd5e1" }}>{row.optimalOutputStructure}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
