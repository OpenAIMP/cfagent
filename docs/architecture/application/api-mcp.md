# API & MCP Architecture Assessment, Standards Compliance & Endpoint Directory

## Executive Summary

This document provides a comprehensive architectural assessment of the API and Model Context Protocol (MCP) infrastructure within **Multi-Agent Studio** (`ai-search-agent`). The system runs on Cloudflare Workers, Durable Objects (SQLite), Vectorize, Workers AI, KV, and R2, implementing an API-first, multi-agent serverless application.

The application surfaces capabilities across four communication protocols:
1. **REST & Edge HTTP Endpoints**: Managed via `src/server.ts` entrypoint serving web UI, authentication, trading integrations, webhook receivers, and Durable Object forwarding.
2. **Model Context Protocol (MCP)**: JSON-RPC 2.0 server (`src/mcp/index.ts`) conforming to protocol version `2024-11-05`, exposing tools, resources, and prompts, as well as a pay-per-use x402 options scanner MCP (`/mcp/scanner`).
3. **Agent-to-Agent (A2A) Protocol**: Standard JSON-RPC agent discovery (`/.well-known/agent-card.json`) and task execution (`/a2a/*`).
4. **Real-time WebSockets**: Bidirectional streaming for voice trading (`/voice/trade`) and live market quotes (`/api/market/quotes/ws`).

---

## Architecture Overview

```
                                    +----------------------------------+
                                    |       Clients & Consumers        |
                                    | (Web Dashboard, MCP Clients,     |
                                    |  Slack, Webhooks, A2A Agents)    |
                                    +----------------------------------+
                                                     |
                                                     v
                                  +--------------------------------------+
                                  | Cloudflare Worker Gateway (server.ts)|
                                  +--------------------------------------+
                                     /               |                \
                                    /                |                 \
                                   v                 v                  v
                       +-------------------+ +---------------+ +------------------+
                       | REST / WebSockets | | MCP & Scanner | | A2A Agent Card   |
                       | Middleware & Auth | | JSON-RPC      | | JSON-RPC Dispatch|
                       +-------------------+ +---------------+ +------------------+
                                   \                 |                 /
                                    \                |                /
                                     v               v               v
                                  +--------------------------------------+
                                  | Durable Objects (Orchestrator,       |
                                  |  Research, Trading, Payments, etc.)  |
                                  +--------------------------------------+
```

### Core Architecture Components

1. **Worker Gateway Router (`src/server.ts`)**:
   - Handles top-level HTTP routing, static asset serving, CORS checks, session validation, OAuth flow initiation, and webhook signature verification.
   - Forwards agent execution requests to Durable Objects (`SEARCH_AGENT`, `OPTIONS_SCANNER_MCP`, `SCHEDULED_AGENT`, etc.).

2. **Model Context Protocol (MCP) Server (`src/mcp/`)**:
   - Implements JSON-RPC 2.0 over HTTP at `/mcp` or `/api/mcp`.
   - Uses GoF Command (`IMcpToolCommand`), Factory (`McpToolFactory`), and Facade (`McpSystemFacade`) design patterns.
   - Requires session auth cookie or `Authorization: Bearer cfk_...` per-user API keys.
   - Supports async job submission (`submitJob`) and polling (`get_async_job`, `list_async_jobs`).

3. **x402 Pay-Per-Use MCP Options Scanner (`/mcp/scanner`)**:
   - Independent Durable Object (`OptionsScannerMCP`) enforcing Cloudflare Wallets x402 payment headers (`PAYMENT-SIGNATURE`, `PAYMENT-REQUIRED`).
   - Allows anonymous access where payment token serves as access control.

4. **Agent-to-Agent (A2A) Protocol (`src/a2a/`)**:
   - Dispatches JSON-RPC calls under `/a2a/` and serves `/.well-known/agent-card.json` for inter-agent agentic interoperability.

---

## Architectural Issues, Gaps & Non-Compliance

### 1. Monolithic Ingress Handler (`src/server.ts`)
* **Issue**: `handleFetch` in `src/server.ts` contains over 1,000 lines of inline `if-else` path matching and logic.
* **Impact**: High cognitive complexity, risk of routing order bugs, difficult unit testing, and duplicated header/CORS manipulation logic.
* **Remediation**: Refactor routing into a modular router (e.g. Itty-Router or Hono middleware structure) separating Auth, Webhooks, OAuth, Trading, MCP, and System APIs into distinct route handlers.

### 2. Protocol & Specification Non-Compliance
* **OpenAPI Spec Drift**: `/openapi.json` is generated via static builder (`src/security/openapiSpec.ts`) but does not automatically inspect or validate against all runtime routes in `src/server.ts`.
* **MCP Specification Alignment**:
  * Tool definitions expose schemas, but `tools/list` and `tools/call` handling in `src/mcp/index.ts` hardcodes capability responses rather than dynamically validating all tool inputs against Zod schemas.
  * Errors in MCP execution sometimes return HTTP 200 with `{ error: ... }` inside JSON-RPC result instead of standard JSON-RPC error codes (-32602, -32603) or proper transport statuses.
* **REST Path Standard Violations**:
  * Mixed singular and plural route conventions (e.g., `/api/schedule/goals` vs `/api/schedules`, `/api/api-keys` vs `/api/social/brief`).
  * Duplicated route aliases (`/nlq/webhook`, `/api/trading/nlq/webhook`, `/api/nlq/webhook`, `/api/market-data/quotes`, `/api/market/quotes`, `/api/foss/quotes`).

### 3. Security & Authentication Gaps
* **Token & Identity Verification Inconsistencies**:
  * Webhook endpoints (Slack, NLQ, Email) use different signature header names and verification mechanisms (`X-Signature-256`, `X-Slack-Signature`).
  * Some endpoints allow caller-supplied `x-user-login` or `x-user-id` headers when session authentication fails or is unconfigured, introducing potential spoofing risks if edge middleware doesn't strip untrusted headers.
* **Rate-Limiting Granularity**:
  * Throttling is applied ad-hoc via `throttle()` on specific routes (`/nlq/webhook`, `/api/memory/search`) rather than uniform rate limiting middleware across all sensitive mutation endpoints.

### 4. Areas for Consolidation, Optimization & Reuse
* **Broker & Market Data Consolidation**: Market quote HTTP and WebSocket handlers (`/api/market-data/quotes`, `/api/market/quotes`, `/api/foss/quotes`) duplicate logic across E*TRADE, Yahoo Finance, and Alpaca providers. Unifying under a provider-agnostic `MarketDataService` facade will streamline maintenance.
* **Unified Webhook Verification Middleware**: Abstract signature verification into a generic higher-order middleware covering Slack, NLQ, Stripe, PayPal, and Lemon Squeezy.
* **MCP & REST Handler Reuse**: MCP tool commands (`src/mcp/commands.ts`) duplicate business logic found in REST API routes. Wrapping domain services in reusable command objects allows REST routes to invoke the exact same command objects as MCP JSON-RPC calls.

---

## Endpoint Categorization Directory

The following table lists all endpoints across the platform, categorized by **Purpose**, **Usage**, **Secure/Unsecure**, and **Sync/Async**.

| Endpoint & Method | Purpose (What problem does it solve) | Usage (Consumers) | Secure / Unsecure (How Secured) | Sync / Async |
| :--- | :--- | :--- | :--- | :--- |
| `GET /.well-known/oauth-client-id-metadata-document` | Serves OAuth 2.1 client metadata for Public.com resource provider identification. | Public.com Auth Server | **Unsecure** (Public metadata spec, CORS allowed) | Sync |
| `ANY /.well-known/*` | Serves Agent-to-Agent (A2A) agent cards and discovery documents. | Autonomous External Agents, A2A Clients | **Unsecure** (Public discovery protocol) | Sync |
| `ANY /a2a/*` | Handles JSON-RPC 2.0 agent-to-agent task requests and communication. | External AI Agents, A2A Orchestrators | **Secured** (Bearer tokens / A2A signature verification) | Async / Sync |
| `POST /nlq/webhook`<br>`POST /api/nlq/webhook`<br>`POST /api/trading/nlq/webhook` | Inbound natural language query webhook for external automated pipelines and email forwarding. | External Webhook Senders, Email Integrations | **Secured** (`X-Signature-256` HMAC + Nonce Replay Check + Domain Allowlist) | Sync |
| `ANY /agents/*` | Dispatches HTTP and WebSocket connections directly to Cloudflare Agents DOs. | Web Client, Agent WebSockets | **Secured** (Session Cookie Auth checked in `onBeforeConnect`) | Sync / WS |
| `GET /login` | Renders HTML login page with configured OAuth providers. | End Users / Web Browser | **Unsecure** (Public landing/login UI) | Sync |
| `GET /auth/login/:provider` | Initiates OAuth 2.0 authorization code flow for specified provider (e.g. GitHub, Google). | End Users / Web Browser | **Unsecure** (Initiates login flow, validates provider) | Sync |
| `GET /auth/callback/:provider` | Handles OAuth callback, exchanges authorization code for tokens, establishes session. | End Users / Web Browser | **Unsecure** (Validates OAuth state & code) | Sync |
| `GET /auth/logout` | Revokes user session and clears authentication cookies. | Signed-in Users | **Secured** (Session Cookie) | Sync |
| `GET /auth/etrade/start`<br>`GET /api/etrade/oauth/start` | Begins 3-legged E*TRADE OAuth 1.0a flow to retrieve request token. | Signed-in Users | **Secured** (Session Cookie + IAAA PDP Gate) | Sync |
| `GET /auth/etrade/callback` | Browser callback route for E*TRADE OAuth verifier submission. | Signed-in Users | **Secured** (Session Cookie) | Sync |
| `GET /api/etrade/oauth/status` | Checks connection status and token validity for user's E*TRADE account. | Web Dashboard, Trading Panel | **Secured** (Session Cookie) | Sync |
| `GET /api/etrade/diagnostics` | Probes E*TRADE upstream API connection, accounts, and balance health. | Admin / Debug Tools | **Secured** (Session Cookie) | Sync |
| `POST /api/etrade/oauth/verifier` | Submits PIN verifier to finalize E*TRADE OAuth token exchange. | Web Dashboard | **Secured** (Session Cookie + IAAA PDP Gate) | Sync |
| `POST /api/etrade/oauth/renew` | Renews access tokens for E*TRADE before midnight expiration. | Background Workers, Web UI | **Secured** (Session Cookie) | Sync |
| `POST /api/etrade/oauth/revoke` | Revokes stored E*TRADE OAuth credentials. | Signed-in Users | **Secured** (Session Cookie) | Sync |
| `GET /auth/public/start` | Initiates OAuth 2.1 authorization code flow for Public.com. | Signed-in Users | **Secured** (Session Cookie + IAAA PDP Gate) | Sync |
| `GET /auth/public/callback` | Handles OAuth 2.1 authorization code callback for Public.com. | Signed-in Users | **Secured** (Session Cookie) | Sync |
| `GET /api/public/status` | Checks Public.com personal token and OAuth connection state. | Web Dashboard | **Secured** (Session Cookie) | Sync |
| `POST /api/public/connect` | Connects Public.com account via Personal Access Token. | Signed-in Users | **Secured** (Session Cookie + IAAA PDP Gate) | Sync |
| `POST /api/public/disconnect` | Removes Public.com integration credentials. | Signed-in Users | **Secured** (Session Cookie) | Sync |
| `GET /health`<br>`GET /api/health` | Returns Factor 14 telemetry, system health, and runtime operational metrics. | Monitoring Tools, Load Balancers | **Unsecure** (Public operational probe) | Sync |
| `POST /api/qa/investigate` | Triggers LLM self-healing investigation for post-deploy smoke test failures. | Automated QA Scripts / CI/CD | **Secured** (Internal QA token / Session) | Async |
| `POST /api/memory/search` | Performs semantic vector search over past session outcomes in Vectorize. | Web UI, Autonomous Agents | **Secured** (Rate Limited, Throttled) | Sync |
| `GET /api/schedule/goals` | Lists configured scheduled goals and cron schedules. | Scheduled Dashboard | **Secured** (Session Cookie) | Sync |
| `POST /api/schedule/goals` | Adds a new automated goal schedule. | Scheduled Dashboard | **Secured** (Session Cookie) | Sync |
| `GET /api/schedule/ticks` | Retrieves recent execution history ticks for scheduled tasks. | Scheduled Dashboard | **Secured** (Session Cookie) | Sync |
| `POST /api/schedule/goals/:id/enabled` | Enables or disables a specific scheduled goal. | Scheduled Dashboard | **Secured** (Session Cookie) | Sync |
| `POST /api/schedule/goals/:id/trigger` | Manually triggers execution of a scheduled goal immediately. | Scheduled Dashboard | **Secured** (Session Cookie) | Async |
| `DELETE /api/schedule/goals/:id` | Removes a scheduled goal configuration. | Scheduled Dashboard | **Secured** (Session Cookie) | Sync |
| `GET /api/social/brief` | Retrieves social content brief for specified date. | Social Dashboard, Agents | **Secured** (Session Cookie) | Sync |
| `POST /api/social/brief` | Provisions or updates social media content brief for a date. | Content Managers, Agents | **Secured** (Session Cookie) | Sync |
| `GET /api/social/approvals` | Lists pending human approvals for social media post drafts. | Reviewers / Social Panel | **Secured** (Session Cookie) | Sync |
| `POST /api/social/approval` | Approves or rejects a queued social post draft for publication. | Reviewers / Social Panel | **Secured** (Session Cookie) | Sync |
| `GET /api/social/token-health` | Probes health and presence of social channel credentials (X, Threads, LinkedIn, Meta). | Admin / Social Panel | **Secured** (Session Cookie) | Sync |
| `GET /api/me` | Returns current user profile, authentication state, and provider details. | Web Client Frontend | **Secured** (Session Cookie) | Sync |
| `GET /api/iaaa/overview` | Retrieves identity, access, and governance overview (admin memberships, audit logs). | Platform Admins | **Secured** (Session Cookie + Platform Admin Check) | Sync |
| `POST /api/iaaa/access-request` | Submits a request for tenant-admin role access. | Signed-in Users | **Secured** (Session Cookie + Active Membership Check) | Sync |
| `GET /api/iaaa/access-requests` | Lists pending tenant access requests. | Tenant Admins | **Secured** (Session Cookie + Tenant Admin Check) | Sync |
| `POST /api/iaaa/access-request/decision` | Approves or denies a pending tenant access request. | Tenant Admins | **Secured** (Session Cookie + Role Grant Check) | Sync |
| `GET /api/api-keys` | Lists user's active per-user API keys for MCP access. | Web Client / Settings | **Secured** (Session Cookie) | Sync |
| `POST /api/api-keys` | Mints a new per-user API key (returns plain-text secret once). | Web Client / Settings | **Secured** (Session Cookie + Step-Up Auth Gate) | Sync |
| `DELETE /api/api-keys/:id` | Revokes an existing per-user API key. | Web Client / Settings | **Secured** (Session Cookie) | Sync |
| `POST /mcp`<br>`POST /api/mcp` | Model Context Protocol JSON-RPC 2.0 endpoint (tools, resources, prompts). | MCP Clients, Cursor, Claude Desktop | **Secured** (Session Cookie OR `Authorization: Bearer cfk_...` API Key) | Sync / Async Jobs |
| `POST /mcp/scanner`<br>`ANY /mcp/scanner/*` | Cloudflare Wallets x402 Pay-Per-Use Options Scanner MCP endpoint ($0.05 USDC/call). | External MCP Payers | **Secured via Payment** (`PAYMENT-SIGNATURE` / x402 Header) | Sync |
| `ANY /api/payments/agentic/*` | Agentic Wallet API (manage wallet balances, limits, and HITL auto-approvals). | Agentic Wallet Panel | **Secured** (Session Cookie) | Sync |
| `ANY /api/premium/*` | Premium paid API endpoints requiring x402 micropayments. | Paid API Consumers, Web App | **Secured via Payment or Session** (`PAYMENT-SIGNATURE` or Session) | Sync |
| `POST /api/payments/webhook`<br>`POST /payments/webhook` | External payment gateway webhooks (Stripe, PayPal, Lemon Squeezy). | Payment Processors | **Secured** (Gateway Webhook Signature Check) | Async |
| `POST /api/trading/email/inbound` | Receives inbound trade approval emails and parses action commands. | Email Webhook Relay | **Secured** (Session Cookie / Verified Webhook) | Async |
| `POST /api/trading/slack/test` | Test simulator endpoint for Slack event processing. | Slack Integration Developer | **Secured** (Session Cookie) | Sync |
| `POST /api/trading/voice/turn`<br>`POST /api/trading/voice/test` | Processes voice turn input for AI trading dialogue. | Voice Web Client / Simulator | **Secured** (Session Cookie) | Sync |
| `GET /api/trading/voice/greeting` | Fetches personalized voice assistant greeting. | Voice Web Client | **Secured** (Session Cookie) | Sync |
| `ANY /api/trading/options/*`<br>`ANY /trading/options/*` | Forwards options intelligence requests (catalog, strategies, screens, payoff) to agent DO. | Web UI / Options Panel | **Secured** (Session Cookie) | Sync |
| `ANY /api/schedules` | Cloudflare Agents task schedule management (create, cancel, trigger). | Task Scheduler Panel | **Secured** (Session Cookie) | Sync / Async |
| `WS /voice/trade`<br>`WS /api/trading/voice/ws` | Real-time WebSocket connection for bidirectional audio/voice trading turns. | Web Client Voice Studio | **Secured** (Session Cookie checked before upgrade) | Async (WS) |
| `WS /api/market-data/quotes/ws`<br>`WS /api/market/quotes/ws`<br>`WS /api/foss/quotes/ws` | WebSocket feed for streaming level-1 equity quotes and NBBO spreads. | Real-time Market Dashboard | **Unsecure / Public** (Rate limited) | Async (WS) |
| `GET /api/market-data/quotes`<br>`GET /api/market/quotes`<br>`GET /api/foss/quotes` | Batch HTTP polling endpoint for market quotes. | Web Dashboard | **Unsecure / Public** (Rate limited) | Sync |
| `POST /api/browser/snapshot`<br>`POST /browser/snapshot` | Captures web page snapshot via Browser Rendering DO and posts to Slack. | Web UI / Browser Agent | **Secured** (Session Cookie) | Async |
| `POST /api/browser/transaction-snap`<br>`POST /browser/transaction-snap` | Captures trade transaction confirmation screen and forwards to Slack. | Trading Hub | **Secured** (Session Cookie) | Async |
| `POST /slack/commands`<br>`POST /slack/slash` | Receives incoming Slack slash commands (`/snap`, `/trade`, `/quote`, `/screen`). | Slack Workspace | **Secured** (Slack HMAC Signing Secret `X-Slack-Signature`) | Async |
| `POST /slack`<br>`POST /slack/events` | Slack Event Subscriptions webhook receiver. | Slack Workspace | **Secured** (Slack HMAC Signing Secret `X-Slack-Signature`) | Async |
| `POST /slack/interactions` | Receives interactive Slack component button clicks (trade approvals, social post approvals). | Slack Workspace | **Secured** (Slack HMAC Signing Secret `X-Slack-Signature`) | Sync / Async |
| `GET /slack/install` | Redirects to Slack OAuth installation page. | Workspace Admin | **Unsecure** (Redirects to Slack OAuth) | Sync |
| `GET /slack/oauth_callback` | OAuth callback endpoint receiving Slack authorization code. | Slack OAuth | **Unsecure** (Exchanges OAuth code) | Sync |
| `GET /trade/approve` | Session-authenticated HITL trade approval execution shortcut. | End User Browser | **Secured** (Session Cookie required) | Sync |
| `ANY /clear`<br>`ANY /reset`<br>`ANY /api/clear`<br>`ANY /api/reset` | Resets or clears session state and chat history. | Web UI | **Secured** (Session Cookie) | Sync |
| `GET /api/options/flows/live`<br>`GET /api/options/flows/historical` | Queries dynamic options order flow and historical modelled estimates. | Flow Dashboard | **Unsecure / Public** (Rate limited) | Sync |
| `GET /api/options/flows/news` | Fetches real-time market news relevant to ticker options flows. | Flow Dashboard | **Unsecure / Public** (Rate limited) | Sync |
| `GET /api/options/flows/insider` | Retrieves SEC insider transaction filings. | Flow Dashboard | **Unsecure / Public** (Rate limited) | Sync |
| `GET /api/options/flows/congress` | Fetches Congressional trading disclosure filings. | Flow Dashboard | **Unsecure / Public** (Rate limited) | Sync |
| `GET /api/options/flows/summary` | Calculates market cap and asset class flow summary statistics. | Flow Dashboard | **Unsecure / Public** (Rate limited) | Sync |
| `GET /api/options/flows/presets` | Returns default saved presets for options flow filters. | Flow Dashboard | **Unsecure / Public** (Rate limited) | Sync |
| `GET /openapi.json` | Serves generated OpenAPI 3.1 JSON specification. | API Developers / Swagger | **Secured** (Session Cookie) | Sync |
| `GET /api/docs` | Renders Interactive Swagger UI documentation. | API Developers / Web UI | **Secured** (Session Cookie) | Sync |
| `ANY /api/*` | Forwarder catch-all dispatching authenticated API requests to session user's `SearchAgent` DO. | Web UI Dashboard | **Secured** (Session Cookie) | Sync / Async |
| `GET /checkout/sandbox` | Renders simulated payment gateway checkout terminal UI. | Sandbox Developers | **Unsecure** (Interactive UI sandbox) | Sync |
| `GET /`<br>`GET /index.html` | Serves single-page application (SPA) HTML or public landing page based on session. | End Users / Web Browser | **Unsecure / Public** (Session cookie enriches HTML state) | Sync |

---

## MCP Capabilities Directory

The MCP Server (`src/mcp/index.ts`) exposes **17 Tools**, **11 Resources**, and **4 Prompts** through the JSON-RPC 2.0 protocol (`2024-11-05`).

### MCP Tools & Commands

| Tool Name | Purpose (What Problem Does It Solve) | Category & Execution |
| :--- | :--- | :--- |
| `knowledge_search` | Vector search over enterprise knowledge base using Cloudflare AI Search & Vectorize. | Knowledge / RAG |
| `query_platform_knowledge` | Queries platform capability guides, workflows, and FAQs. | Knowledge / Platform |
| `draft_payment` | Prepares an explicit human-authorized payment intent draft with Agent W3C DID attestation. | Payments / HITL |
| `confirm_payment_draft` | Authorizes or rejects a pending payment draft using HITL approval. | Payments / HITL |
| `get_payment_gateways` | Queries gateway processor statuses (Stripe, PayPal, Lemon Squeezy) and Agent DIDs. | Payments / System |
| `get_transactions` | Queries settled payment transactions and proof signatures from SQLite ledger. | Payments / Ledger |
| `execute_nlq` | Submits natural-language database or market query as an async job. | NLQ / Database |
| `get_async_job` | Retrieves status and result for an asynchronous platform job by ID. | System / Jobs |
| `list_async_jobs` | Lists recent asynchronous jobs and status for current session. | System / Jobs |
| `list_database_tables` | Introspects relational SQLite database schema, tables, and row counts. | Database / Schema |
| `query_table_data` | Queries rows from SQLite tables with filtering and pagination via ORM. | Database / Data |
| `manage_categories` | Full CRUD management for referral categories taxonomy in `mas_categories`. | Admin / Taxonomy |
| `manage_referrals` | Manages developer referral links and tracks click attribution. | Growth / Referrals |
| `manage_external_ads` | Manages external ad placements (EthicalAds, Carbon, AdSense) and CPM/CPC revenue. | Growth / Ads |
| `get_revenue_summary` | Computes platform financial analytics across ad networks, payments, and fees. | Analytics / Finance |
| `manage_session_memory` | Reads, persists, or clears grounding session facts in `mas_memory`. | Agent Memory |
| `get_audit_events` | Queries real-time observability events stream from `mas_events`. | Observability |
| `etrade_market_scan` | Runs quantitative screening for equity/options setups via E*TRADE. | Trading / E*TRADE |
| `etrade_get_quote` | Fetches real-time equity quote from E*TRADE. | Trading / E*TRADE |
| `etrade_preview_order` | Prepares preview order for stock/options trade. | Trading / E*TRADE |
| `etrade_execute_order` | Submits previewed trade order for execution. | Trading / E*TRADE |
| `etrade_get_positions` | Retrieves portfolio holdings and account cash balances. | Trading / E*TRADE |
| `etrade_auth_status` | Checks E*TRADE OAuth connection state. | Trading / E*TRADE |
| `etrade_account_discovery` | Discovers available E*TRADE accounts. | Trading / E*TRADE |
| `market_data_get_quote` | Fetches market quote via Yahoo Finance or Alpaca. | Market Research |
| `market_data_company_fundamentals` | Fetches institutional fundamental metrics (P/E, PEG, price targets). | Market Research |
| `market_data_historical_bars` | Fetches historical price candle bars. | Market Research |
| `market_data_research` | Synthesizes full equity research report. | Market Research |
| `paid_options_screener` | Runs premium options screener (x402 micro-payment tool). | Paid Tools / x402 |
| `paid_market_research` | Runs deep-dive institutional research (x402 micro-payment tool). | Paid Tools / x402 |
| `agentic_wallet_status` | Returns x402 wallet balance and auto-approve limits. | Payments / Wallet |
| `browser_inspect` | Inspects DOM structure of web page using Cloudflare Browser Rendering. | Browser Agent |
| `browser_screenshot` | Captures web page screenshot and posts to Slack channel. | Browser Agent |
| `dispatch_trading_webhook` | Dispatches authenticated trade webhook payload. | Webhooks |
| `sandbox_run` | Executes code snippet in secure Cloudflare Sandbox. | Compute / Sandbox |
| `quant_backtest` | Executes backtest on quantitative trading strategy. | Quant Analytics |
| `think_trade_validation` | Runs multi-agent reasoning chain to validate trade setup. | Decision Engine |
| `ai_search_financial_docs` | Searches SEC filings and financial documents via Vectorize. | Knowledge / SEC |
| `durable_twap_order` | Schedules Time-Weighted Average Price (TWAP) algorithmic order. | Algorithmic Trading |

### MCP Resources

| Resource URI | Name | Purpose / Content |
| :--- | :--- | :--- |
| `sqlite://schema/tables` | Database Tables & Schema | SQLite table names, column types, and row counts. |
| `sqlite://revenue/summary` | Platform Revenue Summary | Gross revenue, CPM/CPC ad earnings, transaction fees. |
| `sqlite://categories/list` | Referral Categories Taxonomy | Active referral link categories. |
| `sqlite://external-ads/inventory` | External Ad Network Inventory | Placements, impression counters, and CPM earnings. |
| `sqlite://memory/facts` | Persistent Session Facts | Grounding facts and long-term user preferences. |
| `sqlite://audit/recent` | Observability Audit Stream | Recent router decisions, HITL authorizations, and execution events. |
| `sqlite://trading/orders` | E*TRADE Order Ledger | Historical trade orders with Agent DID proof stamps. |
| `etrade://portfolio/positions` | E*TRADE Portfolio Positions | Portfolio holdings, cost basis, and unrealized P&L. |
| `market-data://market/quote/{ticker}` | Market Data Quote | Real-time quote and NBBO bid/ask spread. |
| `market-data://research/fundamentals/{ticker}` | Market Data Company Fundamentals | P/E, PEG, price targets, balance sheet metrics. |
| `market-data://providers/status` | Market Data Providers Health | Connection status and rate limit status for market data providers. |

### MCP Prompts

| Prompt Name | Purpose / Workflow | Arguments |
| :--- | :--- | :--- |
| `audit_security_review` | Security & compliance review of pending financial drafts and DID proof signatures. | `draftId` (required) |
| `revenue_performance_analysis` | Analyzes monetization efficiency across ad networks and recommends optimizations. | None |
| `nlq_schema_exploration` | Formulates optimal natural language queries to explore SQLite relationships. | None |
| `market_data_equity_research_report` | Generates comprehensive equity research report synthesizing fundamentals & technicals. | `symbol` (required) |

> **#1906 deprecation note:** the pre-rename names remain available as
> deprecated aliases on the same handlers — REST `/api/foss/*` routes
> (canonical `/api/market-data/*`), MCP tools `foss_get_quote`,
> `foss_company_fundamentals`, `foss_historical_bars`,
> `foss_market_research`, `foss_alpaca_snapshot`, `foss_alpaca_account`,
> `foss_alpaca_positions`, `foss_alpaca_orders`,
> `foss_alpaca_place_order`, resources `foss://market/quote/*`,
> `foss://research/fundamentals/*`, `foss://providers/status`, prompt
> `foss_equity_research_report`, env vars `FOSS_*_MODE`, and the
> `foss` order-mode value. Alias removal is a separate follow-up slice.

---

## Action Plan & Roadmap

1. **Short-Term (Immediate Remediations)**:
   - Ensure all webhook routes enforce strict HMAC signature verification and timestamp replay checks.
   - Strip caller-supplied identity headers (`x-user-login`, `x-user-id`) at worker entrypoint unless validated by session cookie or verified API key.
   - Enforce uniform rate limiting across all mutation endpoints.

2. **Medium-Term (Refactoring & Standardization)**:
   - Modularize `src/server.ts` into discrete sub-routers (`auth.ts`, `trading.ts`, `mcp.ts`, `social.ts`, `schedule.ts`).
   - Standardize REST path conventions to pluralized RESTful endpoints and remove legacy route aliases.
   - Automatically generate OpenAPI 3.1 spec from route definitions to eliminate documentation drift.

3. **Long-Term (Architecture Consolidation)**:
   - Unify E*TRADE, Yahoo, and Alpaca integrations under a single polymorphic `BrokerageAdapter` interface.
   - Refactor REST API handlers to call `IMcpToolCommand` execution methods directly, eliminating duplicated domain logic between REST and MCP protocols.
