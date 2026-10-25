/**
 * Issue #758 (P2-5.2): isolated evaluation harness for improvement
 * candidates (#757).
 *
 * A candidate is evaluated against RECORDED data — counterfactual
 * replay over the research track record — never against live state.
 * The harness reports the measured effect versus the live baseline
 * with sample sizes, supports window splits (the held-out mechanics
 * the #759 promotion gate consumes), and is deterministic: identical
 * inputs produce identical reports.
 *
 * THE BOUNDARY (the point of this issue): this module has no
 * live-application surface. It imports no adaptation-application or
 * weight-writing code, writes only its own report table
 * (mas_candidate_evaluations), and moves only the candidate's own
 * lifecycle state (queued → evaluating). Live weights and the
 * adaptation audit trail are inputs' business, never outputs'.
 * tests/candidate_evaluation.test.ts pins the boundary by source
 * scan and by statement log.
 *
 * Replay methods (v1):
 *  - disable-strategy (gate-off): portfolio win rate with the
 *    strategy's evaluated ideas excluded vs the full baseline.
 *  - raise-weight-cap: weighted win rate under the "target-at-cap"
 *    scenario — the target strategy's weight at the proposed cap vs
 *    at its current capped weight, all other weights at their
 *    current stored values.
 *  - anything else: method "unsupported" with an explicit reason —
 *    the harness never fabricates an effect it cannot measure.
 */
import type { TrackRecord, TrackRecordIdea } from "./researchTrackRecord";
import {
  transitionCandidate,
  type ImprovementCandidate,
} from "./improvementCandidates";

export interface EvaluationWindow {
  from?: string;
  to?: string;
}

export interface ReplayOptions {
  weights?: Record<string, number>;
  window?: EvaluationWindow;
}

export interface EvaluationReport {
  method: "counterfactual-replay" | "unsupported";
  baselineMetric: number | null;
  candidateMetric: number | null;
  delta: number | null;
  sampleSize: number;
  detail: Record<string, unknown>;
}

export interface StoredEvaluation extends EvaluationReport {
  id: string;
  candidateId: string;
  window: EvaluationWindow;
  createdAt: string;
}

export function isWinningIdea(idea: TrackRecordIdea): boolean {
  return ((idea.evaluation?.pnlEstimatePerUnit ?? 0) as number) > 0;
}

export function ideasInEvaluationWindow(track: TrackRecord, window?: EvaluationWindow): TrackRecordIdea[] {
  return track.ideas.filter((i) => {
    if (i.evaluation == null) return false;
    if (window?.from && i.runCreatedAt < window.from) return false;
    if (window?.to && i.runCreatedAt >= window.to) return false;
    return true;
  });
}

function winRate(ideas: TrackRecordIdea[]): number | null {
  if (ideas.length === 0) return null;
  return ideas.filter(isWinningIdea).length / ideas.length;
}

function weightedWinRate(
  ideas: TrackRecordIdea[],
  weightOf: (structure: string) => number
): number | null {
  let num = 0;
  let den = 0;
  for (const i of ideas) {
    const w = weightOf(i.structure || "(unknown)");
    den += w;
    if (isWinningIdea(i)) num += w;
  }
  return den > 0 ? num / den : null;
}

function targetStructure(candidate: ImprovementCandidate, prefix: string): string | null {
  return candidate.target.startsWith(prefix)
    ? candidate.target.slice(prefix.length)
    : null;
}

/**
 * Pure replay: no storage, no clocks, no randomness — identical
 * inputs produce identical reports (pinned).
 */
export function replayCandidate(
  candidate: ImprovementCandidate,
  track: TrackRecord,
  opts: ReplayOptions
): EvaluationReport {
  const ideas = ideasInEvaluationWindow(track, opts.window);
  const sampleSize = ideas.length;
  const action = candidate.change.action;

  if (action === "disable-strategy") {
    const structure = targetStructure(candidate, "strategy-gate:");
    if (!structure) {
      return {
        method: "unsupported",
        baselineMetric: null,
        candidateMetric: null,
        delta: null,
        sampleSize,
        detail: { reason: `candidate target "${candidate.target}" does not name a strategy to disable` },
      };
    }
    const baseline = winRate(ideas);
    const remaining = ideas.filter((i) => (i.structure || "(unknown)") !== structure);
    const candidateMetric = winRate(remaining);
    return {
      method: "counterfactual-replay",
      baselineMetric: baseline,
      candidateMetric,
      delta: baseline !== null && candidateMetric !== null ? candidateMetric - baseline : null,
      sampleSize,
      detail: {
        structure,
        excludedCount: ideas.length - remaining.length,
        excludedWins: ideas.filter((i) => (i.structure || "(unknown)") === structure && isWinningIdea(i)).length,
        remainingCount: remaining.length,
      },
    };
  }

  if (action === "raise-weight-cap") {
    const structure = targetStructure(candidate, "strategy-weight-cap:");
    const fromCap = typeof candidate.change.from === "number" ? candidate.change.from : 2.0;
    const toCap = typeof candidate.change.to === "number" ? candidate.change.to : null;
    if (!structure || toCap === null) {
      return {
        method: "unsupported",
        baselineMetric: null,
        candidateMetric: null,
        delta: null,
        sampleSize,
        detail: { reason: `candidate target/change does not define a weight-cap raise` },
      };
    }
    const weights = opts.weights ?? {};
    const stored = (s: string) => weights[s] ?? 1.0;
    const baselineTargetWeight = Math.min(stored(structure), fromCap);
    const baseline = weightedWinRate(ideas, (s) => (s === structure ? baselineTargetWeight : stored(s)));
    // Scenario: the target's weight rises to the proposed cap; every
    // other strategy stays at its current stored weight.
    const candidateMetric = weightedWinRate(ideas, (s) => (s === structure ? toCap : stored(s)));
    return {
      method: "counterfactual-replay",
      baselineMetric: baseline,
      candidateMetric,
      delta: baseline !== null && candidateMetric !== null ? candidateMetric - baseline : null,
      sampleSize,
      detail: {
        structure,
        scenario: "target-at-cap",
        fromCap,
        toCap,
        targetWeightBaseline: baselineTargetWeight,
        targetWeightCandidate: toCap,
      },
    };
  }

  return {
    method: "unsupported",
    baselineMetric: null,
    candidateMetric: null,
    delta: null,
    sampleSize,
    detail: {
      reason: `no replay is defined for change action "${action}" — this candidate class needs a purpose-built evaluation before it can pass the promotion gate`,
    },
  };
}

export function ensureEvaluationsTable(sql: any): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_candidate_evaluations (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    method TEXT NOT NULL,
    baseline_metric REAL,
    candidate_metric REAL,
    delta REAL,
    sample_size INTEGER NOT NULL DEFAULT 0,
    window_from TEXT,
    window_to TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_evaluations_candidate ON mas_candidate_evaluations(candidate_id, created_at)`);
}

/**
 * Evaluate one candidate: move it queued → evaluating (its own
 * lifecycle only), run the replay, persist the report. Writes touch
 * ONLY mas_candidate_evaluations and the candidate row itself.
 */
export function evaluateCandidate(
  sql: any,
  candidate: ImprovementCandidate,
  track: TrackRecord,
  opts: ReplayOptions,
  now: Date = new Date()
): StoredEvaluation {
  if (candidate.status === "queued") {
    transitionCandidate(sql, candidate.id, "evaluating", now);
  }
  const report = replayCandidate(candidate, track, opts);
  ensureEvaluationsTable(sql);
  const id = `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const iso = now.toISOString();
  sql.exec(
    `INSERT INTO mas_candidate_evaluations
     (id, candidate_id, method, baseline_metric, candidate_metric, delta, sample_size, window_from, window_to, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    candidate.id,
    report.method,
    report.baselineMetric,
    report.candidateMetric,
    report.delta,
    report.sampleSize,
    opts.window?.from ?? null,
    opts.window?.to ?? null,
    JSON.stringify(report.detail),
    iso
  );
  return {
    ...report,
    id,
    candidateId: candidate.id,
    window: { from: opts.window?.from, to: opts.window?.to },
    createdAt: iso,
  };
}

export function listEvaluations(sql: any, candidateId: string): StoredEvaluation[] {
  ensureEvaluationsTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_candidate_evaluations WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 100`,
      candidateId
    )
  ) as any[];
  return rows.map((r) => ({
    id: r.id,
    candidateId: r.candidate_id,
    method: r.method,
    baselineMetric: r.baseline_metric,
    candidateMetric: r.candidate_metric,
    delta: r.delta,
    sampleSize: r.sample_size,
    window: { from: r.window_from ?? undefined, to: r.window_to ?? undefined },
    detail: JSON.parse(r.detail_json || "{}"),
    createdAt: r.created_at,
  }));
}
