// @vitest-environment node
/**
 * #2356 (#1976 step 4c) — evidence-satellite ports conformance.
 *
 * One contract suite per port, run over EVERY adapter the
 * composition roots can serve: the DO-SQLite adapters (over a
 * node:sqlite-backed SqlStorage double with real semantics)
 * via createEvidenceSatellitePorts, and the in-memory
 * adapters via createInMemoryEvidenceSatellitePorts. The
 * contract is the legacy modules' behaviour as characterized
 * in evidence_satellites_step4c_characterization_2356:
 * tenant scoping where the family has it, referential
 * honesty, upsert-merge, append-only tracking, the reader's
 * in-code sort, and never-throws activity recording.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  createEvidenceSatellitePorts,
  createInMemoryEvidenceSatellitePorts,
  type EvidenceSatellitePorts,
} from "../src/data/createEvidenceSatellitePorts";

/** SqlStorage-shaped executor over node:sqlite (real semantics). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] & { changes?: number } {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { changes?: number };
    out.changes = Number(info.changes);
    return out;
  }
}

function spinWait(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* force distinct created_at timestamps */ }
}

const ADAPTERS: Array<[string, () => EvidenceSatellitePorts]> = [
  ["DO-SQLite", () => createEvidenceSatellitePorts(new SqliteTestStorage() as never)],
  ["in-memory", () => createInMemoryEvidenceSatellitePorts()],
];

for (const [name, make] of ADAPTERS) {
  describe(`conformance 4c [${name}]: GoalScenarioStore`, () => {
    it("create/get round-trips with payload JSON intact", () => {
      const p = make();
      const g = p.goals.createGoal({ userLogin: "alice", kind: "income", title: "T", payload: { x: [1, 2] } });
      expect(p.goals.getGoal("alice", g.id)?.payload).toEqual({ x: [1, 2] });
      expect(g.status).toBe("proposed");
      expect(g.source).toBe("user");
    });

    it("createGoal refuses a missing owner", () => {
      const p = make();
      expect(() => p.goals.createGoal({ kind: "income", title: "T" })).toThrow(/owning userLogin/);
    });

    it("tenant isolation: cross-tenant reads are invisible, updates fail", () => {
      const p = make();
      const g = p.goals.createGoal({ userLogin: "alice", kind: "income", title: "T" });
      expect(p.goals.getGoal("bob", g.id)).toBeNull();
      expect(p.goals.listGoals("bob")).toEqual([]);
      expect(p.goals.updateGoalStatus("bob", g.id, "active")).toBe(false);
      expect(p.goals.updateGoalStatus("alice", g.id, "active")).toBe(true);
      expect(p.goals.listGoals("alice", "active")).toHaveLength(1);
      expect(p.goals.listGoals("alice", "paused")).toEqual([]);
    });

    it("lists newest first", () => {
      const p = make();
      const a = p.goals.createGoal({ userLogin: "alice", kind: "income", title: "A" });
      spinWait(3);
      const b = p.goals.createGoal({ userLogin: "alice", kind: "directional", title: "B" });
      expect(p.goals.listGoals("alice").map((g) => g.id)).toEqual([b.id, a.id]);
    });

    it("scenario attach: orphan and cross-tenant attaches return null", () => {
      const p = make();
      const g = p.goals.createGoal({ userLogin: "alice", kind: "repair", title: "R" });
      expect(p.goals.createScenario({ userLogin: "alice", goalId: "nope", portfolioRef: { kind: "real" } })).toBeNull();
      expect(p.goals.createScenario({ userLogin: "bob", goalId: g.id, portfolioRef: { kind: "real" } })).toBeNull();
      const s = p.goals.createScenario({ userLogin: "alice", goalId: g.id, portfolioRef: { kind: "real", ref: "x" }, shocks: { v: 1 } });
      expect(s?.shocks).toEqual({ v: 1 });
      expect(p.goals.listScenarios("alice", g.id)).toHaveLength(1);
      expect(p.goals.getScenario("bob", s!.id)).toBeNull();
    });

    it("outcome attach: named parents must exist for the tenant; filters work", () => {
      const p = make();
      const g = p.goals.createGoal({ userLogin: "alice", kind: "income", title: "I" });
      expect(p.goals.recordOutcome({ userLogin: "alice", goalId: "nope", kind: "paper" })).toBeNull();
      const o = p.goals.recordOutcome({ userLogin: "alice", goalId: g.id, kind: "paper", recommendationRef: "r1" });
      expect(o?.goalId).toBe(g.id);
      expect(p.goals.listOutcomes("alice", { goalId: g.id })).toHaveLength(1);
      expect(p.goals.listOutcomes("alice", { scenarioId: "none" })).toEqual([]);
      expect(p.goals.listOutcomes("bob")).toEqual([]);
    });
  });

  describe(`conformance 4c [${name}]: JobOutcomeStore`, () => {
    it("record/list round-trips the full row shape", () => {
      const p = make();
      const row = p.jobOutcomes.record({
        id: "j1", kind: "goal", trigger: "manual", status: "partial",
        scanned: 5, matched: 2, origin: "test", createdAt: "2026-10-29T00:00:00.000Z",
      });
      expect(row.scanned).toBe(5);
      expect(p.jobOutcomes.list().map((r) => r.id)).toEqual(["j1"]);
    });

    it("upsert-merge: undefined never wipes, delivery merges, completed clears error", () => {
      const p = make();
      p.jobOutcomes.record({
        id: "j1", kind: "stock", trigger: "scheduled", status: "failed",
        scanned: 9, codedError: "E", deliveryStates: { a: "1" }, origin: "x",
        createdAt: "2026-10-28T00:00:00.000Z",
      });
      const merged = p.jobOutcomes.record({
        id: "j1", kind: "stock", trigger: "scheduled", status: "completed",
        deliveryStates: { b: "2" }, origin: "y",
      });
      expect(merged.scanned).toBe(9);
      expect(merged.codedError).toBeNull();
      expect(merged.deliveryStates).toEqual({ a: "1", b: "2" });
      expect(merged.createdAt).toBe("2026-10-28T00:00:00.000Z");
    });

    it("list is newest-first and honours the limit", () => {
      const p = make();
      p.jobOutcomes.record({ id: "old", kind: "stock", trigger: "manual", status: "completed", origin: "t", createdAt: "2026-10-27T00:00:00.000Z" });
      p.jobOutcomes.record({ id: "new", kind: "stock", trigger: "manual", status: "completed", origin: "t", createdAt: "2026-10-28T00:00:00.000Z" });
      expect(p.jobOutcomes.list().map((r) => r.id)).toEqual(["new", "old"]);
      expect(p.jobOutcomes.list(1).map((r) => r.id)).toEqual(["new"]);
    });

    it("prune: age rule and cap rule are independent", () => {
      const p = make();
      const now = Date.parse("2026-10-29T00:00:00.000Z");
      p.jobOutcomes.record({ id: "ancient", kind: "stock", trigger: "manual", status: "completed", origin: "t", createdAt: "2026-01-01T00:00:00.000Z" });
      p.jobOutcomes.record({ id: "fresh", kind: "stock", trigger: "manual", status: "completed", origin: "t", createdAt: "2026-10-28T00:00:00.000Z" });
      expect(p.jobOutcomes.prune({ retentionDays: 90, now: () => now }).deletedByAge).toBe(1);
      for (let i = 0; i < 4; i++) {
        p.jobOutcomes.record({ id: `c${i}`, kind: "stock", trigger: "manual", status: "completed", origin: "t", createdAt: `2026-10-28T0${i}:00:00.000Z` });
      }
      expect(p.jobOutcomes.prune({ retentionDays: 0, keepRows: 2, now: () => now }).deletedByCap).toBe(3);
    });

    it("maybePrune watermark gates to once per interval", () => {
      const p = make();
      const t0 = Date.parse("2026-10-29T00:00:00.000Z");
      expect(p.jobOutcomes.maybePrune(t0)).toBe(true);
      expect(p.jobOutcomes.maybePrune(t0 + 60_000)).toBe(false);
      expect(p.jobOutcomes.maybePrune(t0 + 25 * 3_600_000)).toBe(true);
    });
  });

  describe(`conformance 4c [${name}]: StrategyReviewStore`, () => {
    it("record/list: pending by default, rank order within the same instant", () => {
      const p = make();
      p.strategyReviews.recordCandidates("AAPL", [
        { id: "c2", label: "B", rank: 2, rationale: "r2", quantStatus: "verified" },
        { id: "c1", label: "A", rank: 1, rationale: "r1", quantStatus: "unverified" },
      ]);
      const rows = p.strategyReviews.list();
      expect(rows.map((r) => r.candidateId)).toEqual(["c1", "c2"]);
      expect(rows[0].decision).toBe("pending");
    });

    it("same-day re-record replaces and re-pends", () => {
      const p = make();
      p.strategyReviews.recordCandidates("AAPL", [
        { id: "c1", label: "A", rank: 1, rationale: "r", quantStatus: "verified" },
      ]);
      const row = p.strategyReviews.list()[0];
      expect(p.strategyReviews.decide(row.id, "approved")).toBe(true);
      p.strategyReviews.recordCandidates("AAPL", [
        { id: "c1", label: "A2", rank: 1, rationale: "r2", quantStatus: "verified" },
      ]);
      const after = p.strategyReviews.list();
      expect(after).toHaveLength(1);
      expect(after[0].label).toBe("A2");
      expect(after[0].decision).toBe("pending");
    });

    it("decide moves only a pending row, exactly once; decision filter works", () => {
      const p = make();
      p.strategyReviews.recordCandidates("MSFT", [
        { id: "c1", label: "A", rank: 1, rationale: "r", quantStatus: "verified" },
      ]);
      const row = p.strategyReviews.list()[0];
      expect(p.strategyReviews.decide(row.id, "rejected")).toBe(true);
      expect(p.strategyReviews.decide(row.id, "approved")).toBe(false);
      expect(p.strategyReviews.list("rejected")).toHaveLength(1);
      expect(p.strategyReviews.list("pending")).toEqual([]);
      expect(p.strategyReviews.list()[0].decidedAt).not.toBeNull();
    });
  });

  describe(`conformance 4c [${name}]: OutcomeTrackingStore`, () => {
    function seed(p: EvidenceSatellitePorts): void {
      const g = p.goals.createGoal({ userLogin: "alice", kind: "income", title: "I" });
      p.goals.recordOutcome({ userLogin: "alice", goalId: g.id, kind: "paper", recommendationRef: "rec-1" });
    }

    it("start returns null without an outcome row; summary is open/pending after", () => {
      const p = make();
      expect(p.outcomeTracking.start("alice", { recommendationRef: "ghost" })).toBeNull();
      seed(p);
      const s = p.outcomeTracking.start("alice", { recommendationRef: "rec-1" });
      expect(s?.status).toBe("open");
      expect(s?.quality).toBe("pending");
      expect(s?.provenance.goalId).not.toBeNull();
    });

    it("start is idempotent (first provenance wins)", () => {
      const p = make();
      seed(p);
      const s1 = p.outcomeTracking.start("alice", { recommendationRef: "rec-1", now: new Date("2026-10-20T00:00:00.000Z") });
      const s2 = p.outcomeTracking.start("alice", { recommendationRef: "rec-1", now: new Date("2026-10-22T00:00:00.000Z") });
      expect(s2?.trackedAt).toBe(s1?.trackedAt);
      expect(p.outcomeTracking.list("alice")).toHaveLength(1);
    });

    it("first terminal stands; no-price terminal is Unverified; priced is Verified", () => {
      const p = make();
      seed(p);
      p.outcomeTracking.start("alice", { recommendationRef: "rec-1" });
      expect(p.outcomeTracking.recordTerminal("alice", "rec-1", { kind: "expired" }).appended).toBe(true);
      expect(p.outcomeTracking.recordTerminal("alice", "rec-1", { kind: "realized", pnlAfterCost: 1 }).appended).toBe(false);
      const s = p.outcomeTracking.list("alice")[0];
      expect(s.quality).toBe("unverified");
      expect(s.pnlAfterCost).toBeNull();
    });

    it("expireDue awaits a supplied price, then expires with it", () => {
      const p = make();
      seed(p);
      p.outcomeTracking.start("alice", { recommendationRef: "rec-1", expiryDate: "2026-10-01" });
      const now = new Date("2026-10-29T00:00:00.000Z");
      expect(p.outcomeTracking.expireDue("alice", { now, finalPnlByRef: {} }))
        .toEqual({ expired: [], awaitingPrice: ["rec-1"] });
      expect(p.outcomeTracking.expireDue("alice", { now, finalPnlByRef: { "rec-1": 4 } }))
        .toEqual({ expired: ["rec-1"], awaitingPrice: [] });
      expect(p.outcomeTracking.list("alice")[0].quality).toBe("verified");
    });

    it("tenant isolation and the joined outcomes path", () => {
      const p = make();
      seed(p);
      p.outcomeTracking.start("alice", { recommendationRef: "rec-1" });
      expect(p.outcomeTracking.list("bob")).toEqual([]);
      const path = p.outcomeTracking.buildPath("alice", { ideas: [] } as never);
      expect(path).toHaveLength(1);
      expect(path[0].tracking?.recommendationRef).toBe("rec-1");
      expect(path[0].outcome.recommendationRef).toBe("rec-1");
    });
  });

  describe(`conformance 4c [${name}]: ComparisonLedgerStore`, () => {
    it("record/list round-trips with the in-code sort (created_at, arm, candidate)", () => {
      const p = make();
      p.comparisonLedger.ensureTable(); // the kernel seam ensures before recording (legacy contract)
      const rec = (id: string, runId: string, arm: string, cand: string, at: string) =>
        p.comparisonLedger.recordOutcome({
          id, runId, arm, candidateId: cand, structure: "spread",
          symbol: "AAPL", status: "ranked", provenance: "panel", createdAt: at,
        });
      rec("1", "run-1", "quant", "c2", "2026-10-29T00:00:02.000Z");
      rec("2", "run-1", "llm", "c1", "2026-10-29T00:00:02.000Z");
      rec("3", "run-1", "llm", "c0", "2026-10-29T00:00:01.000Z");
      expect(p.comparisonLedger.listOutcomes("run-1").map((r) => r.id)).toEqual(["3", "2", "1"]);
    });

    it("runId filter: unfiltered lists all runs; filtered lists one", () => {
      const p = make();
      p.comparisonLedger.ensureTable();
      const rec = (id: string, runId: string) =>
        p.comparisonLedger.recordOutcome({
          id, runId, arm: "llm", candidateId: id, structure: "s",
          symbol: "AAPL", status: "ranked", provenance: "panel", createdAt: "2026-10-29T00:00:00.000Z",
        });
      rec("a", "run-1");
      rec("b", "run-2");
      expect(p.comparisonLedger.listOutcomes()).toHaveLength(2);
      expect(p.comparisonLedger.listOutcomes("run-2").map((r) => r.id)).toEqual(["b"]);
    });
  });

  describe(`conformance 4c [${name}]: ScreeningActivityStore`, () => {
    it("record returns an id; list is tenant-scoped and newest-first", () => {
      const p = make();
      const id = p.screeningActivity.record({
        userLogin: "alice", kind: "screen_run", summary: "ran",
        detail: { n: 1 }, createdAt: "2026-10-28T00:00:00.000Z",
      });
      expect(id).toMatch(/^sact_/);
      p.screeningActivity.record({
        userLogin: "alice", kind: "delivery", summary: "sent",
        createdAt: "2026-10-29T00:00:00.000Z",
      });
      p.screeningActivity.record({
        userLogin: "bob", kind: "screen_run", summary: "other",
        createdAt: "2026-10-29T01:00:00.000Z",
      });
      const rows = p.screeningActivity.list("alice");
      expect(rows.map((r) => r.summary)).toEqual(["sent", "ran"]);
      expect(rows[1].detail).toEqual({ n: 1 });
    });

    it("record never throws: incomplete input returns null; empty login lists empty", () => {
      const p = make();
      expect(p.screeningActivity.record({ userLogin: "", kind: "screen_run", summary: "x" })).toBeNull();
      expect(p.screeningActivity.record({ userLogin: "alice", kind: "screen_run", summary: "" })).toBeNull();
      expect(p.screeningActivity.list("")).toEqual([]);
    });

    it("list limit is honoured and capped", () => {
      const p = make();
      for (let i = 0; i < 3; i++) {
        p.screeningActivity.record({
          userLogin: "alice", kind: "screen_run", summary: `s${i}`,
          createdAt: `2026-10-2${i}T00:00:00.000Z`,
        });
      }
      expect(p.screeningActivity.list("alice", 2)).toHaveLength(2);
      expect(p.screeningActivity.list("alice", 2)[0].summary).toBe("s2");
    });
  });
}
