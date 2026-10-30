// @vitest-environment node
/**
 * #2357 (#1976 step 4b) — strategy-cluster ports conformance.
 *
 * One contract suite per port, run over EVERY adapter the
 * composition roots can serve: the DO-SQLite adapters (over a
 * node:sqlite-backed SqlStorage double with real semantics)
 * via createStrategyClusterPorts, and the in-memory adapters
 * via createInMemoryStrategyClusterPorts. The contract is the
 * legacy modules' behaviour as characterized in
 * strategy_cluster_step4b_characterization_2357 and the #2346
 * suites: exact-restore null semantics, tenant scoping,
 * append-only records, the collapsed/regime weight reads.
 *
 * The final describe RE-PROVES #2346's atomicity property on
 * the new seam: the promotion transition's legs now run
 * through these ports, so per-leg fault injection against the
 * service entry points must still show post-state == pre-state
 * exactly, and a transaction unit composed directly over the
 * ports must roll back every port's writes together.
 */
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createInMemoryStrategyClusterPorts,
  createStrategyClusterPorts,
  type StrategyClusterPorts,
} from "../src/data/createStrategyClusterPorts";
import {
  createChallenger,
  getChallenger,
  listPromotionRecords,
  promoteChallenger,
  recordChallengerApproval,
  resolveChallengerOutcome,
  rollbackChallengerPromotion,
} from "../src/services/championChallenger";
import {
  applyWeightsV2Targets,
  getStrategyWeightsV2 as getWeightsService,
  weightsV2Key,
} from "../src/services/strategyWeightsV2";
import { isStrategyGatedOff } from "../src/services/strategyPolicyState";
import {
  getTransactionRunner,
  registerTransactionRunner,
} from "../src/data/transactionRunnerProvider";
import { aspectTransactionRunner } from "../src/data/transactionRunner";
import type { Challenger } from "../src/data/challengerPorts";

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
  transactionSync<T>(closure: (txn: { sql: SqliteTestStorage }) => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const result = closure({ sql: this });
      this.sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Fault-injecting sql handle: throws when a statement matches. */
class FaultySql {
  constructor(
    private readonly inner: SqliteTestStorage,
    private readonly pattern: RegExp,
    private readonly label: string,
  ) {}
  exec(query: string, ...params: unknown[]): unknown[] {
    if (this.pattern.test(query)) {
      throw new Error(`sabotage ${this.label}: ${query.slice(0, 80)}`);
    }
    return this.inner.exec(query, ...params);
  }
}

const NOW = new Date("2026-10-29T12:00:00.000Z");

const ADAPTERS: Array<[string, () => StrategyClusterPorts]> = [
  ["DO-SQLite", () => createStrategyClusterPorts(new SqliteTestStorage() as never)],
  ["in-memory", () => createInMemoryStrategyClusterPorts()],
];

for (const [name, make] of ADAPTERS) {
  describe(`conformance 4b [${name}]: StrategyWeightsStore`, () => {
    it("write/read round-trips; per-regime read does not leak; collapsed is the mean", () => {
      const p = make();
      p.weights.ensureTables();
      p.weights.writeWeightRow("iron_condor", "chop", 1.2, 1, NOW);
      p.weights.writeWeightRow("iron_condor", "bull", 1.6, 2, NOW);
      p.weights.writeWeightRow("bull_put", "chop", 0.8, 3, NOW);
      expect(p.weights.getWeights()).toEqual({
        [weightsV2Key("iron_condor", "chop")]: 1.2,
        [weightsV2Key("iron_condor", "bull")]: 1.6,
        [weightsV2Key("bull_put", "chop")]: 0.8,
      });
      expect(p.weights.getWeightsForRegime("chop")).toEqual({ iron_condor: 1.2, bull_put: 0.8 });
      expect(p.weights.getWeightsCollapsed()).toEqual({ iron_condor: 1.4, bull_put: 0.8 });
      expect(p.weights.weightRowExists("iron_condor", "chop")).toBe(true);
      expect(p.weights.weightRowExists("iron_condor", "bear")).toBe(false);
    });

    it("null weight deletes the row; version records are append-only and versioned", () => {
      const p = make();
      p.weights.ensureTables();
      expect(p.weights.currentVersion()).toBe(0);
      p.weights.writeWeightRow("iron_condor", "chop", 1.3, 1, NOW);
      p.weights.writeVersionRecord({
        version: 1, strategy: "iron_condor", regime: "chop", before: null, after: 1.3,
        signal: null, evaluated: 0, winRateAfterCost: null, avgRAfterCost: null,
        actor: "owner", rationale: "first",
      }, NOW);
      expect(p.weights.currentVersion()).toBe(1);
      p.weights.writeWeightRow("iron_condor", "chop", null, 2, NOW);
      expect(p.weights.getWeights()).toEqual({});
      const recs = p.weights.listVersionRecords();
      expect(recs).toHaveLength(1);
      expect(recs[0].before).toBeNull();
      expect(recs[0].after).toBe(1.3);
    });

    it("replace-by-key: a second write for the same key replaces, never duplicates", () => {
      const p = make();
      p.weights.ensureTables();
      p.weights.writeWeightRow("iron_condor", "chop", 1.1, 1, NOW);
      p.weights.writeWeightRow("iron_condor", "chop", 1.5, 2, NOW);
      expect(p.weights.getWeights()).toEqual({ [weightsV2Key("iron_condor", "chop")]: 1.5 });
    });
  });

  describe(`conformance 4b [${name}]: StrategyPolicyStore`, () => {
    it("cap round-trip with null-delete exact restore", () => {
      const p = make();
      expect(p.policy.getCap("iron_condor")).toBeNull();
      p.policy.setCap("iron_condor", 1.5, NOW);
      p.policy.setCap("bull_put", 0.5, NOW);
      expect(p.policy.getCaps()).toEqual({ iron_condor: 1.5, bull_put: 0.5 });
      p.policy.setCap("iron_condor", null, NOW);
      expect(p.policy.getCap("iron_condor")).toBeNull();
    });

    it("gate three states: no row, row-on, row-off are distinct and restorable", () => {
      const p = make();
      expect(p.policy.hasGateRow("iron_condor")).toBe(false);
      p.policy.setGate("iron_condor", false, NOW);
      expect(p.policy.hasGateRow("iron_condor")).toBe(true);
      expect(p.policy.isGatedOff("iron_condor")).toBe(false);
      p.policy.setGate("iron_condor", true, NOW);
      expect(p.policy.isGatedOff("iron_condor")).toBe(true);
      expect(p.policy.getGates()).toEqual({ iron_condor: true });
      p.policy.setGate("iron_condor", null, NOW);
      expect(p.policy.hasGateRow("iron_condor")).toBe(false);
    });
  });

  describe(`conformance 4b [${name}]: ChallengerStore`, () => {
    function seedChallenger(p: StrategyClusterPorts): Challenger {
      const challenger: Challenger = {
        id: "chl-test-1", userLogin: "alice", kind: "weights", title: "T",
        regime: "chop", spec: { weights: { iron_condor: 1.4 } },
        criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 },
        evalSetVersion: "v2", sourceProposalId: null, createdBy: "research-agent",
        status: "proposed", evaluation: null, createdAt: NOW.toISOString(),
      };
      p.challengers.ensureTables();
      p.challengers.insertChallenger(challenger);
      return challenger;
    }

    it("insert/get round-trips with spec/criteria JSON intact; tenant-scoped", () => {
      const p = make();
      const c = seedChallenger(p);
      const got = p.challengers.getChallenger("alice", c.id);
      expect(got?.spec).toEqual({ weights: { iron_condor: 1.4 } });
      expect(got?.criteria.minHoldoutEdge).toBe(0.0005);
      expect(p.challengers.getChallenger("bob", c.id)).toBeNull();
      expect(p.challengers.listChallengers("alice").map((x) => x.id)).toEqual([c.id]);
      expect(p.challengers.listChallengers("bob")).toEqual([]);
    });

    it("insert is insert-or-throw on the primary key (D-E.1)", () => {
      const p = make();
      const c = seedChallenger(p);
      expect(() => p.challengers.insertChallenger(c)).toThrow();
    });

    it("status write moves the row and preserves the evaluation when undefined", () => {
      const p = make();
      const c = seedChallenger(p);
      const evaluation = {
        datasetVersion: "v2", evaluatedAt: NOW.toISOString(),
        selection: { championScore: 0.1, challengerScore: 0.2, evaluated: 5 },
        holdout: { championScore: 0.1, challengerScore: 0.25, evaluated: 5 },
        verdict: "pass" as const, criteria: c.criteria,
      };
      p.challengers.setChallengerStatus(c, "evaluated", evaluation, NOW);
      const got = p.challengers.getChallenger("alice", c.id);
      expect(got?.status).toBe("evaluated");
      expect(got?.evaluation?.verdict).toBe("pass");
      p.challengers.setChallengerStatus(got!, "promoted", undefined, NOW);
      const after = p.challengers.getChallenger("alice", c.id);
      expect(after?.status).toBe("promoted");
      expect(after?.evaluation?.verdict).toBe("pass");
    });

    it("approvals: latest approved approver wins; lists are tenant-scoped, oldest first", () => {
      const p = make();
      const c = seedChallenger(p);
      expect(p.challengers.getApprovedApprover("alice", c.id)).toBeNull();
      p.challengers.insertApproval({
        id: "apr-1", challengerId: c.id, userLogin: "alice", approver: "owner-a",
        decision: "approved", createdAt: "2026-10-29T10:00:00.000Z",
      });
      p.challengers.insertApproval({
        id: "apr-2", challengerId: c.id, userLogin: "alice", approver: "owner-b",
        decision: "approved", createdAt: "2026-10-29T11:00:00.000Z",
      });
      expect(p.challengers.getApprovedApprover("alice", c.id)).toBe("owner-b");
      expect(p.challengers.listApprovals("alice", c.id).map((a) => a.approver)).toEqual(["owner-a", "owner-b"]);
      expect(p.challengers.listApprovals("bob", c.id)).toEqual([]);
    });

    it("promotion records round-trip prior/applied JSON; active set versions ascend", () => {
      const p = make();
      const c = seedChallenger(p);
      p.challengers.insertPromotion({
        id: "prm-1", challengerId: c.id, userLogin: "alice", action: "promoted",
        prior: { weights: [{ strategy: "iron_condor", weight: null }] }, applied: { weights: [] },
        weightsVersion: 3, actor: "owner-a", reason: null, createdAt: NOW.toISOString(),
      });
      const records = p.challengers.listPromotionRecords("alice", c.id);
      expect(records).toHaveLength(1);
      expect(records[0].prior.weights[0].weight).toBeNull();
      expect(p.challengers.listPromotionRecords("bob", c.id)).toEqual([]);
      expect(p.challengers.getActiveStrategySet("alice")).toBeNull();
      p.challengers.insertActiveSet({
        id: "act-1", userLogin: "alice", version: 1, strategies: ["iron_condor"],
        challengerId: c.id, createdAt: NOW.toISOString(),
      });
      p.challengers.insertActiveSet({
        id: "act-2", userLogin: "alice", version: 2, strategies: ["bull_put"],
        challengerId: null, createdAt: NOW.toISOString(),
      });
      const active = p.challengers.getActiveStrategySet("alice");
      expect(active?.version).toBe(2);
      expect(active?.strategies).toEqual(["bull_put"]);
    });
  });

  describe(`conformance 4b [${name}]: ReselectionStore`, () => {
    it("insert/list round-trips tenant-scoped, newest first, with the limit honoured", () => {
      const p = make();
      const proposal = (at: string) => ({
        regime: "chop" as const, generatedAt: at, governance: "proposal_only_not_promoted" as const,
        overallWinRate: 0.5, activeSet: [], log: [], evaluatedCount: 0, costUnitsUsed: 0, costCapUnits: 100,
      });
      p.reselection.ensureTable(); // the legacy seam ensures before recording
      p.reselection.insertProposal("sbp-1", "alice", proposal("2026-10-28T00:00:00.000Z"));
      p.reselection.insertProposal("sbp-2", "alice", proposal("2026-10-29T00:00:00.000Z"));
      p.reselection.insertProposal("sbp-3", "bob", proposal("2026-10-29T01:00:00.000Z"));
      const listed = p.reselection.listProposals("alice");
      expect(listed.map((r) => r.id)).toEqual(["sbp-2", "sbp-1"]);
      expect(listed[0].proposal.governance).toBe("proposal_only_not_promoted");
      expect(p.reselection.listProposals("alice", 1)).toHaveLength(1);
    });
  });

  describe(`conformance 4b [${name}]: AdaptationAuditStore + settingsRead`, () => {
    it("insert/list: applied and blocked rows, subject filter, newest first", () => {
      const p = make();
      const rec = {
        actor: "reflection-job", subject: "strategy-weight:Momentum", parameter: "weight",
        before: "1.0", after: "1.1", delta: 0.1, rationale: "r", dataWindow: "w",
      };
      p.adaptationAudit.insert({ ...rec, createdAt: "2026-10-28T00:00:00.000Z" }, "applied", null, NOW);
      p.adaptationAudit.insert({ ...rec, createdAt: "2026-10-29T00:00:00.000Z" }, "blocked", "budget", NOW);
      const rows = p.adaptationAudit.list("strategy-weight:Momentum");
      expect(rows.map((r) => r.status)).toEqual(["blocked", "applied"]);
      expect(rows[0].blockReason).toBe("budget");
      expect(p.adaptationAudit.list("other-subject")).toEqual([]);
      expect(p.adaptationAudit.list()).toHaveLength(2);
    });

    it("list limit clamps to 500", () => {
      const p = make();
      const rec = {
        actor: "a", subject: "s", parameter: "weight",
        before: "1", after: "2", delta: 0.1, rationale: "r", dataWindow: "w",
      };
      p.adaptationAudit.insert(rec, "applied", null, NOW);
      expect(p.adaptationAudit.list("s", 9999)).toHaveLength(1);
    });

    it("settingsRead: absent reads null (G-7 read-only surface)", () => {
      const p = make();
      // The cluster ensure creates mas_settings (the weights
      // family's pre-existing DDL ensure) — reads then see the
      // empty table, exactly as in production composition.
      p.weights.ensureTables();
      expect(p.settingsRead.get("adaptation.killSwitch")).toBeNull();
      expect(p.settingsRead.has("adaptation.killSwitch")).toBe(false);
    });
  });
}

/* ------------------------------------------------------------------ */
/* The promotion property, re-proved on the port seam                  */
/* ------------------------------------------------------------------ */

beforeAll(() => {
  registerTransactionRunner(aspectTransactionRunner);
});
afterAll(() => {
  registerTransactionRunner(undefined as never);
});

const OWNER = "owner-mubasher";
const CRITERIA = { minHoldoutEdge: 0.0005, minEvaluated: 1 };
const STATE_TABLES = [
  "mas_challengers", "mas_challenger_approvals", "mas_challenger_promotions",
  "mas_strategy_bank_active", "mas_strategy_weights_v2", "mas_strategy_weight_versions",
  "mas_strategy_gates", "mas_strategy_weight_caps", "mas_adaptation_audit", "mas_settings",
] as const;

function dumpState(sql: SqliteTestStorage): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of STATE_TABLES) {
    const exists = (sql.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t,
    ) as Array<{ name: string }>).length > 0;
    out[t] = exists ? (sql.exec(`SELECT * FROM ${t} ORDER BY rowid`) as unknown[]) : [];
  }
  return out;
}

function forceEvaluated(sql: SqliteTestStorage, challengerId: string): void {
  const evaluation = {
    datasetVersion: "v2", evaluatedAt: NOW.toISOString(),
    selection: { championScore: 0.1, challengerScore: 0.2, evaluated: 5 },
    holdout: { championScore: 0.1, challengerScore: 0.25, evaluated: 5 },
    verdict: "pass", criteria: CRITERIA,
  };
  sql.exec(
    `UPDATE mas_challengers SET status = 'evaluated', evaluation_json = ? WHERE id = ?`,
    JSON.stringify(evaluation), challengerId,
  );
}

function makeChallenger(
  sql: SqliteTestStorage,
  spec: Record<string, unknown>,
): Challenger {
  const challenger = createChallenger(sql as never, "alice", {
    kind: "weights", title: "T", regime: "chop", spec,
    criteria: CRITERIA, evalSetVersion: "v2", sourceProposalId: null,
    createdBy: "research-agent", now: NOW,
  });
  forceEvaluated(sql, challenger.id);
  expect(recordChallengerApproval(sql as never, "alice", challenger.id, {
    approver: OWNER, decision: "approved", now: NOW,
  }).ok).toBe(true);
  return challenger;
}

describe("re-proof 4b: the promotion unit over the ports is atomic per leg", () => {
  it.each([
    ["apply leg (weight write)", /INTO\s+mas_strategy_weights_v2/],
    ["promotion-record leg", /INTO\s+mas_challenger_promotions/],
    ["status leg", /UPDATE\s+mas_challengers\s+SET\s+status/],
  ])("promote: throw at %s ⇒ post-state equals pre-state exactly", (_label, pattern) => {
    const sql = new SqliteTestStorage();
    applyWeightsV2Targets(sql as never, [{ strategy: "iron_condor", regime: "chop", weight: 1.0 }], {
      actor: OWNER, rationale: "seed", now: NOW,
    });
    const challenger = makeChallenger(sql, { weights: { iron_condor: 1.4 } });
    const before = dumpState(sql);
    const faulty = new FaultySql(sql, pattern, _label);
    expect(() =>
      promoteChallenger(faulty as never, "alice", challenger.id, { actor: OWNER, now: NOW }, sql as never),
    ).toThrow(/sabotage/);
    expect(dumpState(sql)).toEqual(before);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("evaluated");
    expect(listPromotionRecords(sql as never, "alice", challenger.id)).toHaveLength(0);
  });

  it("retire: throw at the gate leg ⇒ post-state equals pre-state exactly", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, { retireStrategy: "iron_condor" });
    const before = dumpState(sql);
    const faulty = new FaultySql(sql, /INTO\s+mas_strategy_gates/, "gate leg");
    expect(() =>
      resolveChallengerOutcome(faulty as never, "alice", challenger.id, {
        outcome: "retire_strategy", actor: OWNER, reason: "persistent loser", now: NOW,
      }, sql as never),
    ).toThrow(/sabotage/);
    expect(dumpState(sql)).toEqual(before);
    expect(isStrategyGatedOff(sql as never, "iron_condor")).toBe(false);
  });

  it("rollback: throw at the status leg ⇒ the promotion stays fully live", () => {
    const sql = new SqliteTestStorage();
    applyWeightsV2Targets(sql as never, [{ strategy: "iron_condor", regime: "chop", weight: 1.0 }], {
      actor: OWNER, rationale: "seed", now: NOW,
    });
    const challenger = makeChallenger(sql, { weights: { iron_condor: 1.4 } });
    expect(promoteChallenger(sql as never, "alice", challenger.id, { actor: OWNER, now: NOW }, sql as never))
      .toEqual({ ok: true });
    const before = dumpState(sql);
    const faulty = new FaultySql(sql, /UPDATE\s+mas_challengers\s+SET\s+status/, "status leg");
    expect(() =>
      rollbackChallengerPromotion(faulty as never, "alice", challenger.id, { actor: OWNER, now: NOW }, sql as never),
    ).toThrow(/sabotage/);
    expect(dumpState(sql)).toEqual(before);
    expect(getWeightsService(sql as never)[weightsV2Key("iron_condor", "chop")]).toBe(1.4);
  });

  it("a unit composed directly over the ports rolls back every port's writes together", () => {
    const sql = new SqliteTestStorage();
    const ports = createStrategyClusterPorts(sql as never);
    ports.challengers.ensureTables();
    ports.weights.ensureTables();
    const runner = getTransactionRunner();
    expect(runner).not.toBeNull();
    expect(() =>
      runner!.runSyncUnit(sql as never, { operationName: "conformance.portsUnit", domain: "champion-challenger" }, () => {
        ports.weights.writeWeightRow("iron_condor", "chop", 1.9, 1, NOW);
        ports.challengers.insertActiveSet({
          id: "act-x", userLogin: "alice", version: 1, strategies: ["iron_condor"],
          challengerId: null, createdAt: NOW.toISOString(),
        });
        throw new Error("unit fails after both ports wrote");
      }),
    ).toThrow(/unit fails/);
    expect(ports.weights.getWeights()).toEqual({});
    expect(ports.challengers.getActiveStrategySet("alice")).toBeNull();
    // And the committing path applies both.
    runner!.runSyncUnit(sql as never, { operationName: "conformance.portsUnitCommit", domain: "champion-challenger" }, () => {
      ports.weights.writeWeightRow("iron_condor", "chop", 1.9, 1, NOW);
    });
    expect(ports.weights.getWeights()).toEqual({ [weightsV2Key("iron_condor", "chop")]: 1.9 });
  });
});
