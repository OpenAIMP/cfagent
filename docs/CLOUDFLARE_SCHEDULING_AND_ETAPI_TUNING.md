# Cloudflare Agents Task Scheduling & ETAPI Engine Tuning Guide

This document is the technical architecture and operational manual for **Cloudflare Agents Task Scheduling** and **ETAPI Engine Tuning** within the **Multi-Agent Studio (OpenAIMP)** trading intelligence platform.

---

## Part 1: Cloudflare Agents Task Scheduling Architecture

The platform leverages native **Cloudflare Agents Task Scheduling** (built on Durable Objects Alarms and the `@cloudflare/ai-chat` / Cloudflare Agents runtime) as documented in the [Cloudflare Agents Task Scheduling Reference](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/).

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        CLOUDFLARE AGENTS SCHEDULING RUNTIME                            │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   ┌─────────────────────┐   ┌────────────────────────┐   ┌─────────────────────────┐   │
│   │   Durable Object    │   │  Cron / Alarms Runtime │   │   ScheduledTasksService │   │
│   │   Orchestrator      │──▶│  schedule() /          │──▶│   - Token Auto-Renewal  │   │
│   │   Agent (AgentDO)   │   │  scheduleEvery()       │   │   - Autonomous Screener │   │
│   └─────────────────────┘   └────────────────────────┘   │   - 15m HITL Expiration │   │
│              │                                           │   - Cross-Symbol Options│   │
│              ▼                                           └─────────────────────────┘   │
│   ┌─────────────────────┐                                             │                │
│   │ keepAliveWhile(...) │                                             ▼                │
│   │ Prevents DO         │                              ┌───────────────────────────┐   │
│   │ Eviction on Long    │                              │   Omnichannel Dispatch    │   │
│   │ Options Analysis    │                              │   Slack / Email / Webhook │   │
│   └─────────────────────┘                              └───────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Core Scheduling Primitives

The master agent [`OrchestratorAgent`](file:///c:/Users/spr9s/cfagent/src/agents/orchestrator.ts) implements the Cloudflare Agents scheduling runtime with the following execution models:

#### A. Cron Expressions (`this.schedule`)
Used for recurring tasks tied to calendar times or market events:
```typescript
// Registered in onStart(): Proactive daily E*TRADE token renewal at 23:00 ET
await this.schedule(
  "0 23 * * *",
  "autoRenewETradeTokens",
  { userLogin: this.sessionKey() },
  { idempotent: true }
);

// Market open options opportunity scan at 9:30 AM ET Monday through Friday
await this.schedule(
  "30 9 * * 1-5",
  "autonomousOptionsAnalysis",
  { symbols: ["AAPL", "NVDA", "SPY", "MSFT"], thesis: "bullish", pushToSlack: true }
);
```

#### B. Recurring Intervals (`this.scheduleEvery`)
Used for periodic background scanning and continuous monitoring:
```typescript
// Registered in onStart(): Autonomous market screening every 5 minutes (300 seconds)
await this.scheduleEvery(
  300,
  "autonomousMarketScreen",
  { sector: "Technology", maxItems: 5 }
);
```

#### C. Delayed One-Off Timers (`this.schedule` with delay in seconds)
Used for safety lifecycles, such as Human-in-the-Loop (HITL) order preview expirations:
```typescript
// When an order draft is generated, schedule auto-expiration after 15 minutes (900 seconds)
const timer = await this.schedule(
  900,
  "expireStaleOrderDraft",
  { orderId: trade.id, userLogin: this.sessionKey() }
);
```

#### D. Specific Absolute Dates (`this.schedule` with `Date`)
Used for event-driven reminders or earnings release dates:
```typescript
await this.schedule(
  new Date("2026-10-25T13:30:00Z"),
  "sendScheduledReminder",
  { reminderId: "rem_earnings_nvda", message: "Review Q3 NVDA earnings options straddle pricing" }
);
```

#### E. Durable Object Keepalive Protection (`this.keepAliveWhile`)
Because scanning multi-contract option chains across hundreds of strikes can exceed standard Durable Object event timeouts, long-running background tasks are wrapped in `keepAliveWhile`:
```typescript
async autonomousOptionsAnalysis(payload?: AutonomousOptionsAnalysisOptions): Promise<void> {
  const runAnalysis = async () => {
    const service = new ScheduledTasksService(this.env, this.getOrm(), this.sessionKey());
    const res = await service.autonomousOptionsAnalysis(payload);
    // Broadcast websocket alert and dispatch omnichannel notifications
  };

  if (typeof this.keepAliveWhile === "function") {
    await this.keepAliveWhile(runAnalysis);
  } else {
    await runAnalysis();
  }
}
```

---

### 1.2 Autonomous Background Daemons Implemented

The platform includes 5 production-grade background daemons implemented in [`src/services/scheduledTasks.ts`](file:///c:/Users/spr9s/cfagent/src/services/scheduledTasks.ts):

| Daemon Name | Trigger Cadence | Primary Function | Failure / Alert Behavior |
|---|---|---|---|
| **E*TRADE Token Auto-Renewal** | Daily at `23:00 ET` (`0 23 * * *`) | Calls `/oauth/renew_access_token` to acquire fresh session before midnight ET cutoff. Persists to KV & SQLite. | Dispatches audit log `did:agent:openaimp:auth` and warns operator if token was invalidated. |
| **Autonomous Market Opportunity Screener** | Every `300 seconds` (5 min) | Scans Nasdaq & NYSE equities with `DynamicMarketScreener` for oversold bounces and momentum breakouts. | Emits real-time WebSocket `market_alert` broadcast to all connected UI clients. |
| **HITL Order Draft Auto-Expiration** | Delayed `900 seconds` (15 min) | Transitions stale unconfirmed `previewed` order drafts to `expired` status. Prevents unintended execution of outdated prices. | Appends note `[Auto-expired: 15-minute HITL window elapsed]` and logs to `mas_events`. |
| **Autonomous Options Intelligence Scanner** | Configurable Cron / Interval | Evaluates option chains across user-selected symbols (e.g. `NVDA, AAPL, SPY, MSFT`) against the 72-strategy engine. | Dispatches interactive Slack cards, responsive dark-mode HTML email, and webhooks. |
| **Scheduled Reminders & Risk Alerts** | On-demand scheduled timer | Sends scheduled reminders and alerts with persistence into SQLite assistant messages. | Dispatches `scheduled_reminder` broadcast event. |

---

### 1.3 REST Endpoints for Scheduling Management

Administrators and frontend components can manage schedules via the following endpoints on [`src/agents/orchestrator.ts`](file:///c:/Users/spr9s/cfagent/src/agents/orchestrator.ts#L4081-L4220) and [`src/server.ts`](file:///c:/Users/spr9s/cfagent/src/server.ts#L500-L510):

```http
# 1. List active schedules (optional filter: ?type=cron|interval|delayed|scheduled)
GET /api/schedules
Response:
{
  "count": 2,
  "schedules": [
    { "id": "sched_1", "type": "cron", "cron": "0 23 * * *", "callback": "autoRenewETradeTokens" },
    { "id": "sched_2", "type": "interval", "intervalSeconds": 300, "callback": "autonomousMarketScreen" }
  ]
}

# 2. Create a new schedule
POST /api/schedules/create
Content-Type: application/json
{
  "scheduleType": "cron",
  "cron": "30 9 * * 1-5",
  "callback": "autonomousOptionsAnalysis",
  "payload": {
    "symbols": ["SPY", "QQQ", "NVDA"],
    "thesis": "bullish",
    "pushToSlack": true
  }
}

# 3. Cancel an existing schedule
POST /api/schedules/cancel
Content-Type: application/json
{ "scheduleId": "sched_1" }

# 4. Trigger tasks on-demand (Manual Bypass)
POST /api/schedules/trigger-screen
POST /api/schedules/trigger-renew
POST /api/schedules/trigger-options-analysis
```

---

### 1.4 Frontend Management UI: `ScheduledOptionsManager`

The interactive UI is available in the options trading hub via [`src/client/options/ScheduledOptionsManager.tsx`](file:///c:/Users/spr9s/cfagent/src/client/options/ScheduledOptionsManager.tsx):

- **Preset Horizons**:
  - *Market Open*: `30 9 * * 1-5` (9:30 AM ET M–F)
  - *Midday Scan*: `0 12 * * 1-5` (12:00 PM ET M–F)
  - *Market Close*: `0 16 * * 1-5` (4:00 PM ET M–F)
  - *Daily Overnight*: `0 23 * * *` (11:00 PM ET)
- **Symbol Basket Presets**:
  - *Megacap Tech*: `NVDA, AAPL, MSFT, AMZN, GOOGL`
  - *Index ETFs*: `SPY, QQQ, IWM, DIA`
  - *Semiconductors*: `NVDA, AMD, AVGO, TSM, INTC`
  - *High Beta Momentum*: `TSLA, META, NFLX, PLTR, COIN`
- **Omnichannel Channels**: Toggle Slack `#options-alerts`, recipient Email, and Webhook dispatch.
- **On-Demand Triggering & Real-Time Audit Log Inspection**.

---

## Part 2: ETAPI Engine Tuning & Quantitative Scoring Calibration

All tuning parameters are externalized in [`environment.config.json`](file:///c:/Users/spr9s/cfagent/environment.config.json) and dynamically managed via [`src/config/etapiConfig.ts`](file:///c:/Users/spr9s/cfagent/src/config/etapiConfig.ts).

### 2.1 Screener Engine Tuning (`screener`)

The screener filters thousands of option contracts into a curated, mathematically viable subset before evaluation.

| Parameter | Type | Default Value | Tuning Impact & Guidance |
|---|---|---|---|
| `maxScanSymbols` | `number` | `20` (Prod) / `10` (Test) | Maximum symbols scanned in a multi-symbol scan. Increase for broader universe coverage; decrease if hitting Cloudflare subrequest limits. |
| `maxExpirationsPerSymbol` | `number` | `18` (Prod) / `6` (Test) | Maximum expirations requested from upstream broker per symbol. Restricts LEAPS latency. |
| `defaultMinDte` | `number` | `0` days | Minimum Days To Expiration. Set to `0` to allow 0DTE trading; set to `7` or `14` to avoid gamma risk. |
| `defaultMaxDte` | `number` | `90` days | Furthest expiration horizon included in default screens. Prevents low-volume LEAPS contract noise. |
| `atmBandPct` | `number` | `0.03` (±3%) | Distance from underlying price defining At-The-Money (ATM). Higher values include deeper OTM wings. |
| `unusualVolumeOiRatio` | `number` | `2.0x` | Multiplier for flagging institutional unusual volume ($V / \text{OI} \ge 2.0$). |
| `highDeltaThreshold` | `number` | `0.70` | Delta threshold for deep-in-the-money delta-substitute contracts. |
| `highIvThreshold` | `number` | `0.80` (80% IV) | Implied Volatility boundary flagging high-premium expansion candidates. |
| `lowIvThreshold` | `number` | `0.25` (25% IV) | Implied Volatility boundary flagging cheap volatility purchase candidates. |
| `symbolFetchConcurrency` | `number` | `4` | Parallel requests when fetching quotes across multiple tickers. |
| `expiryFetchConcurrency` | `number` | `4` | Parallel requests when fetching option chains across different expiration dates. |

---

### 2.2 Strategy Engine & Black-Scholes Greeks Tuning (`strategyEngine`)

Governs mathematical candidate synthesis across all 72 option strategy templates.

| Parameter | Type | Default Value | Mathematical Purpose & Guidance |
|---|---|---|---|
| `riskFreeRate` | `number` | `0.04` (4.00%) | Risk-free rate ($r$) utilized in Black-Scholes formulas for $d_1$, $d_2$, and Rho ($\rho$). Adjust to mirror current US 3-month Treasury yields. |
| `feePerContract` | `number` | `$0.65` USD | Broker commission per leg. Automatically subtracted from net credit and net debit payoff calculations. |
| `maxCombinations` | `number` | `500` | Upper limit on combinatorial leg permutations generated for complex multi-leg spreads (condors, butterflies). |
| `detailLimit` | `number` | `50` | Maximum quantitative candidate structures ranked and surfaced to the UI or downstream LLM judge. |
| `maxLegs` | `number` | `4` | Maximum leg count for any single strategy structure (supports single leg, 2-leg spreads, 3-leg ratios, 4-leg condors). |

---

### 2.3 Six-Factor Composite Score Weights (`scoreWeights`)

Each candidate strategy is evaluated against a normalized quantitative scoring function $\text{Score} \in [0, 100]$:

$$\text{Score} = \sum_{i=1}^{6} w_i \times S_i$$

```
┌──────────────────────────────────────────────────────────────┐
│                  COMPOSITE SCORING WEIGHTS                   │
├────────────────────────────────┬─────────┬───────────────────┤
│ Factor                         │ Weight  │ Focus             │
├────────────────────────────────┼─────────┼───────────────────┤
│ 1. Thesis Alignment            │ 30%     │ Directional match │
│ 2. Target Reward / Risk        │ 20%     │ Asymmetric payoff │
│ 3. Liquidity & Spread          │ 20%     │ Slippage control  │
│ 4. Volatility / IV Alignment   │ 10%     │ Vega efficiency   │
│ 5. Theta Burden                │  5%     │ Time-decay impact │
│ 6. Data Freshness              │ 15%     │ Quote latency     │
└────────────────────────────────┴─────────┴───────────────────┘
```

1. **Thesis Alignment (`0.30`)**: Evaluates how cleanly delta ($\Delta$) and strategy payoff match user sentiment (`bullish`, `bearish`, `neutral`, `large_move`).
2. **Target Reward/Risk (`0.20`)**: Computes net expected payoff versus maximum defined risk: $\text{EV} = (\text{WinRate} \times \text{MaxProfit}) - ((1 - \text{WinRate}) \times \text{MaxLoss})$.
3. **Liquidity (`0.20`)**: Penalizes wide bid/ask spreads: $S_{\text{liq}} = 1 - (\text{Spread} / \text{MidPrice})$.
4. **Volatility Alignment (`0.10`)**: Rewards net long Vega when IV is low, and net short Vega when IV is elevated.
5. **Theta Decay (`0.05`)**: Rewards positive time decay for credit structures and bounds daily theta burn for debit structures.
6. **Data Freshness (`0.15`)**: Discounts stale quote snapshots older than `defaultQuoteAgeSeconds`.

---

### 2.4 LLM Ideas & Context Token Pruning Tuning (`llmIdeas`)

When feeding raw options chains directly to Workers AI models:

| Parameter | Default Value | Purpose |
|---|---|---|
| `inputTokenBudget` | `90,000` tokens | Total prompt budget allocated across expiration cohorts. Prevents context window overflow. |
| `defaultModel` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Reasoning model assigned for raw options evaluation. |
| `expirationGroups` | 3 groups | Partitions chains into near-term (0–30d), mid-term (31–90d), and long-term (91d+) cohorts analyzed concurrently. |

---

### 2.5 Cache & Broker Resilience Tuning (`cache` & `etrade`)

Controls Durable Object caching and retry thresholds:

| Parameter | Default Value | Purpose |
|---|---|---|
| `cache.quoteTtlSeconds` | `60` seconds | In-memory quote cache TTL. |
| `cache.chainTtlSeconds` | `120` seconds | Option chain cache TTL. |
| `cache.expirationsTtlSeconds` | `600` seconds | Expiration dates calendar cache TTL. |
| `etrade.defaultTimeoutMs` | `8,000` ms | Upstream broker REST HTTP timeout. |
| `etrade.maxRetries` | `3` retries | Exponential backoff retry attempts for 429/503 upstream responses. |
| `etrade.retryDelayMs` | `500` ms | Base delay before retry. |

---

### 2.6 Interactive Runtime Tuning Modal

System operators can tune all parameters without modifying configuration files or redeploying the worker:

1. Click **⚙️ Settings** in the top navigation bar or **Tuning** inside the Options Screener.
2. The [`EtapiConfigModal`](file:///c:/Users/spr9s/cfagent/src/client/options/EtapiConfigModal.tsx) provides dedicated sliders, input fields, and model selectors for:
   - AI Model Catalog & Task Assignments.
   - Trading Constraints (Max Order USD, Max Quantity, Voice HITL).
   - Screener Engine & DTE Windows.
   - Strategy Score Weights & Black-Scholes Risk-Free Rate.
3. Clicking **Save Configuration** persists the parameters into Durable Object SQLite storage (`mas_memory`) via `POST /api/config/etapi`, immediately taking effect across all running agents.
4. Clicking **Reset Defaults** reloads baseline values from [`environment.config.json`](file:///c:/Users/spr9s/cfagent/environment.config.json).

---

## Part 3: Verification & Test Coverage

The scheduling engine and ETAPI configuration subsystems are thoroughly verified by the test suite:

- [`tests/scheduled_tasks.test.ts`](file:///c:/Users/spr9s/cfagent/tests/scheduled_tasks.test.ts): 15 comprehensive tests covering token renewal, market screening, 15m order expiration, reminder dispatching, and agent scheduler harnesses.
- [`tests/scheduled_options_screening.test.ts`](file:///c:/Users/spr9s/cfagent/tests/scheduled_options_screening.test.ts): 5 tests validating autonomous options scanning, basket resolution, and Slack/Email dispatch.
- [`tests/etapi_config_and_unified_options.test.ts`](file:///c:/Users/spr9s/cfagent/tests/etapi_config_and_unified_options.test.ts): 10 tests verifying config loading, tier overrides, quantitative score weight normalization, and omnichannel serialization.
