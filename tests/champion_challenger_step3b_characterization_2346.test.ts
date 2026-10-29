/**
 * Issue #2346 (#1976 step 3b) — CHARACTERIZATION of the champion/
 * challenger promotion transition, written against the UNWRAPPED
 * implementation before the transaction wrap lands.
 *
 * What is pinned here: the observable behaviour of
 * promoteChallenger / resolveChallengerOutcome /
 * rollbackChallengerPromotion as found — happy paths, every
 * refusal reason (exact strings), refusal ORDER where the code
 * makes it observable, and the state each outcome leaves behind.
 * These pins pass before the wrap and must pass after it,
 * unchanged: the wrap (#2346) changes only atomicity, never a
 * successful-path behaviour, a status, an approval rule, or a
 * weight computation (issue #2346, Requirements).
 *
 * The PARTIAL STATES the wrap eliminates are named here so the
 * sabotage pins in the companion suite
 * (champion_challenger_step3b_promotion_tx_2346.test.ts) can be
 * read against them. As found, the transition is a sequence of
 * bare statements over one sql handle; a throw (crash) between
 * them leaves:
 *  - after the apply leg, before the promotion record: weights
 *    or the active set changed in production with NO record —
 *    the prior snapshot existed only in memory, so rollback is
 *    impossible and a re-promote double-applies;
 *  - after the record, before the status update: the record
 *    says promoted while the challenger still reads evaluated
 *    and can be promoted again;
 *  - inside the weights apply leg itself: some targets applied
 *    (weight row + version record + adaptation audit row each)
 *    and the rest not, when a later target's seam call throws.
 * Intra-instance concurrency interleaving is impossible as
 * found (the functions are synchronous and DO requests
 * serialize); the hazard is crash partiality only (step-3
 * audit §3.2).
 *
 * DOUBLES: node:sqlite-backed SqlStorage (real SQLite
 * semantics), the step-2/3a characterization shape.
 * MockSqlStorage round-trips of this module stay pinned by the
 * pre-existing suites (phase5_rsi_loop et al.). Challenger
 * evaluation is NOT exercised here — evaluation is a separate
 * function with its own suites; these pins construct the
 * evaluated state directly so the TRANSITION is what is under
 * test.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createChallenger,
  recordChallengerApproval,
  promoteChallenger,
  resolveChallengerOutcome,
  rollbackChallengerPromotion,
  getChallenger,
  getActiveStrategySet,
  listPromotionRecords,
  type Challenger,
} from "../src/services/championChallenger";
import {
  applyWeightsV2Targets,
  getStrategyWeightsV2,
  currentWeightsVersion,
  weightsV2Key,
} from "../src/services/strategyWeightsV2";
import {
  isStrategyGatedOff,
  hasStrategyGateRow,
} from "../src/services/strategyPolicyState";

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

const NOW = new Date("2026-10-29T12:00:00.000Z");
const OWNER = "owner-mubasher";
const CRITERIA = { minHoldoutEdge: 0.0005, minEvaluated: 1 };

const STATE_TABLES = [
  "mas_challengers",
  "mas_challenger_approvals",
  "mas_challenger_promotions",
  "mas_strategy_bank_active",
  "mas_strategy_weights_v2",
  "mas_strategy_weight_versions",
  "mas_strategy_gates",
  "mas_strategy_weight_caps",
  "mas_adaptation_audit",
  "mas_settings",
] as const;

/** Full raw dump of every table the transition can touch. */
function dumpState(sql: SqliteTestStorage): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of STATE_TABLES) {
    const exists = (sql.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      t,
    ) as Array<{ name: string }>).length > 0;
    out[t] = exists
      ? (sql.exec(`SELECT * FROM ${t} ORDER BY rowid`) as unknown[])
      : [];
  }
  return out;
}

function setKillSwitch(sql: SqliteTestStorage, on: boolean): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS mas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  );
  sql.exec(`DELETE FROM mas_settings WHERE key = ?`, "adaptation.killSwitch");
  if (on) {
    sql.exec(
      `INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      "adaptation.killSwitch",
      "on",
      NOW.toISOString(),
    );
  }
}

function forceEvaluated(
  sql: SqliteTestStorage,
  challengerId: string,
  verdict: "pass" | "fail",
): void {
  const evaluation = {
    datasetVersion: "v2",
    evaluatedAt: NOW.toISOString(),
    selection: { championScore: 0.1, challengerScore: 0.2, evaluated: 5 },
    holdout: { championScore: 0.1, challengerScore: 0.25, evaluated: 5 },
    verdict,
    criteria: CRITERIA,
  };
  sql.exec(
    `UPDATE mas_challengers SET status = 'evaluated', evaluation_json = ? WHERE id = ?`,
    JSON.stringify(evaluation),
    challengerId,
  );
}

function makeChallenger(
  sql: SqliteTestStorage,
  input: Partial<Parameters<typeof createChallenger>[2]> & {
    verdict?: "pass" | "fail" | null;
    approve?: boolean;
  } = {},
): Challenger {
  const { verdict = "pass", approve = true, ...rest } = input;
  const challenger = createChallenger(sql as never, "alice", {
    kind: "weights",
    title: "Raise iron_condor weight in chop",
    regime: "chop",
    spec: { weights: { iron_condor: 1.4 } },
    criteria: CRITERIA,
    evalSetVersion: "v2",
    sourceProposalId: null,
    createdBy: "research-agent",
    now: NOW,
    ...rest,
  });
  if (verdict !== null) forceEvaluated(sql, challenger.id, verdict);
  if (approve) {
    const res = recordChallengerApproval(sql as never, "alice", challenger.id, {
      approver: OWNER,
      decision: "approved",
      now: NOW,
    });
    expect(res.ok).toBe(true);
  }
  return challenger;
}

function seedWeight(
  sql: SqliteTestStorage,
  strategy: string,
  regime: string,
  weight: number,
): void {
  const res = applyWeightsV2Targets(
    sql as never,
    [{ strategy, regime, weight }],
    { actor: OWNER, rationale: "characterization seed", now: NOW },
  );
  expect(res.halted).toBeFalsy();
  expect(res.applied).toHaveLength(1);
}

/* ------------------------------------------------------------------ */
/* promote — weights kind                                              */
/* ------------------------------------------------------------------ */

describe("characterization #2346: promoteChallenger (weights)", () => {
  it("happy path: applies targets, snapshots prior (incl. rowExisted), records, promotes", () => {
    const sql = new SqliteTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4, bull_put: 0.8 } },
    });
    const versionBefore = currentWeightsVersion(sql as never);

    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({ ok: true });

    const weights = getStrategyWeightsV2(sql as never);
    expect(weights[weightsV2Key("iron_condor", "chop")]).toBe(1.4);
    expect(weights[weightsV2Key("bull_put", "chop")]).toBe(0.8);
    expect(currentWeightsVersion(sql as never)).toBeGreaterThan(versionBefore);

    const records = listPromotionRecords(sql as never, "alice", challenger.id);
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("promoted");
    expect(records[0].actor).toBe(OWNER);
    expect(records[0].prior).toEqual({
      weights: [
        { strategy: "iron_condor", regime: "chop", weight: 1.0, rowExisted: true },
        { strategy: "bull_put", regime: "chop", weight: null, rowExisted: false },
      ],
    });
    expect(records[0].applied.weights).toHaveLength(2);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("promoted");
  });

  it("refuses an unknown challenger and changes nothing", () => {
    const sql = new SqliteTestStorage();
    makeChallenger(sql);
    const before = dumpState(sql);
    const res = promoteChallenger(sql as never, "alice", "chl-missing", {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({ ok: false, reason: "challenger not found for this tenant" });
    expect(dumpState(sql)).toEqual(before);
  });

  it("refuses an unevaluated challenger (status proposed)", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, { verdict: null });
    const before = dumpState(sql);
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "challenger has not been evaluated on its frozen set; no promotion without evidence",
    });
    expect(dumpState(sql)).toEqual(before);
  });

  it("refuses when the frozen-set verdict is fail", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, { verdict: "fail" });
    const before = dumpState(sql);
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "frozen-set evaluation did not pass; the champion stays (resolve as keep-champion)",
    });
    expect(dumpState(sql)).toEqual(before);
  });

  it("refuses with no approval record", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, { approve: false });
    const before = dumpState(sql);
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "no authorized approval record; promotion requires explicit human/owner approval",
    });
    expect(dumpState(sql)).toEqual(before);
  });

  it("refuses when the actor is not the approver of record", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql);
    const before = dumpState(sql);
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: "someone-else",
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "the promoter must be the authorized approver of record",
    });
    expect(dumpState(sql)).toEqual(before);
  });

  it("refuses while the adaptation kill switch is on", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql);
    setKillSwitch(sql, true);
    const before = dumpState(sql);
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "adaptation is halted by the kill switch; promotion refused",
    });
    expect(dumpState(sql)).toEqual(before);
  });

  it("refuses a weights challenger with no regime", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, { regime: null });
    const before = dumpState(sql);
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "weights challenger has no regime; weights v2 are regime-scoped",
    });
    expect(dumpState(sql)).toEqual(before);
  });

  it("refuses a weights challenger carrying no target weights", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, { spec: { weights: {} } });
    const before = dumpState(sql);
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "weights challenger carries no target weights",
    });
    expect(dumpState(sql)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* promote — active-set / ranking kinds                                */
/* ------------------------------------------------------------------ */

describe("characterization #2346: promoteChallenger (active set)", () => {
  it("happy path with no prior set: appends version 1, prior snapshot is null", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      kind: "active_set",
      spec: { activeStrategies: ["iron_condor", "bull_put"] },
    });
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({ ok: true });
    expect(getActiveStrategySet(sql as never, "alice")).toEqual({
      strategies: ["iron_condor", "bull_put"],
      version: 1,
      challengerId: challenger.id,
      createdAt: NOW.toISOString(),
    });
    const records = listPromotionRecords(sql as never, "alice", challenger.id);
    expect(records).toHaveLength(1);
    expect(records[0].prior).toEqual({ activeSet: null });
    expect(records[0].applied).toEqual({
      activeSet: { strategies: ["iron_condor", "bull_put"], version: 1 },
    });
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("promoted");
  });

  it("second promotion appends version 2 and snapshots the version-1 set as prior", () => {
    const sql = new SqliteTestStorage();
    const first = makeChallenger(sql, {
      kind: "active_set",
      spec: { activeStrategies: ["iron_condor"] },
    });
    expect(
      promoteChallenger(sql as never, "alice", first.id, { actor: OWNER, now: NOW }),
    ).toEqual({ ok: true });
    const second = makeChallenger(sql, {
      kind: "active_set",
      title: "Second set",
      spec: { activeStrategies: ["bull_put", "bear_call"] },
    });
    const res = promoteChallenger(sql as never, "alice", second.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({ ok: true });
    const set = getActiveStrategySet(sql as never, "alice");
    expect(set?.version).toBe(2);
    expect(set?.strategies).toEqual(["bull_put", "bear_call"]);
    const records = listPromotionRecords(sql as never, "alice", second.id);
    expect(records[0].prior.activeSet.version).toBe(1);
    expect(records[0].prior.activeSet.strategies).toEqual(["iron_condor"]);
  });

  it("ranking kind falls back to spec.ranking when activeStrategies is absent", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      kind: "ranking",
      spec: { ranking: ["bull_put", "iron_condor"] },
    });
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({ ok: true });
    expect(getActiveStrategySet(sql as never, "alice")?.strategies).toEqual([
      "bull_put",
      "iron_condor",
    ]);
  });

  it("refuses an active-set challenger carrying no strategies", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, { kind: "active_set", spec: {} });
    const before = dumpState(sql);
    const res = promoteChallenger(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason:
        "active-set/ranking challenger carries no strategies (retire specs resolve via resolveChallengerOutcome)",
    });
    expect(dumpState(sql)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* resolve — keep-champion + retire                                    */
/* ------------------------------------------------------------------ */

describe("characterization #2346: resolveChallengerOutcome", () => {
  it("keep-champion: records the outcome and sets kept_champion, weights untouched", () => {
    const sql = new SqliteTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, { verdict: "fail" });
    const res = resolveChallengerOutcome(sql as never, "alice", challenger.id, {
      outcome: "keep_champion",
      actor: OWNER,
      reason: "holdout edge too small",
      now: NOW,
    });
    expect(res).toEqual({ ok: true });
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("kept_champion");
    const records = listPromotionRecords(sql as never, "alice", challenger.id);
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("keep_champion");
    expect(records[0].prior).toBeNull();
    expect(records[0].applied).toBeNull();
    expect(records[0].reason).toBe("holdout edge too small");
    expect(getStrategyWeightsV2(sql as never)[weightsV2Key("iron_condor", "chop")]).toBe(1.0);
  });

  it("keep-champion refuses a challenger that is not evaluated", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, { verdict: null });
    const before = dumpState(sql);
    const res = resolveChallengerOutcome(sql as never, "alice", challenger.id, {
      outcome: "keep_champion",
      actor: OWNER,
      reason: "n/a",
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "keep-champion resolves an evaluated challenger",
    });
    expect(dumpState(sql)).toEqual(before);
  });

  it("retire: gates the strategy off through the adaptation seam, records prior gate, sets retired", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      spec: { retireStrategy: "iron_condor" },
    });
    const res = resolveChallengerOutcome(sql as never, "alice", challenger.id, {
      outcome: "retire_strategy",
      actor: OWNER,
      reason: "persistent loser",
      now: NOW,
    });
    expect(res).toEqual({ ok: true });
    expect(isStrategyGatedOff(sql as never, "iron_condor")).toBe(true);
    expect(hasStrategyGateRow(sql as never, "iron_condor")).toBe(true);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("retired");
    const records = listPromotionRecords(sql as never, "alice", challenger.id);
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("retire_strategy");
    expect(records[0].prior).toEqual({
      gate: { strategy: "iron_condor", rowExisted: false, gatedOff: false, cap: null },
    });
    expect(records[0].applied).toEqual({ gate: { strategy: "iron_condor", gatedOff: true } });
    const audit = sql.exec(
      `SELECT subject, parameter FROM mas_adaptation_audit ORDER BY rowid`,
    ) as Array<{ subject: string; parameter: string }>;
    expect(audit).toEqual([{ subject: "strategy-gate:iron_condor", parameter: "gate" }]);
  });

  it("retire as found: no status guard — an approved retire resolves from proposed", () => {
    // As-found behaviour, pinned so the wrap provably does not
    // change it: the retire path checks spec/approval/actor/
    // kill switch only; it never required evaluated status.
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      verdict: null,
      spec: { retireStrategy: "iron_condor" },
    });
    const res = resolveChallengerOutcome(sql as never, "alice", challenger.id, {
      outcome: "retire_strategy",
      actor: OWNER,
      reason: "persistent loser",
      now: NOW,
    });
    expect(res).toEqual({ ok: true });
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("retired");
  });

  it("retire refuses with no retireStrategy in the spec", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, { spec: { weights: { iron_condor: 1.4 } } });
    const before = dumpState(sql);
    const res = resolveChallengerOutcome(sql as never, "alice", challenger.id, {
      outcome: "retire_strategy",
      actor: OWNER,
      reason: "persistent loser",
      now: NOW,
    });
    expect(res).toEqual({ ok: false, reason: "challenger carries no retireStrategy" });
    expect(dumpState(sql)).toEqual(before);
  });

  it("retire refuses with no approval record", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      approve: false,
      spec: { retireStrategy: "iron_condor" },
    });
    const before = dumpState(sql);
    const res = resolveChallengerOutcome(sql as never, "alice", challenger.id, {
      outcome: "retire_strategy",
      actor: OWNER,
      reason: "persistent loser",
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "no authorized approval record; retiring a strategy requires explicit human/owner approval",
    });
    expect(dumpState(sql)).toEqual(before);
  });

  it("retire refuses when the actor is not the approver of record", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      spec: { retireStrategy: "iron_condor" },
    });
    const before = dumpState(sql);
    const res = resolveChallengerOutcome(sql as never, "alice", challenger.id, {
      outcome: "retire_strategy",
      actor: "someone-else",
      reason: "persistent loser",
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "the actor must be the authorized approver of record",
    });
    expect(dumpState(sql)).toEqual(before);
  });

  it("retire refuses while the kill switch is on", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      spec: { retireStrategy: "iron_condor" },
    });
    setKillSwitch(sql, true);
    const before = dumpState(sql);
    const res = resolveChallengerOutcome(sql as never, "alice", challenger.id, {
      outcome: "retire_strategy",
      actor: OWNER,
      reason: "persistent loser",
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "adaptation is halted by the kill switch; retirement refused",
    });
    expect(dumpState(sql)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* rollback                                                            */
/* ------------------------------------------------------------------ */

describe("characterization #2346: rollbackChallengerPromotion", () => {
  it("weights rollback restores the exact pre-promotion effective weights", () => {
    const sql = new SqliteTestStorage();
    seedWeight(sql, "iron_condor", "chop", 1.0);
    const challenger = makeChallenger(sql, {
      spec: { weights: { iron_condor: 1.4, bull_put: 0.8 } },
    });
    const weightsBefore = getStrategyWeightsV2(sql as never);
    expect(
      promoteChallenger(sql as never, "alice", challenger.id, { actor: OWNER, now: NOW }),
    ).toEqual({ ok: true });

    const res = rollbackChallengerPromotion(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({ ok: true });
    expect(getStrategyWeightsV2(sql as never)).toEqual(weightsBefore);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("rolled_back");
    const records = listPromotionRecords(sql as never, "alice", challenger.id);
    expect(records.map((r) => r.action)).toEqual(["promoted", "rollback"]);
    expect(records[1].prior).toEqual(records[0].prior);

    // A second rollback has nothing live to roll back.
    const again = rollbackChallengerPromotion(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(again).toEqual({ ok: false, reason: "no live promotion to roll back" });
  });

  it("active-set rollback restores the prior set (empty when there was none)", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      kind: "active_set",
      spec: { activeStrategies: ["iron_condor", "bull_put"] },
    });
    expect(
      promoteChallenger(sql as never, "alice", challenger.id, { actor: OWNER, now: NOW }),
    ).toEqual({ ok: true });
    const res = rollbackChallengerPromotion(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({ ok: true });
    expect(getActiveStrategySet(sql as never, "alice")?.strategies).toEqual([]);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("rolled_back");
  });

  it("retire rollback restores the gate exactly — a row that did not exist is gone again", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      spec: { retireStrategy: "iron_condor" },
    });
    expect(
      resolveChallengerOutcome(sql as never, "alice", challenger.id, {
        outcome: "retire_strategy",
        actor: OWNER,
        reason: "persistent loser",
        now: NOW,
      }),
    ).toEqual({ ok: true });
    expect(hasStrategyGateRow(sql as never, "iron_condor")).toBe(true);

    const res = rollbackChallengerPromotion(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({ ok: true });
    expect(hasStrategyGateRow(sql as never, "iron_condor")).toBe(false);
    expect(isStrategyGatedOff(sql as never, "iron_condor")).toBe(false);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("rolled_back");
  });

  it("refuses when there is no promotion record at all", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql);
    const before = dumpState(sql);
    const res = rollbackChallengerPromotion(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({ ok: false, reason: "no live promotion to roll back" });
    expect(dumpState(sql)).toEqual(before);
  });

  it("refuses while the kill switch is on, leaving the promotion live", () => {
    const sql = new SqliteTestStorage();
    const challenger = makeChallenger(sql, {
      kind: "active_set",
      spec: { activeStrategies: ["iron_condor"] },
    });
    expect(
      promoteChallenger(sql as never, "alice", challenger.id, { actor: OWNER, now: NOW }),
    ).toEqual({ ok: true });
    setKillSwitch(sql, true);
    const before = dumpState(sql);
    const res = rollbackChallengerPromotion(sql as never, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res).toEqual({
      ok: false,
      reason: "adaptation is halted by the kill switch; rollback refused",
    });
    expect(dumpState(sql)).toEqual(before);
    expect(getChallenger(sql as never, "alice", challenger.id)?.status).toBe("promoted");
  });
});
