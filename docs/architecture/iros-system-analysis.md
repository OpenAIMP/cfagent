# IROS System Architectural Analysis & Target State Decomposition

**Governance & Standard:** Architecture Body of Knowledge (ABoK) & Enterprise Architecture Body of Knowledge (EABOK)
**Target Architecture:** Cloud-Native, AI-Native, Cloud & Technology Agnostic, Autonomous Multi-Agent & Recursive Self-Improving (RSI)
**Document Status:** Approved Architectural Assessment & Target Remediation Blueprint
**Scope:** IROS (Intelligent Real-time Operating System / Autonomous Financial Intelligence Swarm)

---

## 1. Executive System Summary & ABoK / EABOK Alignment

IROS operating on the `cfagent` platform represents a multi-agent financial intelligence, options/equity screening, quantitative research, and autonomous execution system.

Under Enterprise Architecture Frameworks (TOGAF / EABOK) and System Architecture standards (ABoK), IROS is evaluated as a **layered, event-driven, actor-based modular platform**. This document details:
1. System & Subsystem Layering Architecture
2. Analysis of Built, Unbuilt, and Decomposed Subsystems
3. Detailed Breakdown of Job Subsystems, Orchestrators, Workflows, Queues, Schedulers, Execution Engine, and Data Foundation
4. Complete Directed Acyclic Graph (DAG) Pipeline Model across Ingestion, Screening, Generation, Alerting, and Execution
5. Autonomous & Auto-Fixing Subsystems (Self-Healing, Portfolio Repair, QA, Telemetry Calibration)
6. System & Subsystem Diagramming with Capabilities and Opportunities for Improvement
7. Technology/Cloud-Agnostic Remediation Plan targeting an AI-Native / Agentic / RSI Architecture

---

## 2. Layered Subsystem Architecture

IROS is structured across seven distinct architectural layers using the **Ports & Adapters (Hexagonal)** pattern to guarantee complete vendor and platform independence.

```
+---------------------------------------------------------------------------------------------------+
| 1. INTERACTION & DELIVERY LAYER (Web UI, Slack, Email, Webhooks, A2A Endpoints, REST/OpenAPI/MCP) |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+---------------------------------------------------------------------------------------------------+
| 2. ORCHESTRATION & WORKFLOW LAYER (Workflow Engine Ports, Event Bus, Cron Schedulers, Job Queues)  |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+---------------------------------------------------------------------------------------------------+
| 3. INTELLIGENCE & AGENT SWARM LAYER (Screener, Research, Social, Trading, Meta/RSI Agents)        |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+---------------------------------------------------------------------------------------------------+
| 4. DETERMINISTIC EXECUTION & QUANT LAYER (Greeks, Option Strategies, Technicals, Sizing, Risk)     |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+---------------------------------------------------------------------------------------------------+
| 5. AUTONOMOUS & SELF-FIXING LAYER (Self-Healing QA, Repair Proposals, Telemetry Calibration, RSI) |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+---------------------------------------------------------------------------------------------------+
| 6. DATA FOUNDATION & KNOWLEDGE LAYER (Relational Ledger, Vector RAG, Graph Memory, Blob Storage)  |
+---------------------------------------------------------------------------------------------------+
                                                 |
                                                 v
+---------------------------------------------------------------------------------------------------+
| 7. INGESTION & DATA PROVIDER LAYER (E*TRADE, Yahoo, Nasdaq, FOSS, SEC Filings, Fed/Econ Feeds)    |
+---------------------------------------------------------------------------------------------------+
```

---

## 3. Subsystem Breakdown & Categorization Matrix

| Subsystem Category | Status | Current Implementation State | Architectural Target / Action |
| :--- | :--- | :--- | :--- |
| **Ingestion Subsystem** | **Built** | `src/trading/dataProviders/` (Yahoo, E*TRADE, Nasdaq, FOSS, Public Data) | Wrap all external providers in Circuit Breakers, Rate-Limit Adapters, and Fallback chains (`providerHealth.ts`). |
| **Quant Execution Subsystem** | **Built** | `src/trading/` (`optionsScreener.ts`, `technicals.ts`, `riskMath.ts`) | **Retain Pure Math**; deterministic calculations remain hard-coded without LLM interference. |
| **Job Subsystem** | **Built (Partial)** | `src/services/shardJobs.ts`, `src/services/scheduledTasks.ts` | Decompose synchronous worker jobs into retriable queue/workflow step executions. |
| **Orchestrators & Swarm** | **Needs Refactoring** | Procedural classes (`ScreenerAgent.ts`, `ResearchAgent.ts`) | Migrate to Actor-based Durable Objects (`AgentActorDO`) with isolated working memory and typed MCP tools. |
| **Workflows Subsystem** | **Built** | `src/workflows/` (`screenerWorkflow.ts`, `workflowPorts.ts`) | Extend workflow-engine coverage across all multi-hour or multi-step pipeline executions. |
| **Queues Subsystem** | **Built** | `src/messaging/` (`screenerQueueConsumer.ts`, `messagingPorts.ts`) | Replace in-memory event bus with durable queues across ingestion, screening, research, and delivery. |
| **Schedulers Subsystem** | **Built** | `src/schedule.ts`, `src/services/scheduleManagement.ts` | Unified Cron Scheduler with preflight auth checks (`E*TRADE` token validation) and schedule state management. |
| **Data Foundation Layer** | **Built** | Relational DB (`D1`), KV Cache, R2 Blob Store, Vectorize Embeddings | Consolidate schemas into relational ledger; unify graph memory with D1 market adjacency graph adapters. |
| **Monolithic Router Handlers** | **Needs Decomposition** | `src/index.ts` (Fat routes handling synchronous market scans) | Extract inline handlers into thin gateway endpoints delegating to async Queues and Workflows. |
| **In-Memory Event Bus** | **Needs Decomposition** | `src/trading/screener.ts` (In-memory `ScreenerEventBus`) | Completely eliminate in favor of durable messaging queues (`screenerQueueConsumer.ts`). |
| **Autonomous Self-Fixing Engine** | **Needs Enhancement** | `src/qa/self-healing.ts`, `src/services/repairProposals.ts`, `src/telemetry/calibratedPromptPlug.ts` | Consolidate into unified RSI Loop: Telemetry Collector -> Outcome Analysis -> Calibration -> Auto-Fixing. |
| **Multi-Agent Swarm Negotiator**| **Needs To Be Built** | Basic prompt routing via LLM gateway | Build multi-agent task planner & negotiation protocol for dynamic agent tool selection and task decomposition. |

---

## 4. In-Depth Subsystem Architectural Analysis

### 4.1 Job Subsystem, Orchestrators, Workflows, Queues, and Schedulers

#### 1. Job Subsystem
- **Function:** Handles background work units such as feed snapshots (`feedSnapshotJob.ts`), options screening shards (`shardJobs.ts`), and delivery tasks (`screenerFollowupDelivery.ts`).
- **Target State:** Jobs are serialized as immutable command envelopes (`workflowCommandEnvelope.ts`) processed idempotently by worker pools with exponential backoff and dead-letter queueing.

#### 2. Orchestrators
- **Function:** Coordinates multi-agent workflows, managing dependencies between market screening, research brief expansion, risk policy evaluation, and notification delivery.
- **Target State:** Managed via Actor-based Orchestrator Actors implementing the Agent SDK Port, enforcing deterministic state transitions and Human-in-the-Loop (HITL) execution gates.

#### 3. Workflows Subsystem
- **Function:** Executes multi-step, stateful, long-running pipelines (e.g., `screenerWorkflow.ts`) that survive process restarts and edge execution wall-clock limits.
- **Target State:** Workflow Engine Port adapters (`cfWorkflowAdapter.ts` / `inMemoryWorkflowAdapter.ts`) supporting checkpointing, step retries, and sleep/resume capability for scheduled market tasks.

#### 4. Queues Subsystem
- **Function:** Provides asynchronous event-driven messaging (`messagingPorts.ts`), decoupling ingress/triggers from egress/delivery.
- **Target State:** Queues handle `market-data-q`, `screener-runs-q`, `social-deliveries-q`, and `trade-execution-q` with guaranteed at-least-once delivery semantics.

#### 5. Schedulers Subsystem
- **Function:** Triggers automated recurring tasks (pre-market briefs at 8:30 ET, midday scans at 12:30 ET, token renewal, retention cleanup).
- **Target State:** Schedule manager (`scheduleManagement.ts`) checks preflight prerequisites (e.g. active PROD OAuth sessions) before emitting trigger events to Queues.

---

### 4.2 Data Foundation Layer

The Data Foundation Layer enforces a **4-Tier Unified Storage Architecture**:

1. **Relational Ledger (SQL / D1):** Single source of truth for transactional state, execution records, trade approval ledgers (`iaaaAuditStore.ts`), screening run metadata (`scanRunStore.ts`), and system configuration.
2. **Key-Value Operational Cache (KV):** Ephemeral 5-minute TTL cache for market quotes (`quoteCache.ts`), rate limits, circuit breaker state, and user session tokens (`sessionCache.ts`).
3. **Blob Artifact Storage (R2):** Immutable storage for generated PDFs (`optionsReportPdf.ts`), Excel/CSV export workbooks (`optionsReportXlsx.ts`), and raw market snapshots.
4. **Semantic Vector & Graph Knowledge Store (Vectorize + D1 Graph):** RAG vector index for research reports paired with relational adjacency tables (`d1MarketGraphAdapter.ts`) modeling market dynamics (Sector -> Industry -> Symbol -> Option Chain).

---

### 4.3 Deterministic Execution Engine

The Execution Engine remains **100% deterministic and AI-free** to guarantee absolute precision and safety:
- **Options Pricing & Greeks:** Analytical Black-Scholes and Binomial Option Pricing models (`riskMath.ts`, `calibratedOptionChains.ts`).
- **Technical Indicators:** VWAP, Anchored VWAP, RSI, MACD, Bollinger Bands, and Squeeze indicators (`technicals.ts`, `screeningIndicators.ts`).
- **Risk & Margin Guardrails:** CVaR optimization (`cvarOptimizer.ts`), position sizing ratios (`positionSizing.ts`), portfolio concentration checks (`portfolioConcentration.ts`), and E*TRADE preflight execution gates (`etradeExecutionGate.ts`).

---

### 4.4 Autonomous Subsystem & Auto-Fixing Engine (RSI)

The Autonomous Subsystem enables **Self-Healing, Self-Fixing, and Recursive Self-Improvement (RSI)** across four feedback loops:

```
+---------------------------------------------------------------------------------------------------+
|                               AUTONOMOUS AUTO-FIXING & RSI LOOP                                   |
|                                                                                                   |
|  +-----------------------+      +-----------------------+      +-------------------------------+  |
|  | 1. Outcome Tracking   | ---> | 2. Telemetry & Eval   | ---> | 3. Calibration & Repair       |  |
|  | (5d/30d Realization)  |      | (Sharpe, Hit Rate)    |      | (Proposal Challenger Bridge)  |  |
|  +-----------------------+      +-----------------------+      +-------------------------------+  |
|              ^                                                                  |                 |
|              |                  +-----------------------+                       |                 |
|              +----------------- | 4. Auto-Fix Execution | <---------------------+                 |
|                                 | (Prompt/Weight Plug)  |                                         |
|                                 +-----------------------+                                         |
+---------------------------------------------------------------------------------------------------+
```

1. **Self-Healing QA (`self-healing.ts`):** Automatically detects transient execution errors, API rate-limiting (429s), or corrupt payloads, triggering dynamic fallback adapters and circuit breaker state switches.
2. **Portfolio Repair Policies (`repairPolicies.ts`, `repairProposals.ts`):** Evaluates underperforming positions or portfolio risk breaches, automatically generating delta-neutral hedge proposals (e.g. collar overlays, spread conversions).
3. **Outcome Tracking (`outcomeTracking.ts`):** Records actual price trajectory 5 and 30 days after a screening signal or trade recommendation was issued.
4. **Telemetry Calibration (`calibratedPromptPlug.ts`, `telemetryRoute.ts`):** Feeds outcome metrics back into LLM system prompts and strategy selection weights without requiring code deployments.

---

## 5. End-to-End System Directed Acyclic Graph (DAG) Model

The complete end-to-end execution flow across Schedules, Workflows, Queues, Agents, and Channels is modeled as a unified DAG:

```
[Cron Scheduler / UI Trigger]
         |
         v
(Preflight Auth & Session Check) --[Fail]--> [Emit AUTH_003 Alert to Slack/Logs]
         |
      [Pass]
         v
[Dispatch Event to market-data-q]
         |
         v
[Workflow Engine Execution: Screener Workflow]
         |
         +---> (Step 1: Fetch Universe & Market Data via Data Provider Adapters)
         |            |
         |            v
         +---> (Step 2: Run Deterministic Quant & Screening Engine)
         |            |
         |            v
         +---> (Step 3: Invoke ScreenerAgent Actor for Pattern Classification)
         |            |
         |            v
         +---> (Step 4: Dispatch Candidates to Research Queue)
                      |
                      v
      [Research Queue Consumer]
                      |
                      v
   (ResearchAgent Expansion & Vector RAG Search)
                      |
                      v
   (Generate Reports & Save Artifacts to Blob Store)
                      |
                      v
   [Dispatch Delivery Payload to notify-q]
                      |
                      +---> [Slack Delivery Agent] ---> (Slack Workspace)
                      +---> [Email Delivery Agent] ---> (User Inbox)
                      +---> [Webhook Agent]        ---> (External Systems)
                      +---> [TradingAgent Gate]    ---> (HITL Approval -> E*TRADE)
```

---

## 6. Diagramming Capabilities & Opportunities for Improvement

### Subsystem Capabilities & Opportunities Matrix

```
+---------------------------------------------------------------------------------------------------+
| SUBSYSTEM CAPABILITY MAP & OPPORTUNITIES FOR IMPROVEMENT                                          |
+------------------------------+------------------------------------+-------------------------------+
| Subsystem                    | Current Capability                 | Opportunity for Improvement   |
+------------------------------+------------------------------------+-------------------------------+
| Ingestion & Market Data      | Multi-provider fetching (Yahoo,    | Add automated circuit-breaker |
|                              | E*TRADE, Nasdaq) with quote cache  | failover & mock fallbacks     |
+------------------------------+------------------------------------+-------------------------------+
| Quant & Screening Engine     | Pure TS options math, Greeks,      | Parallelize screening across  |
|                              | technical indicators, strategies   | worker sharding nodes         |
+------------------------------+------------------------------------+-------------------------------+
| Workflow Orchestration       | State-checkpointed workflows for   | Standardize all cron tasks    |
|                              | options screening pipelines        | into Workflow Engine Steps    |
+------------------------------+------------------------------------+-------------------------------+
| Async Queue Messaging        | Queued consumers for screening and | Enforce strict idempotency    |
|                              | social followups                   | keys across all handlers      |
+------------------------------+------------------------------------+-------------------------------+
| Data Foundation Layer        | SQL ledger, KV cache, R2 blob      | Consolidate schemas & enforce |
|                              | storage, Vector RAG embeddings     | single D1 transactional boundary|
+------------------------------+------------------------------------+-------------------------------+
| Intelligence & Swarm Layer   | Multi-agent tasks for screening,   | Standardize on Agent SDK Port |
|                              | research, drafting, trade routing  | & Actor Durable Objects       |
+------------------------------+------------------------------------+-------------------------------+
| Autonomous & Auto-Fixing     | Self-healing QA, repair proposals, | Wire calibration engine directly|
|                              | outcome tracking, telemetry        | into prompt injection layer   |
+------------------------------+------------------------------------+-------------------------------+
```

---

## 7. Cloud-Native, AI-Native, Cloud-Agnostic Remediation Plan

To transform IROS into a fully cloud-native, AI-native, cloud-agnostic, and RSI-capable platform, execution is structured across 4 distinct phases:

### Phase 1: Decoupling & Ports/Adapters Formalization (Months 0 - 3)
- Decompose monolithic router handlers (`src/index.ts`) into thin HTTP adapters delegating to background Workflows and Queues.
- Replace all remaining in-memory event buses (`ScreenerEventBus`) with durable queue consumers (`screenerQueueConsumer.ts`).
- Wrap external market APIs in circuit breakers with automatic fallback adapters (`providerHealth.ts`).

### Phase 2: Actor-Based Multi-Agent Swarm (Months 3 - 6)
- Refactor procedural agent classes (`ScreenerAgent`, `ResearchAgent`) into stateful Actor Durable Objects (`AgentActorDO`) using the Agent SDK Port.
- Implement Model Context Protocol (MCP) tool interfaces with strict schema validation and cryptographic authorization bounds.
- Establish Multi-Agent Swarm Negotiator for dynamic task decomposition and tool selection.

### Phase 3: Hybrid Knowledge Graph & LLM Gateway (Months 6 - 12)
- Deploy Vector RAG index (`reportSemanticIndex.ts`) integrated with relational adjacency graph adapters (`d1MarketGraphAdapter.ts`).
- Route all LLM inference calls through unified LLM Gateway Port (`AI Gateway`) for prompt caching, rate limiting, and multi-model fallbacks (Llama 3.3, DeepSeek-R1, Claude, OpenAI).

### Phase 4: Full RSI & Autonomous Auto-Fixing Engine (Months 12 - 24)
- Complete the autonomous feedback loop linking 5d/30d outcome realization (`outcomeTracking.ts`) to prompt calibration (`calibratedPromptPlug.ts`).
- Automate portfolio repair proposal generation (`repairProposals.ts`) with zero-touch risk rebalancing under strict HITL trade execution gates.
- Deploy continuous self-evaluation and automated backtesting calibration across all strategy families.

---

**Architectural Approval:**
*Software Architecture Review Board (SARB)*
*System Architecture & Multi-Agent Engineering Guild*
