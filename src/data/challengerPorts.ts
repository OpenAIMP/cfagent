/**
 * Issue #2357 (#1976 step 4b, ADR 0022 D-I step 4) — champion/
 * challenger port: the promotion gate's durable state
 * (challengers, approvals, promotion records, the active
 * strategy set).
 *
 * ADR D-0 ruled this family DO-resident behind a port (step-4
 * audit §3): the promotion transition (#2346) is a DO
 * transactionSync unit over these tables — the unit's legs
 * are this port's methods, and its rollback data is the
 * promotion record this port appends. This module carries
 * the record types and the port interface ONLY (ADR 0002
 * R1/R2). Adapters: doSqliteChallengerAdapter.ts (production,
 * the store section of the legacy championChallenger moved
 * into the layer), inMemoryChallengerAdapter.ts (test
 * double). The gate logic (three locks, evaluation, the
 * wrapped transition) stays in
 * src/services/championChallenger.ts, which re-exports these
 * types and delegates its store functions to the DO adapter.
 *
 * CONFLICT POLICY (ADR D-E.1): challenger and record inserts
 * are insert-or-throw on their primary keys — a duplicate id
 * surfaces as the store's own error, never a silent
 * overwrite. Promotion records and approvals are append-only:
 * no update or delete path exists on this port for them. The
 * one update path is the challenger status write, whose
 * caller (the service) re-reads the row inside the promotion
 * unit before writing it (#2346 discipline — the port does
 * not relax it).
 */

import type { WeightsV2Regime } from "./strategyWeightsPorts";

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

export interface ChallengerApprovalRecord {
  id: string;
  challengerId: string;
  approver: string;
  decision: "approved" | "rejected";
  createdAt: string;
}

export interface ChallengerApprovalWrite {
  id: string;
  challengerId: string;
  userLogin: string;
  approver: string;
  decision: "approved" | "rejected";
  createdAt: string;
}

export interface PromotionRecord {
  action: string;
  prior: any;
  applied: any;
  actor: string;
  reason: string | null;
}

export interface PromotionRecordWrite {
  id: string;
  challengerId: string;
  userLogin: string;
  action: string;
  prior: unknown;
  applied: unknown;
  weightsVersion: number | null;
  actor: string;
  reason: string | null;
  createdAt: string;
}

export interface ActiveStrategySet {
  strategies: string[];
  version: number;
  challengerId: string | null;
  createdAt: string;
}

export interface ActiveSetWrite {
  id: string;
  userLogin: string;
  version: number;
  strategies: string[];
  challengerId: string | null;
  createdAt: string;
}

/**
 * The challenger store contract (sync, mirroring the legacy
 * module's seam). Tenant scoping is part of the contract:
 * every read is filtered by userLogin, so another tenant's
 * challenger is invisible. Methods assume ensureTables has
 * run for the family (the composition's ensure covers the
 * whole cluster); each read entry point ensures this port's
 * own tables.
 */
export interface ChallengerStore {
  ensureTables(): void;
  getChallenger(userLogin: string, id: string): Challenger | null;
  listChallengers(userLogin: string): Challenger[];
  insertChallenger(challenger: Challenger): void;
  setChallengerStatus(
    challenger: Challenger,
    status: ChallengerStatus,
    evaluation: ChallengerEvaluation | null | undefined,
    now: Date,
  ): void;
  insertApproval(write: ChallengerApprovalWrite): void;
  getApprovedApprover(userLogin: string, challengerId: string): string | null;
  listApprovals(userLogin: string, challengerId: string): ChallengerApprovalRecord[];
  insertPromotion(write: PromotionRecordWrite): void;
  listPromotionRecords(userLogin: string, challengerId: string): PromotionRecord[];
  getActiveStrategySet(userLogin: string): ActiveStrategySet | null;
  insertActiveSet(write: ActiveSetWrite): void;
}

/** Minimal SQL executor matching the Durable Object SqlStorage
 *  exec signature (the shape the legacy module's seam assumed). */
export interface ChallengerSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
