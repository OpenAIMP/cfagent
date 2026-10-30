/**
 * Issue #2359 (#1976 step 4d) — the DO-SQLite implementation
 * of the report-confirmation port: the mas_report_confirmations
 * statements from src/agents/orchestrator/reportDispatch.ts
 * (create sweep + insert, get, decide) and
 * src/agents/routes/reports.ts (pending list, per-report
 * list), moved into the data layer statement-for-statement,
 * plus the table's DDL + probed report_id migration from
 * OrchestratorAgent.ensureTables (its ONE home now).
 * Payload semantics (delivery metadata only, #308) stay in
 * the legacy modules.
 */
import type {
  InsertConfirmationInput,
  OrchestratorTableSqlExecutor,
  ReportConfirmationForReportRow,
  ReportConfirmationPendingRow,
  ReportConfirmationPort,
  ReportConfirmationRow,
} from "./orchestratorTablePorts";

export class DoSqliteReportConfirmationStore implements ReportConfirmationPort {
  constructor(private readonly sql: OrchestratorTableSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_report_confirmations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        report_id TEXT
      )
    `);
    // Additive migration for tables created before issue #308.
    try {
      const cols = Array.from(
        this.sql.exec("PRAGMA table_info(mas_report_confirmations)")
      ) as Array<{ name?: unknown }>;
      const names = cols.map((c) => String(c?.name ?? ""));
      if (!names.includes("report_id")) {
        this.sql.exec("ALTER TABLE mas_report_confirmations ADD COLUMN report_id TEXT");
      }
    } catch {
      // Non-critical: best-effort migration; fresh installs get the column.
    }
  }

  sweepExpiredPending(cutoffIso: string): void {
    this.sql.exec(
      "DELETE FROM mas_report_confirmations WHERE status = 'pending' AND created_at < ?",
      cutoffIso
    );
  }

  insertConfirmation(input: InsertConfirmationInput): void {
    this.sql.exec(
      "INSERT INTO mas_report_confirmations (id, kind, payload_json, status, created_at, report_id) VALUES (?, ?, ?, ?, ?, ?)",
      input.id,
      input.kind,
      input.payloadJson,
      input.status,
      input.createdAt,
      input.reportId
    );
  }

  getById(id: string): ReportConfirmationRow | null {
    const rows = Array.from(
      this.sql.exec("SELECT * FROM mas_report_confirmations WHERE id = ?", id)
    ) as ReportConfirmationRow[];
    return rows[0] ?? null;
  }

  decide(id: string, status: string, decidedAt: string, decidedBy: string | null): void {
    this.sql.exec(
      "UPDATE mas_report_confirmations SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?",
      status,
      decidedAt,
      decidedBy,
      id
    );
  }

  listPending(): ReportConfirmationPendingRow[] {
    return Array.from(
      this.sql.exec(
        "SELECT id, kind, payload_json, created_at FROM mas_report_confirmations WHERE status = 'pending' ORDER BY created_at DESC"
      )
    ) as ReportConfirmationPendingRow[];
  }

  listByReportId(reportId: string): ReportConfirmationForReportRow[] {
    return Array.from(
      this.sql.exec(
        "SELECT id, kind, status, created_at, decided_at, decided_by, payload_json FROM mas_report_confirmations WHERE report_id = ? ORDER BY created_at DESC",
        reportId
      )
    ) as ReportConfirmationForReportRow[];
  }
}
