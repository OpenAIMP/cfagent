/**
 * Issue #1140 (epic #1096 Phase 5) — the champion/challenger
 * promotion gate: how a Phase 3 re-selection proposal
 * (proposal_only_not_promoted) — or any weights / ranking /
 * active-set change — earns promotion, and how it is reversed.
 *
 * The gate has THREE locks, and all three must open:
 *  1. FROZEN-SET EVIDENCE. The challenger is scored against the
 *     champion walk-forward on a frozen, versioned evaluation
 *     dataset (#583 mechanism; v2 sets ship with this issue). The
 *     HOLDOUT fold decides — selection-fold scores are reported for
 *     context and can never promote anything.
 *  2. FROZEN CRITERIA. The acceptance criteria are written at
 *     challenger creation and are immutable thereafter: a candidate
 *     may never edit its own acceptance criteria (mission.md rule).
 *     There is no update path for them — reviseChallengerCriteria
 *     exists only to refuse, on the record.
 *  3. AUTHORIZED APPROVAL. Promotion requires an approval record
 *     from a human/owner actor who is neither the challenger's
 *     creator nor any system/nightly actor. The nightly re-selection
 *     can create challengers; it can NEVER approve or promote them.
 *     The promoter must be the approver of record.
 *
 * Valid outcomes beyond promotion: keep-champion (the evidence did
 * not earn the change; nothing moves) and retire-strategy (gate a
 * persistent loser off through strategyPolicyState). Every state
 * change is applied through the #755 adaptation seam (audited;
 * kill switch halts promotion), snapshots its prior state, and is
 * reversible with exact restore (#760 semantics — including "the
 * row did not exist"). Evaluation is deterministic over the frozen
 * set (runResearchEvaluation, #583/#340 idiom) — no model call
 * decides a promotion.
 */

import { loadEvaluationDataset } from "./researchEvaluationDatasets";
import {
  runResearchEvaluation,
  type QuoteSnapshot,
  type StoredIdeaRecord,
} from "./researchPipeline";
import { RESEARCH_CONFIG_DEFAULTS } from "./researchConfig";
import {
  applyWeightsV2Targets,
  currentWeightsVersion,
  getStrategyWeightsV2,
  weightsV2Key,
  type WeightsV2Regime,
} from "./strategyWeightsV2";
import {
  getStrategyWeightCap,
  isStrategyGatedOff,
  hasStrategyGateRow,
  setStrategyGate,
  ensureStrategyPolicyTables,
} from "./strategyPolicyState";
import { applyAdaptation, isAdaptationHalted } from "./adaptationAudit";
import { ensureWeightsV2Tables } from "./strategyWeightsV2";

/** Actors that run the autonomous loop. They may CREATE challengers;
 *  they may never APPROVE or PROMOTE them. */
export const SYSTEM_ACTORS = [
  "research-agent",
  "strategy-bank-reselection",
  "strategy-weight-job",
  "strategy-weight-v2-job",
  "rsi-loop",
  "staged-promotion",
  "recommendation-agent",
] as const;

export type ChallengerKind = "weights" | "active_set" | "ranking";
export type ChallengerStatus =
  | "proposed"
  | "evaluated"
  | "promoted"
  | "kept_champion"
  | "retired"
  | "rolled_back";

export interface ChallengerSpec {
  /** Target v2 weights (strategy → weight), applied under the challenger's regime. */
  weights?: Record<string, number>;
  /** Target active set (or ranking order for kind "ranking"). */
  activeStrategies?: string[];
  ranking?: string[];
  /** Strategy to gate off (retire outcome). */
  retireStrategy?: string;
}

export interface ChallengerCriteria {
  /** Minimum holdout score edge over the champion. */
  minHoldoutEdge: number;
  /** Minimum holdout ideas evaluated for the challenger. */
  minEvaluated: number;
}

export interface Challenger {
  id: string;
  userLogin: string;
  kind: ChallengerKind;
  title: string;
  regime: WeightsV2Regime | null;
  spec: ChallengerSpec;
  criteria: ChallengerCriteria;
  evalSetVersion: string;
  sourceProposalId: string | null;
  createdBy: string;
  status: ChallengerStatus;
  evaluation: ChallengerEvaluation | null;
  createdAt: string;
}

export interface FoldScore {
  championScore: number | null;
  challengerScore: number | null;
  evaluated: number;
}

export interface ChallengerEvaluation {
  datasetVersion: string;
  evaluatedAt: string;
  selection: FoldScore;
  holdout: FoldScore;
  verdict: "pass" | "fail";
  criteria: ChallengerCriteria;
}

/* ------------------------------------------------------------------ */
/* Stores                                                              */
/* ------------------------------------------------------------------ */

export function ensureChallengerTables(sql: any): void {
  ensureWeightsV2Tables(sql); // mas_settings (kill switch) + v2 weights
  ensureStrategyPolicyTables(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_challengers (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    regime TEXT,
    spec_json TEXT NOT NULL,
    criteria_json TEXT NOT NULL,
    eval_set_version TEXT NOT NULL,
    source_proposal_id TEXT,
    status TEXT NOT NULL,
    evaluation_json TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_challenger_approvals (
    id TEXT PRIMARY KEY,
    challenger_id TEXT NOT NULL,
    user_login TEXT NOT NULL,
    approver TEXT NOT NULL,
    decision TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_challenger_promotions (
    id TEXT PRIMARY KEY,
    challenger_id TEXT NOT NULL,
    user_login TEXT NOT NULL,
    action TEXT NOT NULL,
    prior_json TEXT NOT NULL,
    applied_json TEXT NOT NULL,
    weights_version INTEGER,
    actor TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_strategy_bank_active (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    version INTEGER NOT NULL,
    strategies_json TEXT NOT NULL,
    challenger_id TEXT,
    created_at TEXT NOT NULL
  )`);
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function rowToChallenger(r: any): Challenger {
  return {
    id: String(r.id),
    userLogin: String(r.user_login),
    kind: r.kind as ChallengerKind,
    title: String(r.title),
    regime: (r.regime ?? null) as WeightsV2Regime | null,
    spec: JSON.parse(String(r.spec_json)) as ChallengerSpec,
    criteria: JSON.parse(String(r.criteria_json)) as ChallengerCriteria,
    evalSetVersion: String(r.eval_set_version),
    sourceProposalId: (r.source_proposal_id ?? null) as string | null,
    createdBy: String(r.created_by),
    status: r.status as ChallengerStatus,
    evaluation: r.evaluation_json
      ? (JSON.parse(String(r.evaluation_json)) as ChallengerEvaluation)
      : null,
    createdAt: String(r.created_at),
  };
}

export function getChallenger(
  sql: any,
  userLogin: string,
  id: string
): Challenger | null {
  ensureChallengerTables(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_challengers WHERE id = ? AND user_login = ?`,
      id,
      userLogin
    )
  ) as any[];
  return rows.length ? rowToChallenger(rows[0]) : null;
}

/**
 * Consolidation #1257: the hub Review inbox lists challengers (the
 * /adaptation/candidates read path after the challenger re-point).
 * Tenant-scoped, newest first.
 */
export function listChallengers(sql: any, userLogin: string): Challenger[] {
  ensureChallengerTables(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_challengers WHERE user_login = ? ORDER BY created_at DESC LIMIT 200`,
      userLogin
    )
  ) as any[];
  return rows.map(rowToChallenger);
}

function setChallengerStatus(
  sql: any,
  challenger: Challenger,
  status: ChallengerStatus,
  evaluation: ChallengerEvaluation | null | undefined,
  now: Date
): void {
  sql.exec(
    `UPDATE mas_challengers SET status = ?, evaluation_json = ?, updated_at = ? WHERE id = ? AND user_login = ?`,
    status,
    evaluation === undefined
      ? challenger.evaluation
        ? JSON.stringify(challenger.evaluation)
        : null
      : evaluation
        ? JSON.stringify(evaluation)
        : null,
    now.toISOString(),
    challenger.id,
    challenger.userLogin
  );
}

/**
 * Create a challenger. The eval set must exist (frozen sets are
 * versioned fixtures — an unknown version throws, loudly, via the
 * #583 loader). Criteria are stored once, here, and never updated.
 */
export function createChallenger(
  sql: any,
  userLogin: string,
  input: {
    kind: ChallengerKind;
    title: string;
    regime?: WeightsV2Regime | null;
    spec: ChallengerSpec;
    criteria: ChallengerCriteria;
    evalSetVersion: string;
    sourceProposalId?: string | null;
    createdBy: string;
    now?: Date;
  }
): Challenger {
  ensureChallengerTables(sql);
  loadEvaluationDataset(input.evalSetVersion); // throws on unknown/frozen-missing
  const now = input.now ?? new Date();
  const challenger: Challenger = {
    id: newId("chl"),
    userLogin,
    kind: input.kind,
    title: input.title,
    regime: input.regime ?? null,
    spec: input.spec,
    criteria: input.criteria,
    evalSetVersion: input.evalSetVersion,
    sourceProposalId: input.sourceProposalId ?? null,
    createdBy: input.createdBy,
    status: "proposed",
    evaluation: null,
    createdAt: now.toISOString(),
  };
  sql.exec(
    `INSERT INTO mas_challengers (id, user_login, kind, title, regime, spec_json, criteria_json, eval_set_version, source_proposal_id, status, evaluation_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    challenger.id,
    userLogin,
    challenger.kind,
    challenger.title,
    challenger.regime,
    JSON.stringify(challenger.spec),
    JSON.stringify(challenger.criteria),
    challenger.evalSetVersion,
    challenger.sourceProposalId,
    challenger.status,
    null,
    challenger.createdBy,
    challenger.createdAt,
    challenger.createdAt
  );
  return challenger;
}

/**
 * The mission.md rule, as an explicit refusal: acceptance criteria
 * are frozen at creation. A candidate (or anyone) attempting to
 * revise them after seeing evaluation results is rejected, and the
 * stored criteria are returned unchanged by getChallenger.
 */
export function reviseChallengerCriteria(
  _sql: any,
  _userLogin: string,
  _challengerId: string,
  _criteria: ChallengerCriteria
): { ok: false; reason: string } {
  return {
    ok: false,
    reason:
      "Acceptance criteria are frozen at challenger creation (mission.md): " +
      "a candidate may never edit its own acceptance criteria. File a new challenger instead.",
  };
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

export function recordChallengerApproval(
  sql: any,
  userLogin: string,
  challengerId: string,
  input: { approver: string; decision: "approved" | "rejected"; now?: Date }
): { ok: boolean; reason?: string } {
  ensureChallengerTables(sql);
  const challenger = getChallenger(sql, userLogin, challengerId);
  if (!challenger) return { ok: false, reason: "challenger not found for this tenant" };
  if (input.decision === "approved") {
    if (input.approver === challenger.createdBy) {
      return {
        ok: false,
        reason: "self-approval is prohibited: the approver must be distinct from the challenger's creator",
      };
    }
    if ((SYSTEM_ACTORS as readonly string[]).includes(input.approver)) {
      return {
        ok: false,
        reason: "system/nightly actors cannot approve promotions; an authorized human/owner approval record is required",
      };
    }
  }
  const now = input.now ?? new Date();
  sql.exec(
    `INSERT INTO mas_challenger_approvals (id, challenger_id, user_login, approver, decision, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    newId("apr"),
    challengerId,
    userLogin,
    input.approver,
    input.decision,
    now.toISOString()
  );
  return { ok: true };
}

function approvedApprover(sql: any, userLogin: string, challengerId: string): string | null {
  const rows = Array.from(
    sql.exec(
      `SELECT approver FROM mas_challenger_approvals WHERE challenger_id = ? AND user_login = ? AND decision = 'approved' ORDER BY created_at DESC`,
      challengerId,
      userLogin
    )
  ) as any[];
  return rows.length ? String(rows[0].approver) : null;
}

export interface ChallengerApprovalRecord {
  id: string;
  challengerId: string;
  approver: string;
  decision: "approved" | "rejected";
  createdAt: string;
}

/**
 * Consolidation #1257: the hub Review inbox's approval read path
 * (the /adaptation/candidates/approvals read path after the
 * challenger re-point). Tenant-scoped, oldest first. Note there is
 * no pending state: recording an approval IS the decision (the old
 * #759 request-then-decide two-step is retired with the panel
 * rework).
 */
export function listChallengerApprovals(
  sql: any,
  userLogin: string,
  challengerId: string
): ChallengerApprovalRecord[] {
  ensureChallengerTables(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_challenger_approvals WHERE challenger_id = ? AND user_login = ? ORDER BY created_at ASC`,
      challengerId,
      userLogin
    )
  ) as any[];
  return rows.map((r) => ({
    id: String(r.id),
    challengerId: String(r.challenger_id),
    approver: String(r.approver),
    decision: r.decision as "approved" | "rejected",
    createdAt: String(r.created_at),
  }));
}

/* ------------------------------------------------------------------ */
/* Frozen-set evaluation (walk-forward; holdout decides)               */
/* ------------------------------------------------------------------ */

export interface ScoringSpec {
  weights: Record<string, number>;
  activeStrategies: string[] | null;
}

interface ScoredIdea {
  structure: string;
  r: number | null;
}

function scoreFold(cases: Array<{ scored: ScoredIdea[] }>, spec: ScoringSpec): { score: number | null; evaluated: number } {
  let wSum = 0;
  let wR = 0;
  let evaluated = 0;
  for (const c of cases) {
    for (const s of c.scored) {
      if (s.r === null) continue;
      if (spec.activeStrategies && !spec.activeStrategies.includes(s.structure)) continue;
      const w = spec.weights[s.structure] ?? 1;
      wSum += w;
      wR += w * s.r;
      evaluated++;
    }
  }
  return { score: wSum > 0 ? wR / wSum : null, evaluated };
}

export async function evaluateChallenger(
  sql: any,
  userLogin: string,
  challengerId: string,
  input: {
    championSpec: ScoringSpec;
    challengerSpec: ScoringSpec;
    now?: Date;
  }
): Promise<ChallengerEvaluation> {
  ensureChallengerTables(sql);
  const challenger = getChallenger(sql, userLogin, challengerId);
  if (!challenger) throw new Error(`challenger ${challengerId} not found for this tenant`);
  const now = input.now ?? new Date();
  const ds = loadEvaluationDataset(challenger.evalSetVersion);

  // Walk-forward order: by the ideas' recorded creation time.
  const cases = [...ds.cases].sort((a, b) => {
    const ka = a.ideas[0]?.createdAt ?? a.caseId;
    const kb = b.ideas[0]?.createdAt ?? b.caseId;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const scoredCases: Array<{ scored: ScoredIdea[] }> = [];
  for (const c of cases) {
    const provider = {
      getQuote: async (symbol: string): Promise<QuoteSnapshot | null> => {
        const price = c.followUp[symbol];
        if (typeof price !== "number") return null;
        return {
          symbol,
          price,
          timestamp: now.getTime(),
          quoteStatus: "live",
          source: "frozen-eval-set",
        } as QuoteSnapshot;
      },
    };
    const evaluation = await runResearchEvaluation(
      { provider } as any,
      c.ideas as StoredIdeaRecord[],
      c.runId,
      RESEARCH_CONFIG_DEFAULTS,
      now.getTime()
    );
    const byKey = new Map(
      evaluation.ideas.map((e) => [`${e.symbol}|${e.structure}`, e])
    );
    scoredCases.push({
      scored: c.ideas.map((idea) => {
        const ev = byKey.get(`${idea.symbol}|${idea.structure}`);
        const pnl = ev?.pnlEstimatePerUnit ?? null;
        const maxLoss = (idea.economics as any)?.maxLoss;
        return {
          structure: idea.structure,
          r:
            pnl !== null && typeof maxLoss === "number" && maxLoss > 0
              ? pnl / maxLoss
              : null,
        };
      }),
    });
  }

  const holdoutCount = Math.max(1, Math.ceil(scoredCases.length / 2));
  const selectionCases = scoredCases.slice(0, scoredCases.length - holdoutCount);
  const holdoutCases = scoredCases.slice(scoredCases.length - holdoutCount);

  const selChamp = scoreFold(selectionCases, input.championSpec);
  const selChal = scoreFold(selectionCases, input.challengerSpec);
  const holdChamp = scoreFold(holdoutCases, input.championSpec);
  const holdChal = scoreFold(holdoutCases, input.challengerSpec);

  const edge =
    holdChamp.score !== null && holdChal.score !== null
      ? holdChal.score - holdChamp.score
      : null;
  const verdict: "pass" | "fail" =
    edge !== null &&
    holdChal.evaluated >= challenger.criteria.minEvaluated &&
    edge >= challenger.criteria.minHoldoutEdge
      ? "pass"
      : "fail";

  const evaluation: ChallengerEvaluation = {
    datasetVersion: challenger.evalSetVersion,
    evaluatedAt: now.toISOString(),
    selection: {
      championScore: selChamp.score,
      challengerScore: selChal.score,
      evaluated: selChal.evaluated,
    },
    holdout: {
      championScore: holdChamp.score,
      challengerScore: holdChal.score,
      evaluated: holdChal.evaluated,
    },
    verdict,
    criteria: challenger.criteria,
  };
  setChallengerStatus(sql, challenger, "evaluated", evaluation, now);
  return evaluation;
}

/* ------------------------------------------------------------------ */
/* Promotion records + active set                                      */
/* ------------------------------------------------------------------ */

function recordPromotion(
  sql: any,
  challenger: Challenger,
  action: string,
  prior: unknown,
  applied: unknown,
  weightsVersion: number | null,
  actor: string,
  reason: string | null,
  now: Date
): void {
  sql.exec(
    `INSERT INTO mas_challenger_promotions (id, challenger_id, user_login, action, prior_json, applied_json, weights_version, actor, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("prm"),
    challenger.id,
    challenger.userLogin,
    action,
    JSON.stringify(prior ?? null),
    JSON.stringify(applied ?? null),
    weightsVersion,
    actor,
    reason,
    now.toISOString()
  );
}

export function listPromotionRecords(
  sql: any,
  userLogin: string,
  challengerId: string
): Array<{ action: string; prior: any; applied: any; actor: string; reason: string | null }> {
  ensureChallengerTables(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_challenger_promotions WHERE challenger_id = ? AND user_login = ? ORDER BY created_at ASC`,
      challengerId,
      userLogin
    )
  ) as any[];
  return rows.map((r) => ({
    action: String(r.action),
    prior: JSON.parse(String(r.prior_json)),
    applied: JSON.parse(String(r.applied_json)),
    actor: String(r.actor),
    reason: (r.reason ?? null) as string | null,
  }));
}

export interface ActiveStrategySet {
  strategies: string[];
  version: number;
  challengerId: string | null;
  createdAt: string;
}

export function getActiveStrategySet(
  sql: any,
  userLogin: string
): ActiveStrategySet | null {
  ensureChallengerTables(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_strategy_bank_active WHERE user_login = ? ORDER BY version DESC LIMIT 1`,
      userLogin
    )
  ) as any[];
  if (!rows.length) return null;
  return {
    strategies: JSON.parse(String(rows[0].strategies_json)) as string[],
    version: Number(rows[0].version),
    challengerId: (rows[0].challenger_id ?? null) as string | null,
    createdAt: String(rows[0].created_at),
  };
}

function appendActiveSet(
  sql: any,
  userLogin: string,
  strategies: string[],
  challengerId: string | null,
  now: Date
): number {
  const current = getActiveStrategySet(sql, userLogin);
  const version = (current?.version ?? 0) + 1;
  sql.exec(
    `INSERT INTO mas_strategy_bank_active (id, user_login, version, strategies_json, challenger_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    newId("act"),
    userLogin,
    version,
    JSON.stringify(strategies),
    challengerId,
    now.toISOString()
  );
  return version;
}

/* ------------------------------------------------------------------ */
/* Promotion / outcomes / rollback                                     */
/* ------------------------------------------------------------------ */

export function promoteChallenger(
  sql: any,
  userLogin: string,
  challengerId: string,
  input: { actor: string; now?: Date }
): { ok: boolean; reason?: string } {
  ensureChallengerTables(sql);
  const now = input.now ?? new Date();
  const challenger = getChallenger(sql, userLogin, challengerId);
  if (!challenger) return { ok: false, reason: "challenger not found for this tenant" };
  if (challenger.status !== "evaluated" || !challenger.evaluation) {
    return {
      ok: false,
      reason: "challenger has not been evaluated on its frozen set; no promotion without evidence",
    };
  }
  if (challenger.evaluation.verdict !== "pass") {
    return {
      ok: false,
      reason: "frozen-set evaluation did not pass; the champion stays (resolve as keep-champion)",
    };
  }
  const approver = approvedApprover(sql, userLogin, challengerId);
  if (!approver) {
    return {
      ok: false,
      reason: "no authorized approval record; promotion requires explicit human/owner approval",
    };
  }
  if (input.actor !== approver) {
    return {
      ok: false,
      reason: "the promoter must be the authorized approver of record",
    };
  }
  if (isAdaptationHalted(sql)) {
    return { ok: false, reason: "adaptation is halted by the kill switch; promotion refused" };
  }

  let prior: unknown = null;
  let applied: unknown = null;
  let weightsVersion: number | null = null;

  if (challenger.kind === "weights") {
    if (!challenger.regime) {
      return { ok: false, reason: "weights challenger has no regime; weights v2 are regime-scoped" };
    }
    const targets = Object.entries(challenger.spec.weights ?? {}).map(
      ([strategy, weight]) => ({
        strategy,
        regime: challenger.regime as string,
        weight,
      })
    );
    if (!targets.length) return { ok: false, reason: "weights challenger carries no target weights" };
    const current = getStrategyWeightsV2(sql);
    prior = {
      weights: targets.map((t) => {
        const key = weightsV2Key(t.strategy, t.regime);
        return {
          strategy: t.strategy,
          regime: t.regime,
          weight: current[key] ?? null,
          rowExisted: key in current,
        };
      }),
    };
    const res = applyWeightsV2Targets(sql, targets, {
      actor: input.actor,
      rationale: `champion/challenger promotion ${challenger.id} (${challenger.title}); frozen set ${challenger.evalSetVersion} holdout pass; approved by ${approver}`,
      now,
    });
    if (res.halted) return { ok: false, reason: "adaptation is halted by the kill switch; promotion refused" };
    applied = { weights: res.applied };
    weightsVersion = currentWeightsVersion(sql);
  } else {
    const strategies =
      challenger.spec.activeStrategies ?? challenger.spec.ranking ?? null;
    if (!strategies) {
      return {
        ok: false,
        reason: "active-set/ranking challenger carries no strategies (retire specs resolve via resolveChallengerOutcome)",
      };
    }
    prior = { activeSet: getActiveStrategySet(sql, userLogin) };
    const version = appendActiveSet(sql, userLogin, strategies, challenger.id, now);
    applied = { activeSet: { strategies, version } };
  }

  recordPromotion(sql, challenger, "promoted", prior, applied, weightsVersion, input.actor, null, now);
  setChallengerStatus(sql, challenger, "promoted", undefined, now);
  return { ok: true };
}

export function resolveChallengerOutcome(
  sql: any,
  userLogin: string,
  challengerId: string,
  input: {
    outcome: "keep_champion" | "retire_strategy";
    actor: string;
    reason: string;
    now?: Date;
  }
): { ok: boolean; reason?: string } {
  ensureChallengerTables(sql);
  const now = input.now ?? new Date();
  const challenger = getChallenger(sql, userLogin, challengerId);
  if (!challenger) return { ok: false, reason: "challenger not found for this tenant" };

  if (input.outcome === "keep_champion") {
    if (challenger.status !== "evaluated") {
      return { ok: false, reason: "keep-champion resolves an evaluated challenger" };
    }
    recordPromotion(sql, challenger, "keep_champion", null, null, null, input.actor, input.reason, now);
    setChallengerStatus(sql, challenger, "kept_champion", undefined, now);
    return { ok: true };
  }

  // retire_strategy: consequential — same approval discipline as promotion.
  const strategy = challenger.spec.retireStrategy;
  if (!strategy) return { ok: false, reason: "challenger carries no retireStrategy" };
  const approver = approvedApprover(sql, userLogin, challengerId);
  if (!approver) {
    return {
      ok: false,
      reason: "no authorized approval record; retiring a strategy requires explicit human/owner approval",
    };
  }
  if (input.actor !== approver) {
    return { ok: false, reason: "the actor must be the authorized approver of record" };
  }
  if (isAdaptationHalted(sql)) {
    return { ok: false, reason: "adaptation is halted by the kill switch; retirement refused" };
  }
  const prior = {
    gate: {
      strategy,
      rowExisted: hasStrategyGateRow(sql, strategy),
      gatedOff: isStrategyGatedOff(sql, strategy),
      cap: getStrategyWeightCap(sql, strategy),
    },
  };
  const out = applyAdaptation(
    sql,
    {
      actor: input.actor,
      subject: `strategy-gate:${strategy}`,
      parameter: "gate",
      before: prior.gate.gatedOff ? "off" : "on",
      after: "off",
      delta: null,
      rationale: `retire strategy via challenger ${challenger.id}: ${input.reason}`,
      dataWindow: `frozen set ${challenger.evalSetVersion}`,
    },
    () => setStrategyGate(sql, strategy, true, now),
    now,
    { enforceBudgets: false }
  );
  if (!out.applied) return { ok: false, reason: out.reason ?? "adaptation seam refused" };
  recordPromotion(sql, challenger, "retire_strategy", prior, { gate: { strategy, gatedOff: true } }, null, input.actor, input.reason, now);
  setChallengerStatus(sql, challenger, "retired", undefined, now);
  return { ok: true };
}

export function rollbackChallengerPromotion(
  sql: any,
  userLogin: string,
  challengerId: string,
  input: { actor: string; now?: Date }
): { ok: boolean; reason?: string } {
  ensureChallengerTables(sql);
  const now = input.now ?? new Date();
  const challenger = getChallenger(sql, userLogin, challengerId);
  if (!challenger) return { ok: false, reason: "challenger not found for this tenant" };
  const records = listPromotionRecords(sql, userLogin, challengerId);
  const rolledBack = records.some((r) => r.action === "rollback");
  const target = [...records]
    .reverse()
    .find((r) => r.action === "promoted" || r.action === "retire_strategy");
  if (!target || rolledBack) {
    return { ok: false, reason: "no live promotion to roll back" };
  }
  if (isAdaptationHalted(sql)) {
    return { ok: false, reason: "adaptation is halted by the kill switch; rollback refused" };
  }

  if (target.action === "promoted" && target.prior?.weights) {
    const res = applyWeightsV2Targets(
      sql,
      (target.prior.weights as Array<{ strategy: string; regime: string; weight: number | null }>).map(
        (w) => ({ strategy: w.strategy, regime: w.regime, weight: w.weight })
      ),
      {
        actor: input.actor,
        rationale: `rollback of challenger promotion ${challenger.id}; exact restore of prior weights state`,
        now,
      }
    );
    if (res.halted) return { ok: false, reason: "adaptation is halted by the kill switch; rollback refused" };
  } else if (target.action === "promoted" && target.prior?.activeSet !== undefined) {
    const priorSet = target.prior.activeSet as ActiveStrategySet | null;
    appendActiveSet(sql, userLogin, priorSet?.strategies ?? [], challenger.id, now);
  } else if (target.action === "retire_strategy" && target.prior?.gate) {
    const gate = target.prior.gate as {
      strategy: string;
      rowExisted: boolean;
      gatedOff: boolean;
    };
    const out = applyAdaptation(
      sql,
      {
        actor: input.actor,
        subject: `strategy-gate:${gate.strategy}`,
        parameter: "gate",
        before: "off",
        after: gate.rowExisted ? (gate.gatedOff ? "off" : "on") : "none",
        delta: null,
        rationale: `rollback of strategy retirement ${challenger.id}; exact restore`,
        dataWindow: `frozen set ${challenger.evalSetVersion}`,
      },
      () =>
        setStrategyGate(
          sql,
          gate.strategy,
          gate.rowExisted ? gate.gatedOff : null,
          now
        ),
      now,
      { enforceBudgets: false }
    );
    if (!out.applied) return { ok: false, reason: out.reason ?? "adaptation seam refused" };
  }

  recordPromotion(sql, challenger, "rollback", target.prior, null, currentWeightsVersion(sql), input.actor, "rollback of promotion", now);
  setChallengerStatus(sql, challenger, "rolled_back", undefined, now);
  return { ok: true };
}
