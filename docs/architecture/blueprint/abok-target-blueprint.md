# cfagent Architecture Body of Knowledge (ABoK) & Target State Blueprint

**Governance & Authority:** Software Architecture Review Board (SARB)
**Board Composition:** Chief Architect, Enterprise Architect, Solution Architect, Cloud Architect, Agentic Systems Architect, Cloudflare Platform Architect, TOGAF Certified Architect, Distributed Systems Architect, Staff+ / Principal Engineers, SRE Lead, Security Architect
**Status:** Approved Target State Architecture & Decision Record Set
**Scope:** `cfagent` Autonomous Financial Intelligence & Multi-Agent RSI Platform

---

## SECTION 1: Executive Architecture Assessment

### Executive Summary
`cfagent` has evolved from an initial automated options/equity screener into an ambitious, multi-agent financial intelligence and execution platform. The current implementation exhibits significant functional density across market data ingestion, algorithmic options and stock screening, multi-channel social delivery (Slack, Bluesky, Twitter/X), and persistent trade approval workflows.

However, critical architectural evaluation reveals that the system currently operates as a **Monolithic Edge Worker** with tight coupling between HTTP routing, synchronous market data fetching, stateful database operations, and agent execution. While edge-native via Cloudflare Workers, the architecture suffers from structural brittleness: synchronous external API dependency chains (e.g., Yahoo Finance, E*TRADE, Nasdaq), in-memory state leakage, fragmented data storage primitives (mixing D1, KV, R2, and Durable Objects inconsistently), and lack of formal event-driven decoupling.

To transition `cfagent` into an enterprise-grade, autonomous, recursive self-improving (RSI) multi-agent platform, the architecture must undergo a systematic transformation toward event-driven Workflows, Durable Object-backed Agent actors, vector-graph hybrid knowledge stores, and agent SDK primitives behind adapter interfaces.

### Current State Architectural Profile
- **Runtime:** Single Cloudflare Worker monolith (`src/index.ts`) routing HTTP requests, scheduled cron triggers, and background tasks.
- **Compute & Coordination:** Mix of stateless Worker routes and stateful Durable Objects (`SessionStore`, `SocialDraftDO`, `OptionsDO`).
- **Data Layer:** Heterogeneous mix of Cloudflare D1 (SQLite at the edge), KV (cache/locks), R2 (blob storage for PDF/CSV reports), and Vectorize (report semantic search).
- **Agent Architecture:** Procedural agent logic (`ScreenerAgent`, `ResearchAgent`, `SocialAgent`, `TradingAgent`) with direct function calls, limited autonomous feedback loops, and basic prompt-driven execution.
- **Resilience:** Defensive fallback mechanisms and try-catch wrappers, but susceptible to single-point-of-failure synchronous timeouts during market data polling.

### Key Risks, Strengths, Gaps, Architectural Debt & Future Readiness

#### Strengths
1. **Cloud-Native Foundation:** Deployment on a worker runtime (current implementation: Cloudflare Workers) provides ultra-low latency globally with zero cold-start overhead.
2. **High Domain Coverage:** Built-in quant formulas for options strategies (Iron Condor, Covered Call, Cash Secured Put, Bull Put Spread), technical indicators (Anchored VWAP, Bollinger Squeeze, RSI, MACD), and compliance filters.
3. **Multi-Channel Delivery Pipeline:** Integrated publishing engine supporting Slack webhooks, PDF generation (via `ReportAssetAgent`), and structured JSON/CSV exports.
4. **Strong Test Suite & Policy Control:** Over 6,300 tests with automated pre-merge verification scripts and strict CI policy gates.

#### Key Risks
1. **Synchronous Cascade Failures:** Upstream provider latency or rate limits (e.g., Yahoo Finance 429s, E*TRADE token expiration) propagate directly into HTTP request timeouts.
2. **State Fragmentation & Race Conditions:** Distributed state split across D1, KV, and DOs without single-source-of-truth transactional boundaries.
3. **Unbounded Compute & Memory Limits:** Complex options screening across full market universes in a single Worker invocation risks hitting 128MB memory caps and CPU wall-clock limits.

#### Gaps & Architectural Debt
1. **Lack of Event Bus Decoupling:** In-memory `ScreenerEventBus` cannot guarantee event delivery across Worker instances or withstand process restarts.
2. **Procedural Agent Implementation:** Agents are implemented as TypeScript classes rather than autonomous state machines or actor-based Durable Objects with long-term memory.
3. **Manual Prompts & Static Pipelines:** Prompts and agent tools are statically compiled; lack of dynamic tool discovery or self-reflection primitives blocks true Recursive Self-Improvement (RSI).

### Architecture Scorecard

| Quality Dimension | Current Score (1-10) | Target Score (1-10) | Key Driver / Gap |
| :--- | :---: | :---: | :--- |
| **Simplicity** | 5 | 8 | Current monolith has overlapping router/agent responsibilities. |
| **Scalability** | 4 | 9 | Heavy synchronous screening loops hit Worker execution limits. |
| **Reliability** | 5 | 9 | Lack of retriable event queues and circuit breakers. |
| **Maintainability** | 6 | 9 | High file density in `/src`; needs clean domain boundaries. |
| **Extensibility** | 5 | 9 | Dynamic agent tools require agent SDK port integration (current implementation: Cloudflare Agents SDK). |
| **Security** | 7 | 10 | Strong Zero Trust & IAAA foundation; needs fine-grained agent sandboxing. |
| **Performance** | 6 | 9 | Edge execution is fast, but external API fetches bottleneck request cycles. |
| **Observability** | 5 | 9 | Basic console logging; needs Analytics Engine & OpenTelemetry tracing. |
| **Provider-Agnostic Alignment**| 7 | 10 | Uses a worker runtime, relational store, and cache; underutilizes workflow engines, queues, LLM gateways, and AI search. |
| **Agentic Readiness** | 4 | 9 | Agents lack autonomous decision-making loops and persistent state graphs. |
| **RSI Readiness** | 2 | 9 | Missing code modification, prompt self-tuning, and automated eval loops. |

---

## SECTION 2: Architecture Vision & Quality Attributes

### Architectural Vision
To establish `cfagent` as the premier cloud-native, cloud-agnostic, autonomous financial intelligence platform—operating as an extensible, resilient multi-agent swarm capable of real-time market discovery, risk-managed trade orchestration, multi-channel narrative synthesis, and recursive self-improvement (RSI) under strict safety and compliance guardrails.

### Guiding Principles & Design Tenets
1. **Cloud-Native, Cloud-Agnostic, Pattern-Oriented:** Capabilities are expressed as ports (workflow orchestration, async messaging, actor runtime, relational ledger, semantic knowledge, LLM gateway, observability). Provider primitives — edge runtimes, actors, workflow engines, queues, gateways, vector stores, relational stores — are used ONLY behind adapter interfaces; no domain code depends on any single provider. Structure is governed by patterns: Adapter/ports, SOLID, GRASP, and GoF (Adapter, Strategy, Command, State, Decorator, Observer), with conformance suites proving adapter substitutability. Cloudflare products are the current adapter implementations, not the architecture.
2. **Event-Driven Asynchrony:** Decouple data ingestion, analysis, report generation, and delivery via durable queues and background workflows.
3. **Actor-Based Agent Autonomy:** Every agent operates as a stateful Durable Object actor with isolated memory, typed MCP tools, and deterministic state transitions.
4. **Deterministic Preflight & Guardrails:** Algorithmic calculation, risk sizing, and compliance rules remain hard-coded and deterministic; AI models assist in synthesis, natural language query, and strategy generation.
5. **Zero Trust Agent Permissions:** Principle of least privilege applied to agent capabilities. Agents cannot execute financial transactions without explicit Human-in-the-Loop (HITL) approval and cryptographic audit traces.
6. **Continuous Self-Evaluation (RSI):** Autonomous performance measurement, backtesting feedback loops, and prompt/tool calibration without manual code deployments.

### Quality Attribute Targets

```
                                  +---------------------------------------+
                                  |    Target Quality Attributes (NFRs)   |
                                  +---------------------------------------+
                                                     |
         +-------------------+-----------------------+-----------------------+-------------------+
         |                   |                       |                       |                   |
  +--------------+    +--------------+        +--------------+        +--------------+    +--------------+
  | Availability |    | Performance  |        | Reliability  |        | Security     |    | Operability  |
  | 99.95% Edge  |    | p95 < 200ms  |        | Zero Event   |        | Zero Trust   |    | Zero-Downtime|
  | SLA          |    | Read Latency |        | Loss (Queues)|        | Cryptographic|    | Deployments  |
  +--------------+    +--------------+        +--------------+        | Audit Trails |    +--------------+
                                                                      +--------------+
```

---

## SECTION 3: Enterprise Architecture (TOGAF Framework)

### Business Architecture
- **Business Domains:** Market Intelligence, Options & Equity Screening, Portfolio Risk Management, Automated Social Synthesizer, Autonomous Trade Execution, Agent Operations.
- **Capabilities:** Real-time data normalization, multi-factor quant screening, automated narrative brief drafting, HITL trade routing, agentic self-reflection and prompt tuning.
- **Value Streams:** Market Signal Identification -> Risk & Margin Screening -> Multi-Agent Research Enrichment -> Narrative Synthesis -> Social/Slack Broadcast -> Trade Approval Routing.
- **Stakeholders:** Quantitative Analysts, Portfolio Managers, Risk Officers, Compliance Auditors, Platform SREs, Autonomous Agent Swarm.

### Application Architecture
- **Core Applications:** Edge HTTP Gateway (`cfagent-router`), Multi-Asset Screener Engine, Options Analytics Engine, Social Synthesizer Engine, Trade Orchestrator, Agent Swarm Manager.
- **Services:** Ingestion Service, Screening Service, PDF Asset Generator, Notification Delivery Engine, Vector/Graph Hybrid Knowledge Service, RSI Calibration Engine.
- **Agent Systems:** `ScreenerAgent` (Quant analysis), `ResearchAgent` (News & fundamental search), `SocialAgent` (Drafting & publishing), `TradingAgent` (E*TRADE & risk execution), `MetaAgent` (Swarm orchestration & RSI).
- **APIs:** REST / JSON OpenAPI v3 spec, Model Context Protocol (MCP) tool endpoints, Server-Sent Events (SSE) streaming streams, Webhook ingestion.

### Data Architecture
- **Data Domains:** Market Data (Quotes, Chains, Fundamentals), Screening Presets & Results, User Sessions & Security Identity, Trade Orders & Execution Ledgers, Agent Memory & Embeddings, RSI Calibration Metrics.
- **Data Ownership:**
  - **D1 (`cfagent-db`):** Transactional state, execution ledgers, screening run metadata, audit logs.
  - **Durable Objects (`SessionStore`, `AgentDO`):** Active user sessions, agent state machines, real-time message queues.
  - **Vectorize (`reports-index`):** Semantic vector embeddings of historical market reports and research briefs.
  - **R2 (`cfagent-artifacts`):** Generated PDFs, exported XLSX/CSV workbooks, raw market snapshots.
  - **KV (`cfagent-cache`):** Ephemeral market quotes, rate limit counters, circuit breaker states.
- **Data Lifecycles:** Ephemerality rules enforced per tier (KV: 5-minute TTL; D1: 90-day execution retention; R2: 1-year archive tier).

### Technology Architecture
- **Current implementation platform (adapter implementations, not the architecture):** Cloudflare Developer Platform (Workers, Durable Objects, Workflows, Queues, Hyperdrive, D1, R2, KV, Vectorize, AI Gateway, Workers AI).
- **Runtime Environments:** Edge V8 Isolation (Cloudflare Workers Runtime), Node.js (Local testing/Vitest), Workers AI (Llama 3.3 70B, DeepSeek-R1, BGE Embeddings).

---

## SECTION 4: Architectural Perspectives (14 Views)

1. **Business View:** Maps platform capabilities directly to trading desk value streams and risk management guardrails.
2. **Product View:** Details user journey across multi-tab UI (Trading, Research, API/MCP, Options Flows, Workflows) and automated Slack notifications.
3. **Capability View:** Categorizes system features into Feed, Gather, Analysis, Generate, Store, Serve, Deliver, Scheduling, and Meta-Cognition.
4. **Service View:** Defines internal service interfaces, decoupling synchronous web handling from background execution via durable queues.
5. **Solution View:** Describes end-to-end integration between edge workers, stateful Durable Objects, and external market providers.
6. **Runtime View:** Details execution lifecycles for HTTP requests, scheduled Cron triggers, Queue consumers, and Workflow steps.
7. **Operational View:** Focuses on zero-downtime deployments via Wrangler, automated health checks, rate-limit handling, and graceful degradation.
8. **Security View:** Enforces Zero Trust IAAA (Identity, Authentication, Authorization, Audit), OAuth 2.0 PKCE for E*TRADE, Slack HMAC signatures, and secret isolation.
9. **Agent View:** Maps agent interaction protocols, task decomposition, tool invocation via MCP, and human-in-the-loop escalation paths.
10. **Knowledge View:** Defines memory structures across working memory (DO), semantic memory (Vectorize), structured memory (D1), and document archives (R2).
11. **Data View:** Schematizes entity-relationship models, transactional boundaries, and multi-tenant data isolation.
12. **Deployment View:** Specifies global edge deployment topology across edge points of presence (current implementation: Cloudflare PoPs) with automatic region routing.
13. **Governance View:** Defines policy enforcement gates, code ownership (`AGENTS.md`), pre-merge verification scripts, and compliance tracking.
14. **Evolution View:** Outlines the multi-stage migration path from monolithic edge script to autonomous RSI-capable agent platform.

---

## SECTION 5: C4 Architecture Model

> Note: the diagrams in this section depict the current Cloudflare implementation of the capability architecture; the normative capability view is §10.

### Level 1: System Context Diagram

```
                                          +-------------------------+
                                          |   External Systems      |
                                          | (E*TRADE, Yahoo, Nasdaq)|
                                          +-------------------------+
                                                       ^
                                                       | HTTPS / OAuth
                                                       v
+------------------+     HTTPS / REST     +-------------------------+    Slack / Webhooks    +-------------------+
|  Trader / User   | <------------------> |   cfagent Edge Platform | <--------------------> | Social Channels   |
| (Browser / UI)   |                      |  (Cloudflare Workers)   |                        | (Slack, Bluesky)  |
+------------------+                      +-------------------------+                        +-------------------+
                                                       ^
                                                       | MCP / AI Tokens
                                                       v
                                          +-------------------------+
                                          | Cloudflare AI Gateway   |
                                          |   & Workers AI Models   |
                                          +-------------------------+
```

### Level 2: Container Diagram

```
+---------------------------------------------------------------------------------------------------------+
| cfagent Boundary (Cloudflare Global Network)                                                            |
|                                                                                                         |
|  +--------------------+      +-------------------------+      +--------------------------------------+  |
|  | Single Page App    | ---> | HTTP Gateway Worker     | ---> | Background Workflows Engine          |  |
|  | (React / Vite UI)  |      | (src/index.ts)          |      | (Cloudflare Workflows)               |  |
|  +--------------------+      +-------------------------+      +--------------------------------------+  |
|                                           |                                      |                      |
|                                           v                                      v                      |
|                              +-------------------------+      +--------------------------------------+  |
|                              | Durable Objects         |      | Async Cloudflare Queues              |  |
|                              | (Session, Agent Actors) |      | (market-data-q, notify-q)            |  |
|                              +-------------------------+      +--------------------------------------+  |
|                                           |                                      |                      |
|                                           +-------------------+------------------+                      |
|                                                               |                                         |
|                                                               v                                         |
|  +-------------------+   +-------------------+   +-------------------+   +-------------------------------+  |
|  | D1 Relational DB  |   | KV Key-Value Store|   | R2 Object Storage |   | Vectorize Vector Database     |  |
|  | (cfagent-db)      |   | (cfagent-cache)   |   | (cfagent-artifacts|   | (reports-index)               |  |
|  +-------------------+   +-------------------+   +-------------------+   +-------------------------------+  |
+---------------------------------------------------------------------------------------------------------+
```

### Level 3: Component Diagram (Target Agent Subsystem)

```
+---------------------------------------------------------------------------------------------------------+
| Agent Swarm Container                                                                                   |
|                                                                                                         |
|  +-----------------------+      +-----------------------+      +-------------------------------------+  |
|  | Orchestrator Agent DO | ---> | Screener Agent Actor  | ---> | Market Data Acquisition Engine      |  |
|  | (Task Planner)        |      | (Quant Calculation)   |      | (Yahoo / Nasdaq / E*TRADE Providers)|  |
|  +-----------------------+      +-----------------------+      +-------------------------------------+  |
|              |                              |                                                           |
|              v                              v                                                           |
|  +-----------------------+      +-----------------------+      +-------------------------------------+  |
|  | Social Agent Actor    |      | Trading Agent Actor   | ---> | Deterministic Compliance &          |  |
|  | (Narrative Synthesizer|      | (Risk & Orders)       |      | Preflight Gate                      |  |
|  +-----------------------+      +-----------------------+      +-------------------------------------+  |
|              |                              |                                                           |
|              +------------------------------+------------------------------------+                      |
|                                                                                  |                      |
|                                                                                  v                      |
|                                                                +-------------------------------------+  |
|                                                                | MCP Tool Registry & Execution       |  |
|                                                                +-------------------------------------+  |
+---------------------------------------------------------------------------------------------------------+
```

### Level 4: Code-Level Architecture Specification
- **`src/index.ts`:** Entrypoint router; maps HTTP routes to thin handlers, verifies JWT/I3A sessions, and dispatches async tasks to Queues.
- **`src/agents/`:** Encapsulates agent state machines (`ScreenerAgent`, `ResearchAgent`, `SocialAgent`, `TradingAgent`) implementing standardized `AgentInterface`.
- **`src/trading/`:** Core deterministic domain logic containing mathematical models for options pricing, Greeks calculations, indicator evaluations, and data provider adapters.
- **`src/workflows/`:** Workflow-engine definitions (current implementation: Cloudflare Workflows) executing multi-step long-running pipelines (e.g., Scheduled Screening -> PDF Generation -> Slack Delivery).
- **`src/durable/`:** Durable Object implementations (`SessionStore`, `AgentActorDO`, `TradeApprovalDO`).

---

## SECTION 6: Domain-Driven Design (DDD) Architecture

### Bounded Contexts & Context Map

```
+--------------------------------------------------------------------------------------------------+
|                                    CONTEXT MAP                                                   |
|                                                                                                  |
|  +--------------------------+       Customer-Supplier      +----------------------------------+  |
|  | Market Ingestion Context | ---------------------------> | Screener & Quant Context         |  |
|  +--------------------------+                              +----------------------------------+  |
|                                                                             |                    |
|                                                                             | Upstream-Downstream|
|                                                                             v                    |
|  +--------------------------+       Shared Kernel          +----------------------------------+  |
|  | Autonomous Execution Context | <----------------------- | Narrative & Social Context       |  |
|  +--------------------------+                              +----------------------------------+  |
|              ^                                                              |                    |
|              |                                                              | Anti-Corruption    |
|              +--------------------------------------------------------------+ Layer (ACL)        |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

### Domain Entities, Aggregates, and Value Objects

#### 1. Screener & Quant Bounded Context
- **Aggregates:** `ScreenerRunAggregate` (Root: `ScreenerRunId`).
- **Entities:** `ScreeningCandidate`, `OptionContract`, `TechnicalIndicatorSet`.
- **Value Objects:** `StrikePrice`, `ExpirationDate`, `DeltaGreeks`, `ImpliedVolatility`, `SqueezeState`.
- **Domain Events:** `ScreenerRunStarted`, `CandidateMatched`, `ScreenerRunCompleted`, `ScreenerRunFailed`.

#### 2. Autonomous Execution Bounded Context
- **Aggregates:** `TradeApprovalAggregate` (Root: `ApprovalId`).
- **Entities:** `OrderLeg`, `ExecutionRule`, `ComplianceCheckResult`.
- **Value Objects:** `OptionStrategyType`, `MaxLossLimit`, `PositionSizingRatio`, `OrderState`.
- **Domain Events:** `TradeProposed`, `RiskValidationPassed`, `HumanApprovalRequested`, `OrderExecuted`.

#### 3. Narrative & Social Bounded Context
- **Aggregates:** `SocialBriefAggregate` (Root: `BriefId`).
- **Entities:** `BriefDraft`, `DeliveryAttempt`.
- **Value Objects:** `MarkdownContent`, `TargetChannel`, `ApprovalStatus`.
- **Domain Events:** `BriefGenerated`, `BriefApproved`, `BriefPublished`.

---

## SECTION 7: Architectural Candidate Analysis

### Candidate Analysis: Asynchronous Processing Engine

- **Candidate A:** In-Memory Event Bus + Direct Async Function Calls (Current State).
- **Candidate B:** Workflow engine + durable queues (Target Recommendation; current implementation: Cloudflare Workflows + Cloudflare Queues).
- **Candidate C:** External Event Broker (Kafka / RabbitMQ / AWS SQS).

#### Evaluation Matrix

| Criteria | Candidate A | Candidate B | Candidate C |
| :--- | :---: | :---: | :---: |
| **Complexity** | Low | Low-Medium | High |
| **Scalability** | Low (Single Worker Limit) | Extremely High | Extremely High |
| **Reliability** | Low (Lost on Restart) | High (At-Least-Once Delivery) | High |
| **Cost** | Minimal | Low (Included in CF Plan) | High (Infra overhead) |
| **Maintainability** | Medium | High | Low |
| **Security** | Medium | High (CF Edge Isolation) | Medium (VPC/Auth Setup) |
| **Provider Coupling** | Yes | Tight (10/10) | None (0/10) |
| **Agentic Support** | Poor | Native Workflow Steps | Requires Connectors |

**Recommendation:** Proceed with **Candidate B (workflow engine + durable queues)**. Eliminates timeout vulnerabilities while preserving operational simplicity with the current implementation (Cloudflare Workflows + Queues).

---

## SECTION 8: Trade-Off Analysis (ATAM Methodology)

```
+-------------------------------------------------------------------------------------------------------+
| ARCHITECTURAL TRADE-OFF MATRIX (ATAM SUMMARY)                                                         |
+-------------------------------------+-----------------------------------+-----------------------------+
| Decision Topic                      | Key Trade-Off                     | Selected Target Choice      |
+-------------------------------------+-----------------------------------+-----------------------------+
| Edge Monolith vs. Decomposed Workers| Deployment Simplicity vs.         | Modular Monolith router     |
|                                     | Execution Isolation & Memory Caps | backed by workflow-engine steps |
+-------------------------------------+-----------------------------------+-----------------------------+
| Relational store vs. actor-runtime storage | SQL Queryability vs.              | Relational store for tabular history; actor runtime |
|                                     | Strong Consistency & Single-Key actor | for real-time agent actors  |
+-------------------------------------+-----------------------------------+-----------------------------+
| Vector DB vs. Graph + Vector        | Pure Similarity vs. Strategic     | Vector store + relational adjacency |
|                                     | Relationship Navigation           | Graph for Market Knowledge  |
+-------------------------------------+-----------------------------------+-----------------------------+
| External LLMs vs. embedded inference | Model Capacity (GPT-4o/Claude) vs.| Hybrid: embedded/fast inference |
|                                     | Zero Egress / LLM gateway         | + Gateway (Fallback; current implementation: Workers AI + AI Gateway) |
+-------------------------------------+-----------------------------------+-----------------------------+
```

---

## SECTION 9: Capability Mapping & Implementation Notes (current Cloudflare adapters)

> The table below maps capabilities to their current Cloudflare adapter implementations. The architecture is defined by the capabilities; providers are interchangeable adapters, and no domain code depends on any single provider.

| Capability (current Cloudflare implementation) | Current Status | Target Role & Transformation Plan |
| :--- | :--- | :--- |
| **Edge runtime (Workers)** | Monolithic HTTP Engine | Decoupled Router & Stateless Execution Endpoints |
| **Stateful actors (Durable Objects)** | Sessions & Social Drafts | Core Stateful Actor Primitives for Agents (`AgentActorDO`) |
| **Workflow orchestration (Workflows)** | Unused | Primary Orchestration Engine for Long-Running Screener Runs |
| **Async messaging (Queues)** | Unused | Asynchronous Event Bus (`market-data-q`, `social-deliveries-q`) |
| **Relational ledger (D1)** | Relational DB | Transactional Execution & Audit Ledger (`cfagent-db`) |
| **Blob storage (R2)** | Artifact Storage | Immutable Storage for PDF/XLSX Reports & Market Snapshots |
| **Semantic knowledge (Vectorize)** | Basic Search | Semantic Knowledge Index (`reports-index`) for RAG & Agent Memory |
| **LLM gateway (AI Gateway)** | Partial Usage | Unified Observability, Fallback, & Rate-Limiting for LLM Calls |
| **Embedded inference (Workers AI)** | Primary Inference | Real-time fast inference (Llama 3.3, BGE Embeddings) |
| **Agent SDK port (Agents SDK)** | Unused | Migration Target for Standardized Agent Memory & Tool Execution |
| **Telemetry (Analytics Engine)**| Unused | Telemetry, Quant Execution Performance, & RSI Metric Tracking |

---

## SECTION 10: Solution Architecture (Target Architecture State)

```
                                +-------------------------------------------+
                                |        Target Architecture (capability view) |
                                +-------------------------------------------+
                                                      |
            +-----------------------------------------+-----------------------------------------+
            |                                         |                                         |
            v                                         v                                         v
+-----------------------+                 +-----------------------+                 +-----------------------+
|   HTTP/API Gateway    |                 | Workflow Engine     |                 | Async Event Pipeline  |
|   (Stateless Router)  |                 | Orchestration Engine  |                 | Async Event Pipeline  |
+-----------------------+                 +-----------------------+                 +-----------------------+
            |                                         |                                         |
            +-----------------------------------------+-----------------------------------------+
                                                      |
                                                      v
                                +-------------------------------------------+
                                | Agent SDK & Actor Runtime                 |
                                | (Screener, Research, Social, Trading DOs) |
                                +-------------------------------------------+
                                                      |
            +-----------------------------------------+-----------------------------------------+
            |                                         |                                         |
            v                                         v                                         v
+-----------------------+                 +-----------------------+                 +-----------------------+
|  Relational Ledger    |                 | Vector + Blob Store |                 | LLM Inference & Gateway |

> Capability labels above are the architecture. Current adapter implementations: Cloudflare Workflows (workflow engine), Queues (async event pipeline), Agents SDK & Durable Objects (agent SDK & actor runtime), D1 (relational ledger), Vectorize + R2 (vector + blob store), Workers AI & AI Gateway (LLM inference & gateway).
|  (State & History)    |                 | (Semantic Knowledge)  |                 | (LLM & Embeddings)    |
+-----------------------+                 +-----------------------+                 +-----------------------+
```

---

## SECTION 11: Architecture Standards Catalog

### 1. Code & Module Standards
- Strict TypeScript (`tsc --strict`) with zero implicit `any`.
- Functional purity for mathematical algorithms (`src/trading/calculators/`).
- No direct external network calls outside designated Data Provider interfaces.

### 2. API & MCP Standards
- All endpoints must be documented via OpenAPI v3 spec (`/openapi.json`).
- Agent tools must expose typed Zod schemas adhering to Model Context Protocol (MCP).
- Standardized Error Format (`BUSINESS_ERROR_CODES` with UI-friendly remediation).

### 3. Event & Messaging Standards
- Event envelopes must include: `eventId`, `eventType`, `timestamp`, `correlationId`, `producer`, `payload`.
- Idempotency keys mandatory for all Queue consumption steps.

---

## SECTION 12: Architectural Decision Records (ADRs)

### ADR-0003: Adoption of Cloudflare Workflows for Long-Running Screener Pipelines
- **Status:** Approved
- **Context:** Market screening across full equities/options universes frequently exceeds Worker wall-clock limits and HTTP timeout windows.
- **Decision:** Migrate all multi-step screening runs from synchronous Workers to Cloudflare Workflows with explicit step retries and checkpoints.
- **Consequences:** Eliminates request timeouts, enforces deterministic retry states, enables multi-hour async executions.
> Annotation (2026-10-26, cloud-agnostic restatement, issue #1795): this decision selects a Cloudflare product as the current adapter implementation for the capability port named above. It does not make the architecture dependent on that provider; the capability is defined by the port, and the implementation is replaceable behind it. The decision itself is recorded unchanged.

### ADR-0004: Standardizing Agent State Machines on Durable Objects & Agents SDK
- **Status:** Approved
- **Context:** Procedural agent classes lack persistent long-term memory, real-time message coordination, and state isolation.
- **Decision:** Wrap every agent domain in a stateful Durable Object implementing the Cloudflare Agents SDK framework.
- **Consequences:** Enables persistent agent memory, WebSocket streaming, stateful tool orchestration, and actor-isolated security bounds.
> Annotation (2026-10-26, cloud-agnostic restatement, issue #1795): this decision selects a Cloudflare product as the current adapter implementation for the capability port named above. It does not make the architecture dependent on that provider; the capability is defined by the port, and the implementation is replaceable behind it. The decision itself is recorded unchanged.

### ADR-0005: Hybrid RAG Knowledge Engine via Vectorize and D1 Adjacency Graphs
- **Status:** Approved
- **Context:** Vector search alone lacks structural awareness of market relationships (e.g., Sector -> Industry -> Ticker -> Option Chain).
- **Decision:** Pair Cloudflare Vectorize embeddings with D1 relational graph tables to construct a hybrid RAG knowledge engine.
- **Consequences:** Significantly improves context retrieval accuracy for market research and strategy synthesis.
> Annotation (2026-10-26, cloud-agnostic restatement, issue #1795): this decision selects a Cloudflare product as the current adapter implementation for the capability port named above. It does not make the architecture dependent on that provider; the capability is defined by the port, and the implementation is replaceable behind it. The decision itself is recorded unchanged.

---

## SECTION 13: Non-Functional Requirements (NFRs) Benchmark

| Metric Dimension | Target Standard | SLA / Threshold | Enforcement Mechanism |
| :--- | :--- | :--- | :--- |
| **Read Availability** | 99.95% | Edge multi-region failover | Global anycast (current implementation: Cloudflare) |
| **API Latency (p95)** | < 200ms | Ephemeral KV quote caching | Ephemeral Read Cache |
| **Screener Pipeline Execution**| 100% Retriable | Max 3 retries per step | Workflow engine (current implementation: Cloudflare Workflows) |
| **Data Integrity** | Zero Event Loss | At-least-once Queue delivery | Durable queues (current implementation: Cloudflare Queues) |
| **Security Gate** | 100% HITL Approval | Trade order execution gate | Crypto-Signed TradeDO |
| **LLM Gateway Reliability** | 99.9% Up-time | Multi-provider fallback | LLM gateway (current implementation: Cloudflare AI Gateway) |

---

## SECTION 14: Security & Compliance Architecture

```
                                  +---------------------------------------+
                                  | Zero Trust IAAA Security Architecture |
                                  +---------------------------------------+
                                                      |
         +-------------------+------------------------+-----------------------+-------------------+
         |                   |                        |                       |                   |
  +--------------+    +--------------+         +--------------+        +--------------+    +--------------+
  | Identity     |    | Authn        |         | Authz        |        | Audit        |    | Protection   |
  | Derived      |    | OAuth 2.0 PKCE|        | RBAC &       |        | Cryptographic|    | WAF, SSRF,   |
  | Stable ID    |    | + Slack HMAC |         | Agent Bounds |        | D1 Ledger    |    | Rate Limits  |
  +--------------+    +--------------+         +--------------+        +--------------+    +--------------+
```

### Security Maturity Assessment
- **Current Security Level:** Level 3 (Defined & Guarded). Enforces Zero Trust access, HMAC verification, and secure secret handling via the platform secret store (current implementation: Cloudflare Secrets).
- **Target Security Level:** Level 5 (Optimized & Autonomous). Introduces cryptographic proof-of-execution ledgers, fine-grained agent tool permissioning, and dynamic prompt injection firewalls via the LLM gateway.

---

## SECTION 15: Operational Architecture & SRE Controls

- **CI/CD Pipeline:** Automated GitHub Actions with strict policy gates, pre-merge verification (`scripts/verify-before-merge.sh`), and linting.
- **Observability Stack:** OpenTelemetry tracing via the analytics engine (current implementation: Workers Analytics Engine), centralized aspect-oriented logging (`[Aspect]`), structured JSON metrics.
- **Disaster Recovery:** Automated relational-store daily backups, multi-region worker failover, immutable blob artifact retention (current implementations: D1, Cloudflare Workers, R2).
- **Chaos & Resilience:** Injected fault testing for external market providers (e.g., simulated 429 rate limits, 503 service outages) verified via Vitest suites.

---

## SECTION 16: Agentic Architecture & Recursive Self-Improvement (RSI)

```
+---------------------------------------------------------------------------------------------------------+
| AGENTIC RECURSIVE SELF-IMPROVEMENT (RSI) ENGINE                                                         |
|                                                                                                         |
|  +-----------------------+      +-----------------------+      +-------------------------------------+  |
|  | Task Execution Engine | ---> | Telemetry & Outcome   | ---> | Calibration & Evaluation Engine     |  |
|  | (Agent Actors)        |      | Collector             |      | (Backtesting vs Realized Outcome)   |  |
|  +-----------------------+      +-----------------------+      +-------------------------------------+  |
|              ^                                                                    |                     |
|              |                  +-----------------------+                         |                     |
|              +----------------- | Dynamic Prompt & Tool | <-----------------------+                     |
|                                 | Calibration Layer     |                                               |
|                                 +-----------------------+                                               |
+---------------------------------------------------------------------------------------------------------+
```

### RSI Engine Mechanics
1. **Outcome Telemetry:** Every trade recommendation or screening signal is tracked against market realization over a 5-day / 30-day horizon.
2. **Calibration Evaluation:** The Calibration Engine computes hit rates, Sharpe ratios, and thesis accuracy scores per strategy family.
3. **Dynamic Prompt & Weight Optimization:** Calibration scores are automatically fed back into prompt templates and indicator weight matrices without requiring code redeployments.

---

## SECTION 17: Multi-Year Architecture Roadmap

```
+---------------------------------------------------------------------------------------------------------+
| MULTI-YEAR TRANSFORMATION ROADMAP                                                                        |
+----------------------+----------------------------------------------------------+-----------------------+
| Phase                | Key Initiatives & Milestones                             | Timeline              |
+----------------------+----------------------------------------------------------+-----------------------+
| Phase 1: Foundation  | Decouple Worker Monolith via workflow engines &        | Months 0 - 3          |
|                      | Queues. Eliminate synchronous API bottleneck timeouts.   |                       |
+----------------------+----------------------------------------------------------+-----------------------+
| Phase 2: Agent Actors| Migrate Agents to the agent SDK port & actor runtime     | Months 3 - 6          |
|                      | Objects. Implement typed MCP tool boundaries.            |                       |
+----------------------+----------------------------------------------------------+-----------------------+
| Phase 3: RAG Knowledge| Deploy vector + relational hybrid knowledge graph. Deploy | Months 6 - 12         |
|                      | LLM-gateway fallback mechanisms across LLM models.        |                       |
+----------------------+----------------------------------------------------------+-----------------------+
| Phase 4: RSI Engine  | Implement autonomous calibration feedback loops, automated| Months 12 - 24        |
|                      | backtesting, and dynamic prompt optimization.            |                       |
+----------------------+----------------------------------------------------------+-----------------------+
| Phase 5: Autonomous  | Enable multi-agent swarm negotiation, cross-tenant agent | Months 24 - 36        |
|                      | marketplace, and zero-touch quantitative strategy research|                       |
+----------------------+----------------------------------------------------------+-----------------------+
```

---

## SECTION 18: Architecture Heat Maps

### Risk & Debt Heat Map

| Architectural Subsystem | Technical Debt | Security Risk | Scalability Risk | Provider-Agnostic Alignment | RSI Readiness |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **HTTP Routing Engine** | HIGH | LOW | MEDIUM | HIGH | LOW |
| **Market Ingestion Providers**| HIGH | MEDIUM | HIGH | MEDIUM | LOW |
| **Screener Quant Engine** | MEDIUM | LOW | HIGH | HIGH | MEDIUM |
| **PDF / Asset Synthesizer**| LOW | LOW | MEDIUM | HIGH | LOW |
| **Agent State Orchestration**| HIGH | MEDIUM | HIGH | LOW | LOW |
| **Trade Execution & Guardrails**| LOW | HIGH | LOW | HIGH | LOW |
| **Storage & Memory Layer** | MEDIUM | LOW | MEDIUM | MEDIUM | MEDIUM |

---

## SECTION 19: Final Strategic Recommendations & Target Component Action Plan

### Core Component Retention / Replacement Blueprint

To transform `cfagent` into an enterprise-grade cloud-native, cloud-agnostic RSI agent platform, existing codebase components are evaluated and categorized into specific architectural actions:

```
+---------------------------------------------------------------------------------------------------------+
| COMPONENT ACTION MATRIX                                                                                 |
+-----------------------------------+--------------------+------------------------------------------------+
| Component                         | Action             | Target Architectural State                     |
+-----------------------------------+--------------------+------------------------------------------------+
| `src/index.ts` Router             | Decompose          | Extract synchronous pipelines into workflow-engine steps |
| `src/agents/ScreenerAgent.ts`     | Replace / Refactor | Wrap into an actor-based `ScreenerAgent` via the agent SDK port |
| `src/agents/ResearchAgent.ts`     | Refactor           | Integrate with vector store + LLM search (current implementations: Vectorize + Workers AI Search) |
| `src/agents/SocialAgent.ts`       | Retain             | Preserve drafting logic, bind to Queues delivery|
| `src/agents/TradingAgent.ts`      | Retain             | Retain hard-coded compliance & HITL guardrails |
| In-Memory `ScreenerEventBus`      | Eliminate          | Replace completely with durable queues (current implementation: Cloudflare Queues) |
| Ephemeral Market Cache (`KV`)     | Retain / Refactor | Formalize 5-min TTL with circuit breakers      |
| `SessionStore` Durable Object     | Retain             | Maintain secure session state management       |
| D1 Execution Tables               | Merge              | Consolidate fragmented schemas into `cfagent-db`|
+-----------------------------------+--------------------+------------------------------------------------+
```

### Top 10 High-Impact Initiatives

1. **Immediate Decoupling of Screener Executions:** Convert synchronous screening routes to async workflow-engine steps (current implementation: Cloudflare Workflows) triggered by background events.
2. **Standardization on the agent SDK port:** Refactor procedural agent classes into actor-based agents (current implementation: Cloudflare Agents SDK, `AgentActorDO`).
3. **Queue-Backed Messaging Pipeline:** Replace in-memory event buses with durable queues (current implementation: Cloudflare Queues) for guaranteed delivery.
4. **Hybrid RAG Knowledge Deployment:** Combine vector-store embeddings with relational market adjacency graphs (current implementations: Vectorize + D1) for agent contextual retrieval.
5. **LLM Gateway Fallback Integration:** Route all LLM inference calls through the LLM gateway (current implementation: Cloudflare AI Gateway) for rate limiting, caching, and multi-provider failover.
6. **RSI Telemetry & Calibration Engine:** Deploy automated thesis realization tracking in the relational ledger (current implementation: D1) to dynamically calibrate agent prompts.
7. **Aspect-Oriented Observability:** Expand structured logging to stream directly into the analytics engine (current implementation: Cloudflare Analytics Engine).
8. **Granular MCP Tool Permissions:** Enforce cryptographic isolation and permission scopes on all agent tool executions.
9. **Automated Market Data Circuit Breakers:** Wrap external market APIs (Yahoo, Nasdaq, E*TRADE) in resilient retry policies with instant fallback states.
10. **Zero-Downtime Migration Testing:** Maintain 100% test suite parity (`npm run check`) across all architectural refactor steps.

---

**Board Approval Signature:**
*Software Architecture Review Board (SARB)*
*Cloudflare Agent Platform Engineering Guild*
