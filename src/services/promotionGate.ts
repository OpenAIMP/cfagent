/**
 * Issue #759 (P2-5.3): the promotion gate.
 *
 * A candidate reaches "gated" only here, and only when BOTH hold:
 *
 *  1. Held-out significance. The candidate's latest evaluation (the
 *     held-out evaluation) ran on a bounded window disjoint from
 *     every earlier evaluation window for that candidate, has at
 *     least GATE_POLICY.minHeldOutSample evaluated ideas, and its
 *     effect re-proves there: a one-sided two-proportion z-test at
 *     α = 0.05 over the replay's independent arms (for gate-off:
 *     retained vs excluded strategies; for weight-cap: the target
 *     strategy vs all others), plus a held-out delta in the
 *     candidate's expected direction.
 *  2. Informed human approval, through the #653 decision pattern: a
 *     recorded decision on a pending row in mas_promotion_approvals
 *     (the promotion queue mirrors mas_strategy_reviews semantics
 *     deliberately — a separate store so promotion decisions never
 *     pollute the strategy-review approval-rate signal that
 *     reflection and candidate generation consume). The decision
 *     must post-date the held-out evaluation: the human approves
 *     evidence, not a hunch.
 *
 * Known limitation, stated plainly: candidate GENERATION (#757) saw
 * aggregate statistics over the full record when it selected the
 * hypothesis. The gate's protection is that the EFFECT must re-prove
 * on the disjoint held-out window before promotion — selection
 * peeking cannot manufacture a held-out effect.
 *
 * Every gate run persists a verdict with its reasons, pass or fail.
 * Failing candidates stay in "evaluating" — most failures (missing
 * approval, missing held-out run) are curable. This module is the
 * only code path that transitions a candidate to "gated" (pinned).
 */
import type { TrackRecord } from "./researchTrackRecord";
import {
  transitionCandidate,
  type ImprovementCandidate,
} from "./improvementCandidates";
import {
  ideasInEvaluationWindow,
  isWinningIdea,
  listEvaluations,
  type EvaluationWindow,
  type StoredEvaluation,
} from "./candidateEvaluation";

export const GATE_POLICY = {
  alpha: 0.05,
  minHeldOutSample: 20,
} as const;

// ---------------------------------------------------------------------------
// Human approval (the #653 decision pattern)
// ---------------------------------------------------------------------------

export interface PromotionApproval {
  id: string;
  candidateId: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: string | null;
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export function ensurePromotionApprovalsTable(sql: any): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_promotion_approvals (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_by TEXT,
    decided_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_promotion_approvals_candidate ON mas_promotion_approvals(candidate_id, status)`);
}

function rowToApproval(r: any): PromotionApproval {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    status: r.status,
    requestedBy: r.requested_by ?? null,
    decidedBy: r.decided_by ?? null,
    createdAt: r.created_at,
    decidedAt: r.decided_at ?? null,
  };
}

export function listPromotionApprovals(sql: any, candidateId: string): PromotionApproval[] {
  ensurePromotionApprovalsTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_promotion_approvals WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 50`,
      candidateId
    )
  ) as any[];
  return rows.map(rowToApproval);
}

/** Request approval for a candidate; idempotent while one is pending. */
export function requestPromotionApproval(
  sql: any,
  candidateId: string,
  requestedBy: string,
  now: Date = new Date()
): PromotionApproval {
  ensurePromotionApprovalsTable(sql);
  const pending = listPromotionApprovals(sql, candidateId).find((a) => a.status === "pending");
  if (pending) return pending;
  const id = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const iso = now.toISOString();
  sql.exec(
    `INSERT INTO mas_promotion_approvals (id, candidate_id, status, requested_by, decided_by, created_at, decided_at)
     VALUES (?, ?, 'pending', ?, NULL, ?, NULL)`,
    id,
    candidateId,
    requestedBy,
    iso
  );
  return {
    id,
    candidateId,
    status: "pending",
    requestedBy,
    decidedBy: null,
    createdAt: iso,
    decidedAt: null,
  };
}

/** Record the human decision; only a pending approval can be decided. */
export function decidePromotionApproval(
  sql: any,
  approvalId: string,
  decision: "approved" | "rejected",
  decidedBy: string,
  now: Date = new Date()
): boolean {
  ensurePromotionApprovalsTable(sql);
  const result = sql.exec(
    `UPDATE mas_promotion_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = ?`,
    decision,
    decidedBy,
    now.toISOString(),
    approvalId,
    "pending"
  ) as any;
  const changes = typeof result?.changes === "number" ? result.changes : 1;
  return changes > 0;
}

// ---------------------------------------------------------------------------
// Significance
// ---------------------------------------------------------------------------

/** Standard normal CDF (Abramowitz–Stegun 26.2.17, |ε| < 7.5e-8). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI) * poly;
  return z >= 0 ? 1 - upper : upper;
}

/**
 * One-sided two-proportion z-test of A > B (pooled variance).
 * Returns p = P(Z >= z): small p is evidence A's rate exceeds B's.
 */
export function twoProportionZTest(
  winsA: number,
  nA: number,
  winsB: number,
  nB: number
): { z: number; pOneSided: number } {
  if (nA <= 0 || nB <= 0) return { z: 0, pOneSided: 1 };
  const pA = winsA / nA;
  const pB = winsB / nB;
  const pooled = (winsA + winsB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) {
    return { z: 0, pOneSided: pA > pB ? 0 : pA < pB ? 1 : 0.5 };
  }
  const z = (pA - pB) / se;
  return { z, pOneSided: 1 - normalCdf(z) };
}

interface SignificanceArms {
  armA: { label: string; wins: number; n: number };
  armB: { label: string; wins: number; n: number };
}

/**
 * The independent comparison arms for a candidate's significance
 * test, computed from the same window + win definition the replay
 * uses (shared helpers, one source of truth).
 */
export function significanceArms(
  candidate: ImprovementCandidate,
  track: TrackRecord,
  window: EvaluationWindow
): SignificanceArms | null {
  const ideas = ideasInEvaluationWindow(track, window);
  const structureOf = (i: (typeof ideas)[number]) => i.structure || "(unknown)";
  const tally = (list: typeof ideas) => ({
    wins: list.filter(isWinningIdea).length,
    n: list.length,
  });
  if (candidate.change.action === "disable-strategy" && candidate.target.startsWith("strategy-gate:")) {
    const structure = candidate.target.slice("strategy-gate:".length);
    return {
      armA: { label: `retained (excl. ${structure})`, ...tally(ideas.filter((i) => structureOf(i) !== structure)) },
      armB: { label: `excluded (${structure})`, ...tally(ideas.filter((i) => structureOf(i) === structure)) },
    };
  }
  if (candidate.change.action === "raise-weight-cap" && candidate.target.startsWith("strategy-weight-cap:")) {
    const structure = candidate.target.slice("strategy-weight-cap:".length);
    return {
      armA: { label: `target (${structure})`, ...tally(ideas.filter((i) => structureOf(i) === structure)) },
      armB: { label: "all other strategies", ...tally(ideas.filter((i) => structureOf(i) !== structure)) },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface GateVerdict {
  id: string;
  candidateId: string;
  passed: boolean;
  reasons: string[];
  heldOutEvaluationId: string | null;
  z: number | null;
  pValue: number | null;
  approvalId: string | null;
  createdAt: string;
}

export function ensureGateVerdictsTable(sql: any): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_promotion_gate_verdicts (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    passed INTEGER NOT NULL DEFAULT 0,
    reasons_json TEXT NOT NULL DEFAULT '[]',
    heldout_evaluation_id TEXT,
    z REAL,
    p_value REAL,
    approval_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_gate_verdicts_candidate ON mas_promotion_gate_verdicts(candidate_id, created_at)`);
}

export function listGateVerdicts(sql: any, candidateId: string): GateVerdict[] {
  ensureGateVerdictsTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_promotion_gate_verdicts WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 50`,
      candidateId
    )
  ) as any[];
  return rows.map((r) => ({
    id: r.id,
    candidateId: r.candidate_id,
    passed: r.passed === 1 || r.passed === true,
    reasons: JSON.parse(r.reasons_json || "[]"),
    heldOutEvaluationId: r.heldout_evaluation_id ?? null,
    z: r.z ?? null,
    pValue: r.p_value ?? null,
    approvalId: r.approval_id ?? null,
    createdAt: r.created_at,
  }));
}

function windowsOverlap(a: EvaluationWindow, b: EvaluationWindow): boolean {
  // An open-ended window overlaps everything on its open side.
  const aFrom = a.from ?? "";
  const aTo = a.to ?? "9999";
  const bFrom = b.from ?? "";
  const bTo = b.to ?? "9999";
  return aFrom < bTo && bFrom < aTo;
}

function findHeldOutEvaluation(sql: any, candidateId: string): {
  heldOut: StoredEvaluation | null;
  reasons: string[];
} {
  const evaluations = listEvaluations(sql, candidateId);
  if (evaluations.length === 0) {
    return { heldOut: null, reasons: ["no evaluations exist for this candidate"] };
  }
  const heldOut = evaluations[0]; // latest first
  const reasons: string[] = [];
  if (!heldOut.window.from || !heldOut.window.to) {
    reasons.push("the latest evaluation has no bounded window — a held-out evaluation needs an explicit [from, to) window");
    return { heldOut: null, reasons };
  }
  const priors = evaluations.slice(1);
  if (priors.length === 0) {
    reasons.push("no tuning evaluation precedes the held-out evaluation — evaluate on a training window first, then on a disjoint held-out window");
    return { heldOut: null, reasons };
  }
  for (const prior of priors) {
    if (windowsOverlap(heldOut.window, prior.window)) {
      reasons.push(
        `held-out window [${heldOut.window.from}, ${heldOut.window.to}) overlaps a prior evaluation window [${prior.window.from ?? "…"}, ${prior.window.to ?? "…"}) — held-out data must be disjoint from tuning data`
      );
      return { heldOut: null, reasons };
    }
  }
  return { heldOut, reasons: [] };
}

/**
 * Run the promotion gate for one candidate. Persists the verdict
 * either way; on pass, transitions the candidate evaluating → gated.
 */
export function runPromotionGate(
  sql: any,
  candidate: ImprovementCandidate,
  track: TrackRecord,
  now: Date = new Date()
): GateVerdict {
  const reasons: string[] = [];
  let z: number | null = null;
  let pValue: number | null = null;
  let approvalId: string | null = null;

  if (candidate.status !== "evaluating") {
    reasons.push(`candidate is in status "${candidate.status}" — the gate only runs on evaluating candidates`);
  }

  const { heldOut, reasons: heldOutReasons } = findHeldOutEvaluation(sql, candidate.id);
  reasons.push(...heldOutReasons);

  if (heldOut) {
    if (heldOut.method !== "counterfactual-replay") {
      reasons.push(`held-out evaluation method is "${heldOut.method}" — no measured effect exists to gate on`);
    }
    if (heldOut.sampleSize < GATE_POLICY.minHeldOutSample) {
      reasons.push(
        `held-out sample ${heldOut.sampleSize} is below the minimum ${GATE_POLICY.minHeldOutSample} evaluated ideas`
      );
    }
    if (heldOut.delta === null) {
      reasons.push("held-out evaluation produced no measurable delta");
    } else if (
      (candidate.expectedEffect.direction === "increase" && heldOut.delta <= 0) ||
      (candidate.expectedEffect.direction === "decrease" && heldOut.delta >= 0)
    ) {
      reasons.push(
        `held-out delta ${heldOut.delta.toFixed(3)} does not move in the expected direction (${candidate.expectedEffect.direction})`
      );
    }
    const arms = significanceArms(candidate, track, heldOut.window);
    if (!arms) {
      reasons.push(`no significance test is defined for change action "${candidate.change.action}"`);
    } else {
      const test = twoProportionZTest(arms.armA.wins, arms.armA.n, arms.armB.wins, arms.armB.n);
      z = test.z;
      pValue = test.pOneSided;
      if (!(test.pOneSided < GATE_POLICY.alpha)) {
        reasons.push(
          `held-out effect is not statistically significant: ${arms.armA.label} ${arms.armA.wins}/${arms.armA.n} vs ${arms.armB.label} ${arms.armB.wins}/${arms.armB.n}, one-sided p = ${test.pOneSided.toFixed(4)} (α = ${GATE_POLICY.alpha})`
        );
      }
    }

    // Informed human approval: decided after the held-out evaluation.
    const approvals = listPromotionApprovals(sql, candidate.id);
    const informed = approvals.find(
      (a) =>
        a.status === "approved" &&
        a.decidedAt !== null &&
        Date.parse(a.decidedAt) >= Date.parse(heldOut.createdAt)
    );
    if (informed) {
      approvalId = informed.id;
    } else {
      reasons.push(
        "no human approval recorded after the held-out evaluation — request approval, let a human review the held-out evidence, and record the decision before gating"
      );
    }
  }

  let passed = reasons.length === 0;
  if (passed) {
    const moved = transitionCandidate(sql, candidate.id, "gated", now);
    if (!moved) {
      passed = false;
      reasons.push("candidate could not be transitioned to gated (concurrent state change?)");
    }
  }

  ensureGateVerdictsTable(sql);
  const id = `verdict_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const iso = now.toISOString();
  sql.exec(
    `INSERT INTO mas_promotion_gate_verdicts
     (id, candidate_id, passed, reasons_json, heldout_evaluation_id, z, p_value, approval_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    candidate.id,
    passed ? 1 : 0,
    JSON.stringify(reasons),
    heldOut?.id ?? null,
    z,
    pValue,
    approvalId,
    iso
  );
  return {
    id,
    candidateId: candidate.id,
    passed,
    reasons,
    heldOutEvaluationId: heldOut?.id ?? null,
    z,
    pValue,
    approvalId,
    createdAt: iso,
  };
}
