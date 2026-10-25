/**
 * Issue #341: the watchlist & rejected-ideas browse extractor — flattens
 * §8 outputs out of stored canonical research reports with provenance,
 * skipping non-run bodies and malformed entries.
 */
import { describe, it, expect } from "vitest";
import {
  extractResearchBrowseEntries,
  researchBrowseGates,
} from "../src/services/researchBrowse";

function report(id: string, body: unknown, title = `Run ${id}`) {
  return {
    id,
    title,
    createdAt: "2026-10-19T12:00:00.000Z",
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

describe("extractResearchBrowseEntries", () => {
  it("flattens watchlist and rejected entries with provenance", () => {
    const entries = extractResearchBrowseEntries([
      report("r1", {
        ideas: [],
        watchlist: [
          { symbol: "NVDA", outlook: "bullish", thesis: "t", structure: "call", reason: "IV too rich", triggerCondition: "IV rank < 40" },
        ],
        rejected: [
          { symbol: "XYZ", outlook: "bearish", structure: "put spread", gate: "liquidity", reason: "Spread too wide" },
          { symbol: "ABC", outlook: "bullish", structure: "call spread", gate: "quote_quality", reason: "Stale quotes" },
        ],
      }),
    ]);
    expect(entries).toHaveLength(3);
    const w = entries.find((e) => e.kind === "watchlist")!;
    expect(w.symbol).toBe("NVDA");
    expect(w.triggerCondition).toBe("IV rank < 40");
    expect(w.reportId).toBe("r1");
    expect(w.reportTitle).toBe("Run r1");
    const r = entries.find((e) => e.symbol === "XYZ")!;
    expect(r.kind).toBe("rejected");
    expect(r.gate).toBe("liquidity");
  });

  it("skips non-run bodies, broken JSON, and symbol-less entries", () => {
    const entries = extractResearchBrowseEntries([
      report("r2", { title: "sheets", sheets: [] }),
      report("r3", "{not json"),
      report("r4", {
        watchlist: [{ outlook: "bullish" }],
        rejected: [{ symbol: "OK", gate: "g", reason: "r" }],
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].symbol).toBe("OK");
  });

  it("collects the distinct rejected gates, sorted", () => {
    const entries = extractResearchBrowseEntries([
      report("r5", {
        rejected: [
          { symbol: "A", gate: "quote_quality", reason: "x" },
          { symbol: "B", gate: "liquidity", reason: "y" },
          { symbol: "C", gate: "liquidity", reason: "z" },
        ],
      }),
    ]);
    expect(researchBrowseGates(entries)).toEqual(["liquidity", "quote_quality"]);
  });
});
