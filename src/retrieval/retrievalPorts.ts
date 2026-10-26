/**
 * Issue #1740 ([AGENTIC] Hybrid RAG, sub-issue of #1736 item 4) —
 * retrieval port module (R1, ADR 0007).
 *
 * Domain code depends ONLY on these interfaces. This module is
 * deliberately free of any store client, any binding reference,
 * and any query language: no adapter import, no store-specific
 * type, no Vectorize/D1 reference. The composition root
 * (src/retrieval/createRetrievalPorts.ts) wires store adapters to
 * these ports; domain code never sees the adapter.
 *
 * The port has two legs and one fusion:
 *  - VectorSearchPort: dense embedding search (the Vectorize leg).
 *    The production adapter wraps VectorMemory's embedding path
 *    (same model, same index) — there is no second embedding
 *    model and no second vector index in this slice.
 *  - MarketGraphReader/Writer: the D1 market adjacency graph leg
 *    (symbol/sector/peer/event nodes and their relations).
 *  - Hybrid retrieval (src/retrieval/hybridRetrieval.ts) composes
 *    the two legs: dense hits first, then graph-adjacent rows.
 *
 * Tenancy (R7): every graph method takes a tenant id resolved
 * server-side. There is no unscoped read method anywhere in this
 * module; adapters inject the tenant predicate into every query.
 *
 * Fallback (issue acceptance): graph unavailability degrades to
 * embeddings-only (logged), never fails the retrieval. An empty
 * graph is parity: hybrid output equals the dense leg alone.
 *
 * Scope note: this slice covers retrieval only. It does not
 * change VectorMemory's stored records, the AgentDB projection
 * tables, or the KNOWLEDGE_MODE / MEMORY_READ_MODE surfaces
 * (#1717 slice (c), #1796) — those are a different, already
 * unified layer, and this port neither reads nor switches them.
 * No row type here carries auth material of any kind — a writer
 * accepting such a row is a defect, pinned by test.
 */

/** One dense-search hit: id, similarity score, text, raw metadata. */
export interface DenseHit {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
}

/** Dense embedding search over one vector index. */
export interface VectorSearchPort {
  searchDense(
    query: string,
    opts?: {
      topK?: number;
      filter?: Record<string, unknown>;
    },
  ): Promise<DenseHit[]>;
}

/** Market graph node kinds. A peer is a symbol node; peerhood is a relation, not a kind. */
export type MarketNodeType = "symbol" | "sector" | "event";

/** Market graph relations. */
export type MarketRelation = "in_sector" | "peer_of" | "related_event";

/** One market graph node, tenant-scoped. */
export interface MarketNode {
  tenantId: string;
  nodeType: MarketNodeType;
  nodeKey: string;
  label: string;
}

/** One market graph edge, tenant-scoped. Weight is informational (1 direct, 0.5 peer); fusion orders by relation, not weight. */
export interface MarketEdge {
  tenantId: string;
  fromType: MarketNodeType;
  fromKey: string;
  relation: MarketRelation;
  toType: MarketNodeType;
  toKey: string;
  weight: number;
  provenance: string;
}

/** One graph-adjacent row returned to a retrieval caller. */
export interface GraphContextRow {
  node: MarketNode;
  viaRelation: MarketRelation;
  viaSeedKey: string;
  weight: number;
}

/**
 * Tenant-scoped graph reads. adjacent() returns rows in no
 * guaranteed order — callers that need a stable order (hybrid
 * fusion) sort by seed order, relation order, then node key.
 */
export interface MarketGraphReader {
  adjacent(
    tenantId: string,
    seedKeys: string[],
    opts?: {
      relations?: MarketRelation[];
      limit?: number;
    },
  ): Promise<GraphContextRow[]>;
  /** Known symbol nodes among the candidates, in candidate order. */
  resolveSymbols(tenantId: string, candidates: string[]): Promise<string[]>;
}

/** Idempotent graph writes: replaying the same node/edge refreshes label/weight/provenance only. */
export interface MarketGraphWriter {
  upsertNodes(nodes: MarketNode[]): Promise<void>;
  upsertEdges(edges: MarketEdge[]): Promise<void>;
}

/** The market graph store surface: one reader plus one writer. */
export interface MarketGraphStore
  extends MarketGraphReader,
    MarketGraphWriter {}

/** Hybrid retrieval input. */
export interface HybridRetrieveInput {
  query: string;
  tenantId: string;
  topK?: number;
  graphTopK?: number;
  denseFilter?: Record<string, unknown>;
}

/** Hybrid retrieval result. degraded=true means the graph leg failed and the dense leg alone is returned. */
export interface HybridRetrievalResult {
  dense: DenseHit[];
  graph: GraphContextRow[];
  degraded: boolean;
  graphError?: string;
}
