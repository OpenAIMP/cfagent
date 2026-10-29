/**
 * Issue #2356 (#1976 step 4c) — the DO-SQLite implementation
 * of the strategy-review port: the legacy src/services/
 * strategyReviews.ts, moved into the data layer
 * statement-for-statement. The service module is now a
 * re-export shim over this adapter and strategyReviewPorts.
 */
import type {
  StrategyCandidateInput,
  StrategyCandidateReview,
  StrategyReviewSqlExecutor,
  StrategyReviewStore,
} from "./strategyReviewPorts";

export class DoSqliteStrategyReviewStore implements StrategyReviewStore {
  constructor(private readonly sql: StrategyReviewSqlExecutor) {}

  ensureTable(): void {
    const sql = this.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS mas_strategy_reviews (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    label TEXT NOT NULL,
    rank INTEGER NOT NULL,
    rationale TEXT NOT NULL,
    quant_status TEXT NOT NULL DEFAULT 'unverified',
    decision TEXT NOT NULL DEFAULT 'pending',
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_strategy_reviews_symbol ON mas_strategy_reviews(symbol)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_strategy_reviews_decision ON mas_strategy_reviews(decision)`);
  }

  recordCandidates(symbol: string, candidates: StrategyCandidateInput[]): void {
    this.ensureTable();
    const now = new Date().toISOString();
    for (const c of candidates) {
      const id = `${symbol}:${c.id}:${now.slice(0, 10)}`;
      this.sql.exec(
        `INSERT OR REPLACE INTO mas_strategy_reviews
       (id, symbol, candidate_id, label, rank, rationale, quant_status, decision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        id, symbol, c.id, c.label, c.rank, c.rationale, c.quantStatus, now
      );
    }
  }

  list(decision?: string): StrategyCandidateReview[] {
    this.ensureTable();
    const where = decision ? `WHERE decision = '${decision}'` : "";
    const rows = Array.from(
      this.sql.exec(`SELECT * FROM mas_strategy_reviews ${where} ORDER BY created_at DESC, rank ASC LIMIT 100`)
    ) as any[];
    return rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      candidateId: r.candidate_id,
      label: r.label,
      rank: r.rank,
      rationale: r.rationale,
      quantStatus: r.quant_status,
      decision: r.decision,
      decidedAt: r.decided_at,
      createdAt: r.created_at,
    }));
  }

  decide(id: string, decision: "approved" | "rejected"): boolean {
    this.ensureTable();
    const result = this.sql.exec(
      `UPDATE mas_strategy_reviews SET decision = ?, decided_at = datetime('now')
     WHERE id = ? AND decision = 'pending'`,
      decision, id
    );
    return (result as any).changes > 0;
  }
}
