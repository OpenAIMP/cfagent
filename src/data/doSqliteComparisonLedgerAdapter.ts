/**
 * Issue #2356 (#1976 step 4c) — the DO-SQLite implementation
 * of the comparison-ledger port: the legacy ledger
 * statements from recommendationKernel.ts (ensure + record)
 * and comparisonRunner.ts (the read), moved into the data
 * layer statement-for-statement.
 */
import {
  compareComparisonOutcomeRows,
  type ComparisonLedgerSqlExecutor,
  type ComparisonLedgerStore,
  type ComparisonOutcomeInput,
  type ComparisonOutcomeRow,
} from "./comparisonLedgerPorts";

export class DoSqliteComparisonLedgerStore implements ComparisonLedgerStore {
  constructor(private readonly sql: ComparisonLedgerSqlExecutor) {}

  ensureTable(): void {
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS mas_comparison_arm_outcomes (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, arm TEXT NOT NULL, candidate_id TEXT NOT NULL, structure TEXT NOT NULL, symbol TEXT NOT NULL, status TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL)",
    );
  }

  recordOutcome(input: ComparisonOutcomeInput): void {
    this.sql.exec(
      "INSERT INTO mas_comparison_arm_outcomes (id, run_id, arm, candidate_id, structure, symbol, status, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      input.id,
      input.runId,
      input.arm,
      input.candidateId,
      input.structure,
      input.symbol,
      input.status,
      input.provenance,
      input.createdAt,
    );
  }

  listOutcomes(runId?: string): ComparisonOutcomeRow[] {
    const rows = (
      runId
        ? Array.from(this.sql.exec(`SELECT id, run_id, arm, candidate_id, structure, symbol, status, provenance, created_at FROM mas_comparison_arm_outcomes WHERE run_id = ?`, runId))
        : Array.from(this.sql.exec(`SELECT id, run_id, arm, candidate_id, structure, symbol, status, provenance, created_at FROM mas_comparison_arm_outcomes`))
    ) as ComparisonOutcomeRow[];
    return rows.sort(compareComparisonOutcomeRows);
  }
}
