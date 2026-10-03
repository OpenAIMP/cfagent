import { describe, expect, it } from "vitest";
import type { StrategyCandidate } from "../src/trading/options/strategyEngine";
import { parseLlmCandidateSelections } from "../src/trading/options/llmComparison";

const candidates = [
  { id: "candidate-a" },
  { id: "candidate-b" },
] as StrategyCandidate[];

function response(selections: unknown[]): string {
  return JSON.stringify({ selections });
}

describe("LLM options candidate comparison validation", () => {
  it("requires the LLM comparison to rank every shared quant candidate exactly once", () => {
    const ranked = parseLlmCandidateSelections(response([
      { candidateId: "candidate-b", score: 82, rationale: "Strong target payoff.", risks: ["Stale quote"] },
      { candidateId: "candidate-a", score: 74, rationale: "Lower risk.", risks: [] },
    ]), candidates, true);

    expect(ranked.map(({ candidateId, rank }) => [candidateId, rank])).toEqual([
      ["candidate-b", 1],
      ["candidate-a", 2],
    ]);
  });

  it("rejects invented, duplicate, and missing candidate IDs", () => {
    expect(() => parseLlmCandidateSelections(response([
      { candidateId: "not-in-the-pool", score: 70, rationale: "Invented.", risks: [] },
    ]), candidates, false)).toThrow("unknown candidate");

    expect(() => parseLlmCandidateSelections(response([
      { candidateId: "candidate-a", score: 70, rationale: "First.", risks: [] },
      { candidateId: "candidate-a", score: 60, rationale: "Duplicate.", risks: [] },
    ]), candidates, false)).toThrow("more than once");

    expect(() => parseLlmCandidateSelections(response([
      { candidateId: "candidate-a", score: 70, rationale: "Incomplete.", risks: [] },
    ]), candidates, true)).toThrow("every quant candidate");
  });

  it("allows validated idea experiments to select a subset of generated candidates", () => {
    const ideas = parseLlmCandidateSelections(response([
      { candidateId: "candidate-b", score: 91, rationale: "Useful alternative.", risks: ["Requires fresh quotes"] },
    ]), candidates, false);

    expect(ideas).toHaveLength(1);
    expect(ideas[0].candidateId).toBe("candidate-b");
  });
});
