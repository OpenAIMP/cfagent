/**
 * Issue #784 — reflection persistence honesty pins.
 *
 * src/services/reflection.ts used to wrap the already-ran guard, both
 * analysis sections, every finding's recordLearning write, and the
 * run-meta write in bare `catch {}` blocks: a broken mas_learnings store
 * made the weekly reflection silently lose every learning it computed
 * while the run reported success (the persistAudit honesty class).
 * These pins hold the new contract:
 *
 *  - No bare `catch {}` may exist in reflection.ts (source pin).
 *  - Every previously-swallowing site logs via console.error with
 *    context (repo convention) when its store operation fails.
 *  - Failed learning writes are COUNTED on the run result
 *    (`learningsFailed`, present only when > 0): the run summary never
 *    claims learnings it failed to persist. Failed analysis sections
 *    are counted likewise (`analysisFailures`).
 *  - The already-ran guard fails OPEN, deliberately and documented:
 *    if the guard read fails, the run proceeds and the failure is
 *    logged — failing closed would silently disable the learning loop.
 *  - Happy path is byte-identical: same findings, same writes, same
 *    result shape (no failure keys), same run-meta text.
 *
 * Red/green note: the log/count pins and the source pin fail on
 * pre-change code; the happy-path, guard-skip and not-Sunday pins are
 * characterization pins that pass on both sides by design.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runReflection } from "../src/services/reflection";

// A Sunday (the weekly guard only fires on Sundays).
const SUNDAY = new Date("2026-10-18T12:00:00.000Z");
const MONDAY = new Date("2026-10-19T12:00:00.000Z");

type FailPredicate = (text: string, params: any[]) => boolean;

/**
 * In-memory fake for the SqlStorage seam the learnings/reviews services
 * use. `fail` injects a store failure for matching statements.
 */
function makeFakeSql(fail?: FailPredicate) {
  const learnings: any[] = [];
  const reviews: any[] = [];
  const sql = {
    exec(text: string, ...params: any[]) {
      if (fail && fail(text, params)) throw new Error("injected store failure");
      if (/^\s*CREATE/i.test(text)) return [];
      if (/INSERT INTO mas_learnings/i.test(text)) {
        const [id, domain, observation, evidence_refs, confidence, source] = params;
        learnings.push({
          id, domain, observation, evidence_refs, confidence, source,
          created_at: new Date().toISOString(), superseded_by: null,
        });
        return [];
      }
      if (/FROM mas_learnings/i.test(text)) {
        let rows = learnings.filter((r) => r.superseded_by === null);
        const m = text.match(/domain = '([^']*)'/);
        if (m) rows = rows.filter((r) => r.domain === m[1]);
        rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return rows.map((r) => ({ ...r }));
      }
      if (/FROM mas_strategy_reviews/i.test(text)) {
        return reviews.map((r) => ({ ...r }));
      }
      return [];
    },
  };
  return { sql, learnings, reviews };
}

function seedApprovedReviews(reviews: any[], n: number, label = "Momentum breakout") {
  for (let i = 0; i < n; i++) {
    reviews.push({
      id: `rev_${i}`, symbol: "AAPL", candidate_id: `cand_${i}`, label,
      rank: i + 1, rationale: "test", quant_status: "verified",
      decision: "approved", decided_at: "2026-10-17T00:00:00.000Z",
      created_at: "2026-10-17T00:00:00.000Z",
    });
  }
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});
const loggedText = () => errSpy.mock.calls.map((c: any[]) => c.map(String).join(" ")).join("\n");

describe("runReflection — persistence honesty (#784)", () => {
  it("happy path: findings persist, result shape and run-meta text unchanged, nothing logged", () => {
    const { sql, learnings, reviews } = makeFakeSql();
    seedApprovedReviews(reviews, 5);
    const result = runReflection(sql, SUNDAY);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].domain).toBe("strategy_ranking");
    expect(result.learningsRecorded).toBe(1);
    expect("learningsFailed" in result).toBe(false);
    expect("analysisFailures" in result).toBe(false);
    expect(learnings).toHaveLength(2);
    const meta = learnings.find((l) => l.domain === "reflection_meta");
    expect(meta?.observation).toBe("Weekly reflection completed: 1 findings, 1 learnings recorded.");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("all learning writes fail: counted in learningsFailed, logged, findings still computed", () => {
    const { sql, learnings, reviews } = makeFakeSql((text) => /INSERT INTO mas_learnings/i.test(text));
    seedApprovedReviews(reviews, 5);
    const result = runReflection(sql, SUNDAY);
    expect(result.findings).toHaveLength(1);
    expect(result.learningsRecorded).toBe(0);
    expect(result.learningsFailed).toBe(2); // the finding write + the run-meta write
    expect(learnings).toHaveLength(0);
    expect(errSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(loggedText()).toContain("[Reflection]");
  });

  it("only the run-meta write fails: finding lands, failure counted and logged", () => {
    const { sql, learnings, reviews } = makeFakeSql(
      (text, params) => /INSERT INTO mas_learnings/i.test(text) && params[1] === "reflection_meta"
    );
    seedApprovedReviews(reviews, 5);
    const result = runReflection(sql, SUNDAY);
    expect(result.learningsRecorded).toBe(1);
    expect(result.learningsFailed).toBe(1);
    expect(learnings).toHaveLength(1);
    expect(learnings[0].domain).toBe("strategy_ranking");
    expect(loggedText()).toMatch(/run-meta|already-ran guard/);
  });

  it("already-ran guard read fails: run proceeds (deliberate fail-open) and the failure is logged", () => {
    const { sql, reviews } = makeFakeSql(
      (text) => /FROM mas_learnings/i.test(text) && text.includes("domain = 'reflection_meta'")
    );
    seedApprovedReviews(reviews, 5);
    const result = runReflection(sql, SUNDAY);
    expect(result.skipped).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.learningsRecorded).toBe(1);
    expect(errSpy.mock.calls.length).toBe(1);
    expect(loggedText()).toMatch(/guard/i);
  });

  it("already-ran guard still skips when a reflection_meta learning exists this week", () => {
    const { sql, learnings } = makeFakeSql();
    learnings.push({
      id: "learn_meta_prev", domain: "reflection_meta",
      observation: "Weekly reflection completed: 0 findings, 0 learnings recorded.",
      evidence_refs: "[]", confidence: 1.0, source: "reflection",
      created_at: "2026-10-18T06:00:00.000Z", superseded_by: null,
    });
    const result = runReflection(sql, SUNDAY);
    expect(result.skipped).toBe("already ran this week");
    expect(result.learningsRecorded).toBe(0);
    expect(learnings).toHaveLength(1); // no new writes
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("strategy-review section fails: counted in analysisFailures, other sections still run", () => {
    const { sql, learnings } = makeFakeSql((text) => /FROM mas_strategy_reviews/i.test(text));
    learnings.push({
      id: "learn_stale_1", domain: "screener_thresholds",
      observation: "Threshold tuned long ago and never re-checked.",
      evidence_refs: "[]", confidence: 0.5, source: "human",
      created_at: new Date(Date.now() - 100 * 86_400_000).toISOString(), superseded_by: null,
    });
    const result = runReflection(sql, SUNDAY);
    expect(result.analysisFailures).toBe(1);
    expect("learningsFailed" in result).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].domain).toBe("screener_thresholds");
    expect(result.learningsRecorded).toBe(1);
    expect(loggedText()).toMatch(/Strategy-review/);
    const meta = learnings.find((l) => l.domain === "reflection_meta");
    expect(meta?.observation).toContain("analysis section");
  });

  it("stale-learning section fails: counted in analysisFailures, review findings still recorded", () => {
    const { sql, reviews, learnings } = makeFakeSql(
      (text) => /FROM mas_learnings/i.test(text) && !text.includes("domain =")
    );
    seedApprovedReviews(reviews, 5);
    const result = runReflection(sql, SUNDAY);
    expect(result.analysisFailures).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].domain).toBe("strategy_ranking");
    expect(result.learningsRecorded).toBe(1);
    expect(learnings.filter((l) => l.domain === "strategy_ranking")).toHaveLength(1);
    expect(loggedText()).toMatch(/Stale-learning/);
  });

  it("not Sunday: skips without touching the store", () => {
    const { sql } = makeFakeSql(() => true); // any store call would throw
    const result = runReflection(sql, MONDAY);
    expect(result).toEqual({ findings: [], learningsRecorded: 0, skipped: "not Sunday" });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("source pin: no bare catch {} remains in reflection.ts", () => {
    const src = readFileSync(
      path.join(fileURLToPath(new URL("../src", import.meta.url)), "services/reflection.ts"),
      "utf-8"
    );
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
});
