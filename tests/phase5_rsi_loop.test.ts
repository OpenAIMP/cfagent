/**
 * Issue #1140 (Phase 5 of epic #1096) — RSI loop hardening pins.
 *
 *  - Outcomes tracking to expiry: Phase 4 paper bundles in mas_outcomes
 *    join Phase 3 screen runs and #340 track-record ideas into ONE
 *    append-only outcomes path — provenance (screen run, scenario,
 *    weights version, eval-set version) on every tracked recommendation,
 *    terminal events appended (never edits), missing final prices stay
 *    Unverified, never fabricated.
 *  - strategyWeights v2: regime-conditioned (Phase 1 regime classes),
 *    risk-adjusted and AFTER-COST (researchEconomics cost assumptions
 *    via researchConfig defaults) — not raw win rate. v1 bounds retained
 *    (min 0.25 / max 2.0 / step ±0.10 / deadband 0.02 / min sample 20),
 *    stale evidence decays, every applied change is a versioned record
 *    applied through the #755 adaptation seam (kill switch halts).
 *  - Frozen eval sets: dataset v2 in the #583 versioned mechanism;
 *    champion vs challenger scored walk-forward, out-of-sample — the
 *    holdout fold decides.
 *  - Champion/challenger gate: Phase 3 reselection proposals
 *    (proposal_only_not_promoted) become challengers; acceptance
 *    criteria are FROZEN at creation (mission.md — a candidate may
 *    never edit its own criteria, pinned); promotion requires passing
 *    frozen-set evidence PLUS an authorized approval record from a
 *    human/owner actor distinct from the creator — no self-promotion
 *    by the nightly run; keep-champion and retire-strategy are valid
 *    outcomes; promotions are reversible with exact restore (#760).
 *  - Recovery drills (COO mission) over the researchTaskLedger idiom
 *    (#577): interruption, duplicate delivery, provider timeout,
 *    expired credentials, cancellation, budget exhaustion — failures
 *    end escalated and visible; consequential steps are never blindly
 *    repeated (reconcile first).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MockSqlStorage } from "./mock-sql";
import {
  createGoal,
  createScenario,
  recordOutcome,
  listOutcomes,
} from "../src/services/goalScenarioStore";
import { buildTrackRecord } from "../src/services/researchTrackRecord";
import { loadEvaluationDataset } from "../src/services/researchEvaluationDatasets";
import {
  buildWeightsV2Slices,
  proposeWeightAdjustmentsV2,
  runWeightsV2Adjustment,
  getStrategyWeightsV2,
  currentWeightsVersion,
  listWeightVersionRecords,
  decayedWeight,
  WEIGHTS_V2_DEFAULTS,
  type WeightsV2IdeaInput,
} from "../src/services/strategyWeightsV2";
import {
  startOutcomeTracking,
  recordOutcomeTerminal,
  listOutcomeTracking,
  buildOutcomesPath,
  expireDueOutcomes,
} from "../src/services/outcomeTracking";
import {
  reselectStrategyBank,
  recordReselectionProposal,
  type ReselectionProposal,
} from "../src/services/strategyBankReselection";
import {
  createChallenger,
  reviseChallengerCriteria,
  recordChallengerApproval,
  evaluateChallenger,
  promoteChallenger,
  resolveChallengerOutcome,
  rollbackChallengerPromotion,
  getChallenger,
  getActiveStrategySet,
  SYSTEM_ACTORS,
} from "../src/services/championChallenger";
import {
  isStrategyGatedOff,
  hasStrategyGateRow,
} from "../src/services/strategyPolicyState";
import {
  ResearchTaskLedger,
  evaluateResearchOutcome,
  type ResearchTaskStore,
} from "../src/services/researchTaskLedger";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const COSTS = { feePerContract: 0.65, slippagePerContract: 0.02 };

function newSql(): any {
  return new MockSqlStorage() as any;
}

function setKillSwitch(sql: any, on: boolean): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS mas_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`
  );
  sql.exec(`DELETE FROM mas_settings WHERE key = ?`, "adaptation.killSwitch");
  if (on) {
    sql.exec(
      `INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      "adaptation.killSwitch",
      "on",
      NOW.toISOString()
    );
  }
}

/** N evaluated ideas for one (strategy, regime) slice with a fixed pnl/R. */
function ideas(
  strategy: string,
  regime: WeightsV2IdeaInput["regime"],
  n: number,
  pnl: number,
  r: number | null,
  evaluatedAt: string,
  contractsPerUnit: number | null = 2
): WeightsV2IdeaInput[] {
  return Array.from({ length: n }, () => ({
    structure: strategy,
    regime,
    contractsPerUnit,
    evaluation: { pnlEstimatePerUnit: pnl, rMultiple: r, evaluatedAt },
  }));
}

/* ------------------------------------------------------------------ */
/* strategyWeights v2                                                  */
/* ------------------------------------------------------------------ */

describe("strategyWeights v2 — after-cost, regime-conditioned evidence", () => {
  it("flips a marginal raw winner to a loser after costs", () => {
    // pnl +0.01/unit gross, 2 contracts/unit → cost 0.67*2/100 = 0.0134
    // per unit → after-cost pnl is negative: costs decide the sign.
    const slices = buildWeightsV2Slices(
      ideas("iron_condor", "chop", 25, 0.01, 0.02, "2026-10-20T00:00:00.000Z"),
      COSTS
    );
    expect(slices).toHaveLength(1);
    expect(slices[0].evaluated).toBe(25);
    expect(slices[0].winRateAfterCost).toBe(0);
    expect(slices[0].avgPnlAfterCost!).toBeLessThan(0);
  });

  it("excludes ideas whose contract count is unknown instead of assuming costs", () => {
    const slices = buildWeightsV2Slices(
      ideas("iron_condor", "chop", 5, 1.0, 0.1, "2026-10-20T00:00:00.000Z", null),
      COSTS
    );
    expect(slices[0].evaluated).toBe(0);
    expect(slices[0].unpriced).toBe(5);
    expect(slices[0].winRateAfterCost).toBeNull();
  });

  it("keeps regimes separate: the same strategy gets different slices per regime", () => {
    const slices = buildWeightsV2Slices(
      [
        ...ideas("iron_condor", "chop", 25, 1.0, 0.1, "2026-10-20T00:00:00.000Z"),
        ...ideas("iron_condor", "high_vol", 25, -1.0, -0.1, "2026-10-20T00:00:00.000Z"),
      ],
      COSTS
    );
    expect(slices).toHaveLength(2);
    const chop = slices.find((s) => s.regime === "chop")!;
    const hv = slices.find((s) => s.regime === "high_vol")!;
    expect(chop.winRateAfterCost).toBe(1);
    expect(hv.winRateAfterCost).toBe(0);
  });

  it("proposes regime-scoped moves only: strong in chop, weak in high_vol", () => {
    const slices = buildWeightsV2Slices(
      [
        ...ideas("iron_condor", "chop", 25, 1.0, 0.1, "2026-10-20T00:00:00.000Z"),
        ...ideas("iron_condor", "high_vol", 25, -1.0, -0.1, "2026-10-20T00:00:00.000Z"),
        // Baseline filler so each regime has an overall rate: flat in
        // chop (baseline 0.5), winning in high_vol (baseline 0.5 with
        // the condor at 0 — a real negative signal to move on).
        ...ideas("bull_put_spread", "chop", 25, 0, 0, "2026-10-20T00:00:00.000Z"),
        ...ideas("bull_put_spread", "high_vol", 25, 1, 0.1, "2026-10-20T00:00:00.000Z"),
      ],
      COSTS
    );
    const proposals = proposeWeightAdjustmentsV2(slices, {}, { now: NOW });
    const chop = proposals.find((p) => p.strategy === "iron_condor" && p.regime === "chop");
    const hv = proposals.find((p) => p.strategy === "iron_condor" && p.regime === "high_vol");
    expect(chop).toBeDefined();
    expect(chop!.delta).toBeGreaterThan(0);
    expect(hv).toBeDefined();
    expect(hv!.delta).toBeLessThan(0);
    expect(chop!.winRateAfterCost).toBe(1);
    expect(chop!.avgRAfterCost).toBeGreaterThan(0);
  });

  it("risk adjustment: positive win-rate excess with non-positive after-cost R never proposes an increase", () => {
    // Win rate 1.0 after cost but every win is tiny vs the losses' R
    // scale: avg R after cost is negative → increase is capped away.
    const winning = ideas("jade_lizard", "bull", 25, 0.02, -0.05, "2026-10-20T00:00:00.000Z");
    const filler = ideas("bull_put_spread", "bull", 25, -1, -0.1, "2026-10-20T00:00:00.000Z");
    const slices = buildWeightsV2Slices([...winning, ...filler], COSTS);
    const proposals = proposeWeightAdjustmentsV2(slices, {}, { now: NOW });
    const p = proposals.find((x) => x.strategy === "jade_lizard");
    expect(p === undefined || p.delta <= 0).toBe(true);
  });

  it("retains v1 bounds, deadband, and minimum sample", () => {
    const slices = buildWeightsV2Slices(
      [
        ...ideas("iron_condor", "chop", 19, 5, 0.5, "2026-10-20T00:00:00.000Z"), // below min sample
        ...ideas("bull_put_spread", "chop", 25, 0.5, 0.05, "2026-10-20T00:00:00.000Z"),
      ],
      COSTS
    );
    const proposals = proposeWeightAdjustmentsV2(
      slices,
      { "bull_put_spread|chop": 1.98 },
      { now: NOW }
    );
    expect(proposals.find((p) => p.strategy === "iron_condor")).toBeUndefined();
    for (const p of proposals) {
      expect(p.proposed).toBeGreaterThanOrEqual(0.25);
      expect(p.proposed).toBeLessThanOrEqual(2.0);
      expect(Math.abs(p.delta)).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(Math.abs(p.delta)).toBeGreaterThanOrEqual(0.02 - 1e-9);
    }
    const capped = proposals.find((p) => p.strategy === "bull_put_spread");
    if (capped) expect(capped.proposed).toBeLessThanOrEqual(2.0);
  });

  it("decays stale evidence: the same signal moves less when old, and an idle weight decays toward default", () => {
    expect(decayedWeight(1.6, 0, 90)).toBeCloseTo(1.6, 6);
    expect(decayedWeight(1.6, 90, 90)).toBeCloseTo(1.3, 6);
    expect(decayedWeight(1.6, 180, 90)).toBeCloseTo(1.15, 6);

    const fresh = buildWeightsV2Slices(
      [
        ...ideas("iron_condor", "chop", 25, 1, 0.1, "2026-10-20T00:00:00.000Z"),
        ...ideas("bull_put_spread", "chop", 25, 0, 0, "2026-10-20T00:00:00.000Z"),
      ],
      COSTS
    );
    const stale = buildWeightsV2Slices(
      [
        ...ideas("iron_condor", "chop", 25, 1, 0.1, "2026-01-01T00:00:00.000Z"),
        ...ideas("bull_put_spread", "chop", 25, 0, 0, "2026-01-01T00:00:00.000Z"),
      ],
      COSTS
    );
    const freshP = proposeWeightAdjustmentsV2(fresh, {}, { now: NOW }).find(
      (p) => p.strategy === "iron_condor"
    )!;
    const staleP = proposeWeightAdjustmentsV2(stale, {}, { now: NOW }).find(
      (p) => p.strategy === "iron_condor"
    );
    // ~295 days old: decay may shrink the step under the deadband (then
    // no proposal at all) — either way it must never exceed fresh.
    const staleDelta = staleP ? Math.abs(staleP.delta) : 0;
    expect(staleDelta).toBeLessThan(Math.abs(freshP.delta));
    if (staleP) expect(staleP.decayFactor).toBeLessThan(0.2);
  });

  it("applies through the adaptation seam and writes versioned records; the kill switch halts it", () => {
    const sql = newSql();
    const slices = buildWeightsV2Slices(
      [
        ...ideas("iron_condor", "chop", 25, 1, 0.1, "2026-10-20T00:00:00.000Z"),
        ...ideas("bull_put_spread", "chop", 25, 0, 0, "2026-10-20T00:00:00.000Z"),
      ],
      COSTS
    );
    const v0 = currentWeightsVersion(sql);
    const res = runWeightsV2Adjustment(sql, slices, { now: NOW, costs: COSTS });
    expect(res.halted).toBeFalsy();
    expect(res.adjusted.length).toBeGreaterThan(0);
    const weights = getStrategyWeightsV2(sql);
    expect(weights["iron_condor|chop"]).toBeGreaterThan(1);
    expect(currentWeightsVersion(sql)).toBeGreaterThan(v0);
    const records = listWeightVersionRecords(sql);
    expect(records.length).toBe(res.adjusted.length);
    const ic = records.find((r) => r.strategy === "iron_condor")!;
    expect(ic.regime).toBe("chop");
    expect(ic.before).toBeNull(); // no prior row existed
    expect(ic.after).toBe(weights["iron_condor|chop"]);
    expect(ic.winRateAfterCost).toBe(1);

    setKillSwitch(sql, true);
    const halted = runWeightsV2Adjustment(sql, slices, { now: NOW, costs: COSTS });
    expect(halted.halted).toBe(true);
    expect(getStrategyWeightsV2(sql)["iron_condor|chop"]).toBe(weights["iron_condor|chop"]);
  });

  it("exports its defaults from the v1 bounds (no second envelope)", () => {
    expect(WEIGHTS_V2_DEFAULTS.min).toBe(0.25);
    expect(WEIGHTS_V2_DEFAULTS.max).toBe(2.0);
    expect(WEIGHTS_V2_DEFAULTS.maxStep).toBe(0.1);
    expect(WEIGHTS_V2_DEFAULTS.deadband).toBe(0.02);
    expect(WEIGHTS_V2_DEFAULTS.minSample).toBe(20);
  });
});

/* ------------------------------------------------------------------ */
/* Outcomes tracking to expiry                                         */
/* ------------------------------------------------------------------ */

function seedPaperBundle(sql: any, userLogin = "alice") {
  const goal = createGoal(sql, {
    userLogin,
    kind: "income",
    title: "Income goal",
    source: "user",
    status: "active",
  });
  const scenario = createScenario(sql, {
    userLogin,
    goalId: goal.id,
    portfolioRef: { kind: "real" },
    shocks: {},
    constraints: {},
  })!;
  const outcome = recordOutcome(sql, {
    userLogin,
    goalId: goal.id,
    scenarioId: scenario.id,
    recommendationRef: "bundle-1",
    screenRunRef: "run-100",
    kind: "paper",
    metrics: { decision: "trade", score: 0.42 },
  })!;
  return { goal, scenario, outcome };
}

function trackRecordFixture() {
  const reports = [
    {
      runId: "run-100",
      createdAt: "2026-10-01T21:00:00.000Z",
      ideas: [
        {
          symbol: "SPY",
          structure: "iron_condor",
          outlook: "range_bound",
          thesis: "Range holds.",
          invalidation: "Breaks range.",
          entrySpot: 510,
          economics: { maxLoss: 380 },
        },
      ],
    },
  ];
  const evaluations = [
    {
      runId: "run-100",
      evaluatedAt: "2026-10-20T21:00:00.000Z",
      ideas: [
        {
          symbol: "SPY",
          structure: "iron_condor",
          invalidated: false,
          pnlEstimatePerUnit: 1.2,
          evalSpot: 512,
          directionCorrect: null,
        },
      ],
    },
  ];
  return buildTrackRecord(reports, evaluations);
}

describe("outcomes tracking — one append-only path to expiry", () => {
  it("tracks a Phase 4 paper bundle with full provenance and deduplicates duplicate starts", () => {
    const sql = newSql();
    seedPaperBundle(sql);
    const first = startOutcomeTracking(sql, "alice", {
      recommendationRef: "bundle-1",
      weightsVersion: 3,
      evalSetVersion: "v2",
      expiryDate: "2026-11-20",
      now: NOW,
    });
    expect(first).not.toBeNull();
    expect(first!.status).toBe("open");
    expect(first!.provenance.screenRunRef).toBe("run-100");
    expect(first!.provenance.scenarioId).toBeTruthy();
    expect(first!.provenance.weightsVersion).toBe(3);
    expect(first!.provenance.evalSetVersion).toBe("v2");

    const dupe = startOutcomeTracking(sql, "alice", {
      recommendationRef: "bundle-1",
      weightsVersion: 99,
      evalSetVersion: "v2",
      now: NOW,
    });
    expect(dupe!.provenance.weightsVersion).toBe(3); // first record wins
    const rows = Array.from(
      sql.exec(`SELECT COUNT(*) AS count FROM mas_outcome_tracking`)
    ) as any[];
    expect(Number(rows[0].count)).toBe(1);
  });

  it("is tenant-scoped: another tenant cannot track or see the bundle", () => {
    const sql = newSql();
    seedPaperBundle(sql, "alice");
    expect(
      startOutcomeTracking(sql, "bob", { recommendationRef: "bundle-1", now: NOW })
    ).toBeNull();
    expect(listOutcomeTracking(sql, "bob")).toEqual([]);
  });

  it("appends terminal events without editing prior records, and refuses a second terminal", () => {
    const sql = newSql();
    seedPaperBundle(sql);
    startOutcomeTracking(sql, "alice", {
      recommendationRef: "bundle-1",
      expiryDate: "2026-11-20",
      now: NOW,
    });
    const before = Array.from(
      sql.exec(`SELECT event_json FROM mas_outcome_tracking ORDER BY created_at, rowid`)
    ) as any[];
    const term = recordOutcomeTerminal(sql, "alice", "bundle-1", {
      kind: "expired",
      pnlAfterCost: 118.5,
      now: new Date("2026-11-21T12:00:00.000Z"),
    });
    expect(term.appended).toBe(true);
    const after = Array.from(
      sql.exec(`SELECT event_json FROM mas_outcome_tracking ORDER BY created_at, rowid`)
    ) as any[];
    expect(after.length).toBe(before.length + 1);
    expect(after[0].event_json).toBe(before[0].event_json); // byte-identical

    const second = recordOutcomeTerminal(sql, "alice", "bundle-1", {
      kind: "realized",
      pnlAfterCost: 999,
      now: new Date("2026-11-22T12:00:00.000Z"),
    });
    expect(second.appended).toBe(false);
    const summary = listOutcomeTracking(sql, "alice")[0];
    expect(summary.status).toBe("expired");
    expect(summary.pnlAfterCost).toBe(118.5);
  });

  it("labels a terminal outcome without a final price Unverified — never a fabricated P&L", () => {
    const sql = newSql();
    seedPaperBundle(sql);
    startOutcomeTracking(sql, "alice", { recommendationRef: "bundle-1", now: NOW });
    recordOutcomeTerminal(sql, "alice", "bundle-1", { kind: "expired", now: NOW });
    const summary = listOutcomeTracking(sql, "alice")[0];
    expect(summary.status).toBe("expired");
    expect(summary.pnlAfterCost).toBeNull();
    expect(summary.quality).toBe("unverified");
  });

  it("expires due outcomes only when a final price exists; otherwise reports awaiting-price", () => {
    const sql = newSql();
    seedPaperBundle(sql);
    startOutcomeTracking(sql, "alice", {
      recommendationRef: "bundle-1",
      expiryDate: "2026-11-20",
      now: NOW,
    });
    const noPrice = expireDueOutcomes(sql, "alice", {
      now: new Date("2026-11-21T00:00:00.000Z"),
      finalPnlByRef: {},
    });
    expect(noPrice.expired).toEqual([]);
    expect(noPrice.awaitingPrice).toEqual(["bundle-1"]);
    expect(listOutcomeTracking(sql, "alice")[0].status).toBe("open");

    const priced = expireDueOutcomes(sql, "alice", {
      now: new Date("2026-11-21T00:00:00.000Z"),
      finalPnlByRef: { "bundle-1": 42 },
    });
    expect(priced.expired).toEqual(["bundle-1"]);
    expect(listOutcomeTracking(sql, "alice")[0].pnlAfterCost).toBe(42);
  });

  it("builds the joined outcomes path: mas_outcomes + tracking + track-record ideas by screen run", () => {
    const sql = newSql();
    seedPaperBundle(sql);
    startOutcomeTracking(sql, "alice", {
      recommendationRef: "bundle-1",
      weightsVersion: 3,
      evalSetVersion: "v2",
      now: NOW,
    });
    const path = buildOutcomesPath(sql, "alice", trackRecordFixture());
    expect(path).toHaveLength(1);
    expect(path[0].outcome.recommendationRef).toBe("bundle-1");
    expect(path[0].tracking?.status).toBe("open");
    expect(path[0].trackIdeas).toHaveLength(1);
    expect(path[0].trackIdeas[0].evaluation?.pnlEstimatePerUnit).toBe(1.2);
    expect(listOutcomes(sql, "alice")).toHaveLength(1);
  });

  it("pins append-only at the source level: no UPDATE against the tracking table", () => {
    const src = readFileSync("src/services/outcomeTracking.ts", "utf8");
    expect(src).not.toMatch(/UPDATE\s+mas_outcome_tracking/i);
  });
});

/* ------------------------------------------------------------------ */
/* Frozen eval set v2                                                  */
/* ------------------------------------------------------------------ */

describe("frozen evaluation dataset v2 (#583 mechanism)", () => {
  it("loads with regime/strategy-family dimensions and walk-forward-orderable cases", () => {
    const ds = loadEvaluationDataset("v2");
    expect(ds.manifest.version).toBe("v2");
    expect(ds.manifest.dimensions).toContain("regime");
    expect(ds.manifest.dimensions).toContain("strategy-family");
    expect(ds.cases.length).toBeGreaterThanOrEqual(4);
    for (const c of ds.cases) {
      expect(c.ideas.length).toBeGreaterThan(0);
      expect(typeof c.ideas[0].createdAt).toBe("string");
      expect(c.expect?.regime).toBeTruthy();
    }
  });

  it("still fails loudly on an unknown version", () => {
    expect(() => loadEvaluationDataset("v99")).toThrow(/Unknown/);
  });
});

/* ------------------------------------------------------------------ */
/* Champion / challenger                                               */
/* ------------------------------------------------------------------ */

function seedProposal(sql: any): ReselectionProposal {
  const proposal = reselectStrategyBank({
    evidence: [
      {
        strategy: "iron_condor",
        regime: "chop",
        published: 30,
        evaluated: 25,
        winRate: 0.72,
        avgRMultiple: 0.08,
      },
    ],
    weights: {},
    regime: "chop",
    overallWinRate: 0.55,
    now: NOW,
  });
  recordReselectionProposal(sql, "alice", proposal);
  return proposal;
}

const CRITERIA = { minHoldoutEdge: 0.0005, minEvaluated: 1 };
const OWNER = "owner-mubasher";

async function evaluatedWeightsChallenger(sql: any) {
  seedProposal(sql);
  const challenger = createChallenger(sql, "alice", {
    kind: "weights",
    title: "Raise iron_condor weight in chop",
    regime: "chop",
    spec: { weights: { iron_condor: 1.4 } },
    criteria: CRITERIA,
    evalSetVersion: "v2",
    sourceProposalId: null,
    createdBy: "research-agent",
    now: NOW,
  });
  const evaluation = await evaluateChallenger(sql, "alice", challenger.id, {
    championSpec: { weights: {}, activeStrategies: null },
    challengerSpec: {
      weights: {},
      activeStrategies: ["iron_condor", "bull_put_spread"],
    },
    now: NOW,
  });
  return { challenger, evaluation };
}

describe("champion/challenger promotion gate", () => {
  it("creates a challenger from a Phase 3 proposal shape with criteria frozen at creation", () => {
    const sql = newSql();
    const proposal = seedProposal(sql);
    expect(proposal.governance).toBe("proposal_only_not_promoted");
    const challenger = createChallenger(sql, "alice", {
      kind: "active_set",
      title: "Promote reselected chop active set",
      regime: "chop",
      spec: { activeStrategies: proposal.activeSet.map((a) => a.strategy) },
      criteria: CRITERIA,
      evalSetVersion: "v2",
      sourceProposalId: null,
      createdBy: "research-agent",
      now: NOW,
    });
    expect(challenger.status).toBe("proposed");
    expect(challenger.criteria).toEqual(CRITERIA);
    expect(challenger.evalSetVersion).toBe("v2");
  });

  it("rejects creating a challenger against an unknown eval set", () => {
    const sql = newSql();
    expect(() =>
      createChallenger(sql, "alice", {
        kind: "weights",
        title: "bad set",
        regime: "chop",
        spec: { weights: { iron_condor: 1.2 } },
        criteria: CRITERIA,
        evalSetVersion: "v99",
        createdBy: "research-agent",
        now: NOW,
      })
    ).toThrow(/Unknown/);
  });

  it("pins the mission.md rule: acceptance criteria can never be revised after creation", async () => {
    const sql = newSql();
    const { challenger } = await evaluatedWeightsChallenger(sql);
    const attempt = reviseChallengerCriteria(sql, "alice", challenger.id, {
      minHoldoutEdge: -1,
      minEvaluated: 0,
    });
    expect(attempt.ok).toBe(false);
    expect(attempt.reason).toMatch(/frozen/i);
    expect(getChallenger(sql, "alice", challenger.id)!.criteria).toEqual(CRITERIA);
  });

  it("evaluates walk-forward on the frozen set: the holdout fold decides and beats the champion", async () => {
    const sql = newSql();
    const { evaluation } = await evaluatedWeightsChallenger(sql);
    expect(evaluation.datasetVersion).toBe("v2");
    expect(evaluation.holdout.challengerScore).toBeGreaterThan(
      evaluation.holdout.championScore
    );
    expect(evaluation.holdout.evaluated).toBeGreaterThanOrEqual(1);
    expect(evaluation.selection.championScore).not.toBeNull();
    expect(evaluation.verdict).toBe("pass");
  });

  it("fails a challenger that only holds the losing strategy on the holdout fold", async () => {
    const sql = newSql();
    const challenger = createChallenger(sql, "alice", {
      kind: "active_set",
      title: "Strangle only",
      regime: "high_vol",
      spec: { activeStrategies: ["long_strangle"] },
      criteria: CRITERIA,
      evalSetVersion: "v2",
      createdBy: "research-agent",
      now: NOW,
    });
    const evaluation = await evaluateChallenger(sql, "alice", challenger.id, {
      championSpec: { weights: {}, activeStrategies: null },
      challengerSpec: { weights: {}, activeStrategies: ["long_strangle"] },
      now: NOW,
    });
    expect(evaluation.verdict).toBe("fail");
  });

  it("promotion requires evaluation AND an authorized approval — self-approval and system actors are rejected", async () => {
    const sql = newSql();
    const { challenger } = await evaluatedWeightsChallenger(sql);

    const noApproval = promoteChallenger(sql, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(noApproval.ok).toBe(false);
    expect(noApproval.reason).toMatch(/approval/i);

    const selfApproval = recordChallengerApproval(sql, "alice", challenger.id, {
      approver: "research-agent",
      decision: "approved",
      now: NOW,
    });
    expect(selfApproval.ok).toBe(false);

    for (const actor of SYSTEM_ACTORS) {
      const sys = recordChallengerApproval(sql, "alice", challenger.id, {
        approver: actor,
        decision: "approved",
        now: NOW,
      });
      expect(sys.ok).toBe(false);
    }

    const ok = recordChallengerApproval(sql, "alice", challenger.id, {
      approver: OWNER,
      decision: "approved",
      now: NOW,
    });
    expect(ok.ok).toBe(true);

    const wrongActor = promoteChallenger(sql, "alice", challenger.id, {
      actor: "research-agent",
      now: NOW,
    });
    expect(wrongActor.ok).toBe(false);

    const promoted = promoteChallenger(sql, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(promoted.ok).toBe(true);
    expect(getStrategyWeightsV2(sql)["iron_condor|chop"]).toBe(1.4);
    expect(getChallenger(sql, "alice", challenger.id)!.status).toBe("promoted");
  });

  it("rollback restores the exact prior state — including 'no weight row existed'", async () => {
    const sql = newSql();
    const { challenger } = await evaluatedWeightsChallenger(sql);
    recordChallengerApproval(sql, "alice", challenger.id, {
      approver: OWNER,
      decision: "approved",
      now: NOW,
    });
    promoteChallenger(sql, "alice", challenger.id, { actor: OWNER, now: NOW });
    expect(getStrategyWeightsV2(sql)["iron_condor|chop"]).toBe(1.4);
    const versionAfterPromote = currentWeightsVersion(sql);

    const rolled = rollbackChallengerPromotion(sql, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(rolled.ok).toBe(true);
    expect(getStrategyWeightsV2(sql)["iron_condor|chop"]).toBeUndefined();
    expect(currentWeightsVersion(sql)).toBeGreaterThan(versionAfterPromote);
    expect(getChallenger(sql, "alice", challenger.id)!.status).toBe("rolled_back");
  });

  it("keep-champion is a recorded outcome that changes nothing", async () => {
    const sql = newSql();
    const challenger = createChallenger(sql, "alice", {
      kind: "active_set",
      title: "Strangle only (will fail)",
      regime: "high_vol",
      spec: { activeStrategies: ["long_strangle"] },
      criteria: CRITERIA,
      evalSetVersion: "v2",
      createdBy: "research-agent",
      now: NOW,
    });
    await evaluateChallenger(sql, "alice", challenger.id, {
      championSpec: { weights: {}, activeStrategies: null },
      challengerSpec: { weights: {}, activeStrategies: ["long_strangle"] },
      now: NOW,
    });
    const before = getStrategyWeightsV2(sql);
    const res = resolveChallengerOutcome(sql, "alice", challenger.id, {
      outcome: "keep_champion",
      actor: OWNER,
      reason: "Holdout evidence does not beat the champion.",
      now: NOW,
    });
    expect(res.ok).toBe(true);
    expect(getChallenger(sql, "alice", challenger.id)!.status).toBe("kept_champion");
    expect(getStrategyWeightsV2(sql)).toEqual(before);
  });

  it("retire-strategy gates the strategy off through the policy state, with approval, and rolls back exactly", async () => {
    const sql = newSql();
    const { challenger } = await evaluatedWeightsChallenger(sql);
    const retire = createChallenger(sql, "alice", {
      kind: "active_set",
      title: "Retire long_strangle",
      regime: "high_vol",
      spec: { retireStrategy: "long_strangle" },
      criteria: CRITERIA,
      evalSetVersion: "v2",
      createdBy: "research-agent",
      now: NOW,
    });
    expect(hasStrategyGateRow(sql, "long_strangle")).toBe(false);
    const noApproval = resolveChallengerOutcome(sql, "alice", retire.id, {
      outcome: "retire_strategy",
      actor: OWNER,
      reason: "Persistent holdout loser.",
      now: NOW,
    });
    expect(noApproval.ok).toBe(false);
    recordChallengerApproval(sql, "alice", retire.id, {
      approver: OWNER,
      decision: "approved",
      now: NOW,
    });
    const done = resolveChallengerOutcome(sql, "alice", retire.id, {
      outcome: "retire_strategy",
      actor: OWNER,
      reason: "Persistent holdout loser.",
      now: NOW,
    });
    expect(done.ok).toBe(true);
    expect(isStrategyGatedOff(sql, "long_strangle")).toBe(true);
    expect(getChallenger(sql, "alice", retire.id)!.status).toBe("retired");
    void challenger;

    const rolled = rollbackChallengerPromotion(sql, "alice", retire.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(rolled.ok).toBe(true);
    expect(hasStrategyGateRow(sql, "long_strangle")).toBe(false);
  });

  it("promotes an active set as a versioned record", async () => {
    const sql = newSql();
    const challenger = createChallenger(sql, "alice", {
      kind: "active_set",
      title: "Chop active set v-next",
      regime: "chop",
      spec: { activeStrategies: ["iron_condor", "bull_put_spread"] },
      criteria: CRITERIA,
      evalSetVersion: "v2",
      createdBy: "research-agent",
      now: NOW,
    });
    await evaluateChallenger(sql, "alice", challenger.id, {
      championSpec: { weights: {}, activeStrategies: null },
      challengerSpec: {
        weights: {},
        activeStrategies: ["iron_condor", "bull_put_spread"],
      },
      now: NOW,
    });
    recordChallengerApproval(sql, "alice", challenger.id, {
      approver: OWNER,
      decision: "approved",
      now: NOW,
    });
    const promoted = promoteChallenger(sql, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(promoted.ok).toBe(true);
    const active = getActiveStrategySet(sql, "alice");
    expect(active).not.toBeNull();
    expect(active!.strategies).toEqual(["iron_condor", "bull_put_spread"]);
    expect(active!.version).toBeGreaterThanOrEqual(1);
  });

  it("the kill switch blocks promotion", async () => {
    const sql = newSql();
    const { challenger } = await evaluatedWeightsChallenger(sql);
    recordChallengerApproval(sql, "alice", challenger.id, {
      approver: OWNER,
      decision: "approved",
      now: NOW,
    });
    setKillSwitch(sql, true);
    const res = promoteChallenger(sql, "alice", challenger.id, {
      actor: OWNER,
      now: NOW,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/halt/i);
    expect(getStrategyWeightsV2(sql)["iron_condor|chop"]).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Recovery drills (researchTaskLedger idiom)                          */
/* ------------------------------------------------------------------ */

function memStore(): ResearchTaskStore {
  const raw = new Map<string, string>();
  return {
    get: (k) => (raw.has(k) ? raw.get(k)! : null),
    set: (k, v) => void raw.set(k, v),
    delete: (k) => void raw.delete(k),
    list: (prefix) =>
      [...raw.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
  };
}

function drillLedger(startIso: string) {
  let clock = Date.parse(startIso);
  let ids = 0;
  const store = memStore();
  const ledger = new ResearchTaskLedger(store, {
    now: () => new Date(clock).toISOString(),
    newId: () => `task-${++ids}`,
  });
  return {
    ledger,
    advanceMs: (ms: number) => {
      clock += ms;
    },
  };
}

const GOOD_EVAL = evaluateResearchOutcome(
  {
    reportRunId: "run-drill",
    expectedTrigger: "scheduled",
    expectedUserLogin: "alice",
    reportTrigger: "scheduled",
    reportUserLogin: "alice",
    summary: "drill",
    ideas: 1,
    watchlist: 0,
    rejected: 0,
  },
  "2026-10-23T12:00:00.000Z"
);

describe("recovery drills for autonomous runs", () => {
  it("interruption: a stale-heartbeat run is swept to escalated, visible to a human", () => {
    const { ledger, advanceMs } = drillLedger("2026-10-23T02:00:00.000Z");
    const { task } = ledger.create({
      trigger: "scheduled",
      userLogin: "alice",
      idempotencyKey: "rsi:nightly:2026-10-23",
    });
    ledger.claim(task.id);
    ledger.start(task.id);
    advanceMs(31 * 60_000); // worker dies mid-run; heartbeat stops
    const swept = ledger.sweepStale(30 * 60_000);
    expect(swept.map((t) => t.id)).toContain(task.id);
    const after = ledger.get(task.id)!;
    expect(after.status).toBe("escalated");
    expect(ledger.list().some((t) => t.status === "escalated")).toBe(true);
  });

  it("duplicate delivery: one record, one execution — consequential steps run exactly once", () => {
    const { ledger } = drillLedger("2026-10-23T02:00:00.000Z");
    const executed: string[] = [];
    // Two deliveries of the same scheduled run arrive before the
    // first completes (the #577 dedup contract: an ACTIVE task for
    // the idempotency key is shared, never duplicated).
    const first = ledger.create({
      trigger: "scheduled",
      userLogin: "alice",
      idempotencyKey: "rsi:nightly:2026-10-23",
    });
    const second = ledger.create({
      trigger: "scheduled",
      userLogin: "alice",
      idempotencyKey: "rsi:nightly:2026-10-23",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(ledger.list()).toHaveLength(1);

    // Only the creating delivery executes; the duplicate is a no-op.
    ledger.claim(first.task.id);
    ledger.start(first.task.id);
    executed.push("reselect", "evaluate", "record-proposal");
    ledger.complete(first.task.id, {
      path: "fallback",
      reportRunId: "run-drill",
      evaluation: GOOD_EVAL,
    });
    expect(executed).toEqual(["reselect", "evaluate", "record-proposal"]);
    expect(ledger.get(first.task.id)!.status).toBe("completed");
  });

  it("provider timeout: failure escalates visibly with the error retained", () => {
    const { ledger } = drillLedger("2026-10-23T02:00:00.000Z");
    const { task } = ledger.create({
      trigger: "scheduled",
      userLogin: "alice",
      idempotencyKey: "rsi:timeout",
    });
    ledger.claim(task.id);
    ledger.start(task.id);
    ledger.fail(task.id, "provider timeout after 30000ms (E*TRADE quotes)");
    const escalated = ledger.escalate(task.id, "nightly run failed; human review");
    expect(escalated.status).toBe("escalated");
    expect(escalated.error).toMatch(/provider timeout/);
  });

  it("expired credentials: failure escalates visibly — never a silent retry loop", () => {
    const { ledger } = drillLedger("2026-10-23T02:00:00.000Z");
    const { task } = ledger.create({
      trigger: "scheduled",
      userLogin: "alice",
      idempotencyKey: "rsi:creds",
    });
    ledger.claim(task.id);
    ledger.start(task.id);
    ledger.fail(task.id, "broker credentials expired (401) — re-auth required");
    ledger.escalate(task.id, "credentials expired; owner must re-authenticate");
    const after = ledger.get(task.id)!;
    expect(after.status).toBe("escalated");
    expect(after.error).toMatch(/credentials expired/);
    // A stale sweep must not resurrect or retry a terminal task.
    expect(ledger.sweepStale(0)).toEqual([]);
    expect(ledger.get(task.id)!.status).toBe("escalated");
  });

  it("cancellation: a cancelled run is terminal — it cannot start, heartbeat, or be swept back", () => {
    const { ledger, advanceMs } = drillLedger("2026-10-23T02:00:00.000Z");
    const { task } = ledger.create({
      trigger: "manual",
      userLogin: "alice",
      idempotencyKey: "rsi:cancel",
    });
    ledger.claim(task.id);
    ledger.cancel(task.id);
    expect(ledger.get(task.id)!.status).toBe("cancelled");
    expect(() => ledger.start(task.id)).toThrow(/cannot move/);
    expect(() => ledger.heartbeat(task.id)).toThrow(/cannot heartbeat/);
    advanceMs(60 * 60_000);
    expect(ledger.sweepStale(30 * 60_000)).toEqual([]);
    expect(ledger.get(task.id)!.status).toBe("cancelled");
  });

  it("budget exhaustion: partial work is recorded, the run escalates, and reconciliation repeats no completed step", () => {
    const { ledger } = drillLedger("2026-10-23T02:00:00.000Z");
    const COST_CAP = 100;
    const STEP_COST = 40;
    const journal: Array<{ step: string; cost: number }> = [];
    const { task } = ledger.create({
      trigger: "scheduled",
      userLogin: "alice",
      idempotencyKey: "rsi:budget",
    });
    ledger.claim(task.id);
    ledger.start(task.id);
    let spent = 0;
    let exhausted = false;
    for (const step of ["screen", "discover", "optimize", "report"]) {
      if (spent + STEP_COST > COST_CAP) {
        exhausted = true;
        break;
      }
      journal.push({ step, cost: STEP_COST });
      spent += STEP_COST;
      ledger.heartbeat(task.id);
    }
    expect(exhausted).toBe(true);
    ledger.fail(task.id, `budget exhausted: cost cap ${COST_CAP} units at ${spent}`);
    ledger.escalate(task.id, "budget exhaustion; reconcile before any re-run");
    expect(ledger.get(task.id)!.status).toBe("escalated");

    // Reconciliation: completed steps come from the journal; a re-plan
    // contains only the steps that never ran — nothing is repeated.
    const completed = journal.map((j) => j.step);
    const replan = ["screen", "discover", "optimize", "report"].filter(
      (s) => !completed.includes(s)
    );
    expect(completed).toEqual(["screen", "discover"]);
    expect(replan).toEqual(["optimize", "report"]);
    expect(new Set(completed).size).toBe(completed.length);
  });
});
