/**
 * Issue #1640 (parent #1638, doc §§2-4) — ranking/weights/promotion core.
 *
 * §2 ranking: `annotateQuantRanking` is the single LLM-annotation
 * contract — quant order authoritative, LLM annotates only. These pins
 * are written against an ADVERSARIAL LLM order (fully reversed) so a
 * regression that lets the LLM reorder is caught, not just a
 * same-order pass-through.
 *
 * §3 weights: live routes never read or write the v1 store. The only
 * v1 symbols any route may import are pure helpers (the week-guard
 * key + ISO-week key, and the measurement-only policy evaluation
 * builder fed with v2 weights). The v1 store functions stay in the
 * drain path only (stagedPromotion baselines/rollback) — see the §15
 * retention reason on #1640.
 *
 * §4 promotion: the /adaptation/* routes promote through
 * championChallenger; stagedPromotion appears in routes only for the
 * drain (advance + active-list visibility), never for new promotions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { annotateQuantRanking } from "../src/services/rankingCore";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const screenerResearch = readFileSync(path.join(SRC, "agents/routes/screenerResearch.ts"), "utf8");

type Ranked = { candidate: { id: string; label: string }; compositeScore: number };

function ranked(ids: string[]): Ranked[] {
  return ids.map((id, i) => ({ candidate: { id, label: `strat-${id}` }, compositeScore: 100 - i * 10 }));
}

describe("annotateQuantRanking: quant authority (#1640 §2)", () => {
  it("preserves quant order under a fully reversed LLM order", () => {
    const quant = ranked(["a", "b", "c"]);
    const out = annotateQuantRanking(quant, [
      { candidateId: "c", score: 99, rationale: "llm loves c", risks: [] },
      { candidateId: "b", score: 50, rationale: "llm mid b", risks: ["r1"] },
      { candidateId: "a", score: 1, rationale: "llm hates a", risks: [] },
    ]);
    expect(out.map((o) => o.ranked.candidate.id)).toEqual(["a", "b", "c"]);
    expect(out[0].annotation?.rationale).toBe("llm hates a");
    expect(out[2].annotation?.score).toBe(99);
  });

  it("drops judgments for unknown ids and annotates missing ones null", () => {
    const out = annotateQuantRanking(ranked(["a", "b"]), [
      { candidateId: "ghost", score: 100, rationale: "invented", risks: [] },
      { candidateId: "a", score: 70, rationale: "ok", risks: [] },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.ranked.candidate.id)).toEqual(["a", "b"]);
    expect(out[1].annotation).toBeNull();
  });

  it("first judgment wins on duplicates, and inputs are not mutated", () => {
    const quant = ranked(["a"]);
    const judgments = [
      { candidateId: "a", score: 10, rationale: "first", risks: [] },
      { candidateId: "a", score: 90, rationale: "second", risks: [] },
    ];
    const out = annotateQuantRanking(quant, judgments);
    expect(out[0].annotation?.rationale).toBe("first");
    expect(out[0].ranked).toBe(quant[0]);
    expect(judgments).toHaveLength(2);
  });

  it("empty judgments leave the quant list intact", () => {
    const quant = ranked(["a", "b", "c"]);
    const out = annotateQuantRanking(quant, []);
    expect(out.map((o) => o.ranked.candidate.id)).toEqual(["a", "b", "c"]);
    expect(out.every((o) => o.annotation === null)).toBe(true);
  });
});

describe("live routes on one weights system (#1640 §3)", () => {
  it("no route imports a v1 store function", () => {
    const forbidden = [
      "getStrategyWeights",
      "setStrategyWeight",
      "deleteStrategyWeight",
      "runStrategyWeightAdjustment",
      "proposeWeightAdjustments",
      "ensureStrategyWeightsTable",
    ];
    for (const name of forbidden) {
      // Word boundary: the v2 names (getStrategyWeightsV2, …V2) must not
      // trip this pin — only the exact v1 symbol counts.
      expect(
        new RegExp(`\\b${name}\\b`).test(screenerResearch),
        `screenerResearch routes must not import v1 store symbol ${name}`
      ).toBe(false);
    }
  });

  it("no route imports v1 strategyWeights; the moved helpers come from v2", () => {
    // The v1 path ends with a quote; the v2 path (strategyWeightsV2)
    // must not trip this pin.
    expect(screenerResearch).not.toMatch(/services\/strategyWeights"/);
    const v2Names = new Set(
      [...screenerResearch.matchAll(/const \{ ([^}]*) \} = await import\("..\/..\/services\/strategyWeightsV2"\)/g)]
        .flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean))
    );
    for (const name of ["buildWeightPolicyEvaluation", "isoWeekKey", "WEIGHTS_LAST_RUN_WEEK_KEY"]) {
      expect(v2Names.has(name), `moved helper ${name} must be imported from v2`).toBe(true);
    }
  });
});

describe("promotion through championChallenger (#1640 §4)", () => {
  it("routes promote/approve through the challenger gate; staged drain is retired", () => {
    for (const name of ["promoteChallenger", "recordChallengerApproval", "rollbackChallengerPromotion"]) {
      expect(screenerResearch).toContain(name);
    }
    expect(screenerResearch).not.toContain("advancePromotion");
    expect(screenerResearch).not.toContain("listActivePromotions");
    expect(screenerResearch).not.toContain("startPromotion(");
  });
});
