# Multi-Agent Studio — Analysis & Execution Workflows Directory

This document provides the authoritative architectural specification of all **14 operational workflows** in the platform, categorized into **8 Analysis Workflows** and **6 Execution Workflows**. It details the exact components, engines, third-party and internal APIs, protocols, and safety guardrails that power each workflow.

---

## Executive Summary: Workflow Classification Matrix

| # | Workflow Name | Operational Track | Category | Primary UI Tab | Key API Endpoints & Protocols |
|---|---|---|---|---|---|
| **A1** | Multi-Exchange Stock Screener & Equity Momentum | **Analysis** | Equities | `trading` | `POST /api/etrade/screen`, `POST /api/foss/screen` |
| **A2** | Options Strategy Discovery, Greeks Modeling & EV Scoring | **Analysis** | Options | `trading` | `POST /api/etrade/options/strategy`, `/unified` |
| **A3** | Raw Options Contract Screener & Chain Filtering | **Analysis** | Options | `trading` | `POST /api/trading/options/screen`, `/mcp/scanner` |
| **A4** | Real-Time Options Flow & Institutional Activity Tracker | **Analysis** | Market Flows | `options-flows` | `GET /api/options/flows/live`, `/summary` |
| **A5** | Visual Multi-Leg Strategy Builder & Expiration Payoff | **Analysis** | Options | `trading` | `POST /api/trading/options/compare`, `/llm-ideas` |
| **A6** | Portfolio Risk Exposure, SPY Beta-Weighting & Hedging | **Analysis** | Brokerage | `trading` | `GET /api/etrade/positions`, `GET /etrade/accounts` |
| **A7** | Zero-Credential FOSS Equity & Crypto Research | **Analysis** | Research | `research` | `GET /api/foss/quote`, `/fundamentals`, `/bars` |
| **A8** | Conversational Financial Intelligence & NLQ Analytics | **Analysis** | Chat & NLQ | `chat` / `nlq` | `POST /api/nlq`, `POST /api/chat`, `POST /nlq/webhook` |
| **E1** | Brokerage Order Preview & HITL Execution (E*TRADE) | **Execution** | Brokerage | `trading` | `POST /api/etrade/order/preview`, `/order/execute` |
| **E2** | Direct Equities & Crypto Order Placement (Alpaca) | **Execution** | Brokerage | `research` | `POST /api/trading/alpaca/order`, `GET /alpaca/orders` |
| **E3** | Autonomous Background Cron, Intervals & Token Lifecycle | **Execution** | Automation | `trading` | DO Alarms, `POST /api/schedules/trigger-renew` |
| **E4** | Omnichannel Execution & Approvals (Slack, Email, Voice) | **Execution** | Channels | `trading` | `POST /slack/events`, `GET /trade/approve`, `/voice/trade` |
| **E5** | Agentic Micropayments, Gateways & x402 Protocol | **Execution** | Payments | `payments` | `POST /api/payments/create`, `/mcp/scanner` (x402) |
| **E6** | Enterprise Observability & Cryptographic Audit Ledger | **Execution** | Audit | `audit` | `GET /api/audit`, `sqlite://audit/recent` |

---

# Part 1: Analysis Workflows (8 Workflows)

Analysis workflows focus on data ingestion, quantitative mathematical modeling, statistical signal extraction, options Greeks calculation, anomaly detection, and natural language analytics. **They are strictly non-side-effecting and read-only with respect to capital and broker state.**

---

### Workflow A1: Multi-Exchange Stock Screener & Equity Momentum Analysis
* **Operational Track**: Analysis
* **Functional Scope**: Ingests, screens, and ranks 8,000+ active US equities across NASDAQ, NYSE, and AMEX by price boundaries, market capitalization buckets, sector classifications, 14-period daily RSI, and MACD (12, 26, 9 EMA) momentum.
* **Autonomous Fallback Hierarchy**:
  1. Priority 1: Official Nasdaq Screener API (`api.nasdaq.com`) — dynamic 8,000+ ticker catalog.
  2. Priority 2: Yahoo Finance Chart/Summary API (`query1.finance.yahoo.com` / `query2.finance.yahoo.com`).
  3. Priority 3: Externalized Curated Stock Universe (`src/config/curatedStockUniverse.json`) — resilient offline safety net.
* **Downstream Integration**: Serves as the Single Source of Truth for Workflow A4 (Options Flows), ensuring dynamic underlying resolution.
* **Enabling Components**:
  - `DynamicMarketScreener` (`src/trading/yfinanceScreener.ts`)
  - `ETradeRestClient` (`src/trading/etrade/client.ts`)
  - `FossResearchService` (`src/services/fossResearch.ts`)
  - `curatedStockUniverse.json` (`src/config/curatedStockUniverse.json`)
* **APIs Leveraged**:
  - `https://api.nasdaq.com/api/screener/stocks` (Nasdaq listings)
  - `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}` (historical OHLCV)
  - `https://query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}` (market capitalization & statistics)
  - `https://fc.yahoo.com` (session cookie/crumb authentication)
  - `https://api.etrade.com/v1/market/quote/{symbol}` (E*TRADE live quotes)
* **REST Endpoints**: `POST /api/etrade/screen`, `POST /api/foss/screen`
* **MCP Tools**: `etrade_market_scan`, `foss_market_research`

---

### Workflow A2: Options Strategy Discovery, Greeks Modeling & EV Scoring
* **Operational Track**: Analysis
* **Functional Scope**: Evaluates multi-leg options structures across a **72-strategy catalog** (Iron Condors, Vertical Spreads, Butterflies, Calendars, Diagonals, Straddles, Strangles). Calibrates synthetic option pricing, computes analytical Black-Scholes Greeks ($\Delta, \Gamma, \Theta, \text{Vega}$), Probability of Profit ($\text{POP} = N(d_2)$), and Expected Value ($\text{EV}$).
* **Budget & Constraint Engine**: Supports strict user limits such as **Max Loss $\le$ $30** and **Max Profit > $0**, delta ranges, and expiration horizons (Weekly, Monthly, LEAPS).
* **Enabling Components**:
  - `UnifiedOptionsService` (`src/trading/options/unifiedOptionsService.ts`)
  - `OptionsStrategyRegistry` (`src/trading/options/strategyRegistry.ts`)
  - `BlackScholesCalculator` (`src/trading/options/blackScholes.ts`)
  - `CalibratedOptionChains` (`src/trading/options/calibratedOptionChains.ts`)
  - `StrategyDiscoveryEngine` (`src/client/options/strategyDiscoveryEngine.ts`)
* **APIs Leveraged**:
  - `https://api.etrade.com/v1/market/optionchains` (option chains, strikes, bid/ask spreads, open interest)
  - `https://api.etrade.com/v1/market/optionexpiredate` (standardized expiration cycles)
  - Black-Scholes analytical engine with continuous dividend and risk-free interest rates
* **REST Endpoints**: `POST /api/etrade/options/strategy`, `POST /api/trading/options/unified`, `GET /api/etrade/options/chains`
* **MCP Tools**: `query_platform_knowledge`, `execute_nlq`

---

### Workflow A3: Raw Options Contract Screener & Chain Filtering
* **Operational Track**: Analysis
* **Functional Scope**: Direct, granular contract-level filtering of raw option strikes. Applies 15 rejection code gates (e.g. `SPREAD_TOO_WIDE`, `MIN_VOLUME_FAIL`, `OUTSIDE_DELTA_RANGE`, `STALE_QUOTE`).
* **Enabling Components**:
  - `DynamicOptionsScreener` (`src/trading/optionsScreener.ts`)
  - `OptionsScreenPipeline` (`src/trading/options/pipeline.ts`)
  - `PaidOptionsScreenerCommand` (`src/mcp/agenticPaymentCommands.ts`)
* **APIs Leveraged**:
  - `https://api.etrade.com/v1/market/optionchains`
  - Synthetic mid-price and spread-ratio solvers
* **REST Endpoints**: `POST /api/trading/options/screen`, `POST /api/premium/options-scan`
* **MCP Tools**: `options_screen_paid` (x402-gated), `execute_nlq`

---

### Workflow A4: Real-Time Options Flow & Institutional Smart Money Tracking
* **Operational Track**: Analysis
* **Functional Scope**: Analyzes real-time options trade prints for unusual institutional activity. Detects **Sweeps** (orders executed aggressively across multiple exchanges at/above the ask with $\ge \$100\text{k}$ premium), **Blocks**, and **Splits**. Classifies volume-to-open-interest surges ($V/\text{OI} > 1.5\text{x}$) and aggregates live Bull/Bear sentiment leaderboards.
* **Screener Integration**: Dynamically queries Workflow A1 first (`DynamicMarketScreener.screenLive`) to establish active market cap underlyings (Mega, Large, Mid) rather than relying on a static list.
* **Enabling Components**:
  - `OptionsFlowService` (`src/trading/options/flows/flowService.ts`)
  - `DynamicMarketScreener` (`src/trading/yfinanceScreener.ts`)
  - `OptionsFlowFilter` (`src/trading/options/flows/index.ts`)
  - `OptionsFlowsHub` (`src/client/options/flows/index.tsx`)
* **APIs Leveraged**:
  - Live normalized options tape feed
  - `api.nasdaq.com` (dynamic underlying discovery)
  - Volume/OI anomaly detection algorithms
* **REST Endpoints**: `GET /api/options/flows/live`, `GET /api/options/flows/summary`, `GET /api/options/flows/news`, `GET /api/options/flows/insider`, `GET /api/options/flows/congress`
* **MCP Tools**: `query_platform_knowledge`, `execute_nlq`

---

### Workflow A5: Visual Multi-Leg Strategy Builder & Expiration Payoff Analysis
* **Operational Track**: Analysis
* **Functional Scope**: Construct custom 1-to-4 leg options positions with real-time expiration and pre-expiration ($T+0$) payoff diagrams. Automatically computes upper and lower breakeven points, maximum theoretical profit, maximum capital at risk, return on risk (RoR), and aggregate portfolio Greeks.
* **Enabling Components**:
  - `StrategyBuilderEngine`
  - Payoff curve mathematical modeler: $\text{PnL}(S) = \sum \text{leg\_pnl}(S)$
  - LLM Options Ideas Generator (`src/trading/options/llmIdeas.ts`)
  - Options LLM Comparison Engine (`src/trading/options/llmComparison.ts`)
* **APIs Leveraged**:
  - Live quote and option chain pricing feeds
  - Cloudflare Workers AI (`@cloudflare/ai-chat` / `Llama 3.3 70B`)
* **REST Endpoints**: `POST /api/trading/options/compare`, `POST /api/trading/options/llm-ideas`
* **MCP Tools**: `foss_equity_research_report`, `execute_nlq`

---

### Workflow A6: Portfolio Risk Exposure, SPY Beta-Weighting & Hedging Analysis
* **Operational Track**: Analysis
* **Functional Scope**: Connects to the user's active brokerage portfolio to compute total portfolio Net Delta ($\Delta_{\text{SPY}}$), beta-weighted against the S&P 500. Audits daily Theta decay vs. negative carry burden, detects volatility tail-risk imbalances, and proposes delta-neutral hedging setups.
* **Enabling Components**:
  - `PortfolioRiskEngine`
  - `ETradeRestClient` (`src/trading/etrade/client.ts`)
  - `ScheduledTasksService` (`src/services/scheduledTasks.ts`)
* **APIs Leveraged**:
  - `https://api.etrade.com/v1/accounts/{accountIdKey}/portfolio` (active holdings and cost basis)
  - `https://api.etrade.com/v1/accounts/{accountIdKey}/balance` (cash & margin balances)
  - Historical beta calculation feeds
* **REST Endpoints**: `GET /api/etrade/positions`, `GET /api/etrade/accounts`
* **MCP Tools**: `etrade_get_positions`, `sqlite://trading/orders`

---

### Workflow A7: Zero-Credential FOSS Equity & Crypto Research (Yahoo Finance & Alpaca)
* **Operational Track**: Analysis
* **Functional Scope**: 100% free, credential-less equity and cryptocurrency research. Ingests fundamental ratios (P/E, forward P/E, PEG, Price-to-Book, EV/EBITDA), analyst consensus price targets, historical OHLCV chart bars (daily, hourly, 5-minute), and crypto Level 1 NBBO bid/ask quotes.
* **Enabling Components**:
  - `FossResearchService` (`src/services/fossResearch.ts`)
  - `YahooFinanceProvider` (`src/services/fossResearch.ts`)
  - `AlpacaMarketDataProvider` (`src/services/alpacaMarketData.ts`)
  - `FossResearchHub` (`src/client/FossResearchHub.tsx`)
* **APIs Leveraged**:
  - `https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}`
  - `https://data.alpaca.markets/v2/stocks/{symbol}/quotes` (NBBO bid/ask)
  - `https://data.alpaca.markets/v1beta3/crypto/us/latest/quotes` (Crypto tape)
* **REST Endpoints**: `GET /api/foss/quote`, `GET /api/foss/fundamentals`, `GET /api/foss/bars`, `GET /api/foss/research`, `GET /api/foss/snapshot`
* **MCP Tools**: `foss_get_quote`, `foss_fundamentals`, `foss_historical_bars`, `foss_market_research`

---

### Workflow A8: Conversational Financial Intelligence & NLQ Analytics
* **Operational Track**: Analysis
* **Functional Scope**: Natural Language Query (NLQ) engine converting user questions into parameter-bound SQLite queries, market scans, and options evaluations. Integrates the **LLM Judge** router to classify intents (`search`, `trading`, `research`, `payments`, `tasks`, `memory`) with confidence scoring.
* **Enabling Components**:
  - `NLQPlanner` & `NLQExecutor` (`src/agents/nlq.ts`)
  - `LLMJudge` (`src/agents/judge.ts`)
  - `DatabaseORM` (`src/orm/index.ts`)
  - `PlatformKnowledgeService` (`src/services/platformKnowledge.ts`)
* **APIs Leveraged**:
  - Cloudflare Workers AI (`glm-4.7-flash` / `Llama 3.3 70B`)
  - Cloudflare AI Search RAG (Vectorize index retrieval)
  - Durable Object transactional SQLite storage (`mas_messages`, `mas_events`, `mas_memory`, `mas_trades`, `mas_categories`)
* **REST Endpoints**: `POST /api/nlq`, `POST /api/chat`, `POST /nlq/webhook`, `GET /api/schema/tables`, `POST /api/schema/query`
* **MCP Tools**: `execute_nlq`, `knowledge_search`, `query_platform_knowledge`, `manage_session_memory`

---

# Part 2: Execution Workflows (6 Workflows)

Execution workflows perform side-effecting operations, money movement, order submission, background automation, and external communications. **Every execution workflow enforces strict guardrails, including Human-in-the-Loop (HITL) approval, W3C DID attestations, and cryptographic audit logging.**

---

### Workflow E1: Brokerage Order Preview & Human-in-the-Loop (HITL) Execution (E*TRADE)
* **Operational Track**: Execution
* **Functional Scope**: Safe stock and options order placement. The agent **NEVER** executes trades autonomously. Orders are drafted as preview tickets containing calculated commissions, fees, and margin requirements. Each draft is cryptographically signed with the agent's Decentralized Identifier (`did:agent:openaimp:trading`). Execution only proceeds after explicit user confirmation in the UI or chat.
* **Enabling Components**:
  - `ETradeRestClient` (`src/trading/etrade/client.ts`)
  - `ETradeTradingHub` (`src/client/ETradeTradingHub.tsx`)
  - `ETradePreviewOrderCommand` & `ETradeExecuteOrderCommand` (`src/mcp/etradeCommands.ts`)
  - W3C DID Attestation Service (`src/agents/did.ts`)
* **APIs Leveraged**:
  - `https://api.etrade.com/v1/accounts/{accountIdKey}/orders/preview` (order preview & validation)
  - `https://api.etrade.com/v1/accounts/{accountIdKey}/orders/place` (authorized live execution)
  - `https://api.etrade.com/v1/accounts/{accountIdKey}/orders/cancel` (cancel order)
  - SQLite Transactional Order Ledger (`mas_trades`, `mas_events`)
* **REST Endpoints**: `POST /api/etrade/order/preview`, `POST /api/etrade/order/execute`, `POST /api/etrade/orders/cancel`
* **MCP Tools**: `etrade_preview_order`, `etrade_execute_order`

---

### Workflow E2: Direct Equities & Crypto Order Placement (Alpaca Broker API)
* **Operational Track**: Execution
* **Functional Scope**: Places equity and cryptocurrency market, limit, and stop orders through Alpaca Securities. Supports fractional shares and extended-hours execution.
* **Enabling Components**:
  - `AlpacaMarketDataProvider` (`src/services/alpacaMarketData.ts`)
  - `FossAlpacaPlaceOrderCommand` (`src/mcp/fossCommands.ts`)
* **APIs Leveraged**:
  - `https://api.alpaca.markets/v2/orders` (order creation & placement)
  - `https://api.alpaca.markets/v2/account` (buying power check)
  - `https://api.alpaca.markets/v2/positions` (open position updates)
* **REST Endpoints**: `POST /api/trading/alpaca/order`, `GET /api/trading/alpaca/orders`, `DELETE /api/trading/alpaca/orders/{orderId}`
* **MCP Tools**: `foss_alpaca_place_order`, `foss_alpaca_orders`, `foss_alpaca_account`

---

### Workflow E3: Autonomous Background Cron, Interval Alarms & Token Lifecycle Management
* **Operational Track**: Execution
* **Functional Scope**: 24/7 background automation powered by Cloudflare Durable Object Alarms. Automatically renews E*TRADE OAuth access tokens daily at 23:00 ET before midnight expiration, triggers market screening scans every 5 minutes (300 seconds), processes queued async jobs, and broadcasts live alerts over WebSockets.
* **Enabling Components**:
  - `ScheduledTasksService` (`src/services/scheduledTasks.ts`)
  - Cloudflare Agents Alarm Lifecycle (`schedule`, `scheduleEvery`, `keepAliveWhile`)
  - SQLite Durable Async Job Ledger (`mas_async_jobs`)
* **APIs Leveraged**:
  - `https://api.etrade.com/oauth/renew_access_token`
  - Cloudflare Durable Object Alarm API
  - Durable Object WebSocket Server (`broadcast`)
* **REST Endpoints**: `POST /api/schedules/trigger-screen`, `POST /api/schedules/trigger-renew`, `POST /api/schedules/trigger-options-analysis`, `GET /api/jobs`, `GET /api/jobs/{jobId}`
* **MCP Tools**: `get_async_job`, `list_async_jobs`

---

### Workflow E4: Omnichannel Execution & One-Click Approvals (Slack, Email, Voice)
* **Operational Track**: Execution
* **Functional Scope**: Multi-channel execution gateway allowing traders to interact with the platform from anywhere:
  - **Slack**: Ingests `@mention` commands, renders Block Kit visual cards, and processes interactive button clicks.
  - **Email**: Receives inbound emails, parses trade intents, and emails `.xlsx` quantitative workbooks.
  - **One-Click Approval Link**: Generates secure, HMAC-signed approval URLs (`/trade/approve?orderId=...`) for instant mobile execution.
  - **Voice**: Full-duplex WebSocket audio session for conversational trading.
* **Enabling Components**:
  - `ETradeSlackTradingService` (`src/trading/slack/agent.ts`)
  - `ETradeEmailTradingService` (`src/trading/email/agent.ts`)
  - `ETradeVoiceTradingService` (`src/trading/voice/agent.ts`)
  - `ETradeWebhookService` (`src/services/tradingWebhooks.ts`)
* **APIs Leveraged**:
  - Slack Web API (`chat.postMessage`, interactive payload verification)
  - Cloudflare `EMAIL` Worker binding (`sendOutboundEmail`)
  - Cloudflare WebSockets (`/voice/trade`)
  - Outbound HMAC-SHA256 Webhook Dispatch (`OUTBOUND_WEBHOOK_URL`)
* **REST Endpoints**: `POST /slack/events`, `POST /slack/interactions`, `GET /trade/approve`, `POST /api/trading/reports/email`, `POST /api/trading/reports/webhook`
* **MCP Tools**: `dispatch_trading_webhook`

---

### Workflow E5: Agentic Micropayments, Gateways & x402 Protocol Settlement
* **Operational Track**: Execution
* **Functional Scope**: Multi-processor payment intent drafting and execution with human confirmation across traditional gateways (Stripe, PayPal, Lemon Squeezy) and next-generation **HTTP 402 (x402) pay-per-use micropayments**. Enables external MCP clients to access premium scanning tools by paying $0.05 USDC per query with verifiable cryptographic receipts.
* **Enabling Components**:
  - `PaymentGatewayService` (`src/services/payments.ts`)
  - `PaymentStrategyFactory` (`src/patterns/paymentStrategies.ts`)
  - `x402Verifier` (`src/services/x402Verifier.ts`)
  - `OptionsScannerMCP` (`src/services/cloudflareWalletsScanner.ts`)
* **APIs Leveraged**:
  - `https://api.stripe.com/v1/payment_intents` (Stripe Charges)
  - `https://api-m.paypal.com/v2/checkout/orders` (PayPal Orders)
  - `https://api.lemonsqueezy.com/v1/checkouts` (Lemon Squeezy Invoicing)
  - Base / Ethereum / Solana RPC nodes (x402 on-chain payment proof verification)
* **REST Endpoints**: `POST /api/payments/create`, `POST /api/payments/confirm`, `POST /api/payments/capture`, `POST /mcp/scanner`
* **MCP Tools**: `draft_payment`, `confirm_payment_draft`, `get_payment_gateways`, `get_transactions`

---

### Workflow E6: Enterprise Observability & Cryptographic Audit Ledger Execution
* **Operational Track**: Execution
* **Functional Scope**: Records immutable audit events for every system action: routing decisions, judge evaluations, payment lifecycle transitions, order previews, and executions. Publishes events to the SQLite event store and streams telemetry to external observability collectors.
* **Enabling Components**:
  - `DatabaseORM` (`src/orm/index.ts`)
  - `AuditEventPublisher` & `Observer` pattern (`src/patterns/observer.ts`)
  - `SqliteAuditObserver` & `TelemetryAuditObserver`
* **APIs Leveraged**:
  - SQLite Transactional WAL Store (`mas_events`)
  - Cloudflare Workers Telemetry & Metrics
* **REST Endpoints**: `GET /api/audit`, `POST /api/audit/event`
* **MCP Tools**: `get_audit_events`, `sqlite://audit/recent`

---

## Architectural Comparison: Analysis vs. Execution

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
 │ A6: Portfolio Risk & Hedging  │                             │ E6: Observability Audit Ledger│
 │ A7: FOSS Research (YF/Alpaca) │                             └───────────────┬───────────────┘
 │ A8: Conversational NLQ & RAG  │                                             │
 └───────────────┬───────────────┘                                             │
                 │                                                             ▼
                 ▼                                             ┌───────────────────────────────┐
 ┌───────────────────────────────┐                             │   MANDATORY HITL GUARDRAILS   │
 │        DATA FEEDS & APIS      │                             │ 1. Zero Unconfirmed Trading   │
 │ • api.nasdaq.com              │                             │ 2. W3C DID Attestation Stamps │
 │ • query1/query2.finance.yahoo │                             │ 3. Two-Phase Commit Preview   │
 │ • api.etrade.com (Quotes/Chns)│                             │ 4. Replay-Proof HMAC Webhooks │
 │ • data.alpaca.markets         │                             │ 5. Transactional WAL Logging  │
 │ • Cloudflare Workers AI & RAG │                             └───────────────────────────────┘
 └───────────────────────────────┘
```
