/**
 * Issue #653: persistence for strategy candidate reviews.
 * Stores LLM-ranked candidates with quant verification status; approve/reject
 * decisions feed back into ranking (stored as feedback for future runs).
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

export function ensureStrategyReviewsTable(sql: any): void {
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

export function recordStrategyCandidates(
  sql: any,
  symbol: string,
  candidates: Array<{ id: string; label: string; rank: number; rationale: string; quantStatus: string }>
): void {
  ensureStrategyReviewsTable(sql);
  const now = new Date().toISOString();
  for (const c of candidates) {
    const id = `${symbol}:${c.id}:${now.slice(0, 10)}`;
    sql.exec(
      `INSERT OR REPLACE INTO mas_strategy_reviews
       (id, symbol, candidate_id, label, rank, rationale, quant_status, decision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id, symbol, c.id, c.label, c.rank, c.rationale, c.quantStatus, now
    );
  }
}

export function listStrategyReviews(sql: any, decision?: string): StrategyCandidateReview[] {
  ensureStrategyReviewsTable(sql);
  const where = decision ? `WHERE decision = '${decision}'` : "";
  const rows = Array.from(
    sql.exec(`SELECT * FROM mas_strategy_reviews ${where} ORDER BY created_at DESC, rank ASC LIMIT 100`)
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

export function decideStrategyReview(
  sql: any,
  id: string,
  decision: "approved" | "rejected"
): boolean {
  ensureStrategyReviewsTable(sql);
  const result = sql.exec(
    `UPDATE mas_strategy_reviews SET decision = ?, decided_at = datetime('now')
     WHERE id = ? AND decision = 'pending'`,
    decision, id
  );
  return (result as any).changes > 0;
}
