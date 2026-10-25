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

export function ensureJobOutcomesTable(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS mas_job_outcomes (id TEXT PRIMARY KEY, kind TEXT, trigger TEXT, status TEXT, scanned INTEGER, matched INTEGER, coded_error TEXT, report_url TEXT, pdf_key TEXT, xlsx_key TEXT, csv_key TEXT, delivery_json TEXT, origin TEXT, created_at TEXT)");
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

export function listJobOutcomes(sql: SqlStorage, limit = 50): JobOutcomeRow[] {
  ensureJobOutcomesTable(sql);
  const rows = Array.from(
    sql.exec("SELECT * FROM mas_job_outcomes ORDER BY created_at DESC LIMIT ?", limit)
  ) as Array<Record<string, any>>;
  return rows.map(rowFromRecord);
}
