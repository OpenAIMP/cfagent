# Platform Decoupling, Agnosticism, Native Capabilities & Governance Blueprint
**Target Platform:** `cfagent` (Multi-Agent Financial Research & Screening Platform)
**Document Reference:** `docs/architecture/enterprise/assessment/platform-decoupling-and-native-roadmap.md`
**Status:** Comprehensive Architecture Assessment & Strategy Blueprint

---

## Executive Summary

This document defines the architectural blueprint and transformation roadmap required to transition `cfagent` from an edge-specific Cloudflare application into a completely **cloud-agnostic**, **technology-agnostic**, **framework-agnostic**, and **natively extensible** enterprise multi-agent platform.

By applying **Hexagonal Architecture (Ports and Adapters)**, `cfagent` decouples core business logic, agent orchestration, financial calculations, and LLM reasoning from any underlying cloud vendor runtime (Cloudflare Workers, GCP Cloud Run, AWS Lambda, Azure Container Apps, or On-Premises Kubernetes).

```
                      +-------------------------------------------------+
                      |           HEXAGONAL CORE (PORTABLE)             |
                      |  - Multi-Agent Orchestrator (mas.ts)             |
                      |  - Options Strategy Engine (strategyEngine.ts)  |
                      |  - LLM Judge & Intent Router (judge.ts)         |
                      |  - NLQ Analytics Engine (nlq.ts)               |
                      +-------------------------------------------------+
                                               |
         +-------------------------------------+-------------------------------------+
         |                                     |                                     |
         v                                     v                                     v
+------------------+                 +--------------------+                 +------------------+
| Cloudflare Port  |                 |     GCP Port       |                 |     AWS Port     |
| (Workers, DO,    |                 | (Cloud Run,        |                 | (Lambda, ECS,    |
| Workers AI, R2)  |                 | Vertex, Spanner)   |                 | Bedrock, S3)     |
+------------------+                 +--------------------+                 +------------------+
```

---

## 1. Platform Agnosticism Blueprint

### 1.1 Cloud Agnosticism
To run `cfagent` on **Google Cloud Platform (GCP)**, **Amazon Web Services (AWS)**, **Microsoft Azure**, or **On-Premises Kubernetes (K8s)** without modifying core application logic, all platform interactions are abstracted behind unified Ports:

| System Subsystem | Cloudflare Binding (Current) | GCP Adapter (Target) | AWS Adapter (Target) | Generic Container / K8s |
|---|---|---|---|---|
| **Compute Execution** | Cloudflare Worker / DO | Cloud Run / Cloud Functions | AWS Lambda / ECS Fargate | Express / Fastify in Docker |
| **State & Persistence** | DO SQLite (`ctx.storage.sql`) | Cloud Spanner / Cloud SQL | DynamoDB / Aurora Postgres | PostgreSQL / SQLite (Volume) |
| **LLM Inference** | Workers AI (`@cf/glm-4.7-flash`) | Vertex AI (Gemini 1.5 Pro/Flash) | Amazon Bedrock (Claude / Llama) | Ollama / vLLM |
| **Vector Index** | Vectorize (`VECTOR_MEMORY`) | Vertex AI Search & Vector Search | Amazon OpenSearch Serverless | pgvector / Qdrant / Milvus |
| **Object Storage** | R2 (`REPORTS_BUCKET`) | Google Cloud Storage (GCS) | AWS S3 | MinIO / Local FS |
| **Cache & Sessions** | DO / KV | Cloud Memorystore (Redis) | ElastiCache (Redis) | Redis / KeyDB |

### 1.2 Technology & Database Agnosticism
Persistence is managed via a unified `DatabaseAdapter` interface:

```typescript
export interface DatabaseAdapter {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T>;
}
```

Implementations exist for:
- `DOSqliteAdapter`: Uses Cloudflare Durable Object `ctx.storage.sql`.
- `PostgresAdapter`: Uses `pg` / `node-postgres` or Cloud SQL / Aurora PostgreSQL.
- `SpannerAdapter`: Uses GCP Cloud Spanner client library.
- `DynamoDBAdapter`: Uses AWS DynamoDB Document Client.

### 1.3 Framework & Runtime Agnosticism
The HTTP and WebSocket routing tier uses Web Standard `Request` and `Response` objects (Hono / Fetch standard).
- **Cloudflare Runtime:** `export default { fetch: app.fetch }`
- **Node.js / Express / Fastify:** `@hono/node-server` bridge.
- **AWS Lambda:** `hono/aws-lambda` handler.
- **GCP Cloud Run:** Containerized Node.js execution listening on `PORT`.

---

## 2. Native Capabilities Framework

### 2.1 AI-Native
- **LLM Judge & Router:** Automatic intent classification, prompt evaluation, and real-time response quality judging (`src/agents/judge.ts`).
- **Semantic Prompt Guardrails:** Pre-execution input validation preventing jailbreaks, PII leakage, and off-topic prompts.
- **Semantic Caching:** High-speed vector caching of frequent financial screening queries to eliminate redundant LLM calls.
- **Fallback Chains:** Multi-provider LLM failover (e.g., Workers AI $\rightarrow$ OpenAI $\rightarrow$ Vertex AI $\rightarrow$ Ollama).

### 2.2 API-Native
- **OpenAPI 3.1 Auto-Generation:** Schema-first design where routes automatically generate interactive Swagger/OpenAPI documentation.
- **Unified JSON Error Envelope:** Standardized error response structure across all endpoints (`{ success: false, error: { code, message, details } }`).
- **Idempotency & Rate-Limiting:** Request deduplication via `X-Idempotency-Key` headers and token bucket rate limiters.
- **Async Webhook Engine:** Real-time outbound HMAC-SHA256 signed event delivery to external client webhooks.

### 2.3 MCP-Native (Model Context Protocol)
`cfagent` natively implements the Model Context Protocol (MCP) standard:
- **MCP Tools:** Exposes options screening, stock research, payment drafting, and memory vault functions as MCP tools.
- **MCP Transports:** Supports Server-Sent Events (SSE), HTTP POST stream, and Stdio transports.
- **Client Compatibility:** Enables seamless zero-code integration with Claude Desktop, Cursor IDE, ChatGPT Custom GPTs, and autonomous LangChain/LlamaIndex agents.

### 2.4 Agentic-Native
- **Goal-Driven Autopilot:** Background cron workers (`ScheduledAgent`) that execute multi-step market scanning goals autonomously.
- **Multi-Agent Consensus:** Multi-agent voting protocols for high-stakes trading proposals before presenting recommendations to human supervisors.
- **Outcome Ledger & RSI:** Tracks real-world trade thesis performance in `mas_outcomes` and uses Recursive Self-Improvement (RSI) feedback loops to re-weight screening heuristics.

### 2.5 Data-Native
- **Event Sourcing:** All system mutations recorded as immutable domain events in the `mas_events` audit table.
- **Real-Time Streaming:** Sub-second streaming of agent reasoning, market data ticks, and screening logs over WebSockets and SSE.
- **Data Lineage:** Full tracking of market data origin (Yahoo, E*TRADE, NASDAQ) attached to every screening result and PDF report.

---

## 3. Governance Architecture

```
+-----------------------------------------------------------------------------------+
|                              GOVERNANCE TIER                                      |
+-----------------------------------------------------------------------------------+
|  1. AI GOVERNANCE: Input Moderation -> LLM Judge Evals -> Hallucination Check     |
|  2. DATA GOVERNANCE: Zero-Trust Isolation -> Automated Retention -> GDPR Erasure  |
|  3. APP & SECURITY GOVERNANCE: Session Gate #329 -> IAAA PDP -> Constant HMAC     |
|  4. COMPLIANCE GOVERNANCE: Non-Advisory Disclaimers -> Immutable Audit Logs      |
+-----------------------------------------------------------------------------------+
```

### 3.1 AI Governance
- **Safety Guardrails:** Real-time input toxicity and prompt-injection filtering.
- **LLM Judge Evaluation:** Automated scoring ($0.0 - 1.0$) of agent responses against accuracy, helpfulness, and safety metrics.
- **Deterministic Audit Trails:** System logs exact model identifiers, temperature, seed, and raw prompts for all generated research reports.

### 3.2 Data Governance
- **Zero-Trust Tenant Isolation:** Tenant data separated by strict namespace prefixes and isolated database schemas.
- **Automated Retention Passes:** Scheduled nightly cleanup passes (`mas_messages` retention) purging stale ephemeral data.
- **GDPR / CCPA Erasure:** Dedicated user deletion endpoints (`DELETE /api/memory/user`) enforcing the right-to-be-forgotten.

### 3.3 Application & Security Governance
- **Session Gate #329:** Strict session cookie validation gating all REST and WebSocket connections.
- **IAAA Policy Decision Point (PDP):** Role-Based and Attribute-Based Access Control (RBAC/ABAC) validating user permissions before executing sensitive operations.
- **Constant-Time HMAC Verification:** Replay-protected OAuth state and webhook payload verification.

### 3.4 Regulatory & Compliance Governance
- **Financial Disclaimers:** Mandatory non-advisory headers affixed to all screening outputs, PDF reports, and Slack alerts.
- **Immutable Event Audit:** Event bus logging all state mutations to append-only storage.

---

## 4. Platform Improvement & Optimization Blueprint

### 4.1 Subrequest Budget Management
- **Problem:** Edge runtimes enforce strict limits on subrequests per invocation (e.g., Cloudflare Workers 50-subrequest ceiling).
- **Optimization:** Implement 5-minute TTL Quote Caches, batch market data request bundling, and async DAG stage sharding (`shardJobs.ts`).

### 4.2 Observability & Distributed Tracing
- **OpenTelemetry Integration:** Propagate `traceparent` headers across Worker invocations, Durable Objects, and external market API calls.
- **Structured Error Taxonomy:** Standardize machine-readable error codes (e.g., `ERR_SUBREQUEST_BUDGET_EXCEEDED`, `ERR_BROKER_OAUTH_EXPIRED`, `ERR_RATE_LIMIT_EXCEEDED`).

### 4.3 Resilience & Fault Tolerance
- **Circuit Breakers:** Automatic circuit breaking on failing external APIs (e.g., E*TRADE outage gracefully degrading to Yahoo Finance fallback).
- **Exponential Backoff & Jitter:** Adaptive retry policies on transient network errors.

---

## 5. Decoupling Blueprint: Zero-Modification Cloud Deployment

To deploy `cfagent` on **Google Cloud Platform (GCP)** or **Amazon Web Services (AWS)** without changing platform code, construct the Hexagonal Adapter layer:

```
src/
├── adapters/
│   ├── cloud/
│   │   ├── CloudflareAdapter.ts
│   │   ├── GCPAdapter.ts
│   │   ├── AWSAdapter.ts
│   │   └── DockerAdapter.ts
│   ├── ai/
│   │   ├── WorkersAIAdapter.ts
│   │   ├── VertexAIAdapter.ts
│   │   ├── BedrockAdapter.ts
│   │   └── OpenAIAdapter.ts
│   ├── db/
│   │   ├── DOSqliteAdapter.ts
│   │   ├── PostgresAdapter.ts
│   │   └── SpannerAdapter.ts
│   └── storage/
│       ├── R2Adapter.ts
│       ├── GCSAdapter.ts
│       └── S3Adapter.ts
```

### GCP Cloud Run Step-by-Step Execution Blueprint
1. **Containerize:** Build Docker image using Node.js 22 LTS base image.
2. **Inject Env Adapters:** Set `PLATFORM_ADAPTER=GCP`, `DATABASE_PROVIDER=SPANNER`, `AI_PROVIDER=VERTEX_AI`, `STORAGE_PROVIDER=GCS`.
3. **Deploy:** Deploy container to Google Cloud Run with Cloud SQL / Spanner connection string.
4. **Zero Code Changes:** The core orchestrator, screening engine, and multi-agent tools run identically without modifying a single line of business logic.
