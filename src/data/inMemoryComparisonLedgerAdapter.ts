/**
 * Issue #2356 (#1976 step 4c) — the in-memory implementation
 * of the comparison-ledger port, with semantics identical
 * to the DO-SQLite adapter (append-only; the reader's
 * in-code sort).
 */
import {
  compareComparisonOutcomeRows,
  type ComparisonLedgerStore,
  type ComparisonOutcomeInput,
  type ComparisonOutcomeRow,
} from "./comparisonLedgerPorts";

export class InMemoryComparisonLedgerStore implements ComparisonLedgerStore {
  private rows: ComparisonOutcomeRow[] = [];

  ensureTable(): void {
    // In-memory: nothing to ensure.
  }

  recordOutcome(input: ComparisonOutcomeInput): void {
    this.rows.push({
      id: input.id,
      run_id: input.runId,
      arm: input.arm,
      candidate_id: input.candidateId,
      structure: input.structure,
      symbol: input.symbol,
      status: input.status,
      provenance: input.provenance,
      created_at: input.createdAt,
    });
  }

  listOutcomes(runId?: string): ComparisonOutcomeRow[] {
    return this.rows
      .filter((r) => !runId || r.run_id === runId)
      .map((r) => ({ ...r }))
      .sort(compareComparisonOutcomeRows);
  }
}
