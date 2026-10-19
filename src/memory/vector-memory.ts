/**
 * PR #6 — VectorMemory: long-term memory for cfagent.
 *
 * Extends the memory.ts pattern with vector-backed recall:
 *   recallForPlan(goal) → up to 8 chunks injected into the
 *   orchestrator prompt, so planning is grounded in past outcomes.
 *
 * Uses the AI Search HTTP endpoint (AI_SEARCH_ENDPOINT, via the injected
 * aiSearch client) + Vectorize. (Issue #278: there is no AI_SEARCH_INSTANCE
 * binding — only the endpoint var.)
 */

export interface MemoryOutcome {
  jobId: string;
  operation: string;
  summary: string;
  success: boolean;
  timestamp: string;
}

export interface RecalledChunk {
  summary: string;
  operation: string;
  success: boolean;
  score: number;
}

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const RECALL_TOP_K = 8;

async function embed(ai: any, text: string): Promise<number[]> {
  const res = await ai.run(EMBEDDING_MODEL, { text });
  return (res as { data: number[][] }).data[0];
}

export class VectorMemory {
  constructor(
    private ai: any,
    private vectorize: any,
    private aiSearch: any
  ) {}

  /** Store a job outcome. Called after every orchestrator job. */
  async remember(outcome: MemoryOutcome): Promise<void> {
    const text = `Operation: ${outcome.operation}\nSuccess: ${outcome.success}\nSummary: ${outcome.summary}`;
    const values = await embed(this.ai, text);
    await this.vectorize.upsert([
      {
        id: outcome.jobId,
        values,
        metadata: {
          operation: outcome.operation,
          success: String(outcome.success),
          timestamp: outcome.timestamp,
          summary: outcome.summary.slice(0, 500),
        },
      },
    ]);
  }

  /**
   * Recall relevant past outcomes for a goal.
   * Returns up to 8 chunks for injection into the planner prompt.
   */
  async recallForPlan(goal: string, operationFilter?: string, topK: number = RECALL_TOP_K): Promise<RecalledChunk[]> {
    const values = await embed(this.ai, goal);
    const results = await this.vectorize.query(values, {
      topK: Math.max(1, Math.min(50, Math.floor(topK) || RECALL_TOP_K)),
      filter: operationFilter ? { operation: { $eq: operationFilter } } : undefined,
      returnMetadata: true,
    });
    return (results.matches ?? []).map((m: any) => ({
      summary: String(m.metadata?.summary ?? ""),
      operation: String(m.metadata?.operation ?? ""),
      success: m.metadata?.success === "true",
      score: m.score,
    }));
  }

  /** Format recalled chunks as a planner-prompt brief. */
  static brief(chunks: RecalledChunk[]): string {
    if (chunks.length === 0) return "No relevant past outcomes.";
    return [
      "Relevant past outcomes:",
      ...chunks.map(
        (c, i) => `${i + 1}. [${c.success ? "OK" : "FAIL"}] ${c.operation}: ${c.summary}`
      ),
    ].join("\n");
  }
}
