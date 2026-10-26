/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — in-memory market graph
 * adapter (test + second-adapter independence proof).
 *
 * Map-backed, same contract as the D1 adapter: composite keys
 * (tenant, type, key) for nodes and (tenant, from, relation, to)
 * for edges; upserts refresh label/weight only; every read is
 * tenant-scoped. adjacent() returns rows in no guaranteed order
 * (hybrid fusion sorts); resolveSymbols() returns known symbols
 * in candidate order.
 */
import type {
  MarketEdge,
  MarketGraphStore,
  MarketNode,
  GraphContextRow,
  MarketRelation,
} from "./retrievalPorts";

function nodeKey(tenantId: string, nodeType: string, nodeKey: string): string {
  return `${tenantId}:${nodeType}:${nodeKey}`;
}

function edgeKey(edge: MarketEdge): string {
  return `${edge.tenantId}:${edge.fromType}:${edge.fromKey}:${edge.relation}:${edge.toType}:${edge.toKey}`;
}

export class InMemoryMarketGraphAdapter implements MarketGraphStore {
  private nodes = new Map<string, MarketNode>();
  private edges = new Map<string, MarketEdge>();

  async upsertNodes(nodes: MarketNode[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(nodeKey(node.tenantId, node.nodeType, node.nodeKey), {
        ...node,
      });
    }
  }

  async upsertEdges(edges: MarketEdge[]): Promise<void> {
    for (const edge of edges) {
      this.edges.set(edgeKey(edge), { ...edge });
    }
  }

  async adjacent(
    tenantId: string,
    seedKeys: string[],
    opts?: { relations?: MarketRelation[]; limit?: number },
  ): Promise<GraphContextRow[]> {
    const seedSet = new Set(seedKeys);
    const relationSet = opts?.relations ? new Set(opts.relations) : null;
    const rows: GraphContextRow[] = [];
    for (const edge of this.edges.values()) {
      if (edge.tenantId !== tenantId) continue;
      if (!seedSet.has(edge.fromKey)) continue;
      if (relationSet && !relationSet.has(edge.relation)) continue;
      const node = this.nodes.get(
        nodeKey(tenantId, edge.toType, edge.toKey),
      );
      if (!node) continue;
      rows.push({
        node: { ...node },
        viaRelation: edge.relation,
        viaSeedKey: edge.fromKey,
        weight: edge.weight,
      });
    }
    return opts?.limit !== undefined ? rows.slice(0, opts.limit) : rows;
  }

  async resolveSymbols(
    tenantId: string,
    candidates: string[],
  ): Promise<string[]> {
    const out: string[] = [];
    for (const candidate of candidates) {
      if (this.nodes.has(nodeKey(tenantId, "symbol", candidate))) {
        out.push(candidate);
      }
    }
    return out;
  }
}
