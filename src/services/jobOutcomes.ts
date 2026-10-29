/**
 * Issue #1333 (job-truth program #1332): the one outcome-event sink
 * for every job producer. A JobOutcome is the uniform shape — job id,
 * kind, trigger, status, counts, coded error, artifact links, delivery
 * states, origin — emitted by the job-tree hook, the bus subscriber,
 * goal-screen, discovery, and manual paths, and rendered by Autopilot
 * Control as its job feed (labeled by origin).
 *
 * Storage is the mas_job_outcomes table, created lazily here (not in
 * orchestrator.ts, honoring its byte budget). Upsert is by stable id:
 * the run's deliveryId when one exists (shared by the tree hook and
 * the bus subscriber, so a run recorded twice converges to one row),
 * otherwise a caller-supplied run key. Re-records MERGE: defined
 * scalar fields win, undefined never wipes an existing value,
 * delivery states merge key-wise, and a completed/partial re-record
 * without a coded error clears a stale one (errors belong to failed
 * outcomes). All statements are single-line: the shared MockSqlStorage
 * INSERT regex has no dotAll flag.
 */

import type { SqlStorage } from "../orm";

export type JobOutcomeKind = "stock" | "options" | "goal" | "discovery";
export type JobOutcomeTrigger = "manual" | "scheduled";
export type JobOutcomeStatus = "completed" | "failed" | "partial";

export interface JobOutcomeInput {
  id: string;
  kind: JobOutcomeKind;
  trigger: JobOutcomeTrigger;
  status: JobOutcomeStatus;
  scanned?: number;
  matched?: number;
  codedError?: string;
  reportUrl?: string;
  pdfKey?: string;
  xlsxKey?: string;
  csvKey?: string;
  deliveryStates?: Record<string, string>;
  origin: string;
  createdAt?: string;
}

export interface JobOutcomeRow {
  id: string;
  kind: JobOutcomeKind;
  trigger: JobOutcomeTrigger;
  status: JobOutcomeStatus;
  scanned: number | null;
  matched: number | null;
  codedError: string | null;
  reportUrl: string | null;
  pdfKey: string | null;
  xlsxKey: string | null;
  csvKey: string | null;
  deliveryStates: Record<string, string>;
  origin: string;
  createdAt: string;
}

/** Default age window for outcome rows; older history has no reader. */
export const JOB_OUTCOMES_RETENTION_DEFAULT_DAYS = 90;
/** Hard row cap per instance; the feed only reads the newest 50. */
export const JOB_OUTCOMES_KEEP_ROWS = 500;

export function ensureJobOutcomesTable(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS mas_job_outcomes (id TEXT PRIMARY KEY, kind TEXT, trigger TEXT, status TEXT, scanned INTEGER, matched INTEGER, coded_error TEXT, report_url TEXT, pdf_key TEXT, xlsx_key TEXT, csv_key TEXT, delivery_json TEXT, origin TEXT, created_at TEXT)");
  // The feed orders by created_at and the prune filters on it; without this
  // index every list call scans the whole table (see #2280).
  sql.exec("CREATE INDEX IF NOT EXISTS idx_mas_job_outcomes_created ON mas_job_outcomes(created_at DESC)");
}

function rowFromRecord(r: Record<string, any>): JobOutcomeRow {
  let deliveryStates: Record<string, string> = {};
  try {
    deliveryStates = r.delivery_json ? JSON.parse(String(r.delivery_json)) : {};
  } catch {
    deliveryStates = {};
  }
  return {
    id: String(r.id),
    kind: r.kind,
    trigger: r.trigger,
    status: r.status,
    scanned: r.scanned ?? null,
    matched: r.matched ?? null,
    codedError: r.coded_error ?? null,
    reportUrl: r.report_url ?? null,
    pdfKey: r.pdf_key ?? null,
    xlsxKey: r.xlsx_key ?? null,
    csvKey: r.csv_key ?? null,
    deliveryStates,
    origin: r.origin,
    createdAt: r.created_at,
  };
}

export function recordJobOutcome(sql: SqlStorage, input: JobOutcomeInput): JobOutcomeRow {
  ensureJobOutcomesTable(sql);
  const now = new Date().toISOString();
  const existing = Array.from(
    sql.exec("SELECT * FROM mas_job_outcomes WHERE id = ?", input.id)
  )[0] as Record<string, any> | undefined;
  const prev = existing ? rowFromRecord(existing) : undefined;
  const merged: JobOutcomeRow = {
    id: input.id,
    kind: input.kind,
    trigger: input.trigger,
    status: input.status,
    scanned: input.scanned ?? prev?.scanned ?? null,
    matched: input.matched ?? prev?.matched ?? null,
    codedError:
      input.codedError ?? (input.status === "completed" || input.status === "partial" ? null : prev?.codedError ?? null),
    reportUrl: input.reportUrl ?? prev?.reportUrl ?? null,
    pdfKey: input.pdfKey ?? prev?.pdfKey ?? null,
    xlsxKey: input.xlsxKey ?? prev?.xlsxKey ?? null,
    csvKey: input.csvKey ?? prev?.csvKey ?? null,
    deliveryStates: { ...(prev?.deliveryStates ?? {}), ...(input.deliveryStates ?? {}) },
    origin: input.origin,
    createdAt: input.createdAt ?? prev?.createdAt ?? now,
  };
  sql.exec(
    "INSERT OR REPLACE INTO mas_job_outcomes (id, kind, trigger, status, scanned, matched, coded_error, report_url, pdf_key, xlsx_key, csv_key, delivery_json, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    merged.id,
    merged.kind,
    merged.trigger,
    merged.status,
    merged.scanned,
    merged.matched,
    merged.codedError,
    merged.reportUrl,
    merged.pdfKey,
    merged.xlsxKey,
    merged.csvKey,
    JSON.stringify(merged.deliveryStates),
    merged.origin,
    merged.createdAt
  );
  return merged;
}

/** The nightly pass reaches only the shared agent; each per-user agent
 * bounds itself on first use instead (see maybePruneJobOutcomes). */
export const JOB_OUTCOMES_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface PruneJobOutcomesOptions {
  /** Age window; <= 0 disables the age prune (the row cap still applies). */
  retentionDays?: number | string | null;
  /** Rows kept regardless of age. Defaults to JOB_OUTCOMES_KEEP_ROWS. */
  keepRows?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface PruneJobOutcomesResult {
  deletedByAge: number;
  deletedByCap: number;
}

function resolveDays(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : JOB_OUTCOMES_RETENTION_DEFAULT_DAYS;
}

function countOutcomes(sql: SqlStorage): number {
  const rows = Array.from(
    sql.exec("SELECT COUNT(*) AS count FROM mas_job_outcomes")
  ) as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Bound the outcome feed. Two independent rules, both reported:
 *  - age: delete rows older than the window (default 90 days);
 *  - cap: keep only the newest `keepRows` (default 500) regardless of age.
 * Readers only ever use the newest 50 plus a point read by id, so older rows
 * are history nothing reads — and, unindexed, they were the whole table's
 * scan cost on every list (#2280).
 */
export function pruneJobOutcomes(
  sql: SqlStorage,
  options: PruneJobOutcomesOptions = {}
): PruneJobOutcomesResult {
  ensureJobOutcomesTable(sql);
  const days = resolveDays(options.retentionDays);
  const keep = Math.max(1, Math.floor(options.keepRows ?? JOB_OUTCOMES_KEEP_ROWS));
  let deletedByAge = 0;

  if (days > 0) {
    const cutoff = new Date((options.now?.() ?? Date.now()) - days * 86_400_000).toISOString();
    const before = countOutcomes(sql);
    sql.exec("DELETE FROM mas_job_outcomes WHERE created_at < ?", cutoff);
    deletedByAge = Math.max(0, before - countOutcomes(sql));
  }

  const total = countOutcomes(sql);
  let deletedByCap = 0;
  if (total > keep) {
    const ids = Array.from(
      sql.exec(
        "SELECT id FROM mas_job_outcomes ORDER BY created_at ASC LIMIT ?",
        total - keep
      )
    ) as Array<{ id: string }>;
    for (const row of ids) {
      sql.exec("DELETE FROM mas_job_outcomes WHERE id = ?", row.id);
      deletedByCap += 1;
    }
  }

  return { deletedByAge, deletedByCap };
}

/**
 * Bound the table from inside the instance that owns it.
 *
 * The 0 4 * * * retention dispatch fires on the shared Orchestrator instance
 * only; the per-user agents that hold most of this history never receive it.
 * A durable per-instance timestamp keeps the prune to once a day, so the
 * first feed read of the day pays for it and every later read does not.
 */
export function maybePruneJobOutcomes(sql: SqlStorage, nowMs: number = Date.now()): boolean {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS mas_job_outcomes_meta (k TEXT PRIMARY KEY, v TEXT)"
  );
  const existing = Array.from(
    sql.exec("SELECT v FROM mas_job_outcomes_meta WHERE k = 'pruned_at'")
  ) as Array<{ v: string }>;
  const last = existing[0] ? Date.parse(existing[0].v) : Number.NaN;
  if (Number.isFinite(last) && nowMs - last < JOB_OUTCOMES_PRUNE_INTERVAL_MS) {
    return false;
  }
  try {
    pruneJobOutcomes(sql, { now: () => nowMs });
  } catch (err) {
    console.warn(
      "[job-outcomes] prune failed:",
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
  sql.exec(
    "INSERT OR REPLACE INTO mas_job_outcomes_meta (k, v) VALUES ('pruned_at', ?)",
    new Date(nowMs).toISOString()
  );
  return true;
}

export function listJobOutcomes(sql: SqlStorage, limit = 50): JobOutcomeRow[] {
  ensureJobOutcomesTable(sql);
  maybePruneJobOutcomes(sql);
  const rows = Array.from(
    sql.exec("SELECT * FROM mas_job_outcomes ORDER BY created_at DESC LIMIT ?", limit)
  ) as Array<Record<string, any>>;
  return rows.map(rowFromRecord);
}
