/**
 * Issue #1888: enrichment run store + dedicated killswitch storage.
 *
 * Runs persist in the orchestrator's storage SQL (the same idiom as
 * the feed-snapshot store: CREATE TABLE IF NOT EXISTS + single-line
 * statements), keyed by job + stage so stage-persisted output is
 * addressable and resumable. The killswitch lives in the existing
 * settings table under its own key — the same table the global
 * #756 halt reads, a different key, so either switch stops this
 * loop and neither aliases the other.
 *
 * State-write safety: the killswitch write is authoritative and
 * throws on failure; the audit call is best-effort (a failed audit
 * must never block an operator stop — it is logged, and the state
 * still changed). Reads fail closed to halted.
 */

import {
  ENRICHMENT_KILLSWITCH_KEY,
  parseKillswitchValue,
  summarizeEnrichmentQuality,
  type EnrichmentKillswitchState,
  type EnrichmentQualitySummary,
  type EnrichmentRunRecord,
  type EnrichmentRunStore,
} from "./enrichmentPorts";

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

/** In-memory store for tests and non-durable callers. */
export class InMemoryEnrichmentStore implements EnrichmentRunStore {
  private runs: EnrichmentRunRecord[] = [];
  private killswitch: EnrichmentKillswitchState = "clear";
  /** When true, reads throw → fail-closed to halted. Test seam. */
  unreadable = false;
  auditCalls: Array<{ type: string; agent: string; payload: Record<string, unknown> }> = [];

  recordRun(run: EnrichmentRunRecord): void {
    this.runs.push(run);
  }

  listRuns(limit = 20): EnrichmentRunRecord[] {
    return [...this.runs].reverse().slice(0, limit);
  }

  getRun(id: string): EnrichmentRunRecord | null {
    return this.runs.find((r) => r.id === id) ?? null;
  }

  qualitySummary(limit = 200): EnrichmentQualitySummary {
    return summarizeEnrichmentQuality(this.listRuns(limit));
  }

  getKillswitchState(): EnrichmentKillswitchState {
    if (this.unreadable) return "halted";
    return this.killswitch;
  }

  setKillswitch(
    state: EnrichmentKillswitchState,
    setBy: string,
    reason: string,
  ): EnrichmentKillswitchState {
    this.killswitch = state;
    this.auditCalls.push({
      type: "enrichment.killswitch",
      agent: "enrichment",
      payload: { state, setBy, reason },
    });
    return state;
  }
}
