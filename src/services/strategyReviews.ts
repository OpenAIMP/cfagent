/**
 * Issue #653: persistence for strategy candidate reviews.
 * Stores LLM-ranked candidates with quant verification status; approve/reject
 * decisions feed back into ranking (stored as feedback for future runs).
 *
 * @deprecated Superseded by src/data/strategyReviewPorts.ts (port),
 * src/data/doSqliteStrategyReviewAdapter.ts (production adapter) and
 * src/data/createEvidenceSatellitePorts.ts (composition root) —
 * #1976 step 4c (#2356, ADR 0022 D-I step 4). This module is a
 * re-export shim: every function delegates to the DO adapter over
 * the caller's sql handle, statement-for-statement identical to
 * the pre-port implementation.
 */

import { DoSqliteStrategyReviewStore } from "../data/doSqliteStrategyReviewAdapter";
import type {
  StrategyCandidateInput,
  StrategyCandidateReview,
} from "../data/strategyReviewPorts";

export type { StrategyCandidateReview } from "../data/strategyReviewPorts";

function store(sql: any): DoSqliteStrategyReviewStore {
  return new DoSqliteStrategyReviewStore(sql);
}

export function ensureStrategyReviewsTable(sql: any): void {
  store(sql).ensureTable();
}

export function recordStrategyCandidates(
  sql: any,
  symbol: string,
  candidates: StrategyCandidateInput[],
): void {
  store(sql).recordCandidates(symbol, candidates);
}

export function listStrategyReviews(sql: any, decision?: string): StrategyCandidateReview[] {
  return store(sql).list(decision);
}

export function decideStrategyReview(
  sql: any,
  id: string,
  decision: "approved" | "rejected",
): boolean {
  return store(sql).decide(id, decision);
}
