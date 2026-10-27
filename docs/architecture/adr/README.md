# Architecture Decision Records

Decisions that are hard to reverse or cross-cutting live here, one file
per decision, so the reasoning survives the issue thread that made it.
See `gitops.md` §5 ("Architecture decision records") for when an ADR
is required: a PR MUST create or update one when it makes such a
decision or overturns a recorded one. Routine slices, bug fixes,
docs-only conforming edits, and configuration changes do not need one.

Rules: ADRs are never deleted or rewritten. A changed decision gets a
new ADR that supersedes the old one, and the old ADR's Status is
updated to superseded with a pointer. The issue that makes the decision
references the ADR; the ADR references the issue and the implementing
PR.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-derived-stable-identity.md) | Derived stable identity from (issuer, subject) | Accepted |
| [0002](0002-data-foundation-layer.md) | Data foundation layer: port-first, Drizzle ORM, D1 as one adapter | Accepted |
| [0003](0003-messaging-port.md) | Queue-backed messaging: port-first, provider adapter + in-memory adapter | Accepted |
| [0004](0004-ux-token-architecture-no-exemptions.md) | UX token architecture compliance is mandatory — no exemptions | Accepted |
| [0005](0005-actor-port.md) | Agents SDK actors: actor port and AgentActorDO pattern | Accepted |
| [0006](0006-cloudflare-feature-flags.md) | Cloudflare feature flags: port-first architecture with Flagship adapter and fail-closed fallbacks | Accepted |
| [0007](0007-hybrid-rag.md) | Hybrid RAG: Vectorize embeddings + D1 market adjacency graphs | Accepted |
| [0008](0008-market-data-circuit-breakers.md) | Market data circuit breakers: port-first breaker Decorator over provider calls | Accepted |
| [0009](0009-telemetry-calibration.md) | RSI telemetry & calibration engine in D1: falsification-gated, governed prompt notes | Accepted |
| [0010](0010-llm-gateway-port.md) | LLM gateway port: AI Gateway fallback integration (rate limiting, caching, multi-provider failover) | Accepted |
| [0011](0011-observability-analytics-engine.md) | Aspect-oriented observability to Analytics Engine: Foundation-layer port (logging/tracing/metrics/correlation), W3C traceparent, whitelist envelope folding | Accepted |
| [0012](0012-mcp-tool-permissions.md) | MCP tool permissions: per-tool scopes + cryptographic execution isolation, port-first gate at every choke point (factory, JSON-RPC queued path, agent-turn adapter) | Accepted |
| [0013](0013-test-parity-harness.md) | Test-parity harness: baseline snapshots, behavior comparison, per-PR checklist (capture/compare/checklist/check/report) | Accepted |
| [0014](0014-chain-native-promotion-authority.md) | Chain-native promotion authority (#1747 branch 2): Phase 3 approval + registry verification + staged rollout replaces #759 verdicts for chains; supersedes #1468 reconciliation for chains only | Accepted |

## Template

```markdown
# NNNN. Short title

- Status: proposed | accepted | superseded by NNNN | deprecated
- Date: YYYY-MM-DD
- Deciders: (owner, agent, reviewers)
- Issue: #NNNN
- Implementing PR: #NNNN (main commit, when merged)

## Context

What problem forced a decision, and what constraints applied.

## Decision

What was decided, precisely enough to implement and to test against.

## Consequences

What follows from the decision, including known costs and warts.

## Alternatives considered

Each alternative and why it was rejected.
```
