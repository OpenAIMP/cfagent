# 0007. Hybrid RAG: Vectorize embeddings + D1 market adjacency graphs

- Status: accepted
- Date: 2026-10-26
- Deciders: owner, #CAIO-quns
- Issue: #1740 (sub-issue of #1736, Top-10 item 4)
- Implementing PR: (filled on merge)

## Context

Agent retrieval used Vectorize embeddings alone: semantically near
content was found, but market relationships (symbol to sector to
peer to event) were invisible to retrieval, so context missed
structurally related material. The blueprint's ADR-0005 (Hybrid RAG
Knowledge Engine) decides pairing Vectorize embeddings with D1
relational graph tables; this ADR records how that decision lands
in this codebase, under the data-layer R1–R9 contract (ADR 0002)
and the adapter-first rule.

Constraints that shaped the design:

- Port-first (R1): retrieval domain code never imports a provider
  SDK; the Vectorize leg and the D1 leg are both behind ports.
- No second embedding model and no second vector index: the dense
  leg reuses VectorMemory's embedding path (same model
  `@cf/baai/bge-base-en-v1.5`, same embed(), same index).
- No second event, job, or embedding model: retrieval events use
  #1739's CloudEvents v1.0 envelope (id-as-idempotency-key);
  actors remain the retrieval consumers via #1738's actor port;
  workflow stages use #1737's stage vocabulary.
- Tenancy at the boundary (R7), retention decided up front (R8),
  session/credential stores never projected (R9).
- Coordination with #1717 (CISO lane): Adapter S1 (#1775) routes
  Vectorize/AI Search through existing adapters — this slice
  consumes VectorMemory (the kept path), it does not duplicate
  it; slice (c) knowledge/memory (#1723/#1796, KNOWLEDGE_MODE /
  MEMORY_READ_MODE) is an already-unified layer this slice
  neither reads nor switches. This RAG layer is the retrieval
  consumer of unified knowledge, not a second unification.

## Decision

- A retrieval port (`src/retrieval/retrievalPorts.ts`): dense
  vector search + graph adjacency + hybrid fusion. Adapters:
  VectorMemory-backed vector search (production), in-memory
  vector search (deterministic token overlap, test + independence
  proof), Drizzle D1 market graph (production), in-memory market
  graph (test + independence proof). One conformance suite runs
  unchanged against the D1 and in-memory graph adapters.
- D1 graph schema (migration 0005, Drizzle parity pinned by
  test): `agent_market_nodes` (one row per tenant/node-type/key)
  and `agent_market_edges` (one row per
  tenant/from/relation/to). Relations: `in_sector`, `peer_of`
  (symmetric, both directions stored), `related_event`.
- Fusion rule (deterministic): dense hits first in score order;
  then graph rows grouped by seed order (query symbols in query
  order, then symbols from dense-hit texts in dense order),
  within a seed by relation order
  in_sector < peer_of < related_event, then node key; deduped
  by node; capped at graphTopK (default 12).
- Seeds are known symbols only: uppercase ticker-like tokens
  resolved against stored symbol nodes. Nothing is inferred.
- Failure contract: graph unavailability degrades to
  embeddings-only (logged, `degraded: true`), never fails the
  retrieval. An empty graph is parity with the dense leg alone.
- Population derives from existing market data (the curated
  stock universe: symbol, company name, sector) via idempotent
  upserts, invoked only through the admin-gated
  `POST /api/retrieval/populate-market-graph` route (seed-route
  pattern: POST only, session + platform-admin, never auto-run).
  The curated universe supplies no events, so the built-in
  population seeds no event edges; the schema and the population
  input support them, and event population from report rows is a
  recorded follow-up.
- Wiring is additive and behavior-preserving: the
  `POST /api/memory/search` route gains `graph` + `graphDegraded`
  fields (chunks unchanged); the actor turn grounding appends a
  graph section only when expansion yields rows (empty/unbound/
  error means byte-identical prior behavior). Retrieval emits
  one best-effort `retrieval.completed` CloudEvents envelope
  (counts only, no query text); emission failure is swallowed.
- Retention (R8): both new tables are KEEP (derived reference
  data, bounded by universe × relations, idempotent
  repopulation; the purge allowlist stays shard-jobs only).

## Consequences

- Agents gain structurally related context (sectors, peers,
  events) without a new index, a new model, or a new event
  system. The graph is small (161 symbols, largest sector 20)
  and rebuildable from its sources.
- The collation-state question #1739 left open (ADR 0003 M10)
  is NOT answered here: hybrid retrieval fuses within one call
  and keeps no collation state. Cross-call collation remains a
  #1737 design item.
- Follow-ups (not this slice): event-edge population from
  report rows; durable cross-instance dedup for retrieval
  events; bus retirement (from #1739); AI Gateway (#1741) and
  telemetry (#1742) consumers of the retrieval hooks named
  here (the `retrieval.completed` envelope shape is the hook).
- Rollback: revert the PR; behavior falls back to the
  pre-change dense-only path (the graph tables stay, unused).
