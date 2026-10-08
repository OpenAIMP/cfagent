# Multi-Agent Studio — Analysis & Execution Workflows Directory

This document provides the authoritative architectural specification of all **14 operational workflows** in the platform (categorized into **8 Analysis Workflows** and **6 Execution Workflows**), the **8 Quantitative Playbooks (FAQ Solutions)**, the **6 Algorithmic Decisioning Engines**, and the **Capability Lookup Matrix**.

---

## Executive Summary: 14 Operational Workflows Classification Matrix

| # | Workflow Name | Operational Track | Category | Primary UI Tab | Key API Endpoints & Protocols | Governing Decision Engine |
|---|---|---|---|---|---|---|
| **A1** | Multi-Exchange Stock Screener & Equity Momentum | **Analysis (Read-Only)** | Equities | `trading` | `POST /api/etrade/screen`, `POST /api/foss/screen` | Dynamic Screener Ingestion Hierarchy |
| **A2** | Options Strategy Discovery, Greeks Modeling & EV Scoring | **Analysis (Read-Only)** | Options | `trading` | `POST /api/etrade/options/strategy`, `/unified` | Multivariate 6-Factor Composite Model |
| **A3** | Raw Options Contract Screener & Chain Filtering | **Analysis (Read-Only)** | Options | `trading` | `POST /api/trading/options/screen`, `/mcp/scanner` | 15-Gate Contract Rejection Matrix |
| **A4** | Real-Time Options Flow & Institutional Activity Tracker | **Analysis (Read-Only)** | Market Flows | `options-flows` | `GET /api/options/flows/live`, `/summary` | Screener Dynamic Resolution First |
| **A5** | Visual Multi-Leg Strategy Builder & Expiration Payoff | **Analysis (Read-Only)** | Options | `trading` | `POST /api/trading/options/compare`, `/llm-ideas` | 72-Strategy Strike Placement & Ladders |
| **A6** | Institutional Risk Management, Defense Playbooks & Exposure | **Analysis (Read-Only)** | Risk & Hedging | `trading` | `GET /api/etrade/positions`, `GET /etrade/accounts` | Risk Anatomy & Defensive Playbooks |
| **A7** | Zero-Credential FOSS Equity & Crypto Research | **Analysis (Read-Only)** | Research | `research` | `GET /api/foss/quote`, `/fundamentals`, `/bars` | Public FOSS Session Crumb Handshake |
| **A8** | Conversational Financial Intelligence & NLQ Analytics | **Analysis (Read-Only)** | Chat & NLQ | `chat` | `POST /api/nlq`, `POST /api/chat`, `POST /nlq/webhook` | LLM Judge Router & Durable SQLite RAG |
| **E1** | Brokerage Order Preview & HITL Execution (E*TRADE) | **Execution (HITL)** | Brokerage | `trading` | `POST /api/etrade/order/preview`, `/order/execute` | Two-Phase Commit & DID Attestation |
| **E2** | Direct Equities & Crypto Order Placement (Alpaca) | **Execution (HITL)** | Brokerage | `research` | `POST /api/trading/alpaca/order`, `GET /alpaca/orders` | Idempotent Order Staging & Buying Power |
| **E3** | Autonomous Background Cron, Intervals & Token Lifecycle | **Execution (Daemon)** | Automation | `trading` | DO Alarms, `POST /api/schedules/trigger-renew` | 24/7 OAuth Refresh & Durable Alarms |
| **E4** | Omnichannel Execution & One-Click Approvals (Slack/Email/Voice) | **Execution (Multi-Gateway)**| Channels | `trading` | `POST /slack/events`, `GET /trade/approve`, `/voice/trade`| Replay-Proof HMAC-SHA256 Token Gates |
| **E5** | Agentic Micropayments, Gateways & x402 Protocol Settlement | **Execution (Settlement)**| Payments | `payments` | `POST /api/payments/create`, `/mcp/scanner` (x402) | Cryptographic On-Chain Payment Proofs |
| **E6** | Enterprise Observability & Cryptographic Audit Ledger | **Execution (Immutable)**| Audit & Logs | `audit` | `GET /api/audit`, `sqlite://audit/recent` | SQLite WAL & Aspect-Oriented Interceptors |

---

# Part 1: The 8 Quantitative Playbooks & Solutions (The Core FAQ Scenarios)

The platform provides deterministic algorithmic playbooks for the **8 core quantitative questions** asked by traders and quantitative analysts. Each scenario features multiple execution paths (Visual UI, NLQ Agent Prompt, and Background Automation / Code) alongside its exact mathematical formulation.

---

### Scenario Q1: "Find me the best opportunities / recommend me the best opportunities"
* **Core Objective**: Ranks multi-leg options structures from the 72-strategy catalog by a multivariate composite score balancing Expected Value (EV), win rate (POP), bid-ask liquidity, and net theta yield.
* **Quick Takeaway (TL;DR)**: Open **Auto Options Research → 🎯 Strategy Discovery** with the Optimization Slider at **50% (Balanced EV)**, or prompt the AI agent in chat. The engine scans 72 strategies and pins the #1 composite scored setup at the top.
* **Key Input Parameters**:
  | Parameter | Value / Range | Operational Role |
  |---|---|---|
  | `optimizationBias` | `50` (Balanced EV) | Geometric balance between Probability of Profit (POP) and Return-on-Risk (RoR%) |
  | `sentiment` | `bullish`, `neutral`, or `bearish` | Directional posture of candidate search |
  | `minVolume` / `minOpenInterest` | `≥ 500` / `≥ 1,000` | Liquidity floor preventing slippage |
  | `minRewardRisk` | `≥ 0.50` | Payoff asymmetry floor |
* **Expected Visual Output Structure**: Top-ranked 2D payoff card showing Net Debit/Credit, Max Profit, Max Loss, Breakevens, Greeks ($\Delta, \Gamma, \Theta, \text{Vega}$), POP%, and Return on Risk (RoR%).
* **Multi-Method Execution Paths**:
  1. **Visual UI**: Navigate to `trading` tab → **Auto Options Research → 🎯 Strategy Discovery**. Enter ticker (e.g. `NVDA`), select sentiment, leave bias at 50%. Top card reflects highest composite score.
  2. **Conversational Agent (NLQ)**: Prompt: `"Recommend me the best options opportunities on NVDA"`. Multi-agent orchestrator triggers `bestTrade` optimization mode.
  3. **Background Automation**: In `trading` tab → **⏰ Schedulers**, enable `"Autonomous Market Opportunity Scanner"`. Durable Objects scan every 5 minutes and push cards when Score $\ge 80$.
* **Mathematical Formulation**:
  $$S_{\text{composite}} = w_{\text{thesis}} S_{\text{thesis}} + w_{\text{EV}} S_{\text{EV}} + w_{\text{POP}} S_{\text{POP}} + w_{\text{liq}} S_{\text{liq}} + w_{\theta} S_{\theta}$$
  $$\text{EV} = (\text{POP} \times \text{MaxProfit}) - ((1 - \text{POP}) \times \text{MaxLoss})$$
* **Governing Engine**: Multivariate Strategy 6-Factor Composite Scoring (`multivariate-scoring-criteria`).

---

### Scenario Q2: "Find me options that have maxprofit > 0 and maxloss <= 30"
* **Core Objective**: Strict budget and risk cap filtering ensuring total dollar capital at risk never exceeds $30.00 while guaranteeing positive upside.
* **Quick Takeaway (TL;DR)**: In **Strategy Discovery**, set the **Budget ($)** filter to `30` and **Min R:R** to `≥ 1:1`; or in **Raw Contracts Screener**, filter by **Max Ask: $0.30**.
* **Key Input Parameters**:
  | Parameter | Value / Range | Operational Role |
  |---|---|---|
  | `budget` | `≤ $30.00` | Strict capital allocation ceiling per spread |
  | `maxLoss` | `≤ 30` | Dollar loss ceiling ($0.30 net debit $\times$ 100 shares) |
  | `minRewardRisk` | `≥ 1.0` (1:1) | Mathematically enforces $\text{MaxProfit} > \text{MaxLoss}$ |
  | `maxAsk` | `≤ 0.30` | Contract price ceiling for single legs |
* **Expected Visual Output Structure**: Capped debit spreads (e.g. 50¢-wide or $1.00-wide call/put spreads trading for $\le \$0.30$ net debit) or low-cost OTM single legs with capped collateral.
* **Multi-Method Execution Paths**:
  1. **Visual UI**: Open `trading` tab → **🎯 Strategy Discovery**. Enter `Budget: 30`, select `Min R:R: ≥ 1:1`. Surfaces qualifying $1-wide call spreads trading for $0.25 debit ($25 max loss, $75 max profit).
  2. **Raw Contracts Screener**: Open `trading` tab → **📋 Raw Contracts Screener**. Set `Max Ask: 0.30`. Surfaces liquid single contracts with premium $\le \$30$.
  3. **Conversational Agent (NLQ)**: Prompt: `"Find me options on AMD with maxprofit > 0 and maxloss <= 30"`. Parser maps `budget: 30, minRR: 1.0`.
* **Mathematical Formulation**:
  $$\text{NetDebit} \le \$0.30 \implies \text{MaxLoss} = \text{NetDebit} \times 100 \le \$30.00$$
  $$\text{MaxProfit} = (\text{Width} - \text{NetDebit}) \times 100 > \$0.00$$
* **Governing Engine**: Strategy Selection & Budget Cap Gate (`strategy-selection-rules`).

---

### Scenario Q3: "Find me options that have maxchance and maxreturn"
* **Core Objective**: Discovers Pareto-optimal setups along the efficiency frontier that maximize Probability of Profit (POP) and Return-on-Risk (RoR%) simultaneously.
* **Quick Takeaway (TL;DR)**: Set the **Optimization Bias Slider to 50% (Balanced EV)** in Strategy Discovery, or select asymmetric structures like **Broken Wing Butterflies** or **Jade Lizards** that eliminate risk on one side.
* **Key Input Parameters**:
  | Parameter | Value / Range | Operational Role |
  |---|---|---|
  | `optimizationBias` | `50` (Balanced EV) | Maximizes geometric product $\text{POP} \times \text{RoR}\%$ |
  | `strategyType` | `broken_wing_butterfly` / `jade_lizard` | Asymmetric structures with $70\%+$ POP and high center peak |
  | `deltaRange` | `0.30 - 0.45` | Sweet spot between OTM leverage and ATM probability |
* **Expected Visual Output Structure**: Pareto candidate cards plotting win rate against return multiple, detailing the expected value tradeoff.
* **Multi-Method Execution Paths**:
  1. **Visual UI**: In Strategy Discovery, move slider to 50%. Inspect top candidates on the efficiency frontier.
  2. **Asymmetric Structures**: In Strategy Discovery, click **"Choose Strategy (72+)"** → select **"Broken Wing Butterfly"**. Strike placement eliminates risk on the untested side.
  3. **Conversational Agent (NLQ)**: Prompt: `"Find me TSLA options with maximum chance and return balance"`.
* **Mathematical Formulation**:
  $$\text{Pareto Frontier} = \arg\max_{\text{legs}} \big[ \text{POP}(\text{legs}), \text{RoR}\%(\text{legs}) \big]$$
  $$\text{EV} = \text{POP} \times \text{Profit} - (1 - \text{POP}) \times \text{Loss}$$
* **Governing Engine**: Multivariate Scoring & Pareto Frontier (`multivariate-scoring-criteria`).

---

### Scenario Q4: "Find me combinations of options (e.g. butterflies and diagonals)"
* **Core Objective**: Evaluates multi-strike structures (Butterflies, Condors) and multi-expiration structures (Diagonals, Calendars, Double Diagonals).
* **Quick Takeaway (TL;DR)**: Click **"Choose Strategy (72+)"** in Strategy Discovery and select **"Butterflies"** or **"Diagonals & Calendars"**, or build custom multi-expiry positions in the **Visual Payoff Builder**.
* **Key Input Parameters**:
  | Parameter | Value / Range | Operational Role |
  |---|---|---|
  | `strategyGroup` | `Butterflies`, `Diagonals`, `Calendars` | Multi-leg catalog family |
  | `nearDte` / `farDte` | `14d` (short leg) / `60d` (long leg) | Calendar cycle horizon separation |
  | `strikeSpread` | Equal wing spacing ($K_2 - K_1 = K_3 - K_2$) | Symmetric or asymmetric wing width |
* **Expected Visual Output Structure**: Multi-wing 2D payoff chart with breakevens and date matrix simulating time decay across multiple expiration cycles.
* **Multi-Method Execution Paths**:
  1. **Strategy Library Modal**: Open Strategy Discovery → click **"Choose Strategy (72+)"** → select **"Diagonal Call Spread"** or **"Long Call Butterfly"**.
  2. **Visual Custom Builder**: Open Visual Payoff Builder → click **"+ Add Option Leg"** → assemble near-term short leg and far-term long leg.
  3. **Conversational Agent (NLQ)**: Prompt: `"Build me a diagonal spread on NVDA"` or `"Show me butterfly combinations on TSLA"`.
* **Mathematical Formulation**:
  $$\text{Butterfly: } +1\,C(K_1, T) - 2\,C(K_2, T) + 1\,C(K_3, T), \quad K_2 - K_1 = K_3 - K_2$$
  $$\text{Diagonal: } -1\,C(K_2, T_{\text{near}}) + 1\,C(K_1, T_{\text{far}}), \quad T_{\text{near}} < T_{\text{far}}, \, K_1 < K_2$$
* **Governing Engine**: Combinatorial Strike Generation (`strategy-selection-rules`).

---

### Scenario Q5: "Find me options with volatility, volume, liquidity"
* **Core Objective**: Filters chains by institutional liquidity gates (Volume $\ge$ 500, OI $\ge$ 1,000, Spread $\le$ 5%) while sorting by Implied Volatility (IV).
* **Quick Takeaway (TL;DR)**: Open **Raw Contracts Screener** and set **Min Volume: 500**, **Min OI: 1,000**, **Max Spread %: 5.0%**, and **Sort By: Implied Volatility**; or check **Options Flows** for Sweeps with **Vol/OI > 1.5x**.
* **Key Input Parameters**:
  | Parameter | Value / Range | Operational Role |
  |---|---|---|
  | `minVolume` | `≥ 500` | Eliminates illiquid dormant contracts |
  | `minOpenInterest` | `≥ 1,000` | Ensures secondary market market-maker depth |
  | `maxSpreadPct` | `≤ 5.0%` of midpoint | Enforces tight bid/ask execution quality |
  | `sortBy` | `iv` (descending) or `volOiRatio` | Ranks by volatility expansion or volume anomaly |
* **Expected Visual Output Structure**: Filtered contract table displaying Greeks, bid/ask spread %, volume, open interest, and Vol/OI anomaly badge.
* **Multi-Method Execution Paths**:
  1. **Raw Contracts Screener**: `trading` tab → **📋 Raw Contracts Screener**. Set Volume $\ge 500$, OI $\ge 1000$, Spread $\le 5\%$, Sort by IV.
  2. **Options Flows**: Navigate to `options-flows` tab. Filter by Premium $> \$250\text{k}$ and Vol/OI $> 1.5\text{x}$ for institutional sweeps.
  3. **Conversational Agent (NLQ)**: Prompt: `"Screen options on NVDA with volume > 500, tight spreads, and IV > 50%"`.
* **Mathematical Formulation**:
  $$\text{Spread}\% = \frac{\text{Ask} - \text{Bid}}{\text{Mid}} \le 0.05 \quad \land \quad \text{Volume} \ge 500 \quad \land \quad \text{OI} \ge 1000$$
* **Governing Engine**: Raw Options Contracts Screener & Rejection Ledger (`options-screener-logic`).

---

### Scenario Q6: "Find me the most bullish and most bearish combos"
* **Core Objective**: Filters catalog by extreme positive Delta ($\Delta \ge +0.60$) for bullish leverage or extreme negative Delta ($\Delta \le -0.60$) for bearish breakdown protection.
* **Quick Takeaway (TL;DR)**: Click **"🚀 Very Bullish"** or **"🩸 Very Bearish"** sentiment buttons in Strategy Discovery, or inspect the **Top Net Bullish / Bearish Leaderboards** in the Options Flows tab.
* **Key Input Parameters**:
  | Parameter | Value / Range | Operational Role |
  |---|---|---|
  | `sentiment` | `very_bullish` ($\Delta \ge +0.60$) or `very_bearish` ($\Delta \le -0.60$) | Filters catalog to high-directional structures |
  | `candidateStructures` | Synthetic Long/Short, Ratio Backspreads, Vertical Debits | Maximum directional leverage |
  | `targetMove` | `+5% to +10%` upward or downward projection | Evaluates target price payoff magnitude |
* **Expected Visual Output Structure**: High-Delta directional spread or synthetic stock structure with max profit/loss profile and directional payoff curve.
* **Multi-Method Execution Paths**:
  1. **Sentiment Filter Buttons**: In Strategy Discovery, click "Very Bullish" or "Very Bearish" buttons.
  2. **Flow Sentiment Leaderboards**: In Options Flows tab, review Top 10 Bullish and Top 10 Bearish ticker leaderboards.
  3. **Conversational Agent (NLQ)**: Prompt: `"Show me the most aggressive bullish combo on TSLA"`. Generates Synthetic Long Future ($\Delta \approx +1.00$).
* **Mathematical Formulation**:
  $$\text{Net }\Delta = \sum_{i=1}^N q_i \cdot \Delta_i, \quad \text{Bullish: } \Delta \ge +0.60, \quad \text{Bearish: } \Delta \le -0.60$$
* **Governing Engine**: Sentiment & Thesis Mapping (`strategy-selection-rules`).

---

### Scenario Q7: "Find me options with defined risk / undefined risk"
* **Core Objective**: Categorizes setups into strictly capped loss structures (Defined Risk: Spreads, Condors, Butterflies) versus unlimited margin loss structures (Undefined Risk: Naked Calls/Puts).
* **Quick Takeaway (TL;DR)**: Inspect the visual **"🛡️ Defined Risk" (Green)** or **"⚠️ Undefined Risk" (Red)** badges on strategy cards, or enforce `riskPolicy: defined_only` in automated scans to eliminate naked options.
* **Key Input Parameters**:
  | Parameter | Value / Range | Operational Role |
  |---|---|---|
  | `riskType` | `defined` (capped loss), `undefined` (unlimited), `covered` | Explicit risk classification |
  | `riskPolicy` | `defined_only` | Prunes all naked short options with `UNDEFINED_RISK_PROHIBITED` |
  | `maxLoss` | `Finite Dollar Value` vs `Infinity` | Loss boundary verification |
* **Expected Visual Output Structure**: Verified capped-loss structures with explicit dollar collateral requirement and safety badge.
* **Multi-Method Execution Paths**:
  1. **Visual Risk Badges**: In Strategy Discovery, inspect the green "🛡️ Defined Risk" tag on each candidate card.
  2. **Policy Enforcement**: Automated scans pass `riskPolicy: 'defined_only'`, filtering out naked short straddles and strangles.
  3. **Conversational Agent (NLQ)**: Prompt: `"Find me neutral options with defined risk on SPY"`. Recommends Iron Condor, explicitly omitting naked Short Straddles.
* **Mathematical Formulation**:
  $$\text{Defined Risk: } \text{MaxLoss} < \infty \quad (\text{Collateral} = \text{StrikeWidth} - \text{Credit})$$
  $$\text{Undefined Risk: } \text{MaxLoss} = \infty \quad (\text{Requires Tier 4 Margin Approval})$$
* **Governing Engine**: Undefined Risk Safeguards & Registry Guards (`additional-decisioning-gates`).

---

### Scenario Q8: "Find me options with least risk"
* **Core Objective**: Targets trades with either minimum dollar capital at risk (Max Loss $\le$ $25) or maximum statistical probability of profit (POP $\ge$ 88-92% with deep safety cushion).
* **Quick Takeaway (TL;DR)**: Move the **Optimization Slider to 100% (Max Chance)** for deep OTM credit spreads with POP $\ge 88-92\%$ and 10-15% safety cushion, or set **Budget: $25** for negligible absolute dollar risk.
* **Key Input Parameters**:
  | Parameter | Value / Range | Operational Role |
  |---|---|---|
  | `optimizationBias` | `100` (Max Chance) | Shifts strikes 2 standard deviations OTM ($\Delta \le 0.10$) |
  | `minPop` | `≥ 85%` | High statistical win probability floor |
  | `safetyCushion` | `≥ 10% - 15%` | Underlying price drop allowed before trade begins to lose money |
  | `budget` | `≤ $25.00` | Alternative objective: negligible total dollar outlay |
* **Expected Visual Output Structure**: Deep OTM credit spreads (POP $\ge$ 90%) or Collars with explicit downside floor and breakeven cushion.
* **Multi-Method Execution Paths**:
  1. **Max Chance Optimizer**: Move Optimization Bias slider to 100%. Recommends wide OTM Bull Put Spreads or Cash-Secured Puts.
  2. **Budget Cap**: Enter `Budget: 25` in Discovery filter box. Limits candidates to structures requiring $\le \$25$ collateral.
  3. **Collars / Hedging**: In Strategy Library, select **"Collar"** (Long 100 Shares + Sell OTM Call to finance Buy of OTM Put). Downside is fully hedged.
* **Mathematical Formulation**:
  $$\text{Safety Cushion} = \frac{\text{Spot} - \text{Breakeven}}{\text{Spot}} \ge 0.10 \quad \land \quad \text{POP} \ge 0.88$$
* **Governing Engine**: RecommendationAgent Profile Re-Ranking (`pickbesttrades-engine`).

---

# Part 2: Analysis Workflows (8 Workflows)

Analysis workflows focus on data ingestion, quantitative mathematical modeling, statistical signal extraction, options Greeks calculation, anomaly detection, and natural language analytics. **They are strictly non-side-effecting and read-only with respect to capital and broker state.**

---

### Workflow A1: Multi-Exchange Stock Screener & Equity Momentum Analysis
* **Operational Track**: Analysis (Read-Only)
* **Functional Scope**: Ingests, screens, and ranks 8,000+ active US equities across NASDAQ, NYSE, and AMEX by price boundaries, market capitalization buckets, sector classifications, 14-period daily RSI, and MACD (12, 26, 9 EMA) momentum.
* **Autonomous Fallback Hierarchy**:
  1. Priority 1: Official Nasdaq Screener API (`api.nasdaq.com`) — dynamic 8,000+ ticker catalog.
  2. Priority 2: Yahoo Finance Chart/Summary API (`query1.finance.yahoo.com` / `query2.finance.yahoo.com`).
  3. Priority 3: Externalized Curated Stock Universe (`src/config/curatedStockUniverse.json`) — resilient offline safety net.
* **Downstream Integration**: Serves as the Single Source of Truth for Workflow A4 (Options Flows), ensuring dynamic underlying resolution partitioned by market cap rather than a static list.
* **Enabling Components**: `DynamicMarketScreener` (`src/trading/yfinanceScreener.ts`), `ETradeRestClient` (`src/trading/etrade/client.ts`), `FossResearchService` (`src/services/fossResearch.ts`), `curatedStockUniverse.json` (`src/config/curatedStockUniverse.json`).
* **REST Endpoints**: `POST /api/etrade/screen`, `POST /api/foss/screen`
* **MCP Tools**: `etrade_market_scan`, `foss_market_research`

---

### Workflow A2: Options Strategy Discovery, Greeks Modeling & EV Scoring
* **Operational Track**: Analysis (Read-Only)
* **Functional Scope**: Evaluates multi-leg options structures across a **72-strategy catalog** (Iron Condors, Vertical Spreads, Butterflies, Calendars, Diagonals, Straddles, Strangles). Calibrates synthetic option pricing, computes analytical Black-Scholes Greeks ($\Delta, \Gamma, \Theta, \text{Vega}$), Probability of Profit ($\text{POP} = N(d_2)$), and Expected Value ($\text{EV}$).
* **Budget & Constraint Engine**: Supports strict user limits such as **Max Loss $\le$ $30** and **Max Profit > $0**, delta ranges, and expiration horizons (Weekly, Monthly, LEAPS).
* **Enabling Components**: `UnifiedOptionsService` (`src/trading/options/unifiedOptionsService.ts`), `OptionsStrategyRegistry` (`src/trading/options/strategyRegistry.ts`), `BlackScholesCalculator` (`src/trading/options/blackScholes.ts`), `CalibratedOptionChains` (`src/trading/options/calibratedOptionChains.ts`), `StrategyDiscoveryEngine` (`src/client/options/strategyDiscoveryEngine.ts`).
* **REST Endpoints**: `POST /api/etrade/options/strategy`, `POST /api/trading/options/unified`, `GET /api/etrade/options/chains`
* **MCP Tools**: `query_platform_knowledge`, `execute_nlq`

---

### Workflow A3: Raw Options Contract Screener & Chain Filtering
* **Operational Track**: Analysis (Read-Only)
* **Functional Scope**: Direct, granular contract-level filtering of raw option strikes across calls and puts. Applies 15 rejection code gates (e.g. `SPREAD_TOO_WIDE`, `MIN_VOLUME_FAIL`, `OUTSIDE_DELTA_RANGE`, `STALE_QUOTE`).
* **Enabling Components**: `DynamicOptionsScreener` (`src/trading/optionsScreener.ts`), `OptionsScreenPipeline` (`src/trading/options/pipeline.ts`), `PaidOptionsScreenerCommand` (`src/mcp/agenticPaymentCommands.ts`).
* **REST Endpoints**: `POST /api/trading/options/screen`, `POST /api/premium/options-scan`
* **MCP Tools**: `options_screen_paid` (x402-gated), `execute_nlq`

---

### Workflow A4: Real-Time Options Flow & Institutional Smart Money Tracking
* **Operational Track**: Analysis (Read-Only)
* **Functional Scope**: Analyzes real-time options trade prints for unusual institutional activity. Detects **Sweeps** (orders executed aggressively across multiple exchanges at/above the ask with $\ge \$100\text{k}$ premium), **Blocks**, and **Splits**. Classifies volume-to-open-interest surges ($V/\text{OI} > 1.5\text{x}$) and aggregates live Bull/Bear sentiment leaderboards.
* **Screener Integration**: Dynamically queries Workflow A1 first (`DynamicMarketScreener.screenLive`) to establish active market cap underlyings (Mega, Large, Mid) rather than relying on a static list.
* **Enabling Components**: `OptionsFlowService` (`src/trading/options/flows/flowService.ts`), `DynamicMarketScreener` (`src/trading/yfinanceScreener.ts`), `OptionsFlowFilter` (`src/trading/options/flows/index.ts`), `OptionsFlowsHub` (`src/client/options/flows/index.tsx`).
* **REST Endpoints**: `GET /api/options/flows/live`, `GET /api/options/flows/summary`, `GET /api/options/flows/news`
* **MCP Tools**: `query_platform_knowledge`, `execute_nlq`

---

### Workflow A5: Visual Multi-Leg Strategy Builder & Expiration Payoff Analysis
* **Operational Track**: Analysis (Read-Only)
* **Functional Scope**: Construct custom 1-to-4 leg options positions with real-time expiration and pre-expiration ($T+0$) payoff diagrams. Automatically computes upper and lower breakeven points, maximum theoretical profit, maximum capital at risk, return on risk (RoR), and aggregate portfolio Greeks.
* **Enabling Components**: `StrategyBuilderEngine`, Payoff curve modeler ($\text{PnL}(S) = \sum \text{leg\_pnl}(S)$), LLM Ideas Generator (`src/trading/options/llmIdeas.ts`), LLM Comparison Engine (`src/trading/options/llmComparison.ts`).
* **REST Endpoints**: `POST /api/trading/options/compare`, `POST /api/trading/options/llm-ideas`
* **MCP Tools**: `foss_equity_research_report`, `execute_nlq`

---

### Workflow A6: Institutional Risk Management, Defense Playbooks & Portfolio Exposure
* **Operational Track**: Analysis (Read-Only)
* **Functional Scope**: Provides institutional-grade risk management and defense playbooks across all strategies and trades in the platform:
  - **Risk Anatomy**: Capital at Risk / Max Loss, Full Greeks Matrix ($\Delta, \$,\Delta, \Gamma, \Theta, \text{Vega}$), Directional Drift Sensitivity, Probability of Profit (POP), Probability of Touch, Multi-strike Breakeven Cushions, American Early Assignment & Dividend Tail Hazards, and Multi-point Stress Test Scenarios (-20% crash to +20% squeeze).
  - **Defense Playbook**: NAV-based Position Sizing Calculator (2–5% capital budget), Profit-Taking Rules (50% rule for credit spreads, 75–100% for debit spreads), Stop-Loss Preservations (2x credit rule or 50% premium loss), and Tactical Defense Adjustments (Roll Out in time for duration/credit, Roll Untested Wing closer to spot, Invert Spreads, Delta Hedge).
  - **Universal Integration**: Accessible on every strategy discovery card, builder action bar, strategy library card, raw contract screener row, institutional flow print, portfolio holding, order draft preview, and orders ledger trade.
* **Enabling Components**: `RiskManagementEngine` (`src/client/options/riskManagementEngine.ts`), `RiskAnalysisModal` (`src/client/options/RiskAnalysisModal.tsx`), `ETradeTradingHub` (`src/client/ETradeTradingHub.tsx`), `ETradeRestClient` (`src/trading/etrade/client.ts`).
* **REST Endpoints**: `GET /api/etrade/positions`, `GET /api/etrade/accounts`
* **MCP Tools**: `etrade_get_positions`, `sqlite://trading/orders`, `query_platform_knowledge`

---

### Workflow A7: Zero-Credential FOSS Equity & Crypto Research (Yahoo Finance & Alpaca)
* **Operational Track**: Analysis (Read-Only)
* **Functional Scope**: 100% free, credential-less equity and cryptocurrency research. Ingests fundamental ratios (P/E, forward P/E, PEG, Price-to-Book, EV/EBITDA), analyst consensus price targets, historical OHLCV chart bars (daily, hourly, 5-minute), and crypto Level 1 NBBO bid/ask quotes without requiring API keys.
* **Enabling Components**: `FossResearchService` (`src/services/fossResearch.ts`), `YahooFinanceProvider` (`src/services/fossResearch.ts`), `AlpacaMarketDataProvider` (`src/services/alpacaMarketData.ts`), `FossResearchHub` (`src/client/FossResearchHub.tsx`).
* **REST Endpoints**: `GET /api/foss/quote`, `GET /api/foss/fundamentals`, `GET /api/foss/bars`, `GET /api/foss/snapshot`
* **MCP Tools**: `foss_get_quote`, `foss_fundamentals`, `foss_historical_bars`, `foss_market_research`

---

### Workflow A8: Conversational Financial Intelligence & NLQ Analytics
* **Operational Track**: Analysis (Read-Only)
* **Functional Scope**: Natural Language Query (NLQ) engine converting user questions into parameter-bound SQLite queries, market scans, and options evaluations. Integrates the **LLM Judge** router to classify intents (`search`, `trading`, `research`, `payments`, `tasks`, `memory`) with confidence scoring. Backed by Workers AI (`glm-4.7-flash` / `Llama 3.3 70B`) and Vectorize RAG retrieval.
* **Enabling Components**: `NLQPlanner` & `NLQExecutor` (`src/agents/nlq.ts`), `LLMJudge` (`src/agents/judge.ts`), `DatabaseORM` (`src/orm/index.ts`), `PlatformKnowledgeService` (`src/services/platformKnowledge.ts`).
* **REST Endpoints**: `POST /api/nlq`, `POST /api/chat`, `POST /nlq/webhook`, `GET /api/schema/tables`
* **MCP Tools**: `execute_nlq`, `knowledge_search`, `query_platform_knowledge`, `manage_session_memory`

---

# Part 3: Execution Workflows (6 Workflows)

Execution workflows perform side-effecting operations, money movement, order submission, background automation, and external communications. **Every execution workflow enforces strict guardrails, including Human-in-the-Loop (HITL) approval, W3C DID attestations, and cryptographic audit logging.**

---

### Workflow E1: Brokerage Order Preview & Human-in-the-Loop (HITL) Execution (E*TRADE)
* **Operational Track**: Execution (HITL Guarded)
* **Functional Scope**: Safe stock and options order placement. The agent **NEVER** executes trades autonomously. Orders are drafted as preview tickets containing calculated commissions, fees, and margin requirements. Each draft is cryptographically signed with the agent's Decentralized Identifier (`did:agent:openaimp:trading`). Execution only proceeds after explicit user confirmation in the UI or chat.
* **Enabling Components**: `ETradeRestClient` (`src/trading/etrade/client.ts`), `ETradeTradingHub` (`src/client/ETradeTradingHub.tsx`), `ETradePreviewOrderCommand` & `ETradeExecuteOrderCommand` (`src/mcp/etradeCommands.ts`), W3C DID Attestation Service (`src/agents/did.ts`).
* **REST Endpoints**: `POST /api/etrade/order/preview`, `POST /api/etrade/order/execute`, `POST /api/etrade/orders/cancel`
* **MCP Tools**: `etrade_preview_order`, `etrade_execute_order`

---

### Workflow E2: Direct Equities & Crypto Order Placement (Alpaca Broker API)
* **Operational Track**: Execution (HITL Guarded)
* **Functional Scope**: Places equity and cryptocurrency market, limit, and stop orders through Alpaca Securities. Supports fractional shares and extended-hours execution.
* **Enabling Components**: `AlpacaMarketDataProvider` (`src/services/alpacaMarketData.ts`), `FossAlpacaPlaceOrderCommand` (`src/mcp/fossCommands.ts`).
* **REST Endpoints**: `POST /api/trading/alpaca/order`, `GET /api/trading/alpaca/orders`, `DELETE /api/trading/alpaca/orders/{orderId}`
* **MCP Tools**: `foss_alpaca_place_order`, `foss_alpaca_orders`, `foss_alpaca_account`

---

### Workflow E3: Autonomous Background Cron, Interval Alarms & Token Lifecycle Management
* **Operational Track**: Execution (Autonomous Daemon)
* **Functional Scope**: 24/7 background automation powered by Cloudflare Durable Object Alarms. Automatically renews E*TRADE OAuth access tokens daily at 23:00 ET before midnight expiration, triggers market screening scans every 5 minutes (300 seconds), processes queued async jobs, and broadcasts live alerts over WebSockets.
* **Enabling Components**: `ScheduledTasksService` (`src/services/scheduledTasks.ts`), Cloudflare Agents Alarm Lifecycle (`schedule`, `scheduleEvery`, `keepAliveWhile`), SQLite Durable Async Job Ledger (`mas_async_jobs`).
* **REST Endpoints**: `POST /api/schedules/trigger-screen`, `POST /api/schedules/trigger-renew`, `POST /api/schedules/trigger-options-analysis`, `GET /api/jobs`
* **MCP Tools**: `get_async_job`, `list_async_jobs`

---

### Workflow E4: Omnichannel Execution & One-Click Approvals (Slack, Email, Voice)
* **Operational Track**: Execution (Multi-Gateway)
* **Functional Scope**: Multi-channel execution gateway allowing traders to interact with the platform from anywhere:
  - **Slack**: Ingests `@mention` commands, renders Block Kit visual cards, and processes interactive button clicks.
  - **Email**: Receives inbound emails, parses trade intents, and emails `.xlsx` quantitative workbooks.
  - **One-Click Approval Link**: Generates secure, HMAC-signed approval URLs (`/trade/approve?orderId=...`) for instant mobile execution.
  - **Voice**: Full-duplex WebSocket audio session for conversational trading.
* **Enabling Components**: `ETradeSlackTradingService` (`src/trading/slack/agent.ts`), `ETradeEmailTradingService` (`src/trading/email/agent.ts`), `ETradeVoiceTradingService` (`src/trading/voice/agent.ts`), `ETradeWebhookService` (`src/services/tradingWebhooks.ts`).
* **REST Endpoints**: `POST /slack/events`, `POST /slack/interactions`, `GET /trade/approve`, `POST /api/trading/reports/email`, `POST /api/trading/reports/webhook`
* **MCP Tools**: `dispatch_trading_webhook`

---

### Workflow E5: Agentic Micropayments, Gateways & x402 Protocol Settlement
* **Operational Track**: Execution (Settlement)
* **Functional Scope**: Multi-processor payment intent drafting and execution with human confirmation across traditional gateways (Stripe, PayPal, Lemon Squeezy) and next-generation **HTTP 402 (x402) pay-per-use micropayments**. Enables external MCP clients to access premium scanning tools by paying $0.05 USDC per query with verifiable cryptographic receipts.
* **Enabling Components**: `PaymentGatewayService` (`src/services/payments.ts`), `PaymentStrategyFactory` (`src/patterns/paymentStrategies.ts`), `x402Verifier` (`src/services/x402Verifier.ts`), `OptionsScannerMCP` (`src/services/cloudflareWalletsScanner.ts`).
* **REST Endpoints**: `POST /api/payments/create`, `POST /api/payments/confirm`, `POST /api/payments/capture`, `POST /mcp/scanner`
* **MCP Tools**: `draft_payment`, `confirm_payment_draft`, `get_payment_gateways`, `get_transactions`

---

### Workflow E6: Enterprise Observability & Cryptographic Audit Ledger Execution
* **Operational Track**: Execution (Immutable Ledger)
* **Functional Scope**: Records immutable audit events for every system action: routing decisions, judge evaluations, payment lifecycle transitions, order previews, and executions. Publishes events to the SQLite event store and streams telemetry to external observability collectors.
* **Enabling Components**: `DatabaseORM` (`src/orm/index.ts`), `AuditEventPublisher` & `Observer` pattern (`src/patterns/observer.ts`), `SqliteAuditObserver` & `TelemetryAuditObserver`, `AspectOrientedLogging` (`src/aspects/loggingAspect.ts`).
* **REST Endpoints**: `GET /api/audit`, `POST /api/audit/event`
* **MCP Tools**: `get_audit_events`, `sqlite://audit/recent`

---

# Part 4: Algorithmic Decisioning, Scoring & Selection Engines (6 Engines)

### Engine 1: Stock Screener Search, Ingestion & Fallback Decision Logic (Governs A1, A4)
1. **Multi-Exchange Ingestion Hierarchy**: Prioritizes `api.nasdaq.com` (~8,500 listings) $\to$ Yahoo Finance FOSS feeds $\to$ curated universe (`src/config/curatedStockUniverse.json`).
2. **Options Flow Screener-First Integration**: Options Flow invokes `DynamicMarketScreener.screenLive({ minPrice: 3.0 })` to partition underlyings into Large Cap ($\ge \$10\text{B}$), Mid Cap ($\$2\text{B}-\$10\text{B}$), and Small Cap ($\$250\text{M}-\$2\text{B}$).
3. **Auditable Rejection Codes**: `EXCHANGE_MISMATCH`, `PRICE_OUT_OF_RANGE`, `MARKET_CAP_OUT_OF_RANGE`, `NON_OPTIONABLE_SECURITY`, `CHANGE_PERCENT_OUT_OF_RANGE`.

### Engine 2: Raw Options Contracts Screener & 15-Gate Rejection Ledger (Governs A3)
1. **Liquidity Gates**: $\text{Volume} \ge \text{minVolume} \land \text{OI} \ge \text{minOI} \land \text{Spread}\% \le \text{maxSpread}\%$.
2. **Moneyness Band**: ATM classified within $\pm 2\%$ of underlying spot.
3. **15 Rejection Codes**: `INVALID_QUOTE`, `SPREAD_TOO_WIDE`, `PREMIUM_OUT_OF_RANGE`, `DTE_OUT_OF_RANGE`, `DELTA_OUT_OF_RANGE`, `GAMMA_OUT_OF_RANGE`, `THETA_OUT_OF_RANGE`, `VEGA_OUT_OF_RANGE`, `IV_OUT_OF_RANGE`, `VOLUME_TOO_LOW`, `OPEN_INTEREST_TOO_LOW`, `MONEYNESS_MISMATCH`, `STRIKE_DISTANCE_TOO_WIDE`, `ADJUSTED_CONTRACT`, `STALE_QUOTE`.

### Engine 3: 72-Strategy Strike Placement & Optimization Bias Shift (Governs A2, A5)
1. **Bias Shift Formula**:
   $$\text{biasShift} = \text{round}\left(\frac{50 - \text{optimizationBias}}{50} \times 3\right)$$
   - Bias 0 (Max Return): Shifts +3 strikes OTM (higher leverage, lower POP).
   - Bias 50 (Balanced EV): Centers around ATM strikes.
   - Bias 100 (Max Chance): Shifts -3 strikes ITM (higher win rate, lower multiple).
2. **Horizon Grouping**: Near-Term (0–30 DTE), Mid-Term (31–90 DTE), Long-Term/LEAPS (91+ DTE).

### Engine 4: Multivariate Strategy 6-Factor Composite Scoring Model (Governs A2)
$$S = w_{\text{thesis}} S_{\text{thesis}} + w_{\text{RR}} S_{\text{RR}} + w_{\text{liq}} S_{\text{liq}} + w_{\text{fresh}} S_{\text{fresh}} + w_{\text{iv}} S_{\text{iv}} + w_{\theta} S_{\theta}$$
| Component | Weight | Mathematical Definition |
|---|---|---|
| **Thesis Alignment** | `30%` | Payoff magnitude at target price: $\text{clamp}(50 + 25 \log_2(1 + \text{RR}))$ |
| **Target Reward/Risk** | `20%` | $\text{clamp}((\text{RR} / \max(\text{minRR}, 0.25)) \times 70)$ |
| **Execution Liquidity** | `20%` | $0.70 \times \text{spreadScore} + 0.30 \times \text{activityScore}$ |
| **Quote Freshness** | `15%` | FRESH (< 60s) = 100, STALE = 25, UNKNOWN = 0 |
| **Volatility Alignment** | `10%` | Vega alignment with expected IV expansion or contraction |
| **Theta Decay Burden** | `5%` | Penalizes trades with daily time decay exceeding collateral limits |

### Engine 5: RecommendationAgent `pickBestTrades` Decision Engine (Governs A2, E1)
1. **Risk Profiles**:
   - Conservative: 35% POP + 20% Capital Safety + 20% Engine Score + 15% Liquidity + 10% R:R.
   - Balanced: 30% Engine Score + 25% R:R + 20% POP + 15% Liquidity + 10% Capital Safety.
   - Aggressive: 45% R:R + 25% Engine Score + 20% Liquidity + 10% POP + 0% Capital Safety.
2. **Blockers & Status Degradation**: Stale quotes degrade status to `LOW` confidence. Negative profit or POP < 20% triggers status `no_trade`.
3. **High Confidence Threshold**: Margin over runner-up $\ge 5.0$ points $\land$ Liquidity $\ge 60$ $\land$ POP $\ge 35\%$.

### Engine 6: Execution Safeguards, Riskless Arbitrage Rejection & HITL (Governs A6, E1, E3, E5)
1. **Undefined Risk Exclusion**: Rejects uncapped naked options when `riskPolicy === 'defined_only'` with `UNDEFINED_RISK_PROHIBITED`.
2. **Apparent Riskless Profit Gate**: Rejects flat positive profit profiles caused by crossed or stale quotes.
3. **Mandatory HITL Gate**: Halts execution, presents amber draft ticket, and requires authenticated human authorization.

---

# Part 5: Capability Matrix & Input/Output Cheat Sheet

| Question / Scenario | Primary Workflow | Secondary Workflow | Key Input Parameter | Optimal Output Structure | Target Tab |
|---|---|---|---|---|---|
| **Best Opportunities** | A2: Strategy Discovery | E3: Autonomous Schedulers | `bias: 50, compositeScore` | Top-ranked 2D payoff card with Greeks | `trading` |
| **Max Profit > 0 & Max Loss <= 30** | A2: Strategy Discovery | A3: Raw Options Screener | `budget: 30, minRR: 1.0` | Capped debit spreads / micro-verticals | `trading` |
| **Max Chance & Max Return** | A2: Strategy Discovery | A8: NLQ Chat Agent | `bias: 50, Pareto Frontier` | Balanced POP vs RoR% Pareto candidates | `trading` |
| **Combinations (Butterflies/Diagonals)**| A2: Strategy Discovery | A5: Strategy Builder | `family: Butterfly / Diagonal`| Multi-expiry / multi-wing payoff matrix | `trading` |
| **Volatility, Volume, Liquidity** | A3: Raw Contracts Screener | A4: Options Flows | `minVol: 500, maxSpread: 5%`| Filtered contract chain table with Greeks | `trading` |
| **Most Bullish / Bearish Combos** | A2: Strategy Discovery | A4: Options Flows | `sentiment: very_bullish` | High-Delta synthetic or ratio spreads | `trading` |
| **Defined vs Undefined Risk** | A2: Strategy Discovery | E1: Brokerage HITL Guard | `riskPolicy: defined_only` | Verified capped-loss structures | `trading` |
| **Least Risk & Capital Preservation** | A2: Strategy Discovery | A6: Institutional Risk | `bias: 100 (Max Chance), POP≥90%`| Deep OTM credit spreads or Collars | `trading` |

---

# Part 6: Architectural Optimization Roadmap (6 Enhancements)

1. **Multi-Underlying Cross-Sectional Constraint Scanning**: Asynchronous batch scanning across top 50 liquid tickers for budget and risk queries.
2. **Multi-Objective Pareto Optimization Engine**: Integration of NSGA-II to construct the true non-dominated Pareto Efficient Frontier between POP and Return.
3. **Declarative Multi-Leg Constraint Solver**: Inverse mathematical solver ($\text{Width} - \text{Credit} \le \$0.30$) discovering dynamic combinations directly from live chains.
4. **Unified Cross-Asset SVI Volatility Surface Model**: Modeling IV smile/skew across delta buckets using Stochastic Volatility Inspired (SVI) parametrization.
5. **Direct NLQ-to-Payoff Builder Deep Linking**: Clickable URL hashes (`#trade=NVDA:BULL_PUT:120P_115P`) loading pre-configured payoff visualizers instantly.
6. **Real-Time Flow-Informed Strategy Discovery**: Injecting institutional tape signals ($S_{\text{flow}}$) directly into the strategy opportunity scoring formula.

---

# Part 7: Architectural Topology & Guardrails Comparison

```
                     ┌────────────────────────────────────────────────────────┐
                     │          Multi-Agent Studio (Cloudflare DO)            │
                     └──────────────────────────┬─────────────────────────────┘
                                                │
                 ┌──────────────────────────────┴──────────────────────────────┐
                 ▼                                                             ▼
 ┌───────────────────────────────┐                             ┌───────────────────────────────┐
 │      ANALYSIS TRACK (8)       │                             │      EXECUTION TRACK (6)      │
 │  (Read-Only, Compute & Quant) │                             │   (Side-Effecting & Money)    │
 ├───────────────────────────────┤                             ├───────────────────────────────┤
 │ A1: Stock Screener & Momentum │                             │ E1: E*TRADE Preview & HITL    │
 │ A2: Options Strategy & Greeks │                             │ E2: Alpaca Equities/Crypto    │
 │ A3: Raw Options Contracts     │                             │ E3: Durable Cron & Alarms     │
 │ A4: Real-Time Options Flows   │                             │ E4: Slack/Email/Voice Channels│
 │ A5: Multi-Leg Payoff Builder  │                             │ E5: Stripe/x402 Micropayments │
 │ A6: Institutional Risk Matrix │                             │ E6: Observability Audit Ledger│
 │ A7: FOSS Research (YF/Alpaca) │                             └───────────────┬───────────────┘
 │ A8: Conversational NLQ & RAG  │                                             │
 └───────────────┬───────────────┘                                             │
                 │                                                             ▼
                 ▼                                             ┌───────────────────────────────┐
 ┌───────────────────────────────┐                             │   MANDATORY HITL GUARDRAILS   │
 │        DATA FEEDS & APIS      │                             │ 1. Zero Autonomous Executions │
 │ • api.nasdaq.com              │                             │ 2. W3C DID Attestation Stamps │
 │ • query1/query2.finance.yahoo │                             │ 3. Two-Phase Commit Preview   │
 │ • api.etrade.com (Chains/Quotes)                            │ 4. Replay-Proof HMAC Webhooks │
 │ • data.alpaca.markets         │                             │ 5. SQLite WAL Transaction Log │
 │ • Cloudflare Workers AI & RAG │                             └───────────────────────────────┘
 └───────────────────────────────┘
```
