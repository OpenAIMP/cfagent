/**
 * Issue #2356 (#1976 step 4c, ADR 0022 D-I step 4) —
 * comparison-arm outcome ledger port for the evidence
 * satellites (the recommendationKernel writer +
 * comparisonRunner reader pair over
 * mas_comparison_arm_outcomes).
 *
 * ADR D-0 ruled this family DO-resident behind a port (audit
 * §3): written and read on the orchestrator instance by the
 * comparison tooling. This module carries the row type and
 * the port interface ONLY (ADR 0002 R1/R2). Adapters:
 * doSqliteComparisonLedgerAdapter.ts (production),
 * inMemoryComparisonLedgerAdapter.ts (test double).
 *
 * The reader's sort lives in code, not SQL (the legacy
 * reader's contract: created_at, then arm, then
 * candidate_id, then id) — both adapters apply the identical
 * comparator, exported here so it cannot drift. The id key
 * (#2367) makes the order TOTAL: id is the table's primary
 * key, so no two distinct rows compare equal, and a list's
 * order depends only on the stored rows — never on the
 * storage scan order feeding the sort.
 */

export interface ComparisonOutcomeRow {
  id: string;
  run_id: string;
  arm: string;
  candidate_id: string;
  structure: string;
  symbol: string;
  status: string;
  provenance: string;
  created_at: string;
}

export interface ComparisonOutcomeInput {
  id: string;
  runId: string;
  arm: string;
  candidateId: string;
  structure: string;
  symbol: string;
  status: string;
  provenance: string;
  createdAt: string;
}

/**
 * The reader's in-code sort (legacy comparisonRunner),
 * extended by #2367 with id as the final tie-break so the
 * order is total: rows tied on (created_at, arm,
 * candidate_id) — routine when a run records its outcomes
 * inside one millisecond — order by their primary key
 * instead of by whatever order storage returned them in.
 */
export function compareComparisonOutcomeRows(
  a: ComparisonOutcomeRow,
  b: ComparisonOutcomeRow,
): number {
  return (
    String(a.created_at).localeCompare(String(b.created_at)) ||
    String(a.arm).localeCompare(String(b.arm)) ||
    String(a.candidate_id).localeCompare(String(b.candidate_id)) ||
    String(a.id).localeCompare(String(b.id))
  );
}

/** The comparison-ledger contract (sync, mirroring the
 *  legacy kernel/runner seams). Append-only: no update or
 *  delete method exists. */
export interface ComparisonLedgerStore {
  ensureTable(): void;
  recordOutcome(input: ComparisonOutcomeInput): void;
  listOutcomes(runId?: string): ComparisonOutcomeRow[];
}

export interface ComparisonLedgerSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
