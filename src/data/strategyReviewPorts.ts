/**
 * Issue #2356 (#1976 step 4c, ADR 0022 D-I step 4) — strategy
 * candidate review port for the evidence satellites.
 *
 * ADR D-0 ruled this family DO-resident behind a port (audit
 * §3): single host (orchestrator), no tenant column — the
 * per-login instance is the scope, exactly as today. This
 * module carries the record type and the port interface
 * ONLY (ADR 0002 R1/R2). Adapters:
 * doSqliteStrategyReviewAdapter.ts (production),
 * inMemoryStrategyReviewAdapter.ts (test double). Types
 * moved here from src/services/strategyReviews.ts, now a
 * re-export shim; src/services/reflection.ts consumes the
 * port through the composition root.
 *
 * TRANSACTION SEAM (ADR D-C): record() is a per-candidate
 * INSERT OR REPLACE loop, sequential exactly as legacy; no
 * multi-statement unit exists to wrap.
 */

export interface StrategyCandidateReview {
  id: string;
  symbol: string;
  candidateId: string;
  label: string;
  rank: number;
  rationale: string;
  quantStatus: "verified" | "unverified" | "failed";
  decision: "pending" | "approved" | "rejected";
  decidedAt: string | null;
  createdAt: string;
}

export interface StrategyCandidateInput {
  id: string;
  label: string;
  rank: number;
  rationale: string;
  quantStatus: string;
}

/** The strategy-review store contract (sync, mirroring the
 *  legacy module's seam). Recording derives the row id from
 *  symbol + candidate id + day, so a same-day re-record
 *  replaces (and re-pends) the row. decide() moves only a
 *  pending row and reports whether it did. */
export interface StrategyReviewStore {
  ensureTable(): void;
  recordCandidates(symbol: string, candidates: StrategyCandidateInput[]): void;
  list(decision?: string): StrategyCandidateReview[];
  decide(id: string, decision: "approved" | "rejected"): boolean;
}

export interface StrategyReviewSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
