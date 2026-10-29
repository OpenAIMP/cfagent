/**
 * Issue #2337 (#1976 step 2) — the DO-SQLite implementation of
 * the enrichment-run port: the legacy SqlEnrichmentStore
 * (issue #1888), moved verbatim into the data layer behind its
 * EXISTING port (src/enrichment/enrichmentPorts.ts).
 * src/enrichment/enrichmentStore.ts keeps the in-memory
 * adapter and re-exports this class.
 *
 * Adapter move only (step-2 audit §2.7): the class carries its
 * killswitch methods with it — the mas_settings statements are
 * byte-identical, same key, same fail-closed read; nothing
 * about the settings family's ownership changes (gate G-7
 * untouched). The get-then-put and supersede-then-put pairs
 * are NOT wrapped in the transaction aspect (audit §4).
 */
import {
  ENRICHMENT_KILLSWITCH_KEY,
  parseKillswitchValue,
  summarizeEnrichmentQuality,
  type EnrichmentKillswitchState,
  type EnrichmentQualitySummary,
  type EnrichmentRunRecord,
  type EnrichmentRunStore,
} from "../enrichment/enrichmentPorts";

export interface EnrichmentSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

export type EnrichmentAuditFn = (
  type: string,
  agent: string,
  payload: Record<string, unknown>,
) => unknown;

const RUNS_TABLE = "mas_enrichment_runs";

const CREATE_RUNS_SQL =
  `CREATE TABLE IF NOT EXISTS ${RUNS_TABLE} (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, job_id TEXT NOT NULL, stage TEXT NOT NULL, record_json TEXT NOT NULL)`;
const CREATE_RUNS_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_mas_enrichment_runs_job ON ${RUNS_TABLE} (job_id, stage, created_at DESC)`;
const INSERT_RUN_SQL =
  `INSERT INTO ${RUNS_TABLE} (id, created_at, job_id, stage, record_json) VALUES (?, ?, ?, ?, ?)`;
const LIST_RUNS_SQL =
  `SELECT record_json FROM ${RUNS_TABLE} ORDER BY created_at DESC, id DESC LIMIT ?`;
const GET_RUN_SQL =
  `SELECT record_json FROM ${RUNS_TABLE} WHERE id = ?`;

export class SqlEnrichmentStore implements EnrichmentRunStore {
  constructor(
    private readonly sql: EnrichmentSqlExecutor,
    private readonly audit?: EnrichmentAuditFn,
  ) {}

  ensureTables(): void {
    this.sql.exec(CREATE_RUNS_SQL);
    this.sql.exec(CREATE_RUNS_INDEX_SQL);
  }

  recordRun(run: EnrichmentRunRecord): void {
    this.ensureTables();
    this.sql.exec(
      INSERT_RUN_SQL,
      run.id,
      run.createdAt,
      run.jobId,
      run.stage,
      JSON.stringify(run),
    );
  }

  listRuns(limit = 20): EnrichmentRunRecord[] {
    this.ensureTables();
    const rows = Array.from(this.sql.exec(LIST_RUNS_SQL, limit)) as Array<{
      record_json: string;
    }>;
    return rows.map((r) => JSON.parse(r.record_json) as EnrichmentRunRecord);
  }

  getRun(id: string): EnrichmentRunRecord | null {
    this.ensureTables();
    const rows = Array.from(this.sql.exec(GET_RUN_SQL, id)) as Array<{
      record_json: string;
    }>;
    if (rows.length === 0) return null;
    return JSON.parse(rows[0].record_json) as EnrichmentRunRecord;
  }

  qualitySummary(limit = 200): EnrichmentQualitySummary {
    return summarizeEnrichmentQuality(this.listRuns(limit));
  }

  /** Fail-closed: an unreadable settings read reports halted. */
  getKillswitchState(): EnrichmentKillswitchState {
    try {
      const rows = Array.from(
        this.sql.exec(
          `SELECT value FROM mas_settings WHERE key = ?`,
          ENRICHMENT_KILLSWITCH_KEY,
        ),
      ) as Array<{ value: string }>;
      if (rows.length === 0) return "clear";
      return parseKillswitchValue(rows[0].value);
    } catch (err) {
      console.error(
        "[Enrichment] Killswitch read failed; halting enrichment (fail-closed):",
        err,
      );
      return "halted";
    }
  }

  setKillswitch(
    state: EnrichmentKillswitchState,
    setBy: string,
    reason: string,
  ): EnrichmentKillswitchState {
    this.sql.exec(`DELETE FROM mas_settings WHERE key = ?`, ENRICHMENT_KILLSWITCH_KEY);
    this.sql.exec(
      `INSERT INTO mas_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      ENRICHMENT_KILLSWITCH_KEY,
      state === "halted" ? "on" : "off",
      new Date().toISOString(),
    );
    // Best-effort audit: never blocks an operator stop.
    try {
      this.audit?.("enrichment.killswitch", "enrichment", {
        state,
        setBy,
        reason,
      });
    } catch (err) {
      console.error("[Enrichment] Killswitch audit failed (ignored):", err);
    }
    return state;
  }
}
