/**
 * Platform Knowledge Base & Capabilities Service
 *
 * Provides a unified, structured knowledge graph of all platform capabilities,
 * 8 core workflows, 8 quantitative FAQs with multi-method execution playbooks,
 * 6 decisioning & logic engines, and step-by-step chat/UI usage instructions.
 */

import {
  FAQ_QUESTIONS,
  DECISIONING_SECTIONS,
  CAPABILITY_MATRIX,
  type FaqQuestionItem,
  type DecisioningSection,
  type CapabilityMatrixRow,
} from "../client/workflowsFaqData";

export interface PlatformWorkflowSummary {
  id: string;
  number: number;
  title: string;
  category: "stocks" | "options" | "flows" | "brokerage" | "scheduled" | "nlq" | "payments";
  categoryLabel: string;
  badge: string;
  subtitle: string;
  overview: string;
  apiEndpoint: string;
  targetTab: string;
  steps: Array<{ step: string; title: string; description: string }>;
  keyFeatures: string[];
  dataSources: string[];
  sampleQueryOrAction: string;
}

export const PLATFORM_WORKFLOWS_KNOWLEDGE: PlatformWorkflowSummary[] = [
  {
    id: "stock-screener",
    number: 1,
    title: "Stock Screener & Multi-Exchange Equity Discovery",
    category: "stocks",
    categoryLabel: "Stocks",
    badge: "Dual-Engine (Nasdaq & Yahoo)",
    subtitle: "Screen 8,000+ US equities dynamically across NASDAQ, NYSE, and AMEX with technical indicators and auditable scan ledgers.",
    overview: "The Stock Screener allows filtering across all active US equities by price, market cap, exchange, 14-period daily RSI, MACD momentum, and daily gainers/losers. It queries official Nasdaq multi-exchange listings (api.nasdaq.com) across 8,000+ active tickers, with resilient automatic fallback to the externalized curated universe (src/config/curatedStockUniverse.json) or Yahoo Finance FOSS feeds if upstream APIs are rate-limited. Downstream workflows (including Options Flow) query this screener first as their primary dynamic market underlyings engine.",
    apiEndpoint: "POST /api/etrade/screen · POST /api/foss/screen",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Filter Configuration", description: "Configure exchange (NASDAQ, NYSE, AMEX, or ALL), price boundaries, market cap, sector, and trend (Gainers, Losers, Most Active)." },
      { step: "Step 2", title: "Dynamic Exchange Ingestion & Fallback Decision", description: "Queries official Nasdaq Screener API (api.nasdaq.com) across 8,000+ active tickers. If rate-limited, automatically falls back to externalized curated universe (src/config/curatedStockUniverse.json) or Yahoo Finance FOSS feeds." },
      { step: "Step 3", title: "Indicator Computation", description: "Calculates 14-Period Daily RSI and MACD (12, 26, 9 EMA) to classify momentum into Overbought, Oversold Bounce, Bullish, or Range-Bound." },
      { step: "Step 4", title: "Auditable Scan Ledger", description: "Compiles a complete audit ledger recording total evaluated tickers, passed candidates, and exact failure reasons for every rejected security." },
    ],
    keyFeatures: [
      "Dynamic all-exchange discovery with live Nasdaq, NYSE, and AMEX support.",
      "Autonomous fallback decision tree: prioritizes remote Nasdaq/Yahoo listings before gracefully falling back to externalized curated universe.",
      "Single Source of Truth for Options Flow: Options Flow queries this screener first to resolve active, liquid market underlyings partitioned by market cap rather than defaulting to a static list.",
      "Dual provider flexibility: E*TRADE broker mode or 100% zero-credential Yahoo Finance FOSS mode.",
      "Auditable scan ledger detailing why each security matched or failed criteria.",
    ],
    dataSources: [
      "Nasdaq Official Screener API (api.nasdaq.com/api/screener/stocks)",
      "Externalized Curated Stock Universe (src/config/curatedStockUniverse.json)",
      "Yahoo Finance Chart & Summary API (query1/query2.finance.yahoo.com)",
      "E*TRADE Market Quote & Orders API (api.etrade.com/v1/market/quote)",
    ],
    sampleQueryOrAction: "Screen NASDAQ stocks with price > $50 and RSI < 35 for oversold tech bounce",
  },
  {
    id: "options-strategy-discovery",
    number: 2,
    title: "Options Strategy Discovery & Greeks Engine",
    category: "options",
    categoryLabel: "Options",
    badge: "72-Strategy Catalog",
    subtitle: "Discover, filter, and score optimal option setups across 72 catalog strategies using calibrated pricing and Black-Scholes Greeks.",
    overview: "Evaluates multi-leg options structures (Iron Condors, Vertical Spreads, Butterflies, Calendars, Straddles, Strangles) against live calibrated option chains. Calculates Delta, Gamma, Theta, Vega, IV Rank, Probability of Profit (POP), and Expected Value (EV). Supports strict user budget and risk filtering (e.g. Max Loss <= $30, Max Profit > $0).",
    apiEndpoint: "POST /api/etrade/options/strategy · POST /api/etrade/options/screen",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Option Chain Ingestion", description: "Fetches live option chains with strikes, expirations, bid/ask spreads, open interest, and implied volatility." },
      { step: "Step 2", title: "Pricing Calibration", description: "Calibrates mid-market pricing with synthetic smoothing to eliminate wide spread anomalies and stale quotes." },
      { step: "Step 3", title: "Black-Scholes Greek & POP Computation", description: "Computes Delta, Gamma, Theta, Vega, and Probability of Profit (N(d2)) for every candidate structure." },
      { step: "Step 4", title: "Filter & Score Evaluation", description: "Filters candidates by user criteria (max loss, max profit, delta range, DTE) and computes multivariate composite ranking score." },
    ],
    keyFeatures: [
      "72 distinct options strategies spanning directional, neutral, volatility, and income plays.",
      "Strict parameter filtering: max loss, max profit, min win rate, strike bounds, and expiration windows.",
      "Black-Scholes analytical Greeks engine with continuous dividend and risk-free rate calibration.",
      "Expected Value (EV) calculation: EV = (POP * MaxProfit) - ((1 - POP) * MaxLoss) / Collateral.",
    ],
    dataSources: [
      "E*TRADE Option Chains API (api.etrade.com/v1/market/optionchains)",
      "E*TRADE Option Expirations API (api.etrade.com/v1/market/optionexpiredate)",
      "Calibrated Synthetic Pricing Engine (src/trading/options/calibratedOptionChains.ts)",
    ],
    sampleQueryOrAction: "Find bullish call spreads on NVDA expiring in 30-45 days with max loss <= $30 and max profit > $0",
  },
  {
    id: "options-flows",
    number: 3,
    title: "Real-Time Options Flow & Institutional Activity Tracker",
    category: "flows",
    categoryLabel: "Flows",
    badge: "Smart Money Tracker",
    subtitle: "Track unusual options volume, institutional sweep & block trades, and sentiment anomalies dynamically.",
    overview: "Monitors options flow in real time across the market. Filters by trade type (SWEEP, BLOCK, SPLIT), sentiment (BULLISH, BEARISH), moneyness (ITM, ATM, OTM), and minimum premium. Dynamically screens underlying equities using the Stock Screener first (with fallback to curated universe), computes Bull/Bear volume ratios, and aggregates top institutional ticker leaderboards.",
    apiEndpoint: "GET /api/options/flows · GET /api/options/flows/summary",
    targetTab: "options-flows",
    steps: [
      { step: "Step 1", title: "Dynamic Universe Resolution", description: "Queries DynamicMarketScreener to obtain active, liquid underlyings partitioned by mega/large/mid caps rather than using a static list." },
      { step: "Step 2", title: "Flow Ingestion & Normalization", description: "Ingests raw option trade prints, normalizing strikes, expirations, spot prices, bid/ask sizes, and executed premiums." },
      { step: "Step 3", title: "Anomaly & Sweep Classification", description: "Flags unusual prints where Volume exceeds Open Interest (>1.5x) or single order premium exceeds $100k+ executed aggressively at the ask (Sweeps)." },
      { step: "Step 4", title: "Sentiment Aggregation & Leaderboards", description: "Computes net premium delta and ranks top bullish and bearish tickers in live visual leaderboards." },
    ],
    keyFeatures: [
      "Integrated directly with Stock Screener as single source of truth for dynamic underlyings.",
      "Sweep vs Block trade discrimination with aggression tags (Above Ask, At Ask, Below Bid).",
      "Dynamic Bull/Bear sentiment ratios and institutional volume leaderboards.",
      "Live audio/visual alert badges for whale prints ($500k+ premium).",
    ],
    dataSources: [
      "Stock Screener Dynamic Listings (api.nasdaq.com + Yahoo FOSS)",
      "Live Options Trade Prints & Quotes Feed",
      "Historical Open Interest & Implied Volatility Surface",
    ],
    sampleQueryOrAction: "Show unusual bullish options sweeps over $100k premium today",
  },
  {
    id: "strategy-builder",
    number: 4,
    title: "Visual Multi-Leg Strategy Builder & Payoff Visualizer",
    category: "options",
    categoryLabel: "Options",
    badge: "Interactive Payoff Analyzer",
    subtitle: "Construct custom multi-leg options positions with real-time interactive payoff curves, breakevens, and risk metrics.",
    overview: "Allows constructing custom 1-to-4 leg options positions (calls, puts, stock shares). Interactively calculates max profit, max loss, breakeven price points, return on risk (RoR), and dynamic Greeks exposure across an underlying price continuum.",
    apiEndpoint: "POST /api/options/builder/payoff · POST /api/options/builder/analyze",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Leg Configuration", description: "Add individual legs specifying action (Buy/Sell), type (Call/Put/Stock), strike price, quantity, and expiration." },
      { step: "Step 2", title: "Payoff Curve Modeling", description: "Computes expiration payoff curve: PnL(S) = sum(leg_pnl(S)) across underlying price points from 0.5x to 1.5x spot." },
      { step: "Step 3", title: "Breakeven & Boundary Calculation", description: "Determines upper and lower breakeven boundaries, theoretical max gain, and max capital at risk." },
      { step: "Step 4", title: "Execution Proposal", description: "Generates one-click order ticket draft ready for Human-in-the-Loop review and execution." },
    ],
    keyFeatures: [
      "Dynamic payoff diagram rendering at expiration and pre-expiration (T+0).",
      "Automatic calculation of exact breakeven points and maximum theoretical drawdown.",
      "Multi-leg Greeks aggregation: Net Delta, Net Gamma, Net Theta, Net Vega.",
      "One-click transition from visual builder to E*TRADE order preview.",
    ],
    dataSources: [
      "Live Option Chain Pricing (E*TRADE & Yahoo FOSS)",
      "Black-Scholes Pricing & Payoff Math Models",
    ],
    sampleQueryOrAction: "Build an Iron Condor on SPY with 45 DTE and $5 wide wings",
  },
  {
    id: "position-risk-hedging",
    number: 5,
    title: "Portfolio Position Risk & Delta/Theta Hedging",
    category: "brokerage",
    categoryLabel: "Brokerage",
    badge: "Portfolio Greeks & Risk",
    subtitle: "Monitor active broker positions, portfolio beta-weighted Delta, daily Theta decay, and generate automated hedging proposals.",
    overview: "Syncs active stock and options positions from your connected E*TRADE account. Computes aggregate portfolio Greeks (SPY beta-weighted Delta, aggregate daily Theta, Vega exposure) and provides algorithmic hedging recommendations to neutralize directional exposure during high volatility.",
    apiEndpoint: "GET /api/etrade/positions · POST /api/etrade/hedge/analyze",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Position Synchronization", description: "Fetches live positions, quantity, cost basis, current market price, and unrealized PnL from E*TRADE." },
      { step: "Step 2", title: "Beta-Weighting & Greeks Rollup", description: "Beta-weights each position against the S&P 500 (SPY) to compute portfolio Net Delta (Δ_SPY)." },
      { step: "Step 3", title: "Risk Exposure Audit", description: "Flags concentration risk, tail risk, and directional imbalances exceeding risk limits." },
      { step: "Step 4", title: "Hedging Draft Generation", description: "Proposes hedge trades (e.g. SPY put spreads or inverse delta structures) to return portfolio to delta-neutral." },
    ],
    keyFeatures: [
      "Real-time account balance, purchasing power, and unrealized PnL tracking.",
      "SPY beta-weighted Net Delta calculation across mixed equities and options.",
      "Daily Theta income vs carry cost reporting.",
      "Automated delta-hedging proposals with Human-in-the-Loop confirmation.",
    ],
    dataSources: [
      "E*TRADE Accounts & Positions API (api.etrade.com/v1/accounts/{accountIdKey}/portfolio)",
      "Historical Beta Feeds & Index Volatility Surface",
    ],
    sampleQueryOrAction: "Check my portfolio Net Delta and recommend a hedge to neutralize directional risk",
  },
  {
    id: "automated-execution-hitl",
    number: 6,
    title: "Brokerage Order Execution with Human-in-the-Loop (HITL) Guardrails",
    category: "brokerage",
    categoryLabel: "Brokerage",
    badge: "DID-Attested HITL Guardrails",
    subtitle: "Prepare, preview, and safely execute stock and options orders with cryptographic DID attestations and mandatory human approval.",
    overview: "Enforces strict safety guardrails for real-world trading. The AI agent NEVER places orders autonomously without explicit human authorization. Orders are first prepared as an order preview draft (signed with Decentralized Identifier `did:agent:openaimp:trading`), showing estimated total, commission, and margin impact. Execution only proceeds when the user explicitly approves the proposal.",
    apiEndpoint: "POST /api/etrade/order/preview · POST /api/etrade/order/execute",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Order Drafting", description: "Agent or user drafts an order ticket with symbol, action (BUY/SELL), quantity, order type (LIMIT/MARKET), and price." },
      { step: "Step 2", title: "E*TRADE Preview Handshake", description: "Calls E*TRADE Preview API to validate account buying power, calculate exact commissions/fees, and obtain a previewId." },
      { step: "Step 3", title: "DID Attestation & Human Review", description: "Signs proposal with Agent DID and displays draft modal in UI. Requires user to review details and click 'Confirm & Execute'." },
      { step: "Step 4", title: "Authorized Execution & Audit", description: "Upon explicit confirmation, submits final order to E*TRADE broker API and records immutable event in SQLite audit ledger." },
    ],
    keyFeatures: [
      "Zero unconfirmed trading: strict Human-in-the-Loop guarantee prevents accidental money movement.",
      "Cryptographic Decentralized Identifier (DID) attestation on every order draft.",
      "Comprehensive pre-trade checks: buying power, account equity, margin requirements, market hours.",
      "Full audit trail in SQLite recording timestamps, user approvals, and broker order IDs.",
    ],
    dataSources: [
      "E*TRADE Order Preview API (api.etrade.com/v1/accounts/{accountIdKey}/orders/preview)",
      "E*TRADE Order Placement API (api.etrade.com/v1/accounts/{accountIdKey}/orders/place)",
      "Agent DID Registry & SQLite Audit Ledger (mas_events, mas_trades)",
    ],
    sampleQueryOrAction: "Preview buy order for 10 shares of AAPL at limit price $220.00",
  },
  {
    id: "background-cron-scheduling",
    number: 7,
    title: "Autonomous Background Execution, Intervals & Cron Schedules",
    category: "scheduled",
    categoryLabel: "Automation",
    badge: "Cloudflare Durable Object Alarms",
    subtitle: "Execute scheduled market scans, proactive OAuth token renewals, and background notifications autonomously.",
    overview: "Leverages Cloudflare Agents and Durable Object Alarms for resilient 24/7 background tasks. Automatically renews E*TRADE OAuth access tokens daily at 23:00 ET before midnight expiration, runs autonomous market screening every 5 minutes (300 seconds), and broadcasts actionable market alerts over WebSockets.",
    apiEndpoint: "POST /api/tasks/schedule · GET /api/tasks/active",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Task Registration", description: "Registers cron schedules ('0 23 * * *') or interval alarms (every 300s) on agent startup via idempotent DO alarms." },
      { step: "Step 2", title: "Proactive Token Renewal", description: "Executes OAuth renewal at 23:00 ET, updating KV tokens and preventing mid-trading session session expiries." },
      { step: "Step 3", title: "Interval Market Screening", description: "Runs autonomous market scan across sectors, filtering top momentum or oversold candidates." },
      { step: "Step 4", title: "Real-Time WebSocket Broadcast", description: "Broadcasts opportunity alerts to connected client UIs via Durable Object WebSocket connections." },
    ],
    keyFeatures: [
      "Native Cloudflare Durable Object scheduling: persists across Worker restarts and sleep cycles.",
      "Zero-downtime E*TRADE OAuth token management with proactive renewal before midnight ET.",
      "Periodic background market scanning with configurable sector and volatility filters.",
      "Real-time event broadcasting to UI without client polling.",
    ],
    dataSources: [
      "Cloudflare Durable Object Alarm Lifecycle (`schedule`, `scheduleEvery`)",
      "E*TRADE OAuth Renewal Endpoint (api.etrade.com/oauth/renew_access_token)",
      "SQLite Job Ledger (`mas_async_jobs`)",
    ],
    sampleQueryOrAction: "Schedule a background market scan for oversold tech stocks every 15 minutes",
  },
  {
    id: "nlq-conversational-agent",
    number: 8,
    title: "Natural Language Financial Intelligence (NLQ) & Conversational Execution",
    category: "nlq",
    categoryLabel: "Chat & NLQ",
    badge: "Vercel AI SDK + LLM Judge",
    subtitle: "Ask financial questions, query database tables, screen markets, and command tools seamlessly through natural chat.",
    overview: "Combines Cloudflare Workers AI with the Vercel AI SDK and an intelligent LLM Judge router. Understands user intents, retrieves facts from the platform knowledge base, queries SQLite database tables (ORM), screens equities, analyzes options payoffs, and drafts actions with Human-in-the-Loop safety.",
    apiEndpoint: "POST /api/chat · POST /api/nlq",
    targetTab: "chat",
    steps: [
      { step: "Step 1", title: "Intent Routing & Safety Classification", description: "LLM Judge evaluates prompt, classifying intent into search, trading, research, payments, tasks, or memory with confidence score." },
      { step: "Step 2", title: "Knowledge & Tool Retrieval", description: "Queries internal Platform Knowledge Base, SQLite tables, or market data feeds to gather grounded facts." },
      { step: "Step 3", title: "Multi-Agent Execution", description: "Executes appropriate MCP commands or drafts proposals requiring confirmation." },
      { step: "Step 4", title: "Streaming Response & Audit", description: "Streams structured markdown response with tool cards, citations, and records audit event in SQLite." },
    ],
    keyFeatures: [
      "Natural language understanding for complex multi-leg options queries and equity screening.",
      "Direct MCP tool dogfooding: search, database ORM, E*TRADE trading, FOSS research, session memory.",
      "Grounded answers: cites internal platform capabilities, workflows, and exact UI navigation steps.",
      "Multi-turn conversational memory persisted in SQLite (`mas_memory`).",
    ],
    dataSources: [
      "Cloudflare Workers AI (Llama 3.3 70B / Qwen / Mistral)",
      "Internal Platform Knowledge Base (Workflows, FAQs, Decisioning Logic)",
      "SQLite Database ORM (tables, transactions, trades, categories, audit logs)",
    ],
    sampleQueryOrAction: "What are the capabilities of this platform and how do I use the stock screener?",
  },
];

export interface KnowledgeSearchResult {
  id: string;
  title: string;
  type: "workflow" | "faq" | "decisioning" | "capability";
  category: string;
  summary: string;
  details: string;
  howToUse: string[];
  targetTab: string;
  apiEndpoint?: string;
  samplePrompt?: string;
  relevanceScore: number;
}

/**
 * Searches across all platform workflows, FAQs, decisioning engines, and capability matrix.
 */
export function searchPlatformKnowledge(
  query: string,
  options?: { maxResults?: number; category?: string }
): {
  query: string;
  count: number;
  results: KnowledgeSearchResult[];
  formattedAnswer: string;
} {
  const q = (query || "").trim().toLowerCase();
  const maxResults = options?.maxResults ?? 5;
  const targetCategory = options?.category?.toLowerCase();

  const terms = q.split(/\s+/).filter((t) => t.length > 2);
  const normalizedQ = q.replace(/[^a-z0-9]/g, "");

  // If query is empty, return the comprehensive 8-workflow overview immediately
  if (terms.length === 0 || !normalizedQ) {
    const formattedAnswer = getPlatformOverviewMarkdown();
    return {
      query,
      count: PLATFORM_WORKFLOWS_KNOWLEDGE.length,
      results: PLATFORM_WORKFLOWS_KNOWLEDGE.slice(0, maxResults).map((wf) => ({
        id: wf.id,
        title: `Workflow ${wf.number}: ${wf.title}`,
        type: "workflow",
        category: wf.categoryLabel,
        summary: wf.subtitle,
        details: wf.overview,
        howToUse: [
          `Open the '${wf.targetTab}' tab in the platform navigation.`,
          ...wf.steps.map((s) => `${s.step} (${s.title}): ${s.description}`),
          `You can also invoke this via Chat with prompt: "${wf.sampleQueryOrAction}"`,
        ],
        targetTab: wf.targetTab,
        apiEndpoint: wf.apiEndpoint,
        samplePrompt: wf.sampleQueryOrAction,
        relevanceScore: 100,
      })),
      formattedAnswer,
    };
  }

  const results: KnowledgeSearchResult[] = [];

  // Helper score calculator
  const computeScore = (haystack: string, exactBonus = false): number => {
    let score = 0;
    const lower = haystack.toLowerCase();
    const normalizedH = lower.replace(/[^a-z0-9]/g, "");

    if (exactBonus && lower.includes(q)) {
      score += 50;
    }
    for (const term of terms) {
      if (lower.includes(term)) {
        score += 15;
      }
      const normTerm = term.replace(/[^a-z0-9]/g, "");
      if (normTerm.length > 3) {
        if (normalizedH.includes(normTerm)) {
          score += 30;
        }
        const stem = normTerm.replace(/(?:es|s)$/, "");
        if (stem.length > 3 && normalizedH.includes(stem)) {
          score += 35;
        }
      }
    }
    return score;
  };

  // 1. Search Workflows
  for (const wf of PLATFORM_WORKFLOWS_KNOWLEDGE) {
    if (targetCategory && wf.category.toLowerCase() !== targetCategory && targetCategory !== "all") {
      continue;
    }
    const searchableText = `${wf.title} ${wf.subtitle} ${wf.overview} ${wf.keyFeatures.join(" ")} ${wf.dataSources.join(" ")} ${wf.sampleQueryOrAction}`;
    const score = computeScore(searchableText, true);
    if (score > 0) {
      results.push({
        id: wf.id,
        title: `Workflow ${wf.number}: ${wf.title}`,
        type: "workflow",
        category: wf.categoryLabel,
        summary: wf.subtitle,
        details: wf.overview,
        howToUse: [
          `Open the '${wf.targetTab}' tab in the platform navigation.`,
          ...wf.steps.map((s) => `${s.step} (${s.title}): ${s.description}`),
          `You can also invoke this via Chat with prompt: "${wf.sampleQueryOrAction}"`,
        ],
        targetTab: wf.targetTab,
        apiEndpoint: wf.apiEndpoint,
        samplePrompt: wf.sampleQueryOrAction,
        relevanceScore: score + 15, // bias towards high-level workflows
      });
    }
  }

  // 2. Search FAQs
  for (const faq of FAQ_QUESTIONS) {
    const searchableText = `${faq.question} ${faq.summary} ${faq.theoreticalContext} ${faq.keyParameters} ${faq.samplePrompt}`;
    const score = computeScore(searchableText, true);
    if (score > 0) {
      results.push({
        id: faq.id,
        title: `FAQ ${faq.number}: ${faq.question}`,
        type: "faq",
        category: faq.categoryLabel,
        summary: faq.summary,
        details: `${faq.theoreticalContext}\n\nMathematical Basis: ${faq.mathematicalBasis || "Multivariate optimization"}`,
        howToUse: faq.methods.flatMap((m) => [
          `**${m.name}**: ${m.description}`,
          ...m.actionSteps.map((s) => `  - ${s}`),
        ]),
        targetTab: faq.targetTab,
        samplePrompt: faq.samplePrompt,
        relevanceScore: score + 20, // bias towards specific practical questions
      });
    }
  }

  // 3. Search Decisioning Engines
  for (const dec of DECISIONING_SECTIONS) {
    const rulesText = dec.rules.map((r) => `${r.name} ${r.description} ${r.formulaOrCode || ""}`).join(" ");
    const extraKeywords = dec.id === "pickbesttrades-engine"
      ? "pickbesttrades pick best trade recommendationagent recommendation agent best trade trade plan"
      : dec.id === "stock-screener-logic"
      ? "stock screener nasdaq fallback curated stock universe rsi macd"
      : "";
    const searchableText = `${dec.title} ${dec.subtitle} ${dec.overview} ${rulesText} ${extraKeywords}`;
    const score = computeScore(searchableText, true);
    if (score > 0) {
      results.push({
        id: dec.id,
        title: `Decision Engine ${dec.number}: ${dec.title}`,
        type: "decisioning",
        category: dec.badge,
        summary: dec.subtitle,
        details: dec.overview,
        howToUse: dec.rules.map((r) => `**${r.name}**: ${r.description}`),
        targetTab: "trading",
        samplePrompt: `Explain how the ${dec.title} evaluates setups`,
        relevanceScore: score + 25, // deep logic bias
      });
    }
  }

  // 4. Search Capability Matrix
  for (const cap of CAPABILITY_MATRIX) {
    const searchableText = `${cap.question} ${cap.primaryWorkflow} ${cap.secondaryWorkflow} ${cap.keyInputParameter}`;
    const score = computeScore(searchableText, true);
    if (score > 0) {
      results.push({
        id: `cap-${cap.primaryWorkflow}-${Math.random()}`,
        title: `Capability: ${cap.question}`,
        type: "capability",
        category: "Matrix",
        summary: `Primary: ${cap.primaryWorkflow} · Secondary: ${cap.secondaryWorkflow}`,
        details: `Key Inputs: ${cap.keyInputParameter} · Expected Output: ${cap.optimalOutputStructure}`,
        howToUse: [`Navigate to the '${cap.targetTab}' tab.`],
        targetTab: cap.targetTab,
        samplePrompt: cap.question,
        relevanceScore: score + 5,
      });
    }
  }

  // Sort descending by relevance score
  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const topResults = results.slice(0, maxResults);

  // Generate clear, structured markdown synthesis
  const formattedAnswer = generateMarkdownAnswer(q, topResults);

  return {
    query,
    count: topResults.length,
    results: topResults,
    formattedAnswer,
  };
}

/**
 * Returns comprehensive markdown for the entire platform overview.
 */
function getPlatformOverviewMarkdown(): string {
  return [
    `### Platform Capabilities & How to Use Multi-Agent Studio`,
    ``,
    `Multi-Agent Studio (OpenAIMP) is an enterprise financial intelligence and multi-agent execution platform featuring **8 core workflows**:`,
    ``,
    `1. **Stock Screener & Multi-Exchange Equity Discovery** (Tab: \`trading\` | API: \`/api/etrade/screen\`, \`/api/foss/screen\`)`,
    `   - Screens 8,000+ US equities dynamically across NASDAQ, NYSE, and AMEX with 14-period RSI and MACD momentum.`,
    `   - Fallback hierarchy: Nasdaq Screener API $\\rightarrow$ Yahoo FOSS $\\rightarrow$ Externalized Curated Universe (\`curatedStockUniverse.json\`).`,
    ``,
    `2. **Options Strategy Discovery & Greeks Engine** (Tab: \`trading\` | API: \`/api/etrade/options/strategy\`)`,
    `   - Evaluates 72 catalog options strategies using Black-Scholes Greeks, IV rank, and Probability of Profit.`,
    `   - Supports strict parameter filtering such as Max Loss $\\le$ $30 and Max Profit > $0.`,
    ``,
    `3. **Real-Time Options Flow & Institutional Activity Tracker** (Tab: \`options-flows\` | API: \`/api/options/flows\`)`,
    `   - Tracks unusual volume, smart-money sweeps, blocks, and institutional sentiment. Queries the Stock Screener first for active underlyings.`,
    ``,
    `4. **Visual Multi-Leg Strategy Builder** (Tab: \`trading\` | API: \`/api/options/builder/payoff\`)`,
    `   - Build custom 1-4 leg positions with real-time payoff diagrams, breakeven boundaries, and risk metrics.`,
    ``,
    `5. **Portfolio Risk & Hedging** (Tab: \`trading\` | API: \`/api/etrade/positions\`)`,
    `   - Syncs broker positions, calculates beta-weighted SPY Delta and Theta decay, and generates hedging proposals.`,
    ``,
    `6. **Brokerage Order Execution with HITL Guardrails** (Tab: \`trading\` | API: \`/api/etrade/order/preview\`)`,
    `   - Safe trading: orders are drafted with Agent DIDs and require explicit human confirmation before execution.`,
    ``,
    `7. **Autonomous Background Cron & Alarms** (Tab: \`trading\` | Durable Objects)`,
    `   - 24/7 background market scans and automatic daily E*TRADE token renewal at 23:00 ET.`,
    ``,
    `8. **Natural Language Financial Intelligence (NLQ)** (Tab: \`chat\` / \`nlq\`)`,
    `   - Conversational equity queries, database exploration via SQLite ORM, and tool execution.`,
    ``,
    `**How to use:** You can ask me any specific question in chat (e.g., *"How do I screen stocks for oversold tech?"* or *"How do I find max profit > 0 and max loss <= 30?"*) or switch to the corresponding tab in the navigation bar!`,
  ].join("\n");
}

/**
 * Formats a clean, user-friendly markdown response explaining platform capabilities and how to use them.
 */
function generateMarkdownAnswer(query: string, results: KnowledgeSearchResult[]): string {
  if (results.length === 0) {
    return [
      `### Platform Capabilities & How to Use Multi-Agent Studio`,
      ``,
      `Multi-Agent Studio (OpenAIMP) is an enterprise financial intelligence and multi-agent execution platform featuring **8 core workflows**:`,
      ``,
      `1. **Stock Screener & Multi-Exchange Equity Discovery** (Tab: \`trading\` | API: \`/api/etrade/screen\`, \`/api/foss/screen\`)`,
      `   - Screens 8,000+ US equities dynamically across NASDAQ, NYSE, and AMEX with 14-period RSI and MACD momentum.`,
      `   - Fallback hierarchy: Nasdaq Screener API $\\rightarrow$ Yahoo FOSS $\\rightarrow$ Externalized Curated Universe (\`curatedStockUniverse.json\`).`,
      ``,
      `2. **Options Strategy Discovery & Greeks Engine** (Tab: \`trading\` | API: \`/api/etrade/options/strategy\`)`,
      `   - Evaluates 72 catalog options strategies using Black-Scholes Greeks, IV rank, and Probability of Profit.`,
      `   - Supports strict parameter filtering such as Max Loss $\\le$ $30 and Max Profit > $0.`,
      ``,
      `3. **Real-Time Options Flow & Institutional Activity Tracker** (Tab: \`options-flows\` | API: \`/api/options/flows\`)`,
      `   - Tracks unusual volume, smart-money sweeps, blocks, and institutional sentiment. Queries the Stock Screener first for active underlyings.`,
      ``,
      `4. **Visual Multi-Leg Strategy Builder** (Tab: \`trading\` | API: \`/api/options/builder/payoff\`)`,
      `   - Build custom 1-4 leg positions with real-time payoff diagrams, breakeven boundaries, and risk metrics.`,
      ``,
      `5. **Portfolio Risk & Hedging** (Tab: \`trading\` | API: \`/api/etrade/positions\`)`,
      `   - Syncs broker positions, calculates beta-weighted SPY Delta and Theta decay, and generates hedging proposals.`,
      ``,
      `6. **Brokerage Order Execution with HITL Guardrails** (Tab: \`trading\` | API: \`/api/etrade/order/preview\`)`,
      `   - Safe trading: orders are drafted with Agent DIDs and require explicit human confirmation before execution.`,
      ``,
      `7. **Autonomous Background Cron & Alarms** (Tab: \`trading\` | Durable Objects)`,
      `   - 24/7 background market scans and automatic daily E*TRADE token renewal at 23:00 ET.`,
      ``,
      `8. **Natural Language Financial Intelligence (NLQ)** (Tab: \`chat\` / \`nlq\`)`,
      `   - Conversational equity queries, database exploration via SQLite ORM, and tool execution.`,
      ``,
      `**How to use:** You can ask me any specific question in chat (e.g., *"How do I screen stocks for oversold tech?"* or *"How do I find max profit > 0 and max loss <= 30?"*) or switch to the corresponding tab in the navigation bar!`,
    ].join("\n");
  }

  const sections: string[] = [
    `### Platform Guidance for: "${query || "Platform Capabilities"}"`,
    ``,
  ];

  for (const item of results) {
    sections.push(`#### ${item.title}`);
    sections.push(`*Category: ${item.category} | UI Tab: \`${item.targetTab}\`*`);
    if (item.apiEndpoint) {
      sections.push(`*API Endpoint: \`${item.apiEndpoint}\`*`);
    }
    sections.push(``);
    sections.push(item.summary);
    sections.push(``);
    if (item.howToUse && item.howToUse.length > 0) {
      sections.push(`**How to Use / Action Steps:**`);
      for (const step of item.howToUse) {
        sections.push(`- ${step}`);
      }
      sections.push(``);
    }
    if (item.samplePrompt) {
      sections.push(`💡 **Try Asking in Chat:** *"${item.samplePrompt}"*`);
      sections.push(``);
    }
    sections.push(`---`);
  }

  return sections.join("\n");
}
