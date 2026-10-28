/**
 * Docs and Reports: the document index behind the nav page.
 *
 * The screener workflow persists one row per run in the Runs read surface
 * (GET /api/runs, src/services/runSummaries.ts) and records the artifacts
 * that run produced (PDF / XLSX / CSV keys → download urls). This module
 * turns those normalized RunSummary rows into the table model the page
 * renders: one row per document set, with the run's family (stock /
 * options / goal / strategy) and its trigger (manual / scheduled).
 *
 * Honesty rules, matching the Runs API:
 *  - A store that records no trigger yields `runType: null` (rendered as
 *    "—"), never a guessed "scheduled".
 *  - Only the four screener-workflow families are listed. Research
 *    reports and IV collection are different products with their own
 *    pages; they are filtered out rather than relabeled.
 *  - A missing artifact keeps a null url (rendered "—"), never a broken
 *    link to a key the run did not record.
 */

import type { RunSummary } from "../services/runSummaries";

/** The four screener-workflow run families the page lists. */
export type DocumentRunSource = "stock" | "options" | "goal" | "strategy";

/** How the run was started. `null` when the home store recorded no trigger. */
export type DocumentRunType = "manual" | "scheduled";

export interface DocumentRow {
  /** Stable row key (the RunSummary id — canonical report id or detail-store id). */
  id: string;
  runId: string;
  /** ISO timestamp of the run. */
  createdAt: string;
  /** Recorded trigger, normalized; null when the store records none. */
  runType: DocumentRunType | null;
  /** The recorded trigger verbatim (e.g. "manual-trigger"), for the tooltip. */
  rawTrigger: string | null;
  runSource: DocumentRunSource;
  title: string;
  status: string | null;
  pdfUrl: string | null;
  xlsxUrl: string | null;
  csvUrl: string | null;
}

const SOURCE_BY_KIND: Record<string, DocumentRunSource> = {
  screener: "stock",
  options_scanner: "options",
  goal: "goal",
  discovery: "strategy",
};

/**
 * Legacy/home-store source labels map onto the same four families, so a
 * detail-only row (kind "report") still lands in the right column when
 * its store names a family it belongs to.
 */
const SOURCE_BY_STORE_SOURCE: Record<string, DocumentRunSource> = {
  screener: "stock",
  options_scanner: "options",
  options_screen: "options",
  goal_screen: "goal",
  discovery: "strategy",
};

/** The explicit family a run records in its body (#2062). */
const RECORDED_SOURCES: Record<string, DocumentRunSource> = {
  stock: "stock",
  options: "options",
  goal: "goal",
  strategy: "strategy",
  screener: "stock",
  options_scanner: "options",
  options_screen: "options",
  goal_screen: "goal",
  discovery: "strategy",
};

export const DOCUMENT_SOURCE_LABELS: Record<DocumentRunSource, string> = {
  stock: "Stock",
  options: "Options",
  goal: "Goal",
  strategy: "Strategy",
};

/** The document family a run belongs to, or null when it is not a screener-workflow run. */
export function documentRunSource(
  run: Pick<RunSummary, "kind" | "source" | "runSource">,
): DocumentRunSource | null {
  // Issue #2062: the family recorded on the run wins; the kind/source
  // derivation stays as the fallback for rows written before the field.
  const recorded = typeof run.runSource === "string" ? RECORDED_SOURCES[run.runSource] : undefined;
  if (recorded) return recorded;
  const byKind = SOURCE_BY_KIND[run.kind];
  if (byKind) return byKind;
  return SOURCE_BY_STORE_SOURCE[run.source] ?? null;
}

/**
 * Normalizes a recorded trigger onto manual/scheduled. Unknown or absent
 * triggers stay null — the page says "—" instead of inventing a value.
 */
export function documentRunType(
  run: Pick<RunSummary, "trigger">,
): DocumentRunType | null {
  const trigger = (run.trigger ?? "").trim().toLowerCase();
  if (!trigger) return null;
  if (trigger.startsWith("manual")) return "manual";
  if (trigger.startsWith("schedul") || trigger === "cron") return "scheduled";
  return null;
}

/** Turns Runs-API rows into the document index, newest first. */
export function toDocumentRows(
  runs: Pick<
    RunSummary,
    "id" | "runId" | "createdAt" | "trigger" | "kind" | "source" | "runSource" | "title" | "status" | "reportUrl" | "xlsxUrl" | "csvUrl"
  >[],
): DocumentRow[] {
  const rows: DocumentRow[] = [];
  for (const run of runs) {
    const runSource = documentRunSource(run);
    if (!runSource) continue;
    const rawTrigger = (run.trigger ?? "").trim() || null;
    rows.push({
      id: String(run.id),
      runId: String(run.runId),
      createdAt: String(run.createdAt ?? ""),
      runType: documentRunType(run),
      rawTrigger,
      runSource,
      title: String(run.title ?? ""),
      status: run.status ?? null,
      pdfUrl: run.reportUrl ?? null,
      xlsxUrl: run.xlsxUrl ?? null,
      csvUrl: run.csvUrl ?? null,
    });
  }
  rows.sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
  return rows;
}

/** Format an ISO timestamp for the table; invalid values render the raw string. */
export function formatRunTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
