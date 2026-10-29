/**
 * Issue #2356 (#1976 step 4c) — the in-memory implementation
 * of the strategy-review port, with semantics identical to
 * the DO-SQLite adapter (same derived ids, replace re-pends,
 * decide only from pending). decidedAt uses the same
 * SQLite datetime('now') shape (UTC, second precision).
 */
import type {
  StrategyCandidateInput,
  StrategyCandidateReview,
  StrategyReviewStore,
} from "./strategyReviewPorts";

function sqliteNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export class InMemoryStrategyReviewStore implements StrategyReviewStore {
  private rows = new Map<string, StrategyCandidateReview>();

  ensureTable(): void {
    // In-memory: nothing to ensure.
  }

  recordCandidates(symbol: string, candidates: StrategyCandidateInput[]): void {
    const now = new Date().toISOString();
    for (const c of candidates) {
      const id = `${symbol}:${c.id}:${now.slice(0, 10)}`;
      this.rows.set(id, {
        id,
        symbol,
        candidateId: c.id,
        label: c.label,
        rank: c.rank,
        rationale: c.rationale,
        quantStatus: c.quantStatus as StrategyCandidateReview["quantStatus"],
        decision: "pending",
        decidedAt: null,
        createdAt: now,
      });
    }
  }

  list(decision?: string): StrategyCandidateReview[] {
    return [...this.rows.values()]
      .filter((r) => !decision || r.decision === decision)
      .sort((a, b) =>
        a.createdAt !== b.createdAt
          ? a.createdAt < b.createdAt
            ? 1
            : -1
          : a.rank - b.rank,
      )
      .slice(0, 100)
      .map((r) => ({ ...r }));
  }

  decide(id: string, decision: "approved" | "rejected"): boolean {
    const row = this.rows.get(id);
    if (!row || row.decision !== "pending") return false;
    row.decision = decision;
    row.decidedAt = sqliteNow();
    return true;
  }
}
