import { describe, it, expect, vi } from "vitest";
import {
  indexReport,
  semanticSearchReports,
  mergeSearchHits,
} from "../src/services/reportSemanticIndex";

/**
 * #337: semantic report indexing + hybrid search.
 */

describe("#337 report semantic index", () => {
  it("no-ops without AI/Vectorize bindings", async () => {
    expect(
      await indexReport({}, { reportId: "r1", title: "t", source: "s", text: "x" })
    ).toBe(false);
    expect(await semanticSearchReports({}, "query")).toEqual([]);
  });

  it("indexes a report via embeddings + Vectorize upsert", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const env = {
      AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
      VECTOR_MEMORY: { upsert },
    };
    const ok = await indexReport(env, {
      reportId: "r1",
      title: "Options research",
      source: "options_research",
      text: "bullish AVGO",
    });
    expect(ok).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0][0];
    expect(arg.id).toBe("report:r1");
    expect(arg.values).toEqual([0.1, 0.2, 0.3]);
    expect(arg.metadata.reportId).toBe("r1");
  });

  it("never throws when the AI call fails", async () => {
    const env = {
      AI: { run: async () => { throw new Error("AI down"); } },
      VECTOR_MEMORY: { upsert: vi.fn() },
    };
    expect(
      await indexReport(env, { reportId: "r1", title: "t", source: "s", text: "x" })
    ).toBe(false);
  });

  it("returns semantic hits from a Vectorize query", async () => {
    const env = {
      AI: { run: async () => ({ data: [[0.1]] }) },
      VECTOR_MEMORY: {
        query: async () => ({
          matches: [
            { metadata: { reportId: "r1" }, score: 0.9 },
            { metadata: { reportId: "r2" }, score: 0.7 },
          ],
        }),
      },
    };
    const hits = await semanticSearchReports(env, "bullish tech", 8);
    expect(hits).toEqual([
      { reportId: "r1", score: 0.9 },
      { reportId: "r2", score: 0.7 },
    ]);
  });

  it("merges lexical and semantic hits, both-sources rank highest", () => {
    const merged = mergeSearchHits(
      ["r1", "r3"],
      [
        { reportId: "r1", score: 0.9 },
        { reportId: "r2", score: 0.8 },
      ]
    );
    expect(merged[0].reportId).toBe("r1");
    expect(merged[0].via).toBe("both");
    const vias = Object.fromEntries(merged.map((m) => [m.reportId, m.via]));
    expect(vias).toEqual({ r1: "both", r2: "semantic", r3: "lexical" });
  });
});
