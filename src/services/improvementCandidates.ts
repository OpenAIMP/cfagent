/**
 * Issue #757 (P2-5.1): improvement candidate generation — the entry
 * point of Phase 5 governed self-modification.
 *
 * Improvement ideas used to live as unstructured reflection prose and
 * learnings. This module converts three signal sources into
 * structured, falsifiable candidates — each with a target, the exact
 * change proposed, a hypothesis, an expected effect with its metric,
 * evidence references, and provenance — and queues them for the
 * evaluation harness (#758). Generation applies NOTHING: the only
 * path from a candidate to production is #758 → #759 → #760.
 *
 * Generator rules (v1):
 *  - R1 (track record): a strategy with >= 20 evaluated ideas and
 *    winRate <= 0.25 → gate-off candidate.
 *  - R2 (track record): a strategy with >= 40 evaluated ideas beating
 *    the overall win rate by >= 0.20 → weight-cap-raise candidate.
 *    Raising a cap is a BOUNDS change — deliberately not routed
 *    through #754's within-bounds mechanism.
 *  - R3 (reflection): the overall-approval-rate diagnostic finding →
 *    quant-filter candidate. Family boost/down-weight findings are
 *    NOT candidates — they are owned by #753's review queue and
 *    #754's weight job; duplicating them here would fork the path.
 *  - R4 (learnings): a human learning carrying a "Proposed:" segment
 *    becomes a candidate with provenance preserved.
 *
 * Dedup: an identical open candidate (same target + action) is not
 * duplicated. Supersede: a different change for the same target
 * supersedes the open candidate, linked via supersedesId.
 */
import type { TrackRecord } from "./researchTrackRecord";
import type { Learning } from "./learnings";
import type { ReflectionFinding } from "./reflection";
import { reflectionFindingFamily } from "./reflection";
import { STRATEGY_WEIGHT_BOUNDS } from "./strategyWeights";

export type CandidateStatus =
  | "queued"
  | "evaluating"
  | "gated"
  | "promoted"
  | "rejected"
  | "superseded";

export interface CandidateChange {
  action: string;
  parameter?: string;
  from?: unknown;
  to?: unknown;
  description: string;
}

export interface CandidateProposal {
  target: string;
  change: CandidateChange;
  hypothesis: string;
  expectedEffect: { metric: string; direction: "increase" | "decrease" };
  evidenceRefs: string[];
  provenance: { source: "reflection" | "learning" | "track-record"; id: string };
}

export interface ImprovementCandidate extends CandidateProposal {
  id: string;
  status: CandidateStatus;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CANDIDATE_RULES = {
  gateOff: { minSample: 20, maxWinRate: 0.25 },
  capRaise: { minSample: 40, minEdge: 0.2, toCap: 2.5 },
} as const;

const OPEN_STATUSES: CandidateStatus[] = ["queued", "evaluating", "gated"];

const TRANSITIONS: Record<CandidateStatus, CandidateStatus[]> = {
  queued: ["evaluating", "rejected", "superseded"],
  evaluating: ["gated", "rejected", "superseded"],
  gated: ["promoted", "rejected", "superseded"],
  // #760: the one exit from promoted is the rollback path — a
  // promotion whose regression check fails restores the snapshot and
  // rejects the candidate (it must re-prove itself from scratch).
  promoted: ["rejected"],
  rejected: [],
  superseded: [],
};

export function ensureImprovementCandidatesTable(sql: any): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_improvement_candidates (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    change_json TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    expected_metric TEXT NOT NULL,
    expected_direction TEXT NOT NULL,
    evidence_refs TEXT NOT NULL DEFAULT '[]',
    provenance_source TEXT NOT NULL,
    provenance_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    supersedes_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_candidates_target ON mas_improvement_candidates(target, status)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_candidates_status ON mas_improvement_candidates(status, created_at)`);
}

function rowToCandidate(r: any): ImprovementCandidate {
  return {
    id: r.id,
    target: r.target,
    change: JSON.parse(r.change_json),
    hypothesis: r.hypothesis,
    expectedEffect: { metric: r.expected_metric, direction: r.expected_direction },
    evidenceRefs: JSON.parse(r.evidence_refs || "[]"),
    provenance: { source: r.provenance_source, id: r.provenance_id },
    status: r.status,
    supersedesId: r.supersedes_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listImprovementCandidates(sql: any, status?: CandidateStatus): ImprovementCandidate[] {
  ensureImprovementCandidatesTable(sql);
  const rows = (
    status
      ? Array.from(
          sql.exec(
            `SELECT * FROM mas_improvement_candidates WHERE status = ? ORDER BY created_at DESC LIMIT 200`,
            status
          )
        )
      : Array.from(sql.exec(`SELECT * FROM mas_improvement_candidates ORDER BY created_at DESC LIMIT 200`))
  ) as any[];
  return rows.map(rowToCandidate);
}

export function getImprovementCandidate(sql: any, id: string): ImprovementCandidate | null {
  ensureImprovementCandidatesTable(sql);
  const rows = Array.from(
    sql.exec(`SELECT * FROM mas_improvement_candidates WHERE id = ?`, id)
  ) as any[];
  return rows.length > 0 ? rowToCandidate(rows[0]) : null;
}

function openCandidatesForTarget(sql: any, target: string): ImprovementCandidate[] {
  ensureImprovementCandidatesTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_improvement_candidates WHERE target = ? ORDER BY created_at DESC LIMIT 50`,
      target
    )
  ) as any[];
  return rows.map(rowToCandidate).filter((c) => OPEN_STATUSES.includes(c.status));
}

function insertCandidate(
  sql: any,
  proposal: CandidateProposal,
  supersedesId: string | null,
  now: Date
): ImprovementCandidate {
  ensureImprovementCandidatesTable(sql);
  const id = `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const iso = now.toISOString();
  sql.exec(
    `INSERT INTO mas_improvement_candidates
     (id, target, change_json, hypothesis, expected_metric, expected_direction, evidence_refs, provenance_source, provenance_id, status, supersedes_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    id,
    proposal.target,
    JSON.stringify(proposal.change),
    proposal.hypothesis,
    proposal.expectedEffect.metric,
    proposal.expectedEffect.direction,
    JSON.stringify(proposal.evidenceRefs),
    proposal.provenance.source,
    proposal.provenance.id,
    supersedesId,
    iso,
    iso
  );
  return { ...proposal, id, status: "queued", supersedesId, createdAt: iso, updatedAt: iso };
}

/** Guarded lifecycle transition; false when the move is not allowed. */
export function transitionCandidate(
  sql: any,
  id: string,
  to: CandidateStatus,
  now: Date = new Date()
): boolean {
  const current = getImprovementCandidate(sql, id);
  if (!current) return false;
  if (!TRANSITIONS[current.status].includes(to)) return false;
  const result = sql.exec(
    `UPDATE mas_improvement_candidates SET status = ?, updated_at = ? WHERE id = ? AND status = ?`,
    to,
    now.toISOString(),
    id,
    current.status
  ) as any;
  // Real SqlStorage cursors expose .changes; fakes may return rows.
  const changes = typeof result?.changes === "number" ? result.changes : 1;
  return changes > 0;
}

/** R1 + R2: track-record anomaly proposals. */
export function proposalsFromTrackRecord(track: TrackRecord): CandidateProposal[] {
  const out: CandidateProposal[] = [];
  const overall = track.winRate;
  for (const s of track.byStrategy) {
    if (s.winRate === null) continue;
    if (s.evaluated >= CANDIDATE_RULES.gateOff.minSample && s.winRate <= CANDIDATE_RULES.gateOff.maxWinRate) {
      out.push({
        target: `strategy-gate:${s.key}`,
        change: {
          action: "disable-strategy",
          parameter: "enabled",
          from: true,
          to: false,
          description: `Disable strategy "${s.key}" in the catalog (gate off).`,
        },
        hypothesis:
          `Strategy "${s.key}" wins only ${(s.winRate * 100).toFixed(0)}% of ${s.evaluated} evaluated ideas — ` +
          `persistently below the viability floor. Removing it raises the portfolio win rate by removing a negative contributor.`,
        expectedEffect: { metric: "portfolioWinRate", direction: "increase" },
        evidenceRefs: [`track-record:${s.key}`, `evaluated:${s.evaluated}`, `winRate:${s.winRate.toFixed(2)}`],
        provenance: { source: "track-record", id: s.key },
      });
    }
    if (
      overall !== null &&
      s.evaluated >= CANDIDATE_RULES.capRaise.minSample &&
      s.winRate - overall >= CANDIDATE_RULES.capRaise.minEdge
    ) {
      out.push({
        target: `strategy-weight-cap:${s.key}`,
        change: {
          action: "raise-weight-cap",
          parameter: "weightCap",
          from: STRATEGY_WEIGHT_BOUNDS.max,
          to: CANDIDATE_RULES.capRaise.toCap,
          description: `Raise the strategy-weight cap for "${s.key}" from ${STRATEGY_WEIGHT_BOUNDS.max} to ${CANDIDATE_RULES.capRaise.toCap}.`,
        },
        hypothesis:
          `Strategy "${s.key}" beats the overall win rate by ${((s.winRate - overall) * 100).toFixed(0)} points over ` +
          `${s.evaluated} evaluated ideas; the current cap (${STRATEGY_WEIGHT_BOUNDS.max}) truncates its earned weight. ` +
          `Raising the cap lets allocation follow demonstrated edge.`,
        expectedEffect: { metric: "weightedWinRate", direction: "increase" },
        evidenceRefs: [`track-record:${s.key}`, `evaluated:${s.evaluated}`, `winRate:${s.winRate.toFixed(2)}`, `overallWinRate:${overall.toFixed(2)}`],
        provenance: { source: "track-record", id: s.key },
      });
    }
  }
  return out;
}

/** R3: reflection diagnostic proposals (family findings are excluded by design). */
export function proposalsFromReflection(findings: ReflectionFinding[]): CandidateProposal[] {
  const out: CandidateProposal[] = [];
  for (const f of findings) {
    const isDiagnostic = f.evidenceRefs.includes("mas_strategy_reviews:all");
    if (!isDiagnostic || reflectionFindingFamily(f) !== null) continue;
    out.push({
      target: "quant-pipeline:filters",
      change: {
        action: "tighten-quant-filters",
        parameter: "minQuantScore",
        description: `Tighten quant pipeline filters in response to human-review misalignment: ${f.proposedAdjustment}`,
      },
      hypothesis:
        `${f.observation} Tightening the quant filters that admit candidates should raise the share ` +
        `of candidates human review approves.`,
      expectedEffect: { metric: "approvalRate", direction: "increase" },
      evidenceRefs: [...f.evidenceRefs],
      provenance: { source: "reflection", id: f.domain },
    });
  }
  return out;
}

/** R4: human learnings carrying an explicit proposal. */
export function proposalsFromLearnings(learnings: Learning[]): CandidateProposal[] {
  const out: CandidateProposal[] = [];
  for (const l of learnings) {
    if (l.source !== "human") continue;
    const marker = "Proposed:";
    const idx = l.observation.indexOf(marker);
    if (idx < 0) continue;
    const hypothesis = l.observation.slice(0, idx).trim();
    const proposalText = l.observation.slice(idx + marker.length).trim();
    if (!proposalText) continue;
    out.push({
      target: `learning-proposal:${l.id}`,
      change: { action: "apply-learning-proposal", description: proposalText },
      hypothesis: hypothesis || l.observation,
      expectedEffect: {
        metric: l.domain === "strategy_ranking" ? "approvalRate" : "winRate",
        direction: "increase",
      },
      evidenceRefs: [...l.evidenceRefs],
      provenance: { source: "learning", id: l.id },
    });
  }
  return out;
}

/**
 * Reflection findings are persisted as learnings (recordLearning
 * composes "observation Proposed: adjustment"); reconstruct the
 * finding shape from reflection-sourced learnings so the generator's
 * route input needs only the learnings store + the track record.
 */
export function findingsFromReflectionLearnings(learnings: Learning[]): ReflectionFinding[] {
  const out: ReflectionFinding[] = [];
  for (const l of learnings) {
    if (l.source !== "reflection" || l.domain === "reflection_meta") continue;
    const marker = " Proposed: ";
    const idx = l.observation.indexOf(marker);
    out.push({
      domain: l.domain,
      observation: idx >= 0 ? l.observation.slice(0, idx) : l.observation,
      evidenceRefs: l.evidenceRefs,
      confidence: l.confidence,
      proposedAdjustment: idx >= 0 ? l.observation.slice(idx + marker.length) : "",
    });
  }
  return out;
}

export interface GenerationInputs {
  track?: TrackRecord;
  findings?: ReflectionFinding[];
  learnings?: Learning[];
  proposals?: CandidateProposal[];
}

export interface GenerationResult {
  created: ImprovementCandidate[];
  deduped: string[];
  superseded: string[];
}

/**
 * Run all generators over the inputs and queue the results with
 * dedup/supersede handling. Pure queueing — nothing is applied.
 */
export function generateImprovementCandidates(
  sql: any,
  inputs: GenerationInputs,
  now: Date = new Date()
): GenerationResult {
  const proposals: CandidateProposal[] = [
    ...(inputs.track ? proposalsFromTrackRecord(inputs.track) : []),
    ...(inputs.findings ? proposalsFromReflection(inputs.findings) : []),
    ...(inputs.learnings ? proposalsFromLearnings(inputs.learnings) : []),
    ...(inputs.proposals ?? []),
  ];
  const result: GenerationResult = { created: [], deduped: [], superseded: [] };
  for (const p of proposals) {
    const open = openCandidatesForTarget(sql, p.target);
    const identical = open.find(
      (o) => o.change.action === p.change.action && o.change.parameter === p.change.parameter
    );
    if (identical) {
      result.deduped.push(p.target);
      continue;
    }
    let supersedesId: string | null = null;
    if (open.length > 0) {
      const victim = open[0];
      if (transitionCandidate(sql, victim.id, "superseded", now)) {
        supersedesId = victim.id;
        result.superseded.push(victim.id);
      }
    }
    result.created.push(insertCandidate(sql, p, supersedesId, now));
  }
  return result;
}
