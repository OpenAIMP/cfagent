import React, { useState, useMemo } from "react";
import "./workflowsHub.css";

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
      "Dynamic all-exchange discovery: no static hardcoded ticker lists.",
      "Dual provider flexibility: E*TRADE broker mode or 100% zero-credential Yahoo Finance FOSS mode.",
      "Auditable scan ledger detailing why each security matched or failed criteria.",
      "Sortable results by 1D change %, volume, market cap, and RSI momentum.",
    ],
    dataSources: [
      "Nasdaq Official Screener API (api.nasdaq.com/api/screener/stocks)",
      "Yahoo Finance Chart & Summary API (query1/query2.finance.yahoo.com)",
      "E*TRADE Market Quote API (api.etrade.com/v1/market/quote)",
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
    id: "options-flows",
    number: 3,
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
    number: 4,
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
    number: 5,
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
    number: 6,
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
    number: 7,
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
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string>("stock-screener");

  const categories = [
    { id: "all", label: "All Workflows (7)" },
    { id: "stocks", label: "📈 Stock Screener" },
    { id: "options", label: "🎯 Options Discovery" },
    { id: "flows", label: "🌊 Options Flows" },
    { id: "brokerage", label: "🤖 Agentic Brokerage" },
    { id: "scheduled", label: "⏰ Schedulers" },
    { id: "nlq", label: "💬 NLQ & Voice" },
    { id: "payments", label: "💳 Micropayments" },
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

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? "" : id));
  };

  return (
    <div className="workflows-hub-container">
      {/* Hero Header */}
      <div className="workflows-hero">
        <div className="workflows-hero-top">
          <div className="workflows-hero-title-group">
            <div className="workflows-hero-icon">🧭</div>
            <div>
              <h1 className="workflows-hero-title">Platform Workflows &amp; Architecture Playbooks</h1>
              <p className="workflows-hero-subtitle">
                Complete architectural documentation, step-by-step pipeline workflows, data feeds, and execution playbooks supported across the Multi-Agent Financial Assistant.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Metrics Bar */}
      <div className="workflows-stats-bar">
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Core Workflows</span>
          <span className="workflows-stat-value">7 End-to-End</span>
          <span className="workflows-stat-desc">Stocks, Options, Flows, Brokerage, Timers, NLQ, x402</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Equity Coverage</span>
          <span className="workflows-stat-value">8,000+ Tickers</span>
          <span className="workflows-stat-desc">Nasdaq, NYSE &amp; AMEX dynamic listings feed</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Options Strategy Library</span>
          <span className="workflows-stat-value">72 Pre-Built</span>
          <span className="workflows-stat-desc">OptionStrat-grade multi-leg spread catalog</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Safety &amp; Compliance</span>
          <span className="workflows-stat-value">100% HITL Safe</span>
          <span className="workflows-stat-desc">Aspect-Oriented guards prevent unverified execution</span>
        </div>
      </div>

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
  );
}
