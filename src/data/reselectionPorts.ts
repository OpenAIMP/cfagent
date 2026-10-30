/**
 * Issue #2357 (#1976 step 4b, ADR 0022 D-I step 4) — strategy
 * bank reselection port: the durable transparency record for
 * nightly re-selection proposals (#1122).
 *
 * ADR D-0 ruled this family DO-resident behind a port (step-4
 * audit §3). The record is append-only by governance: a
 * proposal is recorded once and read back for the Review
 * surfaces; there is no update or delete path on this port.
 * The pure re-selection policy stays in
 * src/services/strategyBankReselection.ts, which re-exports
 * these types and delegates persistence to the DO adapter.
 * This module carries types + the interface ONLY (ADR 0002
 * R1/R2).
 */

import type { RegimeAssessment } from "../services/researchPipeline";

export type ReselectionRegime = RegimeAssessment["regime"];

/** Recorded on every proposal so no consumer can mistake it for a promotion. */
export const RESELECTION_GOVERNANCE = "proposal_only_not_promoted" as const;

export interface StrategyRegimeEvidence {
  strategy: string;
  regime: ReselectionRegime;
  /** Ideas published under this strategy+regime. */
  published: number;
  /** Of those, how many have a recorded evaluation. */
  evaluated: number;
  /** Share of evaluated ideas with pnl > 0 (null when none evaluated). */
  winRate: number | null;
  /** Mean R multiple over evaluated ideas that carry one (null when none). */
  avgRMultiple: number | null;
}

export type ReselectionOutcome =
  | "selected"
  | "deselected"
  | "insufficient_evidence"
  | "eligible_over_cap"
  | "not_evaluated_cost_cap";

export interface ReselectionLogEntry {
  strategy: string;
  outcome: ReselectionOutcome;
  /** True when recorded evidence shows this strategy losing (negative avg R or below-baseline win rate). */
  loser: boolean;
  evaluated: number;
  winRate: number | null;
  avgRMultiple: number | null;
  score: number | null;
  reason: string;
}

export interface ReselectionActiveEntry {
  strategy: string;
  score: number;
  winRate: number;
  avgRMultiple: number;
  evaluated: number;
  /** Current strategyWeights value, informational only — never written here. */
  weight: number | null;
}

export interface ReselectionProposal {
  regime: ReselectionRegime;
  generatedAt: string;
  governance: typeof RESELECTION_GOVERNANCE;
  overallWinRate: number | null;
  activeSet: ReselectionActiveEntry[];
  /** Every strategy in the regime's evidence appears exactly once. */
  log: ReselectionLogEntry[];
  evaluatedCount: number;
  costUnitsUsed: number;
  costCapUnits: number;
}

export interface ReselectionProposalRecord {
  id: string;
  regime: string;
  createdAt: string;
  proposal: ReselectionProposal;
}

/**
 * The reselection record contract (sync, mirroring the legacy
 * module's seam). Tenant scoping is part of the contract:
 * lists are filtered by userLogin.
 */
export interface ReselectionStore {
  ensureTable(): void;
  insertProposal(id: string, userLogin: string, proposal: ReselectionProposal): void;
  listProposals(userLogin: string, limit?: number): ReselectionProposalRecord[];
}

/** Minimal SQL executor matching the Durable Object SqlStorage
 *  exec signature (the shape the legacy module's seam assumed). */
export interface ReselectionSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
