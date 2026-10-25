/**
 * Issue #887 — the DatabaseORM exec seam regression pins.
 *
 * SqlStorage-style services (learnings, strategy reviews, reflection)
 * call `sql.exec(...)`. Routes hand them `ctx.getOrm()` — a
 * DatabaseORM, which historically exposed `execQuery()` but no
 * `exec()`: every store op threw `sql.exec is not a function`, so the
 * production reflection job computed no findings and recorded no
 * learnings (only #784's failure counters showed it), and the
 * learnings routes 500'd. Unit suites never saw it — they pass fake
 * sql objects that do have exec (the §18.4 stub-honesty class).
 *
 * These pins run the real services over a REAL DatabaseORM backed by
 * MockSqlStorage — the same composition the routes use.
 */
import { describe, it, expect } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { recordLearning, getActiveLearnings } from "../src/services/learnings";
import { recordStrategyCandidates, decideStrategyReview, listStrategyReviews } from "../src/services/strategyReviews";
import { runReflection } from "../src/services/reflection";

const SUNDAY = new Date("2026-10-18T12:00:00.000Z");

function makeOrm() {
  const storage = new MockSqlStorage();
  const orm = new DatabaseORM(storage as any);
  return { storage, orm: orm as any };
}

describe("DatabaseORM as a SqlStorage for exec-style services (#887)", () => {
  it("exposes exec delegating to the wrapped storage", () => {
    const { orm } = makeOrm();
    expect(typeof orm.exec).toBe("function");
  });

  it("learnings round-trip over the ORM", () => {
    const { orm } = makeOrm();
    const id = recordLearning(orm, {
      domain: "probe",
      observation: "orm exec seam works",
      confidence: 0.9,
      source: "human",
    });
    expect(id).toBeTruthy();
    const rows = getActiveLearnings(orm, "probe");
    expect(rows).toHaveLength(1);
    expect(rows[0].observation).toBe("orm exec seam works");
  });

  it("runReflection over the ORM computes findings, persists learnings, and wires review candidates (#705/#753 production path)", () => {
    const { storage, orm } = makeOrm();
    // Seed five approved reviews of one family via the RAW storage
    // (the pre-existing working seam), as production data would exist.
    recordStrategyCandidates(storage as any, "AAPL", [
      { id: "c1", label: "Momentum breakout", rank: 1, rationale: "r", quantStatus: "verified" },
      { id: "c2", label: "Momentum breakout", rank: 2, rationale: "r", quantStatus: "verified" },
      { id: "c3", label: "Momentum breakout", rank: 3, rationale: "r", quantStatus: "verified" },
      { id: "c4", label: "Momentum breakout", rank: 4, rationale: "r", quantStatus: "verified" },
      { id: "c5", label: "Momentum breakout", rank: 5, rationale: "r", quantStatus: "verified" },
    ]);
    for (const r of listStrategyReviews(storage as any)) {
      decideStrategyReview(storage as any, r.id, "approved");
    }

    const result = runReflection(orm, SUNDAY);
    expect(result.analysisFailures).toBeUndefined();
    expect(result.learningsFailed).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].domain).toBe("strategy_ranking");
    expect(result.learningsRecorded).toBe(1);
    // Learnings actually persisted in the underlying storage.
    expect(getActiveLearnings(storage as any, "strategy_ranking")).toHaveLength(1);
    expect(getActiveLearnings(storage as any, "reflection_meta")).toHaveLength(1);
    // And the #753 wiring fired through the same seam.
    expect(result.reviewCandidatesCreated).toBe(1);
    const wired = listStrategyReviews(orm, "pending").filter((r) => r.symbol === "REFLECTION");
    expect(wired).toHaveLength(1);
  });
});
