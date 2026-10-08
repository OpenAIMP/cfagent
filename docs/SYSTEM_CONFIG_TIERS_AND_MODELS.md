# System Configuration Tiers, AI Model Catalog & Engine Tuning Guide

This document provides system administrators and quantitative operators with the definitive architecture and operational guide for configuring, tuning, and monitoring the **Multi-Agent Studio (OpenAIMP)** trading intelligence platform.

---

## Part 1: Administrative Configuration Tiers

All configuration settings are externalized into [`environment.config.json`](file:///c:/Users/spr9s/cfagent/environment.config.json) and dynamically loaded via [`src/config/etapiConfig.ts`](file:///c:/Users/spr9s/cfagent/src/config/etapiConfig.ts). Settings are prioritized into **5 distinct operational tiers** to provide system administrators with clear operational hierarchy.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CONFIGURATION TIERS                             │
├────────────────────────────────────────────────────────────────────────┤
│  Tier 1: Mission-Critical Broker, Auth & Environment Connectivity      │
│  Tier 2: AI Workflow Routing & Workers AI Model Catalog                │
│  Tier 3: Trading Safety, Guardrails & HITL Approvals                   │
│  Tier 4: ETAPI Engine Tuning, Screener & Quantitative Weights          │
│  Tier 5: Cloudflare Scheduling, Alarms & External API Limits           │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Tier 1: Mission-Critical Broker, Auth & Environment Connectivity
> **Priority: MAXIMUM (P0)** — Failure to configure prevents system boot or broker communication.

| Setting Key | Environment / Path | Default / Options | Purpose & Administrative Guidance |
|---|---|---|---|
| `APP_ENV` | Environment variable | `PROD` \| `TEST` | Master environment switch. Controls sandbox vs. live endpoints, logging verbosity, and safety assertions. |
| `ETRADE_ENVIRONMENT` | Environment variable | `sandbox` \| `live` | Controls upstream broker routing: `apisb.etrade.com` vs. `api.etrade.com`. |
| `ETRADE_CONSUMER_KEY` | Environment variable / Secret | Required (32-char hex) | E*TRADE Developer Application Consumer Key. |
| `ETRADE_CONSUMER_SECRET` | Environment variable / Secret | Required (32-char hex) | E*TRADE Developer Application Consumer Secret for OAuth 1.0a signatures. |
| `SESSION_SECRET` | Environment variable / Secret | Required | HMAC secret used to sign session cookies and prevent session tampering. |
| `APP_BASE_URL` | Environment variable | `https://agent.openaimp.com` | Canonical public URL used for OAuth callbacks and CORS origin validation. |

---

### Tier 2: AI Workflow Routing & Workers AI Model Catalog
> **Priority: HIGH (P1)** — Governs AI reasoning quality, context window capacity, response latency, and token consumption.

| Setting Key | Config Path | Default Value | Purpose & Administrative Guidance |
|---|---|---|---|
| `ai.defaultModel` | `defaults.etapi.ai.defaultModel` | `@cf/zai-org/glm-4.7-flash` | System-wide flagship model for NLQ, general chat, and multi-agent orchestration. |
| `ai.reasoningModel` | `defaults.etapi.ai.reasoningModel` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | High-parameter reasoning model for multi-leg quantitative payoffs and strategy evaluations. |
| `ai.taskModels.nlqPlanning` | `defaults.etapi.ai.taskModels.nlqPlanning` | `@cf/zai-org/glm-4.7-flash` | Resolves query intent and parses SQL/ORM table filters with native tool calling. |
| `ai.taskModels.nlqValidation` | `defaults.etapi.ai.taskModels.nlqValidation` | `@cf/zai-org/glm-4.7-flash` | Validates query plans before execution to prevent data leakage and syntax errors. |
| `ai.taskModels.optionsIdeas` | `defaults.etapi.ai.taskModels.optionsIdeas` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Multi-group raw options expiration chain analysis and candidate selection. |
| `ai.taskModels.optionsComparison` | `defaults.etapi.ai.taskModels.optionsComparison` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Head-to-head payoff and risk comparison across candidate option strategies. |
| `ai.taskModels.orchestrator` | `defaults.etapi.ai.taskModels.orchestrator` | `@cf/zai-org/glm-4.7-flash` | Master orchestrator agent handling tool calling and streaming responses. |
| `ai.taskModels.searchAgent` | `defaults.etapi.ai.taskModels.searchAgent` | `@cf/zai-org/glm-4.7-flash` | Vector search synthesis and platform documentation RAG agent. |
| `ai.temperatureDefaults` | `defaults.etapi.ai.temperatureDefaults` | `det: 0.0, anal: 0.2, creat: 0.7` | Temperature sampling presets by analytical rigor. |
| `ai.maxTokens` | `defaults.etapi.ai.maxTokens` | `nlq: 2048, ideas: 4096, comp: 4096` | Upper token ceilings per workflow to control latency and cost. |

---

### Tier 3: Trading Safety, Guardrails & Human-in-the-Loop (HITL)
> **Priority: CRITICAL SAFETY (P1)** — Prevents accidental capital loss, unauthorized trade execution, and excessive order sizes.

| Setting Key | Config Path | Default Value | Purpose & Administrative Guidance |
|---|---|---|---|
| `tradingConstraints.maxOrderQuantity` | `defaults.etapi.tradingConstraints` | `10,000` shares / contracts | Maximum allowable shares or option contracts per single order preview. |
| `tradingConstraints.maxOrderTotalUsd` | `defaults.etapi.tradingConstraints` | `$500,000.00` USD | Maximum notional value for any order ticket drafted by an agent. |
| `tradingConstraints.defaultOrderQuantity`| `defaults.etapi.tradingConstraints` | `1` share / contract | Baseline quantity defaulted when unspecified in voice or conversational NLQ prompts. |
| `tradingConstraints.maxDiscountPercent` | `defaults.etapi.tradingConstraints` | `90%` | Maximum limit price discount below prevailing bid before sanity check rejection. |
| `tradingConstraints.maxPremiumPercent` | `defaults.etapi.tradingConstraints` | `500%` | Maximum limit price premium above prevailing ask before sanity check rejection. |
| `tradingConstraints.requireHitlVoiceConfirmation` | `defaults.etapi.tradingConstraints` | `true` | Enforces two-phase verbal confirmation ("Preview" -> "Authorize") for all voice trades. |
| `voice.phoneticCorrections` | `defaults.etapi.voice.phoneticCorrections` | Dictionary | Maps speech-to-text misrecognitions (e.g., "text talks" -> "tech stocks", "talks" -> "stocks"). |
| `voice.companyToTicker` | `defaults.etapi.voice.companyToTicker` | Dictionary | Maps spoken company names to canonical exchange tickers (e.g., "Nvidia" -> "NVDA"). |

---

### Tier 4: ETAPI Engine Tuning & Quantitative Score Weights
> **Priority: OPERATIONAL TUNING (P2)** — Tunes mathematical scoring, screener thresholds, and candidate generation.

| Setting Key | Config Path | Default Value | Purpose & Administrative Guidance |
|---|---|---|---|
| `screener.maxScanSymbols` | `defaults.etapi.screener.maxScanSymbols` | `20` (Prod) / `10` (Test) | Maximum symbols evaluated concurrently during multi-underlying options scans. |
| `screener.defaultMaxDte` | `defaults.etapi.screener.defaultMaxDte` | `90` days | Furthest expiration horizon included in default scans (avoids LEAPS data bloat). |
| `screener.defaultMinDte` | `defaults.etapi.screener.defaultMinDte` | `0` days (includes 0DTE) | Earliest expiration horizon included in scans. |
| `screener.unusualVolumeOiRatio`| `defaults.etapi.screener.unusualVolumeOiRatio` | `2.0x` | Multiplier for flagging institutional unusual volume relative to open interest. |
| `screener.atmBandPct` | `defaults.etapi.screener.atmBandPct` | `0.03` (±3%) | Distance from underlying spot price for classifying At-The-Money contracts. |
| `strategyEngine.riskFreeRate`| `defaults.etapi.strategyEngine.riskFreeRate` | `0.04` (4.00%) | Baseline risk-free interest rate for Black-Scholes Greeks ($d_1, d_2, \rho$). |
| `strategyEngine.feePerContract`| `defaults.etapi.strategyEngine.feePerContract`| `$0.65` USD | Standard broker commission per contract subtracted from net payoff calculations. |
| `strategyEngine.scoreWeights`| `defaults.etapi.strategyEngine.scoreWeights` | Composite weights | Weights for thesis alignment (30%), EV (20%), liquidity (20%), IV (10%), theta (5%), freshness (15%). |
| `opportunityScanner.concurrency`| `defaults.etapi.opportunityScanner.concurrency`| `3` | Parallel background worker routines scanning watchlist symbols. |
| `llmIdeas.inputTokenBudget` | `defaults.etapi.llmIdeas.inputTokenBudget` | `90,000` tokens | Maximum context budget allocated for raw options chains before token pruning. |

---

### Tier 5: Cloudflare Scheduling, Alarms & External API Limits
> **Priority: MAINTENANCE & LIMITS (P3)** — Controls background automation cadence, Durable Object alarms, and external API quotas.

| Setting Key | Config Path | Default Value | Purpose & Administrative Guidance |
|---|---|---|---|
| `externalApis.nasdaqListings.pageSize` | `defaults.etapi.externalApis.nasdaqListings` | `5,000` | Pagination page size for NASDAQ all-exchange equities listing feed. |
| `externalApis.nasdaqListings.timeoutMs` | `defaults.etapi.externalApis.nasdaqListings` | `2,500` ms | Fetch timeout before falling back to Yahoo Finance or curated offline universe. |
| `externalApis.yahooFinance.timeoutMs` | `defaults.etapi.externalApis.yahooFinance` | `5,000` ms | Timeout for zero-credential FOSS market data queries. |
| `externalApis.yahooFinance.maxRetries` | `defaults.etapi.externalApis.yahooFinance` | `2` | Exponential backoff retry count for upstream Yahoo Finance quote endpoints. |
| `cache.quotesTtlSeconds` | `defaults.etapi.cache.quotesTtlSeconds` | `60` seconds | Cache lifetime for market quote snapshots. |
| `cache.optionChainsTtlSeconds` | `defaults.etapi.cache.optionChainsTtlSeconds` | `120` seconds | Cache lifetime for raw options chains before re-requesting upstream broker. |

---

## Part 2: Workers AI Model Catalog & Workflow Assignment

The platform utilizes Cloudflare Workers AI with zero cold-starts and global edge distribution. Below is the curated catalog and assignment matrix.

### Curated Model Catalog

```
┌──────────────────────────────────────────────┬──────────────┬─────────┬──────────────┬────────────────────────────────────────────────────────┐
│ Model Identifier                             │ Context      │ Tools   │ Category     │ Best Fit Workflows                                     │
├──────────────────────────────────────────────┼──────────────┼─────────┼──────────────┼────────────────────────────────────────────────────────┤
│ @cf/zai-org/glm-4.7-flash                    │ 131,072 ctx  │ Yes     │ Flagship     │ Multi-agent orchestration, NLQ planning, validation   │
│ @cf/meta/llama-3.3-70b-instruct-fp8-fast     │ 131,072 ctx  │ Yes     │ Reasoning    │ Deep options payoff analysis, multi-leg comparison    │
│ @cf/meta/llama-3.1-70b-instruct              │ 131,072 ctx  │ Yes     │ General      │ Macro Q&A, comprehensive explanations, research       │
│ @cf/qwen/qwen2.5-72b-instruct                │ 32,768 ctx   │ Yes     │ Analytical   │ Mathematical factor decomposition, quantitative code   │
│ @cf/deepseek-ai/deepseek-r1-distill-qwen-32b │ 65,536 ctx   │ No      │ Reasoning    │ Chain-of-thought risk audits, scenario analysis        │
└──────────────────────────────────────────────┴──────────────┴─────────┴──────────────┴────────────────────────────────────────────────────────┘
```

### Optimal Workflow-to-Model Assignment Matrix

| Workflow Area | Config Task Key | Recommended Model | Rationale & Performance Profile |
|---|---|---|---|
| **Chat & Multi-Agent Orchestration** | `orchestrator` | `@cf/zai-org/glm-4.7-flash` | Ultra-fast token generation, 131k context window, robust function calling across all 14 MCP commands. |
| **NLQ Intent & SQL Query Planning** | `nlqPlanning` | `@cf/zai-org/glm-4.7-flash` | High accuracy parsing user natural language into structured SQL and screener parameters. |
| **NLQ Pre-Execution Safety Validation**| `nlqValidation` | `@cf/zai-org/glm-4.7-flash` | Strict deterministic syntax and security auditing before database execution. |
| **Options Ideas Generation (Raw Chains)**| `optionsIdeas` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Multi-group chain analysis with complex contract strike reasoning and risk trade-off synthesis. |
| **Multi-Leg Strategy Comparison** | `optionsComparison` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Deep Greek modeling ($\Delta, \Gamma, \Theta, \text{Vega}$) and maximum risk payoff matrix evaluations. |
| **Vector Search & Documentation RAG** | `searchAgent` | `@cf/zai-org/glm-4.7-flash` | Low latency knowledge retrieval with high semantic comprehension over platform guides. |
| **FOSS Market Research Summarization** | `marketResearch` | `@cf/zai-org/glm-4.7-flash` | Fast financial statement and news sentiment extraction from unformatted web content. |

---

## Part 3: Cloudflare Scheduling & Autonomous Tasks

The platform implements autonomous background automation powered by **Cloudflare Agents Durable Object Alarms** and **Cron Triggers**, managed via [`src/services/scheduledTasks.ts`](file:///c:/Users/spr9s/cfagent/src/services/scheduledTasks.ts) and the `/api/schedules` endpoint.

### Scheduled Background Daemons

1. **Daily E*TRADE OAuth Token Auto-Renewal**:
   - **Trigger**: Daily at `23:00 ET` (before the midnight ET expiration window enforced by E*TRADE).
   - **Operation**: Automatically calls `/oauth/renew_access_token`, signs the request with existing tokens, persists the renewed session in Durable Object SQLite and KV, and logs a tamper-proof audit event (`did:agent:openaimp:auth`).
   - **Failover**: If auto-renewal encounters an upstream broker 401, an alert is dispatched via Slack and Email informing the administrator to re-authenticate with the PIN handshake.

2. **Autonomous Market Opportunity Scanner**:
   - **Trigger**: Every 5 minutes (`300 seconds`) during market hours (9:30 AM – 4:00 PM ET).
   - **Operation**: Scans user watchlists and top volume equities against the 72-strategy engine. Identifies setups meeting user budget constraints ($\text{Max Loss} \le \$30$, $\text{Max Profit} > \$0$, $\text{Win Rate} \ge 60\%$).
   - **Notification**: Emits WebSocket alert payloads and posts Slack Block Kit cards for high-scoring opportunities ($\text{Score} \ge 80$).

3. **Autonomous Risk Monitor & Delta Hedge Watcher**:
   - **Trigger**: Every 15 minutes (`900 seconds`).
   - **Operation**: Computes aggregate portfolio Beta-weighted SPY Delta and Theta decay. If net portfolio Delta breaches user-configured risk thresholds (e.g., $|\Delta_{\text{SPY}}| > 50$), prepares a protective hedge ticket draft in SQLite.

---

## Part 4: Cloudflare Browser Agent & Slack Agent Integration

The platform provides independent, modular agents built according to Cloudflare Agents reference architectures:
- [Cloudflare Browser Agent](https://developers.cloudflare.com/agents/examples/browser-agent/)
- [Cloudflare Slack Agent](https://developers.cloudflare.com/agents/examples/slack-agent/)
- [Cloudflare Communication Channels: Slack](https://developers.cloudflare.com/agents/communication-channels/slack/)

### Browser Agent Snapshot Posting to Slack

The `ETradeBrowserService` ([`src/services/browserAgent.ts`](file:///c:/Users/spr9s/cfagent/src/services/browserAgent.ts)) allows autonomous headless browser inspection, chart snapshot generation, and posting to Slack:

1. **Cloudflare Browser Rendering Binding**: Uses `env.BROWSER` (`https://browser.cloudflare.local/scrape`) to render client-side JavaScript dashboards, execute selectors, and capture high-resolution screenshots.
2. **Direct Slack Webhook Delivery**: Via `POST /api/browser/snapshot` or the `captureAndSendToSlack(url, options)` method, the agent formats a Slack Block Kit card with the target URL, timestamp, semantic text summary, and chart visual, delivering it to `env.SLACK_WEBHOOK_URL` or an incoming webhook parameter.

```bash
# Example invocation of Browser Agent Slack Snapshot
curl -X POST "https://agent.openaimp.com/api/browser/snapshot" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://etrade.com/market-movers",
    "caption": "Mid-day market movers and volume breakout chart",
    "webhookUrl": "https://hooks.slack.com/services/T00/B00/XXXX"
  }'
```

### Pre-Trade Slack Approval & Trading via Slack

Before executing any trade proposal, strict Human-in-the-Loop (HITL) safety is enforced:

1. **Two-Phase Commit**:
   - Phase 1: When a trade is proposed via Chat, Voice, or Scheduled Scanner, the agent creates a signed draft in the SQLite ledger (`ord_xxx`) and dispatches a Slack Block Kit card with `[✓ Approve & Submit]` and `[✕ Reject & Cancel]` interactive buttons.
   - Phase 2: No money or orders are sent upstream until the user clicks `[✓ Approve & Submit]`. Upon click, the Slack interaction handler (`/slack/interactions`) validates the HMAC-SHA256 signature, verifies the user DID, acquires a fresh E*TRADE preview token, and submits the order.
2. **Conversational Trading via Slack**: Users can prompt `@ETradeAgent preview buy 10 NVDA limit 125.00` in their Slack channel to generate an instant interactive order card directly within the channel thread.

---

## Part 5: Runtime ETAPI Engine Tuning Modal

System administrators and quantitative traders can inspect and adjust these parameters in real time without code deployment:

1. Click the **⚙️ Settings** icon in the top header or visit the **Auto Options Research** panel.
2. Open the **`🤖 AI Models & Guardrails`** tab to:
   - Select default and task-specific Workers AI models.
   - Adjust sampling temperatures and max token budgets.
   - Adjust order quantity and USD limits.
3. Open the **`⚙️ Screener Engine`** and **`📐 Strategy Engine`** tabs to:
   - Tune `maxScanSymbols`, `defaultMaxDte`, and `atmBandPct`.
   - Update `riskFreeRate` (e.g., 4.00% to 5.25%) and `feePerContract`.
   - Adjust the 6-factor composite score weights.
4. Changes are saved instantly to persistent SQLite storage and broadcast to active agent sessions.
