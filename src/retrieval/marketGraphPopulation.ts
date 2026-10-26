/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — market graph population
 * from existing market data (ADR 0007).
 *
 * Derivation (deterministic, no inference):
 *  - One symbol node per security (label = company name).
 *  - One sector node per distinct sector.
 *  - symbol —in_sector→ sector (weight 1).
 *  - symbol —peer_of→ symbol for same-sector pairs, both
 *    directions (weight 0.5; peer_of is symmetric). Bounded by
 *    the universe: 161 symbols, largest sector 20, so at most
 *    ~1,900 peer rows — reference data, not per-request rows.
 *  - symbol —related_event→ event (weight 1) for explicitly
 *    supplied events only. The curated universe supplies no
 *    events, so the built-in population seeds none; event
 *    population from report rows is a recorded follow-up.
 *
 * Writes are idempotent upserts through the port: a second run
 * refreshes labels/weights and changes nothing else. No session
 * or credential material ever flows through this module.
 */
import { getCuratedStockUniverse } from "../config/curatedStockUniverse";
import type {
  MarketEdge,
  MarketGraphWriter,
  MarketNode,
} from "./retrievalPorts";

export interface MarketSecurityInput {
  symbol: string;
  companyName: string;
  sector: string;
}

export interface MarketEventInput {
  eventKey: string;
  label: string;
  symbols: string[];
}

export interface MarketGraphInput {
  nodes: MarketNode[];
  edges: MarketEdge[];
}

export interface MarketGraphPopulationReport {
  nodes: number;
  edges: number;
}

const PROVENANCE = "curated-universe";

/** Derive nodes + edges for one tenant (tenant stamped at populate time, not here). */
export function deriveMarketGraphInput(
  securities: MarketSecurityInput[],
  events: MarketEventInput[] = [],
): { nodes: Omit<MarketNode, "tenantId">[]; edges: Omit<MarketEdge, "tenantId" | "provenance">[] } {
  const nodes = new Map<string, Omit<MarketNode, "tenantId">>();
  const edges = new Map<string, Omit<MarketEdge, "tenantId" | "provenance">>();
  const bySector = new Map<string, string[]>();
  for (const security of securities) {
    const symbol = security.symbol.toUpperCase();
    nodes.set(`symbol:${symbol}`, {
      nodeType: "symbol",
      nodeKey: symbol,
      label: security.companyName,
    });
    nodes.set(`sector:${security.sector}`, {
      nodeType: "sector",
      nodeKey: security.sector,
      label: security.sector,
    });
    edges.set(`${symbol}|in_sector|${security.sector}`, {
      fromType: "symbol",
      fromKey: symbol,
      relation: "in_sector",
      toType: "sector",
      toKey: security.sector,
      weight: 1,
    });
    const peers = bySector.get(security.sector) ?? [];
    peers.push(symbol);
    bySector.set(security.sector, peers);
  }
  for (const symbols of bySector.values()) {
    for (const from of symbols) {
      for (const to of symbols) {
        if (from === to) continue;
        edges.set(`${from}|peer_of|${to}`, {
          fromType: "symbol",
          fromKey: from,
          relation: "peer_of",
          toType: "symbol",
          toKey: to,
          weight: 0.5,
        });
      }
    }
  }
  for (const event of events) {
    nodes.set(`event:${event.eventKey}`, {
      nodeType: "event",
      nodeKey: event.eventKey,
      label: event.label,
    });
    for (const symbol of event.symbols) {
      const upper = symbol.toUpperCase();
      edges.set(`${upper}|related_event|${event.eventKey}`, {
        fromType: "symbol",
        fromKey: upper,
        relation: "related_event",
        toType: "event",
        toKey: event.eventKey,
        weight: 1,
      });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Idempotent population for one tenant; returns row counts written (nodes, edges). */
export async function populateMarketGraph(
  store: MarketGraphWriter,
  tenantId: string,
  input: {
    nodes: Omit<MarketNode, "tenantId">[];
    edges: Omit<MarketEdge, "tenantId" | "provenance">[];
  },
  _nowMs: number,
): Promise<MarketGraphPopulationReport> {
  const nodes: MarketNode[] = input.nodes.map((n) => ({ ...n, tenantId }));
  const edges: MarketEdge[] = input.edges.map((e) => ({
    ...e,
    tenantId,
    provenance: PROVENANCE,
  }));
  await store.upsertNodes(nodes);
  await store.upsertEdges(edges);
  return { nodes: nodes.length, edges: edges.length };
}

/** Built-in population from the curated stock universe (existing market data). */
export async function populateFromCuratedUniverse(
  store: MarketGraphWriter,
  tenantId: string,
  nowMs: number,
): Promise<MarketGraphPopulationReport & { symbols: number }> {
  const universe = getCuratedStockUniverse();
  const derived = deriveMarketGraphInput(universe);
  const report = await populateMarketGraph(store, tenantId, derived, nowMs);
  return { ...report, symbols: universe.length };
}
