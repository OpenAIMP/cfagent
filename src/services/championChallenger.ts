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
 *
 * Issue #2346 (#1976 step 3b, ADR 0022 D-C): the promotion
 * transition — promote / resolve / rollback — is ONE unit of
 * work on the transaction aspect's DO leg (its first production
 * use), entered through the registered TransactionRunner when
 * the caller supplies the DO storage object (the routes pass
 * ctx.getStorage()). Before this slice the transition was a
 * sequence of bare statements: a crash between the apply leg
 * and the promotion record left production weights changed
 * with no rollback data, and a crash after the record left a
 * challenger that read evaluated and could double-apply
 * (step-3 audit §3.2). The guard reads stay pre-checks; the
 * challenger status is RE-READ inside the unit, so the pre-read
 * status is never trusted across the unit boundary. Successful
 * paths are byte-for-byte the pre-wrap behaviour (pinned by the
 * step-3b characterization suite); only atomicity changed.
 * Absence discipline (the step-2 contract): no storage object,
 * a storage without transactionSync, or no registered runner
 * resolves to the sequential legacy execution — registration
 * and the storage argument are what turn the wrap on.
 *
 * Issue #2357 (#1976 step 4b, ADR 0022 D-C/D-I step 4): the
 * transition's legs now run through the strategy-cluster ports
 * (src/data/challengerPorts.ts, strategyWeightsPorts.ts,
 * strategyPolicyPorts.ts, adaptationAuditPorts.ts; composed by
 * createStrategyClusterPorts.ts) — the aspect wraps a PORT call,
 * as D-C intends. The wrap itself is unchanged: same runner
 * seam, same re-read discipline, same refusal set and order;
 * the #2346 sabotage pins pass verbatim and this slice's
 * conformance re-proves the property on the new seam.
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
import { getTransactionRunner } from "../data/transactionRunnerProvider";
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import {
  DataFoundationCode,
  DataFoundationError,
} from "../aspects/errorCodes";
import { DoSqliteChallengerStore } from "../data/doSqliteChallengerAdapter";
import type {
  ChallengerSqlExecutor,
  ChallengerStore,
} from "../data/challengerPorts";

export type {
  ActiveStrategySet,
  Challenger,
  ChallengerApprovalRecord,
  ChallengerCriteria,
  ChallengerEvaluation,
  ChallengerKind,
  ChallengerSpec,
  ChallengerStatus,
  FoldScore,
} from "../data/challengerPorts";
import type {
  ActiveStrategySet,
  Challenger,
  ChallengerApprovalRecord,
  ChallengerCriteria,
  ChallengerEvaluation,
  ChallengerKind,
  ChallengerSpec,
  ChallengerStatus,
} from "../data/challengerPorts";

function challengerStore(sql: ChallengerSqlExecutor): ChallengerStore {
  return new DoSqliteChallengerStore(sql);
}

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

/* ------------------------------------------------------------------ */
/* Stores (behind the challenger port — #2357)                         */
/* ------------------------------------------------------------------ */

export function ensureChallengerTables(sql: any): void {
  ensureWeightsV2Tables(sql); // mas_settings (kill switch) + v2 weights
  ensureStrategyPolicyTables(sql);
  challengerStore(sql).ensureTables();
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function getChallenger(
  sql: any,
  userLogin: string,
  id: string
): Challenger | null {
  ensureChallengerTables(sql);
  return challengerStore(sql).getChallenger(userLogin, id);
}

/**
 * Consolidation #1257: the hub Review inbox lists challengers (the
 * /adaptation/candidates read path after the challenger re-point).
 * Tenant-scoped, newest first.
 */
export function listChallengers(sql: any, userLogin: string): Challenger[] {
  ensureChallengerTables(sql);
  return challengerStore(sql).listChallengers(userLogin);
}

function setChallengerStatus(
  sql: any,
  challenger: Challenger,
  status: ChallengerStatus,
  evaluation: ChallengerEvaluation | null | undefined,
  now: Date
): void {
  challengerStore(sql).setChallengerStatus(challenger, status, evaluation, now);
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
  challengerStore(sql).insertChallenger(challenger);
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
  challengerStore(sql).insertApproval({
    id: newId("apr"),
    challengerId,
    userLogin,
    approver: input.approver,
    decision: input.decision,
    createdAt: now.toISOString(),
  });
  return { ok: true };
}

function approvedApprover(sql: any, userLogin: string, challengerId: string): string | null {
  return challengerStore(sql).getApprovedApprover(userLogin, challengerId);
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
  return challengerStore(sql).listApprovals(userLogin, challengerId);
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
  challengerStore(sql).insertPromotion({
    id: newId("prm"),
    challengerId: challenger.id,
    userLogin: challenger.userLogin,
    action,
    prior,
    applied,
    weightsVersion,
    actor,
    reason,
    createdAt: now.toISOString(),
  });
}

export function listPromotionRecords(
  sql: any,
  userLogin: string,
  challengerId: string
): Array<{ action: string; prior: any; applied: any; actor: string; reason: string | null }> {
  ensureChallengerTables(sql);
  return challengerStore(sql).listPromotionRecords(userLogin, challengerId);
}

export function getActiveStrategySet(
  sql: any,
  userLogin: string
): ActiveStrategySet | null {
  ensureChallengerTables(sql);
  return challengerStore(sql).getActiveStrategySet(userLogin);
}

function appendActiveSet(
  sql: any,
  userLogin: string,
  strategies: string[],
  challengerId: string | null,
  now: Date
): number {
  const store = challengerStore(sql);
  const current = store.getActiveStrategySet(userLogin);
  const version = (current?.version ?? 0) + 1;
  store.insertActiveSet({
    id: newId("act"),
    userLogin,
    version,
    strategies,
    challengerId,
    createdAt: now.toISOString(),
  });
  return version;
}

/* ------------------------------------------------------------------ */
/* Promotion / outcomes / rollback                                     */
/* ------------------------------------------------------------------ */

/**
 * Issue #2346: run one promotion transition as a unit of work
 * on the transaction aspect's DO leg, via the registered
 * TransactionRunner (the step-2 seam — this module cannot
 * import the aspect itself; the runner provider is the
 * client-safe resolution point). The gating mirrors
 * doSqliteFeedSnapshotAdapter exactly: a storage object with
 * transactionSync AND a registered runner turn the wrap on;
 * anything else runs the transition sequentially, which is the
 * pre-#2346 behaviour.
 *
 * One consumer-side guard, stated plainly: runSyncUnit
 * captures failures that pass through its synchronous closure.
 * A failure that prevents the closure from running at all — a
 * primitive that refuses before invoking it, or an ambient
 * unit naming a different backend — reaches the runner as an
 * undefined return instead of a throw. The transition
 * functions never legitimately return undefined, so an
 * undefined here means the unit did not run: surface the
 * catalog's cannot-honour outcome rather than a silent
 * no-result. The aspect and the runner are not modified.
 */
function runPromotionUnit<T>(
  txStorage: DoTransactionStorage | null | undefined,
  operationName: string,
  fn: () => T,
): T {
  const runner = txStorage?.transactionSync ? getTransactionRunner() : null;
  if (!txStorage || !runner) return fn();
  const result = runner.runSyncUnit(
    txStorage,
    { operationName, domain: "champion-challenger" },
    fn,
  );
  if (result === undefined) {
    throw new DataFoundationError(
      DataFoundationCode.TX_CANNOT_HONOUR,
      `The promotion unit (${operationName}) did not run: the store refused the unit or an ambient unit names a different backend. No part of the transition was applied by this call.`,
    );
  }
  return result;
}

export function promoteChallenger(
  sql: any,
  userLogin: string,
  challengerId: string,
  input: { actor: string; now?: Date },
  txStorage?: DoTransactionStorage | null
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

  // Spec-shape pre-checks: functions of the challenger row
  // only, in the pre-wrap refusal order. The transition below
  // consumes them unchanged.
  let targets: Array<{ strategy: string; regime: string; weight: number }> | null =
    null;
  let strategies: string[] | null = null;
  if (challenger.kind === "weights") {
    if (!challenger.regime) {
      return { ok: false, reason: "weights challenger has no regime; weights v2 are regime-scoped" };
    }
    targets = Object.entries(challenger.spec.weights ?? {}).map(
      ([strategy, weight]) => ({
        strategy,
        regime: challenger.regime as string,
        weight,
      })
    );
    if (!targets.length) return { ok: false, reason: "weights challenger carries no target weights" };
  } else {
    strategies =
      challenger.spec.activeStrategies ?? challenger.spec.ranking ?? null;
    if (!strategies) {
      return {
        ok: false,
        reason: "active-set/ranking challenger carries no strategies (retire specs resolve via resolveChallengerOutcome)",
      };
    }
  }

  const transition = (): { ok: boolean; reason?: string } => {
    // #2346: the status is re-read inside the unit — the
    // pre-read status is never trusted across the boundary, so
    // an evaluated→promoted interleave can never double-apply.
    const fresh = getChallenger(sql, userLogin, challengerId);
    if (
      !fresh ||
      fresh.status !== "evaluated" ||
      !fresh.evaluation ||
      fresh.evaluation.verdict !== "pass"
    ) {
      return {
        ok: false,
        reason: `challenger status changed before the promotion unit ran (now ${fresh ? fresh.status : "missing"}); promotion refused without applying`,
      };
    }
    let prior: unknown = null;
    let applied: unknown = null;
    let weightsVersion: number | null = null;
    if (fresh.kind === "weights") {
      const weightTargets = targets as Array<{
        strategy: string;
        regime: string;
        weight: number;
      }>;
      const current = getStrategyWeightsV2(sql);
      prior = {
        weights: weightTargets.map((t) => {
          const key = weightsV2Key(t.strategy, t.regime);
          return {
            strategy: t.strategy,
            regime: t.regime,
            weight: current[key] ?? null,
            rowExisted: key in current,
          };
        }),
      };
      const res = applyWeightsV2Targets(sql, weightTargets, {
        actor: input.actor,
        rationale: `champion/challenger promotion ${fresh.id} (${fresh.title}); frozen set ${fresh.evalSetVersion} holdout pass; approved by ${approver}`,
        now,
      });
      if (res.halted) return { ok: false, reason: "adaptation is halted by the kill switch; promotion refused" };
      applied = { weights: res.applied };
      weightsVersion = currentWeightsVersion(sql);
    } else {
      const activeStrategies = strategies as string[];
      prior = { activeSet: getActiveStrategySet(sql, userLogin) };
      const version = appendActiveSet(sql, userLogin, activeStrategies, fresh.id, now);
      applied = { activeSet: { strategies: activeStrategies, version } };
    }
    recordPromotion(sql, fresh, "promoted", prior, applied, weightsVersion, input.actor, null, now);
    setChallengerStatus(sql, fresh, "promoted", undefined, now);
    return { ok: true };
  };
  return runPromotionUnit(txStorage, "championChallenger.promote", transition);
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
  },
  txStorage?: DoTransactionStorage | null
): { ok: boolean; reason?: string } {
  ensureChallengerTables(sql);
  const now = input.now ?? new Date();
  const challenger = getChallenger(sql, userLogin, challengerId);
  if (!challenger) return { ok: false, reason: "challenger not found for this tenant" };

  if (input.outcome === "keep_champion") {
    if (challenger.status !== "evaluated") {
      return { ok: false, reason: "keep-champion resolves an evaluated challenger" };
    }
    const transition = (): { ok: boolean; reason?: string } => {
      // #2346: status re-read inside the unit, as in promote.
      const fresh = getChallenger(sql, userLogin, challengerId);
      if (!fresh || fresh.status !== "evaluated") {
        return {
          ok: false,
          reason: `challenger status changed before the resolve unit ran (now ${fresh ? fresh.status : "missing"}); keep-champion refused without applying`,
        };
      }
      recordPromotion(sql, fresh, "keep_champion", null, null, null, input.actor, input.reason, now);
      setChallengerStatus(sql, fresh, "kept_champion", undefined, now);
      return { ok: true };
    };
    return runPromotionUnit(txStorage, "championChallenger.resolveKeepChampion", transition);
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
  const transition = (): { ok: boolean; reason?: string } => {
    // #2346: the prior gate snapshot is read inside the unit —
    // it is the rollback data for the state the unit changes.
    const fresh = getChallenger(sql, userLogin, challengerId);
    if (!fresh) {
      return { ok: false, reason: "challenger not found for this tenant" };
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
        rationale: `retire strategy via challenger ${fresh.id}: ${input.reason}`,
        dataWindow: `frozen set ${fresh.evalSetVersion}`,
      },
      () => setStrategyGate(sql, strategy, true, now),
      now,
      { enforceBudgets: false }
    );
    if (!out.applied) return { ok: false, reason: out.reason ?? "adaptation seam refused" };
    recordPromotion(sql, fresh, "retire_strategy", prior, { gate: { strategy, gatedOff: true } }, null, input.actor, input.reason, now);
    setChallengerStatus(sql, fresh, "retired", undefined, now);
    return { ok: true };
  };
  return runPromotionUnit(txStorage, "championChallenger.resolveRetire", transition);
}

export function rollbackChallengerPromotion(
  sql: any,
  userLogin: string,
  challengerId: string,
  input: { actor: string; now?: Date },
  txStorage?: DoTransactionStorage | null
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

  const transition = (): { ok: boolean; reason?: string } => {
    // #2346: the rollback target is re-derived from records
    // read inside the unit — the promotion record is the
    // unit's own input, never a pre-read snapshot.
    const freshRecords = listPromotionRecords(sql, userLogin, challengerId);
    const freshRolledBack = freshRecords.some((r) => r.action === "rollback");
    const target = [...freshRecords]
      .reverse()
      .find((r) => r.action === "promoted" || r.action === "retire_strategy");
    if (!target || freshRolledBack) {
      return { ok: false, reason: "no live promotion to roll back" };
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
  };
  return runPromotionUnit(txStorage, "championChallenger.rollback", transition);
}
