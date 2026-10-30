// @vitest-environment node
/**
 * #2357 (#1976 step 4b) — strategy-cluster characterization.
 *
 * Pins, against the UNMODIFIED service modules, the behaviour
 * of the five cluster families that the #2346 suites and the
 * older phase suites do NOT already pin at the storage seam:
 * policy caps/gates exact-restore semantics, the weights v2
 * per-regime / collapsed reads and version records, reselection
 * proposal persistence (tenant-scoped), adaptation budget
 * settings overrides, and the challenger read paths (list /
 * approvals / active set). These pins must pass pre-cutover
 * and post-cutover without adaptation: the port move changes
 * where statements live, never what they do.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  ensureStrategyPolicyTables,
  getStrategyWeightCap,
  getStrategyWeightCaps,
  setStrategyWeightCap,
  getStrategyGates,
  hasStrategyGateRow,
  isStrategyGatedOff,
  setStrategyGate,
} from "../src/services/strategyPolicyState";
import {
  applyWeightsV2Targets,
  currentWeightsVersion,
  getStrategyWeightsV2,
  getStrategyWeightsV2Collapsed,
  getStrategyWeightsV2ForRegime,
  listWeightVersionRecords,
  weightsV2Key,
} from "../src/services/strategyWeightsV2";
import {
  recordReselectionProposal,
  listReselectionProposals,
  reselectStrategyBank,
  buildStrategyRegimeEvidence,
  type ReselectionProposal,
} from "../src/services/strategyBankReselection";
import {
  applyAdaptation,
  getAdaptationBudget,
  isAdaptationHalted,
  listAdaptationAudit,
  DEFAULT_ADAPTATION_BUDGET,
} from "../src/services/adaptationAudit";
import {
  createChallenger,
  getActiveStrategySet,
  listChallengerApprovals,
  listChallengers,
  recordChallengerApproval,
} from "../src/services/championChallenger";

/** SqlStorage-shaped executor over node:sqlite (real semantics). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

const NOW = new Date("2026-10-29T12:00:00.000Z");

function makeSettings(sql: SqliteTestStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS mas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  );
}
function setSetting(sql: SqliteTestStorage, key: string, value: string): void {
  makeSettings(sql);
  sql.exec(
    `INSERT OR REPLACE INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)`,
    key, value, NOW.toISOString(),
  );
}

describe("characterization 4b: strategy policy state", () => {
  it("cap round-trip: absent is null, set reads back, map lists all, null deletes", () => {
    const sql = new SqliteTestStorage();
    ensureStrategyPolicyTables(sql as never);
    expect(getStrategyWeightCap(sql as never, "iron_condor")).toBeNull();
    setStrategyWeightCap(sql as never, "iron_condor", 1.5, NOW);
    setStrategyWeightCap(sql as never, "bull_put", 0.5, NOW);
    expect(getStrategyWeightCap(sql as never, "iron_condor")).toBe(1.5);
    expect(getStrategyWeightCaps(sql as never)).toEqual({ iron_condor: 1.5, bull_put: 0.5 });
    setStrategyWeightCap(sql as never, "iron_condor", null, NOW);
    expect(getStrategyWeightCap(sql as never, "iron_condor")).toBeNull();
    expect(getStrategyWeightCaps(sql as never)).toEqual({ bull_put: 0.5 });
  });

  it("gate round-trip: no row vs row-off vs row-on are three distinct states", () => {
    const sql = new SqliteTestStorage();
    expect(hasStrategyGateRow(sql as never, "iron_condor")).toBe(false);
    expect(isStrategyGatedOff(sql as never, "iron_condor")).toBe(false);
    setStrategyGate(sql as never, "iron_condor", false, NOW);
    expect(hasStrategyGateRow(sql as never, "iron_condor")).toBe(true);
    expect(isStrategyGatedOff(sql as never, "iron_condor")).toBe(false);
    setStrategyGate(sql as never, "iron_condor", true, NOW);
    expect(isStrategyGatedOff(sql as never, "iron_condor")).toBe(true);
    expect(getStrategyGates(sql as never)).toEqual({ iron_condor: true });
    setStrategyGate(sql as never, "iron_condor", null, NOW);
    expect(hasStrategyGateRow(sql as never, "iron_condor")).toBe(false);
  });
});

describe("characterization 4b: strategy weights v2 reads", () => {
  it("per-regime read never leaks another regime; collapsed read is the mean", () => {
    const sql = new SqliteTestStorage();
    const apply = (strategy: string, regime: string, weight: number) =>
      applyWeightsV2Targets(sql as never, [{ strategy, regime, weight }], {
        actor: "owner", rationale: "characterization seed", now: NOW,
      });
    apply("iron_condor", "chop", 1.2);
    apply("iron_condor", "bull", 1.6);
    apply("bull_put", "chop", 0.8);
    expect(getStrategyWeightsV2(sql as never)).toEqual({
      [weightsV2Key("iron_condor", "chop")]: 1.2,
      [weightsV2Key("iron_condor", "bull")]: 1.6,
      [weightsV2Key("bull_put", "chop")]: 0.8,
    });
    expect(getStrategyWeightsV2ForRegime(sql as never, "chop")).toEqual({
      iron_condor: 1.2, bull_put: 0.8,
    });
    expect(getStrategyWeightsV2Collapsed(sql as never)).toEqual({
      iron_condor: 1.4, bull_put: 0.8,
    });
  });

  it("version records: before is null for a new row, and null-weight restore deletes the row", () => {
    const sql = new SqliteTestStorage();
    expect(currentWeightsVersion(sql as never)).toBe(0);
    applyWeightsV2Targets(sql as never, [{ strategy: "iron_condor", regime: "chop", weight: 1.3 }], {
      actor: "owner", rationale: "first", now: NOW,
    });
    expect(currentWeightsVersion(sql as never)).toBe(1);
    const recs = listWeightVersionRecords(sql as never);
    expect(recs).toHaveLength(1);
    expect(recs[0].before).toBeNull();
    expect(recs[0].after).toBe(1.3);
    applyWeightsV2Targets(sql as never, [{ strategy: "iron_condor", regime: "chop", weight: null }], {
      actor: "owner", rationale: "restore no-row", now: NOW,
    });
    expect(getStrategyWeightsV2(sql as never)).toEqual({});
    const recs2 = listWeightVersionRecords(sql as never);
    expect(recs2).toHaveLength(2);
    expect(recs2[1].before).toBe(1.3);
    // A deleted row records the default as its effective after.
    expect(recs2[1].after).toBe(1.0);
  });
});

describe("characterization 4b: reselection proposal persistence", () => {
  function proposal(): ReselectionProposal {
    const evidence = buildStrategyRegimeEvidence([
      { structure: "iron_condor", regime: "chop", evaluation: { pnlEstimatePerUnit: 2, rMultiple: 0.5 } },
      { structure: "iron_condor", regime: "chop", evaluation: { pnlEstimatePerUnit: 1, rMultiple: 0.4 } },
    ]);
    const many = Array.from({ length: 12 }, () => ({
      structure: "iron_condor", regime: "chop" as const,
      evaluation: { pnlEstimatePerUnit: 2, rMultiple: 0.5 },
    }));
    void evidence;
    return reselectStrategyBank({
      evidence: buildStrategyRegimeEvidence(many),
      weights: { iron_condor: 1.1 },
      regime: "chop",
      overallWinRate: 0.5,
      now: NOW,
    });
  }

  it("record/list round-trips tenant-scoped with the governance marker intact", () => {
    const sql = new SqliteTestStorage();
    const p = proposal();
    const id = recordReselectionProposal(sql as never, "alice", p);
    expect(id).toMatch(/^sbp-/);
    const listed = listReselectionProposals(sql as never, "alice");
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(id);
    expect(listed[0].regime).toBe("chop");
    expect(listed[0].proposal.governance).toBe("proposal_only_not_promoted");
    expect(listed[0].proposal.activeSet.map((a) => a.strategy)).toEqual(["iron_condor"]);
    expect(listReselectionProposals(sql as never, "bob")).toEqual([]);
  });
});

describe("characterization 4b: adaptation budget + kill switch settings reads", () => {
  it("budget defaults stand with no settings; a settings override replaces one field", () => {
    const sql = new SqliteTestStorage();
    expect(getAdaptationBudget(sql as never)).toEqual(DEFAULT_ADAPTATION_BUDGET);
    setSetting(sql, "adaptation.maxPerPeriod", "1");
    const budget = getAdaptationBudget(sql as never);
    expect(budget.maxPerPeriod).toBe(1);
    expect(budget.periodDays).toBe(DEFAULT_ADAPTATION_BUDGET.periodDays);
  });

  it("a maxPerPeriod=1 override blocks the second apply and audits the block", () => {
    const sql = new SqliteTestStorage();
    setSetting(sql, "adaptation.maxPerPeriod", "1");
    const rec = {
      actor: "reflection-job", subject: "strategy-weight:Momentum", parameter: "weight",
      before: "1.0", after: "1.1", delta: 0.1, rationale: "r", dataWindow: "w",
    };
    let calls = 0;
    expect(applyAdaptation(sql as never, rec, () => { calls++; }, NOW).applied).toBe(true);
    expect(applyAdaptation(sql as never, rec, () => { calls++; }, NOW).applied).toBe(false);
    expect(calls).toBe(1);
    const rows = listAdaptationAudit(sql as never, "strategy-weight:Momentum");
    expect(rows.map((r) => r.status).sort()).toEqual(["applied", "blocked"]);
  });

  it("kill switch: unset does not halt; 'on' halts; a missing settings table halts (fail-closed)", () => {
    const sql = new SqliteTestStorage();
    // No mas_settings table at all: the read fails and the
    // switch is treated as thrown — the #756 fail-closed rule.
    expect(isAdaptationHalted(sql as never)).toBe(true);
    makeSettings(sql);
    expect(isAdaptationHalted(sql as never)).toBe(false);
    setSetting(sql, "adaptation.killSwitch", "on");
    expect(isAdaptationHalted(sql as never)).toBe(true);
  });
});

describe("characterization 4b: challenger read paths", () => {
  it("list is tenant-scoped; approvals refuse self-approval and record the rest", () => {
    const sql = new SqliteTestStorage();
    const mk = (userLogin: string, title: string) =>
      createChallenger(sql as never, userLogin, {
        kind: "weights", title, regime: "chop",
        spec: { weights: { iron_condor: 1.4 } },
        criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
        evalSetVersion: "v2", sourceProposalId: null,
        createdBy: "research-agent", now: NOW,
      });
    const a = mk("alice", "A");
    mk("bob", "B");
    expect(listChallengers(sql as never, "alice").map((c) => c.id)).toEqual([a.id]);
    expect(getActiveStrategySet(sql as never, "alice")).toBeNull();
    expect(
      recordChallengerApproval(sql as never, "alice", a.id, {
        approver: "research-agent", decision: "approved", now: NOW,
      }).ok,
    ).toBe(false);
    expect(
      recordChallengerApproval(sql as never, "alice", a.id, {
        approver: "owner-mubasher", decision: "approved", now: NOW,
      }).ok,
    ).toBe(true);
    const approvals = listChallengerApprovals(sql as never, "alice", a.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approver).toBe("owner-mubasher");
    expect(listChallengerApprovals(sql as never, "bob", a.id)).toEqual([]);
  });
});
