// @vitest-environment node
/**
 * Issue #1740 ([AGENTIC] Hybrid RAG) — TDD red-first.
 *
 * VectorMemory gains one generic dense-search method, reusing its
 * existing embedding path (same model, same embed(), same index).
 * This is an EXTENSION of the existing path, not a second model:
 * no new embed function, no new index, no new model constant.
 * Existing recallForPlan/recallPlans behavior is unchanged.
 */
import { describe, it, expect } from "vitest";
import { VectorMemory } from "../src/memory/vector-memory";

function stubAi() {
  const calls: Array<{ model: string; text: string }> = [];
  return {
    calls,
    run: async (model: string, input: { text: string }) => {
      calls.push({ model, text: input.text });
      // Deterministic stub embedding: length-based, never random.
      return { data: [[0.1, 0.2, 0.3]] };
    },
  };
}

function stubVectorize() {
  const queries: Array<{ values: number[]; opts: unknown }> = [];
  return {
    queries,
    upsert: async () => {},
    query: async (values: number[], opts: any) => {
      queries.push({ values, opts });
      return {
        matches: [
          {
            id: "m1",
            score: 0.92,
            metadata: {
              summary: "NVDA beat earnings",
              operation: "screen",
              success: "true",
            },
          },
          {
            id: "m2",
            score: 0.71,
            metadata: { goal: "compare NVDA vs AMD", kind: "plan" },
          },
        ],
      };
    },
  };
}

describe("VectorMemory.searchDense (#1740 extension, reused path)", () => {
  it("embeds with the existing model and queries the same index", async () => {
    const ai = stubAi();
    const vectorize = stubVectorize();
    const vm = new VectorMemory(ai as any, vectorize as any, undefined);
    const hits = await vm.searchDense("NVDA outlook", 5);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].model).toBe("@cf/baai/bge-base-en-v1.5");
    expect(ai.calls[0].text).toBe("NVDA outlook");
    expect(vectorize.queries).toHaveLength(1);
    expect(vectorize.queries[0].opts).toMatchObject({
      topK: 5,
      returnMetadata: true,
    });
    expect(hits).toEqual([
      {
        id: "m1",
        score: 0.92,
        text: "NVDA beat earnings",
        metadata: { summary: "NVDA beat earnings", operation: "screen", success: "true" },
      },
      {
        id: "m2",
        score: 0.71,
        text: "compare NVDA vs AMD",
        metadata: { goal: "compare NVDA vs AMD", kind: "plan" },
      },
    ]);
  });

  it("clamps topK to the existing 1..50 range and passes filters through", async () => {
    const ai = stubAi();
    const vectorize = stubVectorize();
    const vm = new VectorMemory(ai as any, vectorize as any, undefined);
    await vm.searchDense("x", 500, { kind: "plan" });
    expect(vectorize.queries[0].opts).toMatchObject({
      topK: 50,
      filter: { kind: "plan" },
    });
    await vm.searchDense("x", 0);
    expect(vectorize.queries[1].opts).toMatchObject({ topK: 8 });
  });

  it("recallForPlan behavior is unchanged by the extension", async () => {
    const ai = stubAi();
    const vectorize = stubVectorize();
    const vm = new VectorMemory(ai as any, vectorize as any, undefined);
    const chunks = await vm.recallForPlan("NVDA outlook");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      summary: "NVDA beat earnings",
      operation: "screen",
      success: true,
      score: 0.92,
    });
  });
});
