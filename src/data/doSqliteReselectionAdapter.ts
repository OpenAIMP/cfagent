/**
 * Issue #2357 (#1976 step 4b) — the DO-SQLite implementation
 * of the reselection port: the persistence section of the
 * legacy src/services/strategyBankReselection.ts, moved into
 * the data layer statement-for-statement. The service module
 * keeps the pure policy and delegates persistence here.
 */
import type {
  ReselectionProposal,
  ReselectionProposalRecord,
  ReselectionSqlExecutor,
  ReselectionStore,
} from "./reselectionPorts";

export class DoSqliteReselectionStore implements ReselectionStore {
  constructor(private readonly sql: ReselectionSqlExecutor) {}

  ensureTable(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mas_strategy_bank_proposals (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    regime TEXT NOT NULL,
    proposal_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  }

  insertProposal(id: string, userLogin: string, proposal: ReselectionProposal): void {
    this.sql.exec(
      `INSERT INTO mas_strategy_bank_proposals (id, user_login, regime, proposal_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      userLogin,
      proposal.regime,
      JSON.stringify(proposal),
      proposal.generatedAt
    );
  }

  listProposals(userLogin: string, limit = 20): ReselectionProposalRecord[] {
    this.ensureTable();
    const rows = Array.from(
      this.sql.exec(
        `SELECT id, regime, proposal_json, created_at FROM mas_strategy_bank_proposals WHERE user_login = ? ORDER BY created_at DESC LIMIT ?`,
        userLogin,
        limit
      )
    ) as any[];
    return rows.map((row) => ({
      id: String(row.id),
      regime: String(row.regime),
      createdAt: String(row.created_at),
      proposal: JSON.parse(String(row.proposal_json)) as ReselectionProposal,
    }));
  }
}
