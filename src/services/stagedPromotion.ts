/**
 * Issue #760 (P2-5.4): staged promotion with automatic rollback —
 * the final step of the Phase 5 pipeline (#757 → #758 → #759 → here).
 *
 * A candidate that passed the #759 gate is promoted stepwise:
 *
 *   shadow   — the promotion is recorded; NOTHING is applied. The
 *              stage exists so the intent, the baseline snapshot, and
 *              the clock are on record before any state moves.
 *   partial  — half the change is applied (weight halfway to the
 *              floor / cap halfway to the target).
 *   full     — the change is fully applied (gate flag on / cap at
 *              target) and the candidate becomes "promoted".
 *   completed— the full stage's own regression check passed after
 *              its time-box; the promotion is done.
 *
 * Every application goes through the #755 seam (audited; the kill
 * switch is checked before start and before every advance). Budgets
 * are not enforced for these applications (see applyAdaptation):
 * budgets bound the autonomous loop, while a promotion is bounded
 * by the human gate, the stages, and the rollback below.
 *
 * Before any advance out of partial/full, a regression check compares
 * the post-stage metric (ideas recorded since the current stage
 * began) against the pre-promotion baseline. Too little post-stage
 * data holds the stage — no advance, no rollback. A drop beyond
 * PROMOTION_POLICY.regressionTolerance rolls the change back
 * automatically: the pre-promotion snapshot is restored EXACTLY
 * (including "the row did not exist"), the rollback itself is
 * audited through the seam, and the candidate is rejected — a
 * regressed change must re-prove itself from scratch.
 */
import type { TrackRecord, TrackRecordIdea } from "./researchTrackRecord";
import {
  getImprovementCandidate,
  transitionCandidate,
  type ImprovementCandidate,
} from "./improvementCandidates";
import { listGateVerdicts } from "./promotionGate";
import { applyAdaptation, isAdaptationHalted } from "./adaptationAudit";
import {
  getStrategyWeights,
  setStrategyWeight,
  deleteStrategyWeight,
  STRATEGY_WEIGHT_BOUNDS,
} from "./strategyWeights";
import {
  getStrategyWeightCap,
  setStrategyWeightCap,
  isStrategyGatedOff,
  hasStrategyGateRow,
  setStrategyGate,
} from "./strategyPolicyState";
import { ideasInEvaluationWindow, isWinningIdea } from "./candidateEvaluation";

export const PROMOTION_POLICY = {
  regressionTolerance: 0.05,
  minPostStageSample: 10,
  stageDurationsMs: {
    shadow: 24 * 3600_000,
    partial: 72 * 3600_000,
    full: 72 * 3600_000,
  },
} as const;

export type PromotionStage = "shadow" | "partial" | "full" | "completed" | "rolled_back";

export interface PromotionBaseline {
  strategy: string;
  weightRowExisted: boolean;
  weight: number | null;
  cap: number | null;
  gateRowExisted: boolean;
  gatedOff: boolean;
  metric: number | null;
}

export interface Promotion {
  id: string;
  candidateId: string;
  stage: PromotionStage;
  stageStartedAt: string;
  baseline: PromotionBaseline;
  applied: Record<string, unknown>;
  lastCheck: Record<string, unknown> | null;
  createdAt: string;
}

export interface PromotionResult {
  ok: boolean;
  action?: "advanced" | "completed" | "rolled_back";
  reason?: string;
  promotion?: Promotion;
}

const PROMOTION_ACTOR = "staged-promotion";
const ROLLBACK_ACTOR = "staged-promotion-rollback";

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function ensurePromotionsTable(sql: any): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_promotions (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'shadow',
    stage_started_at TEXT NOT NULL,
    baseline_json TEXT NOT NULL DEFAULT '{}',
    applied_json TEXT NOT NULL DEFAULT '{}',
    last_check_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_promotions_candidate ON mas_promotions(candidate_id, created_at)`);
}

function rowToPromotion(r: any): Promotion {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    stage: r.stage,
    stageStartedAt: r.stage_started_at,
    baseline: JSON.parse(r.baseline_json || "{}"),
    applied: JSON.parse(r.applied_json || "{}"),
    lastCheck: r.last_check_json ? JSON.parse(r.last_check_json) : null,
    createdAt: r.created_at,
  };
}

export function getPromotion(sql: any, id: string): Promotion | null {
  ensurePromotionsTable(sql);
  const rows = Array.from(sql.exec(`SELECT * FROM mas_promotions WHERE id = ?`, id)) as any[];
  return rows.length > 0 ? rowToPromotion(rows[0]) : null;
}

export function listPromotions(sql: any, candidateId: string): Promotion[] {
  ensurePromotionsTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_promotions WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 50`,
      candidateId
    )
  ) as any[];
  return rows.map(rowToPromotion);
}

function updatePromotion(
  sql: any,
  promotion: Promotion,
  patch: Partial<Pick<Promotion, "stage" | "stageStartedAt" | "applied" | "lastCheck">>
): Promotion {
  const next: Promotion = { ...promotion, ...patch };
  sql.exec(
    `UPDATE mas_promotions SET stage = ?, stage_started_at = ?, applied_json = ?, last_check_json = ? WHERE id = ?`,
    next.stage,
    next.stageStartedAt,
    JSON.stringify(next.applied),
    next.lastCheck ? JSON.stringify(next.lastCheck) : null,
    next.id
  );
  return next;
}

function targetStrategy(candidate: ImprovementCandidate): string | null {
  for (const prefix of ["strategy-gate:", "strategy-weight-cap:"]) {
    if (candidate.target.startsWith(prefix)) return candidate.target.slice(prefix.length);
  }
  return null;
}

function weightedWinRate(ideas: TrackRecordIdea[], weights: Record<string, number>): number | null {
  let num = 0;
  let den = 0;
  for (const i of ideas) {
    const w = weights[i.structure || "(unknown)"] ?? 1.0;
    den += w;
    if (isWinningIdea(i)) num += w;
  }
  return den > 0 ? num / den : null;
}

function plainWinRate(ideas: TrackRecordIdea[]): number | null {
  if (ideas.length === 0) return null;
  return ideas.filter(isWinningIdea).length / ideas.length;
}

/** The metric a candidate's regression is judged on. */
function currentMetric(
  sql: any,
  candidate: ImprovementCandidate,
  ideas: TrackRecordIdea[]
): number | null {
  if (candidate.change.action === "raise-weight-cap") {
    return weightedWinRate(ideas, getStrategyWeights(sql));
  }
  return plainWinRate(ideas);
}

function baselineMetric(sql: any, candidate: ImprovementCandidate, track: TrackRecord): number | null {
  const evaluated = track.ideas.filter((i) => i.evaluation != null);
  if (candidate.change.action === "raise-weight-cap") {
    return weightedWinRate(evaluated, getStrategyWeights(sql));
  }
  return track.winRate;
}

/**
 * Start a promotion for a gated candidate with a passing #759
 * verdict. Snapshots the exact pre-promotion state and parks the
 * promotion in shadow — no live state changes here.
 */
export function startPromotion(
  sql: any,
  candidate: ImprovementCandidate,
  track: TrackRecord,
  opts: { now?: Date } = {}
): PromotionResult {
  const now = opts.now ?? new Date();
  if (isAdaptationHalted(sql)) {
    return { ok: false, reason: "adaptation kill switch is on — promotions are halted" };
  }
  if (candidate.status !== "gated") {
    return { ok: false, reason: `candidate is in status "${candidate.status}" — only gated candidates can be promoted` };
  }
  const strategy = targetStrategy(candidate);
  if (!strategy || (candidate.change.action !== "disable-strategy" && candidate.change.action !== "raise-weight-cap")) {
    return { ok: false, reason: `no promotion applier is defined for change action "${candidate.change.action}"` };
  }
  const latestVerdict = listGateVerdicts(sql, candidate.id)[0];
  if (!latestVerdict || !latestVerdict.passed) {
    return { ok: false, reason: "no passing promotion-gate verdict exists for this candidate" };
  }
  const existing = listPromotions(sql, candidate.id).find(
    (p) => p.stage === "shadow" || p.stage === "partial" || p.stage === "full"
  );
  if (existing) return { ok: true, promotion: existing };

  const weights = getStrategyWeights(sql);
  const baseline: PromotionBaseline = {
    strategy,
    weightRowExisted: Object.prototype.hasOwnProperty.call(weights, strategy),
    weight: weights[strategy] ?? null,
    cap: getStrategyWeightCap(sql, strategy),
    gateRowExisted: hasStrategyGateRow(sql, strategy),
    gatedOff: isStrategyGatedOff(sql, strategy),
    metric: baselineMetric(sql, candidate, track),
  };
  ensurePromotionsTable(sql);
  const id = `promo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const iso = now.toISOString();
  sql.exec(
    `INSERT INTO mas_promotions (id, candidate_id, stage, stage_started_at, baseline_json, applied_json, last_check_json, created_at)
     VALUES (?, ?, 'shadow', ?, ?, ?, NULL, ?)`,
    id,
    candidate.id,
    iso,
    JSON.stringify(baseline),
    "{}",
    iso
  );
  return {
    ok: true,
    promotion: {
      id,
      candidateId: candidate.id,
      stage: "shadow",
      stageStartedAt: iso,
      baseline,
      applied: {},
      lastCheck: null,
      createdAt: iso,
    },
  };
}

interface SeamChange {
  parameter: string;
  before: string;
  after: string;
  delta: number;
  rationale: string;
  apply: () => void;
}

/** Apply one aspect through the #755 seam (audit on; budgets exempt per policy). */
function applyViaSeam(
  sql: any,
  candidate: ImprovementCandidate,
  promotion: Promotion,
  actor: string,
  change: SeamChange,
  now: Date
): { applied: boolean; reason?: string } {
  return applyAdaptation(
    sql,
    {
      actor,
      subject: `promotion:${candidate.id}`,
      parameter: change.parameter,
      before: change.before,
      after: change.after,
      delta: change.delta,
      rationale: change.rationale,
      dataWindow: `promotion ${promotion.id} stage ${promotion.stage}`,
    },
    change.apply,
    now,
    { enforceBudgets: false }
  );
}

/** The applications that move the promotion INTO `next` stage. */
function stageApplications(
  sql: any,
  candidate: ImprovementCandidate,
  promotion: Promotion,
  next: "partial" | "full",
  now: Date
): { changes: SeamChange[]; applied: Record<string, unknown> } {
  const strategy = promotion.baseline.strategy;
  const applied = { ...promotion.applied };
  const changes: SeamChange[] = [];
  const verdictNote = "human-gated staged promotion (#759 verdict passed)";

  if (candidate.change.action === "disable-strategy") {
    const floor = STRATEGY_WEIGHT_BOUNDS.min;
    const currentWeight = getStrategyWeights(sql)[strategy] ?? STRATEGY_WEIGHT_BOUNDS.defaultWeight;
    if (next === "partial") {
      const snapshotWeight = promotion.baseline.weight ?? STRATEGY_WEIGHT_BOUNDS.defaultWeight;
      const halfway = round4((snapshotWeight + floor) / 2);
      changes.push({
        parameter: "weight",
        before: String(currentWeight),
        after: String(halfway),
        delta: round4(halfway - currentWeight),
        rationale: `partial promotion of gate-off for "${strategy}": weight halfway to the floor (${verdictNote})`,
        apply: () => setStrategyWeight(sql, strategy, halfway, now),
      });
      applied.weight = halfway;
    } else {
      if (currentWeight !== floor) {
        changes.push({
          parameter: "weight",
          before: String(currentWeight),
          after: String(floor),
          delta: round4(floor - currentWeight),
          rationale: `full promotion of gate-off for "${strategy}": weight to the floor (${verdictNote})`,
          apply: () => setStrategyWeight(sql, strategy, floor, now),
        });
      }
      applied.weight = floor;
      changes.push({
        parameter: "strategy-gate",
        before: String(isStrategyGatedOff(sql, strategy)),
        after: "true",
        delta: 1,
        rationale: `full promotion of gate-off for "${strategy}": strategy gated off (${verdictNote})`,
        apply: () => setStrategyGate(sql, strategy, true, now),
      });
      applied.gatedOff = true;
    }
  } else if (candidate.change.action === "raise-weight-cap") {
    const targetCap = typeof candidate.change.to === "number" ? candidate.change.to : null;
    if (targetCap === null) return { changes: [], applied };
    const currentCap = getStrategyWeightCap(sql, strategy) ?? STRATEGY_WEIGHT_BOUNDS.max;
    const newCap = next === "partial" ? round4((currentCap + targetCap) / 2) : targetCap;
    changes.push({
      parameter: "weight-cap",
      before: String(currentCap),
      after: String(newCap),
      delta: round4(newCap - currentCap),
      rationale: `${next} promotion of weight-cap raise for "${strategy}" (${verdictNote})`,
      apply: () => setStrategyWeightCap(sql, strategy, newCap, now),
    });
    applied.cap = newCap;
  }
  return { changes, applied };
}

/** Restore the baseline snapshot exactly, through the seam. */
function rollbackPromotion(
  sql: any,
  candidate: ImprovementCandidate,
  promotion: Promotion,
  check: Record<string, unknown>,
  now: Date
): Promotion {
  const b = promotion.baseline;
  const strategy = b.strategy;
  const restores: SeamChange[] = [];
  if (promotion.applied.weight !== undefined) {
    restores.push({
      parameter: "weight",
      before: String(getStrategyWeights(sql)[strategy] ?? STRATEGY_WEIGHT_BOUNDS.defaultWeight),
      after: b.weightRowExisted ? String(b.weight) : "(no row)",
      delta: 0,
      rationale: `rollback of promotion ${promotion.id}: regression detected — restoring pre-promotion weight for "${strategy}"`,
      apply: () => {
        if (b.weightRowExisted && b.weight !== null) setStrategyWeight(sql, strategy, b.weight, now);
        else deleteStrategyWeight(sql, strategy);
      },
    });
  }
  if (promotion.applied.cap !== undefined) {
    restores.push({
      parameter: "weight-cap",
      before: String(getStrategyWeightCap(sql, strategy) ?? STRATEGY_WEIGHT_BOUNDS.max),
      after: b.cap !== null ? String(b.cap) : "(no override)",
      delta: 0,
      rationale: `rollback of promotion ${promotion.id}: regression detected — restoring pre-promotion cap for "${strategy}"`,
      apply: () => setStrategyWeightCap(sql, strategy, b.cap, now),
    });
  }
  if (promotion.applied.gatedOff !== undefined) {
    restores.push({
      parameter: "strategy-gate",
      before: String(isStrategyGatedOff(sql, strategy)),
      after: b.gateRowExisted ? String(b.gatedOff) : "(no row)",
      delta: 0,
      rationale: `rollback of promotion ${promotion.id}: regression detected — restoring pre-promotion gate for "${strategy}"`,
      apply: () => setStrategyGate(sql, strategy, b.gateRowExisted ? b.gatedOff : null, now),
    });
  }
  for (const change of restores) {
    applyViaSeam(sql, candidate, promotion, ROLLBACK_ACTOR, change, now);
  }
  if (candidate.status === "gated" || candidate.status === "promoted") {
    transitionCandidate(sql, candidate.id, "rejected", now);
  }
  return updatePromotion(sql, promotion, {
    stage: "rolled_back",
    stageStartedAt: now.toISOString(),
    lastCheck: check,
  });
}

/**
 * Advance a promotion one stage: regression check (for live stages)
 * → time-box → apply. Regression rolls back immediately, even inside
 * the time-box.
 */
export function advancePromotion(
  sql: any,
  promotionId: string,
  track: TrackRecord,
  opts: {
    now?: Date;
    stageDurationsMs?: { shadowMs: number; partialMs: number; fullMs: number };
  } = {}
): PromotionResult {
  const now = opts.now ?? new Date();
  const promotion = getPromotion(sql, promotionId);
  if (!promotion) return { ok: false, reason: `promotion ${promotionId} not found` };
  if (promotion.stage === "completed" || promotion.stage === "rolled_back") {
    return { ok: false, reason: `promotion is already ${promotion.stage}`, promotion };
  }
  if (isAdaptationHalted(sql)) {
    return { ok: false, reason: "adaptation kill switch is on — promotions are halted", promotion };
  }
  const candidate = getImprovementCandidate(sql, promotion.candidateId);
  if (!candidate) return { ok: false, reason: "candidate no longer exists", promotion };

  // Regression check for stages where something is live.
  if (promotion.stage === "partial" || promotion.stage === "full") {
    const post = ideasInEvaluationWindow(track, { from: promotion.stageStartedAt });
    if (post.length < PROMOTION_POLICY.minPostStageSample) {
      const held = updatePromotion(sql, promotion, {
        lastCheck: {
          outcome: "insufficient-data",
          postStageSample: post.length,
          at: now.toISOString(),
        },
      });
      return {
        ok: false,
        reason: `insufficient post-stage data (${post.length} evaluated ideas since the stage began; ${PROMOTION_POLICY.minPostStageSample} required) — stage held`,
        promotion: held,
      };
    }
    const metric = currentMetric(sql, candidate, post);
    const check = {
      outcome: "pass",
      postStageSample: post.length,
      metric,
      baselineMetric: promotion.baseline.metric,
      at: now.toISOString(),
    };
    if (
      metric !== null &&
      promotion.baseline.metric !== null &&
      promotion.baseline.metric - metric > PROMOTION_POLICY.regressionTolerance
    ) {
      const rolled = rollbackPromotion(
        sql,
        candidate,
        promotion,
        { ...check, outcome: "regression" },
        now
      );
      return { ok: true, action: "rolled_back", promotion: rolled };
    }
    promotion.lastCheck = check;
  }

  // Time-box.
  const durations = opts.stageDurationsMs ?? {
    shadowMs: PROMOTION_POLICY.stageDurationsMs.shadow,
    partialMs: PROMOTION_POLICY.stageDurationsMs.partial,
    fullMs: PROMOTION_POLICY.stageDurationsMs.full,
  };
  const boxMs =
    promotion.stage === "shadow"
      ? durations.shadowMs
      : promotion.stage === "partial"
        ? durations.partialMs
        : durations.fullMs;
  const elapsed = now.getTime() - Date.parse(promotion.stageStartedAt);
  if (elapsed < boxMs) {
    return {
      ok: false,
      reason: `stage time-box has not elapsed (${elapsed}ms of ${boxMs}ms in stage "${promotion.stage}")`,
      promotion,
    };
  }

  if (promotion.stage === "full") {
    const done = updatePromotion(sql, promotion, {
      stage: "completed",
      stageStartedAt: now.toISOString(),
      lastCheck: promotion.lastCheck,
    });
    return { ok: true, action: "completed", promotion: done };
  }

  const next = promotion.stage === "shadow" ? "partial" : "full";
  const { changes, applied } = stageApplications(sql, candidate, promotion, next, now);
  for (const change of changes) {
    const out = applyViaSeam(sql, candidate, promotion, PROMOTION_ACTOR, change, now);
    if (!out.applied) {
      return { ok: false, reason: `application blocked: ${out.reason ?? "unknown"}`, promotion };
    }
  }
  if (next === "full") {
    transitionCandidate(sql, candidate.id, "promoted", now);
  }
  const advanced = updatePromotion(sql, promotion, {
    stage: next,
    stageStartedAt: now.toISOString(),
    applied,
    lastCheck: promotion.lastCheck,
  });
  return { ok: true, action: "advanced", promotion: advanced };
}
