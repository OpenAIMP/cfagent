/**
 * Issue #754 (P2-4.1): calibration-driven strategy-weight adjustment.
 *
 * Strategy weights are the multiplier a strategy's track record earns:
 * strategies whose evaluated ideas beat the overall win rate gain
 * weight; those that trail lose it. The adjustment job reads the #340
 * track record (per-strategy evaluated/win-rate slices), proposes
 * bounded moves, and applies them exclusively through the #755
 * enforcement seam (budget-checked, audit-trailed). It generalizes
 * #18's human-configured profile biasing into a measured mechanism —
 * while honoring #17's guardrail: weights are computed and stored
 * here, and no production ranking path reads them until an explicit,
 * reviewed config change wires a consumer.
 *
 * Hard bounds (the #79 envelope pattern): weights live in
 * [0.25, 2.0], move at most ±0.10 per run, require >= 20 evaluated
 * ideas (#17's low-sample threshold), and ignore sub-0.02 signals
 * (deadband). Out-of-bounds proposals are clamped; a strategy already
 * at a bound does not move. The job runs at most once per ISO week
 * unless forced, and halts entirely under the adaptation kill switch
 * (#756).
 */
import type { TrackRecord, TrackRecordSlice } from "./researchTrackRecord";
import { applyAdaptation, isAdaptationHalted } from "./adaptationAudit";
import { getStrategyWeightCaps, isStrategyGatedOff } from "./strategyPolicyState";

export const STRATEGY_WEIGHT_BOUNDS = {
  min: 0.25,
  max: 2.0,
  maxStep: 0.1,
  minSample: 20,
  deadband: 0.02,
  defaultWeight: 1.0,
} as const;

export const WEIGHTS_LAST_RUN_WEEK_KEY = "adaptation.weights.lastRunWeek";
export const WEIGHT_ADAPTATION_ACTOR = "strategy-weight-job";

export function ensureStrategyWeightsTable(sql: any): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_strategy_weights (
    strategy TEXT PRIMARY KEY,
    weight REAL NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export function getStrategyWeights(sql: any): Record<string, number> {
  ensureStrategyWeightsTable(sql);
  const rows = Array.from(sql.exec(`SELECT strategy, weight FROM mas_strategy_weights`)) as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.strategy] = r.weight;
  return out;
}

export function getStrategyWeight(sql: any, strategy: string): number {
  ensureStrategyWeightsTable(sql);
  const rows = Array.from(
    sql.exec(`SELECT weight FROM mas_strategy_weights WHERE strategy = ?`, strategy)
  ) as any[];
  return rows.length > 0 ? rows[0].weight : STRATEGY_WEIGHT_BOUNDS.defaultWeight;
}

export function setStrategyWeight(sql: any, strategy: string, weight: number, now: Date): void {
  ensureStrategyWeightsTable(sql);
  sql.exec(
    `INSERT OR REPLACE INTO mas_strategy_weights (strategy, weight, updated_at) VALUES (?, ?, ?)`,
    strategy,
    weight,
    now.toISOString()
  );
}

/** Remove a weight row entirely (#760 exact-restore: "no row" is a state). */
export function deleteStrategyWeight(sql: any, strategy: string): void {
  ensureStrategyWeightsTable(sql);
  sql.exec(`DELETE FROM mas_strategy_weights WHERE strategy = ?`, strategy);
}

export interface WeightProposal {
  strategy: string;
  current: number;
  proposed: number;
  delta: number;
  evaluated: number;
  winRate: number;
  overallWinRate: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * The pure policy: given the track record and current weights, the
 * moves this run would make. Deterministic; no store access.
 */
export function proposeWeightAdjustments(
  track: TrackRecord,
  weights: Record<string, number>,
  caps: Record<string, number> = {}
): WeightProposal[] {
  const overall = track.winRate;
  if (overall === null) return [];
  const proposals: WeightProposal[] = [];
  for (const slice of track.byStrategy) {
    if (slice.evaluated < STRATEGY_WEIGHT_BOUNDS.minSample) continue;
    if (slice.winRate === null) continue;
    const step = clamp(slice.winRate - overall, -STRATEGY_WEIGHT_BOUNDS.maxStep, STRATEGY_WEIGHT_BOUNDS.maxStep);
    if (Math.abs(step) < STRATEGY_WEIGHT_BOUNDS.deadband) continue;
    const current = weights[slice.key] ?? STRATEGY_WEIGHT_BOUNDS.defaultWeight;
    // A per-strategy cap override (#760, human-gated through the
    // promotion pipeline) replaces the global max for that strategy.
    const maxBound = caps[slice.key] ?? STRATEGY_WEIGHT_BOUNDS.max;
    const proposed = round4(clamp(current + step, STRATEGY_WEIGHT_BOUNDS.min, maxBound));
    if (proposed === current) continue;
    proposals.push({
      strategy: slice.key,
      current,
      proposed,
      delta: round4(proposed - current),
      evaluated: slice.evaluated,
      winRate: slice.winRate,
      overallWinRate: overall,
    });
  }
  return proposals;
}

function isoWeekKey(d: Date): string {
  // ISO 8601 week: shift to the Thursday of the current week.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function readSetting(sql: any, key: string): string | null {
  try {
    const rows = Array.from(sql.exec(`SELECT value FROM mas_settings WHERE key = ?`, key)) as any[];
    return rows.length > 0 ? String(rows[0].value) : null;
  } catch {
    return null;
  }
}

function writeSetting(sql: any, key: string, value: string, now: Date): void {
  // DELETE+INSERT idiom (orchestrator writeSetting) for MockSqlStorage parity.
  sql.exec(`DELETE FROM mas_settings WHERE key = ?`, key);
  sql.exec(
    `INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)`,
    key,
    value,
    now.toISOString()
  );
}

export interface WeightAdjustmentResult {
  halted?: boolean;
  skipped?: string;
  considered: number;
  adjusted: Array<{ strategy: string; before: number; after: number; delta: number }>;
  blocked: Array<{ strategy: string; reason: string }>;
  skippedLowSample: string[];
  /** Strategies skipped because a #760 promotion gated them off. */
  skippedGated: string[];
}

/**
 * The scheduled job. Weekly-guarded unless `force`; halted outright by
 * the adaptation kill switch. Every application goes through #755's
 * applyAdaptation (budget + audit); blocked strategies keep their
 * weight and are reported.
 */
export function runStrategyWeightAdjustment(
  sql: any,
  track: TrackRecord,
  opts: { now?: Date; force?: boolean; actor?: string } = {}
): WeightAdjustmentResult {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? WEIGHT_ADAPTATION_ACTOR;
  const base: WeightAdjustmentResult = {
    considered: track.byStrategy.length,
    adjusted: [],
    blocked: [],
    skippedLowSample: track.byStrategy
      .filter((s: TrackRecordSlice) => s.evaluated < STRATEGY_WEIGHT_BOUNDS.minSample)
      .map((s: TrackRecordSlice) => s.key),
    skippedGated: [],
  };

  if (isAdaptationHalted(sql)) {
    return { ...base, halted: true };
  }

  const week = isoWeekKey(now);
  if (!opts.force && readSetting(sql, WEIGHTS_LAST_RUN_WEEK_KEY) === week) {
    return { ...base, skipped: "already ran this week" };
  }

  const weights = getStrategyWeights(sql);
  const proposals = proposeWeightAdjustments(track, weights, getStrategyWeightCaps(sql));
  const generatedAt = track.ideas.length > 0 ? track.ideas[0].runCreatedAt : now.toISOString();
  for (const p of proposals) {
    // A strategy gated off by a #760 promotion is out of the
    // adaptation loop entirely — no proposals are applied to it.
    if (isStrategyGatedOff(sql, p.strategy)) {
      base.skippedGated.push(p.strategy);
      continue;
    }
    const out = applyAdaptation(
      sql,
      {
        actor,
        subject: `strategy-weight:${p.strategy}`,
        parameter: "weight",
        before: String(p.current),
        after: String(p.proposed),
        delta: p.delta,
        rationale:
          `winRate ${p.winRate.toFixed(2)} vs overall ${p.overallWinRate.toFixed(2)} ` +
          `over ${p.evaluated} evaluated ideas; bounded step ${p.delta >= 0 ? "+" : ""}${p.delta.toFixed(2)} ` +
          `within [${STRATEGY_WEIGHT_BOUNDS.min}, ${STRATEGY_WEIGHT_BOUNDS.max}]`,
        dataWindow: `track record through ${generatedAt.slice(0, 10)}`,
      },
      () => setStrategyWeight(sql, p.strategy, p.proposed, now),
      now
    );
    if (out.applied) {
      base.adjusted.push({ strategy: p.strategy, before: p.current, after: p.proposed, delta: p.delta });
    } else {
      base.blocked.push({ strategy: p.strategy, reason: out.reason ?? "budget" });
    }
  }

  if (!opts.force) {
    try {
      writeSetting(sql, WEIGHTS_LAST_RUN_WEEK_KEY, week, now);
    } catch (err) {
      console.error("[Adaptation] Failed to record weight-job weekly marker:", err);
    }
  }
  return base;
}

export interface WeightPolicyEvaluation {
  generatedAt: string;
  unweightedWinRate: number | null;
  weightedWinRate: number | null;
  proposals: WeightProposal[];
  lowSample: string[];
}

/**
 * The #17-style evaluation harness: what the current weights imply
 * (weighted vs unweighted win rate over the track record) and what the
 * policy would do next. Measurement only — applies nothing.
 */
export function buildWeightPolicyEvaluation(
  track: TrackRecord,
  weights: Record<string, number>
): WeightPolicyEvaluation {
  let wHits = 0;
  let wEval = 0;
  for (const s of track.byStrategy) {
    if (s.winRate === null) continue;
    const w = weights[s.key] ?? STRATEGY_WEIGHT_BOUNDS.defaultWeight;
    wHits += w * s.winRate * s.evaluated;
    wEval += w * s.evaluated;
  }
  return {
    generatedAt: new Date().toISOString(),
    unweightedWinRate: track.winRate,
    weightedWinRate: wEval > 0 ? wHits / wEval : null,
    proposals: proposeWeightAdjustments(track, weights),
    lowSample: track.byStrategy
      .filter((s) => s.evaluated < STRATEGY_WEIGHT_BOUNDS.minSample)
      .map((s) => s.key),
  };
}
