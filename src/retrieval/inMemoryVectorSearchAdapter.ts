/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — in-memory vector search
 * adapter (test + second-adapter independence proof).
 *
 * Deterministic token-overlap scoring over seeded records — no
 * AI, no index, no provider. Score is the fraction of distinct
 * query tokens present in the record text (0..1); ties break by
 * id so results are stable across runs. The filter is an exact
 * metadata match. This adapter proves the VectorSearchPort
 * contract, not Vectorize's ranking: production ranking comes
 * from the VectorMemory-backed adapter.
 */
import type { DenseHit, VectorSearchPort } from "./retrievalPorts";

export interface InMemoryVectorRecord {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((t) => t.length > 0),
  );
}

export class InMemoryVectorSearchAdapter implements VectorSearchPort {
  private records: InMemoryVectorRecord[] = [];

  /** Seed records (test setup; replaces any prior seed). */
  seed(records: InMemoryVectorRecord[]): void {
    this.records = [...records];
  }

  async searchDense(
    query: string,
    opts?: { topK?: number; filter?: Record<string, unknown> },
  ): Promise<DenseHit[]> {
    const topK = Math.max(1, Math.min(50, Math.floor(opts?.topK ?? 8) || 8));
    const queryTokens = tokens(query);
    const scored: DenseHit[] = [];
    for (const record of this.records) {
      if (opts?.filter) {
        const metadata = record.metadata ?? {};
        const matches = Object.entries(opts.filter).every(
          ([key, value]) => metadata[key] === value,
        );
        if (!matches) continue;
      }
      const textTokens = tokens(record.text);
      let hits = 0;
      for (const token of queryTokens) {
        if (textTokens.has(token)) hits += 1;
      }
      const score = queryTokens.size === 0 ? 0 : hits / queryTokens.size;
      scored.push({
        id: record.id,
        score,
        text: record.text,
        metadata: record.metadata ?? {},
      });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    return scored.slice(0, topK);
  }
}
