/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — VectorMemory-backed vector
 * search adapter (the production VectorSearchPort).
 *
 * Composition, not duplication: the dense leg delegates to
 * VectorMemory.searchDense, which reuses VectorMemory's existing
 * embedding path (same model, same embed(), same index). This
 * adapter adds no embed function, no model constant, and no
 * index of its own.
 */
import type { VectorMemory } from "../memory/vector-memory";
import type { DenseHit, VectorSearchPort } from "./retrievalPorts";

export class VectorMemorySearchAdapter implements VectorSearchPort {
  constructor(private readonly memory: VectorMemory) {}

  async searchDense(
    query: string,
    opts?: { topK?: number; filter?: Record<string, unknown> },
  ): Promise<DenseHit[]> {
    return this.memory.searchDense(query, opts?.topK ?? 8, opts?.filter);
  }
}
