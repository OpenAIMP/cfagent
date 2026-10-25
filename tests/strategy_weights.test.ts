/**
 * Issue #754 (P2-4.1) — calibration-driven strategy-weight adjustment pins.
 *
 *  - Weights move only within hard bounds [0.25, 2.0], in steps of at
 *    most ±0.10 per run; out-of-bounds proposals are clamped, and a
 *    strategy already at a bound does not move (never applied silently
 *    past a bound).
 *  - Strategies below the minimum sample (20 evaluated ideas, #17's
 *    low-sample threshold) are untouched.
 *  - Every applied adjustment goes through the #755 enforcement seam:
 *    audited (before/after/delta/rationale) and budget-bound; a
 *    budget-blocked strategy keeps its weight and is reported blocked.
 *  - The adaptation kill switch (mas_settings adaptation.killSwitch)
 *    halts the job entirely — nothing applied, nothing audited.
 *  - The job runs at most once per ISO week unless forced (the
 *    scheduled cadence); manual runs force.
 *  - The evaluation harness reports weighted vs unweighted win rate
 *    and the proposals the policy would make — measurement, #17-style.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getStrategyWeight,
  getStrategyWeights,
  proposeWeightAdjustments,
  runStrategyWeightAdjustment,
  buildWeightPolicyEvaluation,
  STRATEGY_WEIGHT_BOUNDS,
} from "../src/services/strategyWeights";
import { recordAdaptation } from "../src/services/adaptationAudit";
import type { TrackRecord } from "../src/services/researchTrackRecord";

function makeFakeSql() {
  const audit: any[] = [];
  const weights = new Map<string, { weight: number; updated_at: string }>();
  const settings = new Map<string, string>();
  const sql = {
    exec(text: string, ...params: any[]) {
      if (/^\s*CREATE/i.test(text)) return [];
      if (/INSERT INTO mas_adaptation_audit/i.test(text)) {
        const cols = /\(([^)]+)\)\s*VALUES/i.exec(text)![1].split(",").map((c) => c.trim());
        const row: any = {};
        cols.forEach((c, i) => (row[c] = params[i]));
        audit.push(row);
        return [];
      }
      if (/FROM mas_adaptation_audit/i.test(text)) {
        let rows = [...audit];
        if (/subject = \?/.test(text)) rows = rows.filter((r) => r.subject === params[0]);
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const lim = /LIMIT (\d+)/.exec(text);
        if (lim) rows = rows.slice(0, Number(lim[1]));
        return rows.map((r) => ({ ...r }));
      }
      if (/INSERT INTO mas_strategy_weights|INSERT OR REPLACE INTO mas_strategy_weights/i.test(text)) {
        const [strategy, weight, updated_at] = params;
        weights.set(strategy, { weight, updated_at });
        return [];
      }
      if (/FROM mas_strategy_weights/i.test(text)) {
        if (/WHERE strategy = \?/.test(text)) {
          const w = weights.get(params[0]);
          return w ? [{ strategy: params[0], ...w }] : [];
        }
        return [...weights.entries()].map(([strategy, w]) => ({ strategy, ...w }));
      }
      if (/FROM mas_settings/i.test(text)) {
        const v = settings.get(params[0]);
        return v === undefined ? [] : [{ value: v }];
      }
      if (/INSERT INTO mas_settings|INSERT OR REPLACE INTO mas_settings/i.test(text)) {
        // setSetting-style upsert: (key, value) in either order of the two params
        settings.set(params[0], params[1]);
        return [];
      }
      return [];
    },
  };
  return { sql, audit, weights, settings };
}

function track(byStrategy: Array<{ key: string; evaluated: number; winRate: number | null }>): TrackRecord {
  const evaluated = byStrategy.reduce((n, s) => n + s.evaluated, 0);
  const hits = byStrategy.reduce((n, s) => n + (s.winRate ?? 0) * s.evaluated, 0);
  return {
    published: evaluated,
    evaluated,
    invalidated: 0,
    winRate: evaluated > 0 ? hits / evaluated : null,
    directionAccuracy: null,
    avgPnlPerUnit: null,
    avgRMultiple: null,
    byStrategy: byStrategy.map((s) => ({ published: s.evaluated, avgRMultiple: null, ...s })),
    byPeriod: [],
    ideas: [],
  };
}

const NOW = new Date("2026-10-21T12:00:00.000Z"); // Wednesday, ISO week 43

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("proposeWeightAdjustments (#754 policy)", () => {
  it("proposes a bounded step toward the win-rate advantage", () => {
    const t = track([
      { key: "Momentum", evaluated: 40, winRate: 0.75 },
      { key: "MeanReversion", evaluated: 40, winRate: 0.25 },
    ]);
    // overall winRate = 0.50; Momentum advantage +0.25 → step clamps to +0.10
    const props = proposeWeightAdjustments(t, {});
    const m = props.find((p) => p.strategy === "Momentum");
    expect(m?.delta).toBeCloseTo(0.1);
    expect(m?.proposed).toBeCloseTo(1.1);
    const mr = props.find((p) => p.strategy === "MeanReversion");
    expect(mr?.delta).toBeCloseTo(-0.1);
  });

  it("clamps at the hard bounds and does not move a strategy already at a bound", () => {
    const t = track([
      { key: "Momentum", evaluated: 40, winRate: 0.9 },
      { key: "MeanReversion", evaluated: 40, winRate: 0.1 },
    ]);
    const atMax = proposeWeightAdjustments(t, { Momentum: STRATEGY_WEIGHT_BOUNDS.max });
    expect(atMax.find((p) => p.strategy === "Momentum")).toBeUndefined();
    const nearMax = proposeWeightAdjustments(t, { Momentum: 1.97 });
    expect(nearMax.find((p) => p.strategy === "Momentum")?.proposed).toBe(STRATEGY_WEIGHT_BOUNDS.max);
    const nearMin = proposeWeightAdjustments(t, { MeanReversion: 0.28 });
    expect(nearMin.find((p) => p.strategy === "MeanReversion")?.proposed).toBe(STRATEGY_WEIGHT_BOUNDS.min);
  });

  it("leaves below-minimum-sample strategies untouched", () => {
    const t = track([
      { key: "Momentum", evaluated: 19, winRate: 0.95 },
      { key: "MeanReversion", evaluated: 60, winRate: 0.4 },
    ]);
    const props = proposeWeightAdjustments(t, {});
    expect(props.find((p) => p.strategy === "Momentum")).toBeUndefined();
  });

  it("deadband: a strategy tracking the overall rate does not move", () => {
    const t = track([
      { key: "Momentum", evaluated: 40, winRate: 0.51 },
      { key: "MeanReversion", evaluated: 40, winRate: 0.49 },
    ]);
    expect(proposeWeightAdjustments(t, {})).toHaveLength(0);
  });
});

describe("runStrategyWeightAdjustment (#754 job)", () => {
  it("applies through the audit seam: weight moves, applied audit row written with rationale", () => {
    const { sql, audit } = makeFakeSql();
    const t = track([
      { key: "Momentum", evaluated: 40, winRate: 0.75 },
      { key: "MeanReversion", evaluated: 40, winRate: 0.25 },
    ]);
    const out = runStrategyWeightAdjustment(sql, t, { now: NOW, force: true });
    expect(out.halted).toBeFalsy();
    expect(out.adjusted.map((a) => a.strategy).sort()).toEqual(["MeanReversion", "Momentum"]);
    expect(getStrategyWeight(sql, "Momentum")).toBeCloseTo(1.1);
    expect(getStrategyWeight(sql, "MeanReversion")).toBeCloseTo(0.9);
    const rows = audit.filter((r) => r.status === "applied");
    expect(rows).toHaveLength(2);
    const m = rows.find((r) => r.subject === "strategy-weight:Momentum");
    expect(m.before_value).toBe("1");
    expect(m.after_value).toBe("1.1");
    expect(m.rationale).toMatch(/winRate 0\.75 vs overall 0\.50 over 40 evaluated/);
  });

  it("a budget-exhausted strategy is reported blocked and keeps its weight", () => {
    const { sql } = makeFakeSql();
    for (let i = 0; i < 4; i++) {
      recordAdaptation(sql, {
        actor: "strategy-weight-job", subject: "strategy-weight:Momentum", parameter: "weight",
        before: "1", after: "1.1", delta: 0.1, rationale: "prior", dataWindow: "w",
      }, NOW);
    }
    const t = track([
      { key: "Momentum", evaluated: 40, winRate: 0.75 },
      { key: "MeanReversion", evaluated: 40, winRate: 0.25 },
    ]);
    const out = runStrategyWeightAdjustment(sql, t, { now: NOW, force: true });
    expect(out.blocked.map((b) => b.strategy)).toEqual(["Momentum"]);
    expect(getStrategyWeight(sql, "Momentum")).toBe(1);
    expect(out.adjusted.map((a) => a.strategy)).toEqual(["MeanReversion"]);
  });

  it("kill switch halts the job: nothing applied, nothing audited", () => {
    const { sql, audit, settings } = makeFakeSql();
    settings.set("adaptation.killSwitch", "on");
    const t = track([{ key: "Momentum", evaluated: 40, winRate: 0.9 }, { key: "X", evaluated: 40, winRate: 0.1 }]);
    const out = runStrategyWeightAdjustment(sql, t, { now: NOW, force: true });
    expect(out.halted).toBe(true);
    expect(out.adjusted).toHaveLength(0);
    expect(audit).toHaveLength(0);
    expect(getStrategyWeights(sql)).toEqual({});
  });

  it("weekly guard: a second non-forced run in the same ISO week is skipped; a forced run proceeds", () => {
    const { sql } = makeFakeSql();
    const t = track([
      { key: "Momentum", evaluated: 40, winRate: 0.75 },
      { key: "MeanReversion", evaluated: 40, winRate: 0.25 },
    ]);
    const first = runStrategyWeightAdjustment(sql, t, { now: NOW });
    expect(first.skipped).toBeFalsy();
    expect(first.adjusted).toHaveLength(2);
    const second = runStrategyWeightAdjustment(sql, t, { now: NOW });
    expect(second.skipped).toMatch(/already ran this week/);
    expect(second.adjusted).toHaveLength(0);
    const forced = runStrategyWeightAdjustment(sql, t, { now: NOW, force: true });
    expect(forced.skipped).toBeFalsy();
  });
});

describe("buildWeightPolicyEvaluation (#754 harness)", () => {
  it("reports weighted vs unweighted win rate and the current proposals", () => {
    const t = track([
      { key: "Momentum", evaluated: 30, winRate: 0.8 },
      { key: "MeanReversion", evaluated: 30, winRate: 0.4 },
    ]);
    const ev = buildWeightPolicyEvaluation(t, { Momentum: 1.5, MeanReversion: 0.5 });
    expect(ev.unweightedWinRate).toBeCloseTo(0.6);
    // weighted: (1.5*24 + 0.5*12) / (1.5*30 + 0.5*30) = 42/60 = 0.70
    expect(ev.weightedWinRate).toBeCloseTo(0.70);
    expect(ev.proposals.find((p) => p.strategy === "Momentum")?.delta).toBeCloseTo(0.1);
    expect(ev.lowSample).toEqual([]);
  });
});
