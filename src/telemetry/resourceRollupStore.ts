/**
 * D1 rollup/alert/report store for the #1819 ScheduledAgent goals.
 *
 * Tables are created idempotently by this module (same deliberate choice
 * as the D1 resource adapter: no shared migration-runner coupling).
 *
 * - resource_daily_rollups: one row per (day, ns, op, caller, trigger),
 *   written by the daily rollup goal, replaced idempotently on re-run
 *   (INSERT OR REPLACE), so a forced re-evaluation reproduces the
 *   scheduled run exactly.
 * - resource_alert_state: one row per (budget, day), written when a
 *   breach is first delivered (or first found undeliverable). This is
 *   the alert dedup: the hourly goal never stamps lastRun (isDue's 23h
 *   guard would otherwise suppress hourly evaluation), so dedup must
 *   live here, not in goal state.
 * - resource_comparison_reports: one row per day, the comparison report
 *   JSON for the latest completed rollup day.
 *
 * Goal-path errors THROW (unlike the per-op record path, which never
 * throws): a failing goal must stay due and surface a tick error, not
 * silently certify an empty rollup.
 */
import type { ResourceD1Db } from "./d1ResourceUsageAdapter";
import type { DailyRollupRow } from "./resourceRollup";

export type { ResourceD1Db };

const CREATE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS resource_daily_rollups (
    day TEXT NOT NULL,
    ns TEXT NOT NULL,
    op TEXT NOT NULL,
    caller TEXT NOT NULL,
    trigger TEXT NOT NULL,
    ops INTEGER NOT NULL,
    rows_read INTEGER NOT NULL,
    rows_written INTEGER NOT NULL,
    PRIMARY KEY (day, ns, op, caller, trigger)
  )`,
  `CREATE TABLE IF NOT EXISTS resource_alert_state (
    budget TEXT NOT NULL,
    day TEXT NOT NULL,
    alerted_at INTEGER NOT NULL,
    delivered INTEGER NOT NULL,
    note TEXT,
    PRIMARY KEY (budget, day)
  )`,
  `CREATE TABLE IF NOT EXISTS resource_comparison_reports (
    day TEXT PRIMARY KEY,
    generated_at INTEGER NOT NULL,
    report_json TEXT NOT NULL
  )`,
];

export async function ensureResourceRollupTables(db: ResourceD1Db): Promise<void> {
  for (const sql of CREATE_TABLES_SQL) {
    await db.prepare(sql).bind().run();
  }
}

export async function writeDailyRollup(
  db: ResourceD1Db,
  day: string,
  rows: readonly DailyRollupRow[]
): Promise<void> {
  for (const row of rows) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO resource_daily_rollups
         (day, ns, op, caller, trigger, ops, rows_read, rows_written)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(row.day, row.ns, row.op, row.caller, row.trigger, row.ops, row.rowsRead, row.rowsWritten)
      .run();
  }
}

export async function readDailyRollup(db: ResourceD1Db, day: string): Promise<DailyRollupRow[]> {
  const result = await db
    .prepare(
      `SELECT day, ns, op, caller, trigger, ops, rows_read, rows_written
       FROM resource_daily_rollups WHERE day = ? ORDER BY ns, op, caller, trigger`
    )
    .bind(day)
    .all();
  return (result.results as Array<Record<string, unknown>>).map((r) => ({
    day: String(r.day),
    ns: String(r.ns),
    op: String(r.op),
    caller: String(r.caller),
    trigger: String(r.trigger),
    ops: Number(r.ops),
    rowsRead: Number(r.rows_read),
    rowsWritten: Number(r.rows_written),
  }));
}

/** Latest day with any rollup row, or null before the first rollup lands. */
export async function latestCompletedRollupDay(db: ResourceD1Db): Promise<string | null> {
  const result = await db
    .prepare(`SELECT MAX(day) AS day FROM resource_daily_rollups`)
    .bind()
    .all();
  const day = (result.results[0] as { day?: unknown } | undefined)?.day;
  return typeof day === "string" ? day : null;
}

export interface AlertState {
  budget: string;
  day: string;
  alerted_at: number;
  delivered: number;
  note: string | null;
}

export async function getAlertState(
  db: ResourceD1Db,
  budget: string,
  day: string
): Promise<AlertState | null> {
  const result = await db
    .prepare(
      `SELECT budget, day, alerted_at, delivered, note FROM resource_alert_state
       WHERE budget = ? AND day = ?`
    )
    .bind(budget, day)
    .all();
  const row = result.results[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    budget: String(row.budget),
    day: String(row.day),
    alerted_at: Number(row.alerted_at),
    delivered: Number(row.delivered),
    note: row.note == null ? null : String(row.note),
  };
}

export async function markAlerted(
  db: ResourceD1Db,
  budget: string,
  day: string,
  delivered: boolean,
  note: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO resource_alert_state
       (budget, day, alerted_at, delivered, note) VALUES (?, ?, ?, ?, ?)`
    )
    .bind(budget, day, Date.now(), delivered ? 1 : 0, note)
    .run();
}

export async function writeComparisonReport(
  db: ResourceD1Db,
  day: string,
  report: unknown
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO resource_comparison_reports
       (day, generated_at, report_json) VALUES (?, ?, ?)`
    )
    .bind(day, Date.now(), JSON.stringify(report))
    .run();
}

export async function readComparisonReport(db: ResourceD1Db, day: string): Promise<unknown | null> {
  const result = await db
    .prepare(`SELECT report_json FROM resource_comparison_reports WHERE day = ?`)
    .bind(day)
    .all();
  const row = result.results[0] as { report_json?: unknown } | undefined;
  if (!row || typeof row.report_json !== "string") return null;
  return JSON.parse(row.report_json) as unknown;
}
