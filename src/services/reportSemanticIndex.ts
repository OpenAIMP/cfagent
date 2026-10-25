/**
 * Semantic report indexing (issue #337).
 *
 * Report retrieval is lexical today (SQL token search, #278/#308). This adds
 * the semantic half: each canonical report is embedded at generation time
 * (Workers AI) into the shared Vectorize index keyed by report id, and
 * search merges lexical + semantic results.
 *
 * Research reports (#319) are first-class citizens from the start — every
 * stored report is indexed, not just research ones.
 *
 * Best-effort throughout: indexing never fails report storage, and search
 * degrades to lexical-only when the AI/Vectorize bindings are absent.
 */

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

async function embed(ai: any, text: string): Promise<number[] | null> {
  try {
    const res = await ai.run(EMBEDDING_MODEL, { text: text.slice(0, 8000) });
    const data = (res as { data?: number[][] }).data;
    if (!data?.[0]) return null;
    return data[0];
  } catch (err) {
    console.warn("[reportSemanticIndex] embed failed:", err);
    return null;
  }
}

export interface ReportIndexInput {
  reportId: string;
  title: string;
  source: string;
  /** Searchable text: summary + key sections. */
  text: string;
}

/**
 * Index one canonical report. Safe to call without AI/Vectorize bindings
 * (no-op). Never throws.
 */
export async function indexReport(
  env: { AI?: any; VECTOR_MEMORY?: any },
  input: ReportIndexInput
): Promise<boolean> {
  try {
    if (!env.AI || !env.VECTOR_MEMORY || !input.reportId) return false;
    const values = await embed(env.AI, `${input.title}\n${input.text}`);
    if (!values) return false;
    await env.VECTOR_MEMORY.upsert([
      {
        id: `report:${input.reportId}`,
        values,
        metadata: {
          kind: "report",
          reportId: input.reportId,
          title: input.title.slice(0, 200),
          source: input.source,
        },
      },
    ]);
    return true;
  } catch (err) {
    console.warn("[reportSemanticIndex] index failed:", err);
    return false;
  }
}

export interface SemanticHit {
  reportId: string;
  score: number;
}

export interface HybridHit {
  reportId: string;
  /** 0..1 blended rank: lexical presence + semantic score. */
  rank: number;
  via: "lexical" | "semantic" | "both";
}

/**
 * Merge lexical hits (report ids) with semantic hits into one ranked list.
 * Pure function — the caller fetches each side.
 */
export function mergeSearchHits(
  lexicalIds: string[],
  semantic: SemanticHit[]
): HybridHit[] {
  const byId = new Map<string, HybridHit>();
  for (const id of lexicalIds) {
    byId.set(id, { reportId: id, rank: 0.5, via: "lexical" });
  }
  for (const s of semantic) {
    const existing = byId.get(s.reportId);
    if (existing) {
      existing.rank = Math.min(1, existing.rank + s.score * 0.5);
      existing.via = "both";
    } else {
      byId.set(s.reportId, {
        reportId: s.reportId,
        rank: s.score * 0.5,
        via: "semantic",
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.rank - a.rank);
}

/**
 * Semantic search over indexed reports. Returns report ids by similarity.
 * Empty array when bindings are absent or the query fails — callers fall
 * back to lexical-only.
 */
export async function semanticSearchReports(
  env: { AI?: any; VECTOR_MEMORY?: any },
  query: string,
  topK = 8
): Promise<SemanticHit[]> {
  try {
    if (!env.AI || !env.VECTOR_MEMORY || !query.trim()) return [];
    const values = await embed(env.AI, query);
    if (!values) return [];
    const res = await env.VECTOR_MEMORY.query(values, {
      topK,
      filter: { kind: "report" },
      returnMetadata: true,
    });
    const matches = (res as { matches?: Array<{ id?: string; score?: number; metadata?: { reportId?: string } }> }).matches ?? [];
    return matches
      .map((m) => ({
        reportId: String(m.metadata?.reportId ?? String(m.id ?? "").replace(/^report:/, "")),
        score: typeof m.score === "number" ? m.score : 0,
      }))
      .filter((h) => h.reportId);
  } catch (err) {
    console.warn("[reportSemanticIndex] search failed:", err);
    return [];
  }
}
