/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — composition root for the
 * retrieval ports (R1). This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of a binding is a normal, non-error state:
 * createMarketGraphAdapter returns null and callers keep their
 * dense-only behavior; createVectorSearchAdapter returns null
 * and callers keep their unbound behavior (the memory_search
 * route 503s, the turn grounding skips, exactly as before).
 * A graph failure never throws to the retrieval caller — the
 * hybrid path degrades and logs (see hybridRetrieval).
 */
import { VectorMemory } from "../memory/vector-memory";
import {
  createD1MarketGraphDb,
  D1MarketGraphAdapter,
  ensureMarketGraphSchema,
} from "./d1MarketGraphAdapter";
import type {
  MarketGraphStore,
  VectorSearchPort,
} from "./retrievalPorts";
import { VectorMemorySearchAdapter } from "./vectorMemorySearchAdapter";

/** Build the market graph adapter from Worker env, or null if unbound. */
export function createMarketGraphAdapter(env: {
  AGENT_DB?: unknown;
}): D1MarketGraphAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1MarketGraphAdapter(
    createD1MarketGraphDb(env.AGENT_DB as D1Database),
  );
}

/** Build the vector search adapter from Worker env, or null if unbound. */
export function createVectorSearchAdapter(env: {
  AI?: unknown;
  VECTOR_MEMORY?: unknown;
}): VectorSearchPort | null {
  if (!env.AI || !env.VECTOR_MEMORY) return null;
  return new VectorMemorySearchAdapter(
    new VectorMemory(env.AI, env.VECTOR_MEMORY, undefined),
  );
}

/** Idempotent schema-ensure for the market graph tables. */
export async function ensureMarketGraphTables(
  adapter: D1MarketGraphAdapter,
): Promise<number[]> {
  return ensureMarketGraphSchema(adapter.db);
}

export type { MarketGraphStore };
