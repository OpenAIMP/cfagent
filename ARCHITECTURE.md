# Multi-Agent Studio Architecture Map & Design System

This document outlines the architectural map, major subsystem boundaries, data flows, and design pattern applications across the repository.

---

## 1. High-Level Subsystem Architecture

```
                               ┌───────────────────────────────────────────────┐
                               │  Browser UI (React 19 + Vite) / External Clients │
                               └──────────────────────┬────────────────────────┘
                                                      │
                                    HTTP / REST / WebSocket / JSON-RPC 2.0
                                                      │
                                                      ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Cloudflare Worker Entry Point (`src/server.ts`)                                                        │
 │  ├── /auth/* ──► GitHub OAuth 2.0 Flow                                                                 │
 │  ├── /checkout/sandbox ──► Payment Terminal Simulation                                                 │
 │  ├── /mcp & /api/mcp ──► MCP JSON-RPC Proxy                                                            │
 │  └── /api/* ──► Forwarded Durable Object Route                                                         │
 └────────────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                                      │
                                                      ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ OrchestratorAgent Durable Object (`src/agents/orchestrator.ts`)                                       │
 │  ├── LLMJudge (`src/agents/judge.ts`): Intent Classification & Response Safety/Quality Evaluation       │
 │  ├── Vercel AI SDK Agent Stream (`streamText`): Cloudflare Workers AI Model                             │
 │  ├── McpSystemFacade (`src/patterns/facade.ts`): Unified Subsystem Access                               │
 │  ├── McpAgentToolAdapter (`src/agents/mcpAdapter.ts`): Adapts MCP Commands into Agent Tools              │
 │  └── AuditEventPublisher (`src/patterns/observer.ts`): Event Stream & Observers                         │
 └────────────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                                      │
                                                      ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Subsystems & Design Pattern Execution Layers                                                          │
 │                                                                                                        │
 │  ┌─────────────────────────────────┐   ┌────────────────────────────────┐   ┌───────────────────────┐ │
 │  │ DatabaseORM (`src/orm/index.ts`) │   │ MCP Server (`src/mcp/`)        │   │ Domain Services       │ │
 │  │ ├── Repository<T> Pattern       │   │ ├── McpToolFactory             │   │ ├── PaymentGateway    │ │
 │  │ ├── 9 Relational Tables        │   │ ├── JSON-RPC 2.0 Protocol      │   │ ├── ETradeService     │ │
 │  │ └── Revenue Analytics           │   │ └── Resources & Prompts        │   │ └── FossResearchService│ │
 │  └─────────────────────────────────┘   └────────────────────────────────┘   └───────────────────────┘ │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Relational Database & ORM Mapping (`src/orm/index.ts`)

| Table Name | Entity Type | Primary Key | Description |
|---|---|---|---|
| `mas_categories` | `CategoryRecord` | `id` | Partner link taxonomy and referral category ordering |
| `mas_referrals` | `ReferralRecord` | `id` | User affiliate and referral links with click attribution |
| `mas_ads` | `AdRecord` | `id` | Sponsored marketplace offers and featured promotions |
| `mas_external_ads` | `ExternalAdRecord` | `id` | Ad network placements (EthicalAds, Carbon, Direct) with CPM/CPC revenue tracking |
| `mas_transactions` | `TransactionRecord` | `id` | Ledger for payments, drafts, and W3C Agent DID cryptographic signatures |
| `mas_messages` | `MessageRecord` | `id` | Transcripts of conversation turns and agent responses |
| `mas_memory` | `MemoryRecord` | `key` | Key-value store for session facts and user preferences |
| `mas_events` | `AuditEvent` | `id` | Real-time audit events for router decisions and security logs |
| `mas_trades` | `TradeRecord` | `id` | E*TRADE brokerage orders with DID attestation and broker execution references |

---

## 3. Design Principles & Pattern Applications

### Gang of Four (GoF) Design Patterns

1. **Command Pattern (`IMcpToolCommand`)**:
   - *Location*: `src/patterns/interfaces.ts`, `src/mcp/commands.ts`, `src/mcp/etradeCommands.ts`, `src/mcp/fossCommands.ts`.
   - *Rationale*: Every system capability is encapsulated as an executable command class with JSON/Zod schemas, input validation, and context handling.

2. **Factory Pattern (`McpToolFactory`, `PaymentStrategyFactory`)**:
   - *Location*: `src/mcp/commands.ts`, `src/patterns/paymentStrategies.ts`.
   - *Rationale*: Centralizes creation and dispatch of tools and payment strategy providers, satisfying the Open/Closed Principle.

3. **Strategy Pattern (`IPaymentGatewayStrategy`, `IFossMarketDataProvider`)**:
   - *Location*: `src/patterns/paymentStrategies.ts`, `src/services/fossResearch.ts`.
   - *Rationale*: Encapsulates payment provider processing algorithms (Stripe, PayPal, Lemon Squeezy, Sandbox) and market data providers (Yahoo Finance, Alpaca, Hybrid).

4. **Adapter Pattern (`McpAgentToolAdapter`)**:
   - *Location*: `src/agents/mcpAdapter.ts`.
   - *Rationale*: Adapts protocol-agnostic `IMcpToolCommand` instances into Vercel AI SDK `tool()` instances so internal agents dogfood the exact same capabilities as external MCP clients.

5. **Facade Pattern (`McpSystemFacade`)**:
   - *Location*: `src/patterns/facade.ts`.
   - *Rationale*: Provides a unified, high-level interface coordinating ORM queries, NLQ execution, payment checkouts, DID attestations, and audit publishing.

6. **Observer Pattern (`IAuditPublisher`, `IAuditObserver`)**:
   - *Location*: `src/patterns/observer.ts`.
   - *Rationale*: Decouples audit log generation from downstream persistence sinks (SQLite `SqliteAuditObserver`, telemetry `TelemetryAuditObserver`).

### SOLID & GRASP Principles

- **Single Responsibility Principle (SRP)**: Each command, repository, and strategy handles a single cohesive domain responsibility.
- **Open/Closed Principle (OCP)**: New tools register into `McpToolFactory` and new gateways into `PaymentStrategyFactory` without modifying core routing logic.
- **Liskov Substitution Principle (LSP)**: Any `IMcpToolCommand` or `IPaymentGatewayStrategy` can be substituted polymorphically.
- **Interface Segregation Principle (ISP)**: Focused interfaces (`IMcpToolCommand`, `IPaymentGatewayStrategy`, `IAuditObserver`) prevent monolithic contracts.
- **Dependency Inversion Principle (DIP)**: High-level modules depend on abstractions (`IMcpSystemFacade`, `IFossMarketDataProvider`, `IPaymentGatewayStrategy`).
- **GRASP Information Expert**: `DatabaseORM` calculates platform revenue summaries, and `ETradeService` calculates order previews and technical indicators.
- **GRASP Pure Fabrication & Indirection**: `McpAgentToolAdapter` mediates between the AI agent framework and the MCP command execution engine.
- **GRASP Protected Variations**: Stable contracts (`IMcpToolCommand`) shield the LLM agents from underlying database or API changes.
