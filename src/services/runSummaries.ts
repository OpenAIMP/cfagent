/**
 * Issue #1057 (consolidation S5): the ONE run-summary shape for the
 * Runs read surface (GET /api/runs), and the normalizers that map each
 * of the four run stores into it. This module is the single definition
 * site for the shape — the route merges, the client renders, neither
 * redefines it.
 *
 * The four stores (survey D9):
 *  - mas_reports — the canonical store (scheduledReports hits). Rows
 *    whose source is a screening kind map to that kind; the remaining
 *    canonical sources (research_report, iv_collection, …) map to
 *    kind "report" so nothing ReportsPanel shows today disappears.
 *  - mas_opportunity_scans (ScanRunSummary) — options scans.
 *  - mas_discovery_runs (DiscoveryRunSummary) — scheduled discovery.
 *  - the ScreenerAgent latest/history feed (ScreenerRunResult) —
 *    stock screens as the agent itself recorded them.
 *
 * Honesty rule: a field a store does not record is null, never
 * invented (scan runs have no status; canonical rows have no status
 * unless their body records success/failure).
 *
 * De-duplication (mergeRunSummaries): a run stored twice — once in a
 * detail store, once canonically — appears ONCE, as the canonical
 * row. The joins are exact, never heuristic:
 *  - options scans: the canonical options_scanner body's embedded
 *    scan-run id (body.report.result.scanRunId, stamped by
 *    UnifiedOptionsService when it persists the run) equals the scan
 *    store's run id.
 *  - stock screens: the canonical screener row's runId is
 *    `screener:<timestamp>` (the persistScreenerReportCanonical /
 *    scheduled-callback generation id) and its createdAt is the feed
 *    run's timestamp.
 *  - discovery runs (consolidation C4, #1329): the canonical
 *    discovery body's body.discoveryRunId (stamped by the discovery
 *    store stage) equals the discovery store's run id.
 * A detail row with no canonical twin survives as its own row.
 */

import type { ScheduledReportHit } from "./scheduledReports";
import { scheduledReportPdfUrl } from "./scheduledReports";
// Via the src/trading barrel — the #290 boundary's sole public surface.
import type { ScanRunSummary, DiscoveryRunSummary, OptionsPartialQualification } from "../trading";
import type { ScreenerRunResult } from "../agents/screener-agent";

export type RunKind = "screener" | "options_scanner" | "discovery" | "goal" | "report";

export interface RunSummary {
  kind: RunKind;
  /** Row identity in the merged list: the canonical report id when the
   *  run is backed by mas_reports, else the detail-store run id (for
   *  screener-feed runs, the `screener:<timestamp>` generation id). */
  id: string;
  /** The run's own id in its home store (mas_reports run_id, scan id,
   *  discovery id, or `screener:<timestamp>`). */
  runId: string;
  title: string;
  summary: string;
  /** The recorded trigger ("manual" / "scheduled" / "manual-trigger" /
   *  a canonical body's trigger), or null when the store records none. */
  trigger: string | null;
  createdAt: string;
  /** "completed" / "failed" / the discovery store's status verbatim,
   *  or null when the store records no status. */
  status: string | null;
  /** The store's own headline count (matched / with-trades / evaluated
   *  / completed), or null when it records none. */
  resultCount: number | null;
  /** Issue #1850: the scan's partial-coverage qualification, when the
   *  run did not evaluate the full requested universe — carried
   *  through for scan-store rows so the list can say so. Null when
   *  the run evaluated completely or the home store records none
   *  (canonical rows: the qualification, when present, rides in the
   *  summary text instead). */
  partial?: OptionsPartialQualification | null;
  pdfKey: string | null;
  reportUrl: string | null;
  /** Issue #1335: stored XLSX / CSV artifact keys + download urls, when
   *  the home store records them (goal-screen rows record all three;
   *  other rows null until their pipelines record keys). */
  xlsxKey: string | null;
  xlsxUrl: string | null;
  csvKey: string | null;
  csvUrl: string | null;
  /** Issue #1239 (#1209 F3): the run's recorded PDF generation state
   *  ("generated" / "failed" / …) and its failure reason, when the
   *  home store records them — so the Reports list can say a PDF is
   *  unavailable instead of silently showing no link. */
  pdfStatus: string | null;
  pdfError: string | null;
  /** The canonical mas_reports id when this run has a canonical row
   *  (the detail/download affordance key), else null. */
  reportId: string | null;
  /** The mas_opportunity_scans run id this row corresponds to, when
   *  known: a canonical options row carries the id its body links to
   *  (the exact de-duplication join); a scan-store row carries its own
   *  id; every other row null. */
  scanRunId: string | null;
  /** Consolidation C4 (#1329): the mas_discovery_runs run id this row
   *  corresponds to, when known — the discovery twin of scanRunId. A
   *  canonical discovery row carries the id its body links to
   *  (body.discoveryRunId, stamped by the discovery store stage); a
   *  discovery-store row carries its own id; every other row null.
   *  Optional so pre-C4 literals still typecheck. */
  discoveryRunId?: string | null;
  /** Display source: the mas_reports source for canonical rows;
   *  "options_scanner" / "discovery" / "screener" for detail-only rows. */
  source: string;
}

function parseBody(body: unknown): Record<string, any> {
  try {
    const parsed = typeof body === "string" ? JSON.parse(body || "{}") : body;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** The scan-run id a canonical options_scanner body links to, if any —
 *  the exact de-duplication join for the scan store. */
export function canonicalScanRunId(body: unknown): string | null {
  const parsed = parseBody(body);
  return (
    strOrNull(parsed?.report?.result?.scanRunId) ??
    strOrNull(parsed?.result?.scanRunId) ??
    strOrNull(parsed?.scanRunId)
  );
}

const KIND_BY_REPORT_SOURCE: Record<string, RunKind> = {
  screener: "screener",
  options_scanner: "options_scanner",
  options_screen: "options_scanner",
  // Consolidation C4 (#1329): discovery runs store canonical reports
  // now (source "discovery"), so their canonical rows map to kind
  // "discovery" instead of falling through to "report".
  discovery: "discovery",
  // Consolidation C5 (#1361): goal-screen canonical rows get their own
  // kind (C4 limitation: they surfaced under "report" because the Runs
  // shape had no goal kind). The Reports panel filters goal_screen
  // client-side by source, so no client change is needed.
  goal_screen: "goal",
};

function xlsxUrlForSource(source: string, key: string): string | null {
  if (source === "screener") return `/api/screener/report.xlsx?key=${encodeURIComponent(key)}`;
  if (source === "options_scanner" || source === "options_screen")
    return `/api/options/report.xlsx?key=${encodeURIComponent(key)}`;
  if (source === "goal_screen")
    return `/api/screening/goal-screen/report.xlsx?key=${encodeURIComponent(key)}`;
  return null;
}

/** Issue #1346: mirrors xlsxUrlForSource for the stored CSV artifact. */
function csvUrlForSource(source: string, key: string): string | null {
  if (source === "screener") return `/api/screener/report.csv?key=${encodeURIComponent(key)}`;
  if (source === "options_scanner" || source === "options_screen")
    return `/api/options/report.csv?key=${encodeURIComponent(key)}`;
  if (source === "goal_screen")
    return `/api/screening/goal-screen/report.csv?key=${encodeURIComponent(key)}`;
  return null;
}

function statusFromResultStatus(v: unknown): string | null {
  if (v === "complete") return "completed";
  if (v === "partial") return "partial";
  if (v === "failed") return "failed";
  return null;
}

/** The discovery-run id a canonical discovery body links to, if any —
 *  the exact de-duplication join for the discovery store. */
export function canonicalDiscoveryRunId(body: unknown): string | null {
  const parsed = parseBody(body);
  return strOrNull(parsed?.discoveryRunId);
}

export function runSummaryFromReport(hit: ScheduledReportHit): RunSummary {
  const body = parseBody(hit.body);
  const kind = KIND_BY_REPORT_SOURCE[hit.source] ?? "report";
  const success = body?.success;
  let resultCount: number | null = null;
  if (kind === "screener") {
    resultCount = numOrNull(body?.matchedCount) ?? numOrNull(body?.report?.matchedCount);
  } else if (kind === "options_scanner") {
    resultCount =
      numOrNull(body?.withTrades) ??
      numOrNull(body?.report?.result?.withTrades) ??
      (Array.isArray(body?.opportunities) ? body.opportunities.length : null);
  }
  return {
    kind,
    id: hit.id,
    runId: hit.runId,
    title: hit.title,
    summary: hit.summary,
    trigger: strOrNull(body?.trigger),
    createdAt: hit.createdAt,
    status:
      success === true
        ? "completed"
        : success === false
          ? "failed"
          : // Issue #1335: goal-screen bodies carry no `success` — the
            // result's own status verb is the status.
            (statusFromResultStatus(body?.result?.status) ??
            statusFromResultStatus(body?.report?.result?.status)),
    resultCount,
    pdfKey: strOrNull(body?.pdfKey) ?? strOrNull(body?.report?.result?.pdfKey),
    reportUrl: scheduledReportPdfUrl(hit.source, hit.body) ?? null,
    xlsxKey: strOrNull(body?.xlsxKey) ?? strOrNull(body?.report?.result?.xlsxKey),
    xlsxUrl: (() => {
      const k = strOrNull(body?.xlsxKey) ?? strOrNull(body?.report?.result?.xlsxKey);
      return k ? xlsxUrlForSource(hit.source, k) : null;
    })(),
    csvKey: strOrNull(body?.csvKey) ?? strOrNull(body?.report?.result?.csvKey),
    csvUrl: (() => {
      const k = strOrNull(body?.csvKey) ?? strOrNull(body?.report?.result?.csvKey);
      return k ? csvUrlForSource(hit.source, k) : null;
    })(),
    pdfStatus:
      strOrNull(body?.pdfStatus) ??
      strOrNull(body?.report?.result?.pdfStatus) ??
      strOrNull(body?.result?.pdfStatus),
    pdfError:
      strOrNull(body?.pdfError) ??
      strOrNull(body?.report?.result?.pdfError) ??
      strOrNull(body?.result?.pdfError),
    reportId: hit.id,
    scanRunId: kind === "options_scanner" ? canonicalScanRunId(hit.body) : null,
    discoveryRunId: kind === "discovery" ? canonicalDiscoveryRunId(hit.body) : null,
    source: hit.source,
  };
}

export function runSummaryFromScanRun(scan: ScanRunSummary): RunSummary {
  const gate = scan.gate;
  const evaluated = numOrNull(scan.coverage?.evaluated);
  const partial = scan.partial ?? null;
  return {
    kind: "options_scanner",
    id: scan.id,
    runId: scan.id,
    title: scan.profileRef?.name
      ? `Options scan — ${scan.mode} (${scan.profileRef.name})`
      : `Options scan — ${scan.mode}`,
    summary:
      `Gate: ${gate?.fit ?? 0} fit, ${gate?.borderline ?? 0} borderline, ${gate?.noFit ?? 0} no fit` +
      (evaluated !== null ? ` across ${evaluated} evaluated.` : ".") +
      // Issue #1850: the same partial segment the service summary
      // appends (R6), so a partial scan-store row reads exactly like
      // a partial canonical row in the same list.
      (partial
        ? ` Partial coverage — qualified partial results: evaluated ${partial.evaluatedCount} of ${partial.consideredCount} underlyings (${partial.coverageErrors} failures, ${partial.truncatedCount} truncated).`
        : ""),
    trigger: null,
    createdAt: scan.generatedAt,
    status: null,
    resultCount: evaluated,
    partial,
    pdfKey: scan.pdfKey ?? null,
    reportUrl: scan.pdfKey
      ? `/api/options/report.pdf?key=${encodeURIComponent(scan.pdfKey)}`
      : null,
    xlsxKey: null,
    xlsxUrl: null,
    csvKey: null,
    csvUrl: null,
    pdfStatus: scan.pdfKey ? "generated" : null,
    pdfError: null,
    reportId: null,
    scanRunId: scan.id,
    source: "options_scanner",
  };
}

export function runSummaryFromDiscoveryRun(run: DiscoveryRunSummary): RunSummary {
  return {
    kind: "discovery",
    id: run.id,
    runId: run.id,
    title: `Strategy discovery — ${run.inputModel}`,
    summary:
      `${run.completedCount} completed, ${run.failedCount} failed, ${run.abstainedCount} abstained` +
      ` across ${run.symbols.length} symbols.`,
    trigger: run.trigger,
    createdAt: run.createdAt,
    status: run.status,
    resultCount: run.completedCount,
    pdfKey: null,
    reportUrl: null,
    xlsxKey: null,
    xlsxUrl: null,
    csvKey: null,
    csvUrl: null,
    pdfStatus: null,
    pdfError: null,
    reportId: null,
    scanRunId: null,
    discoveryRunId: run.id,
    source: "discovery",
  };
}

export function runSummaryFromScreenerRun(run: ScreenerRunResult): RunSummary {
  const runId = `screener:${run.timestamp}`;
  return {
    kind: "screener",
    id: runId,
    runId,
    title: `Market screen — ${run.universe ?? run.sector ?? "ALL"}`,
    summary: run.success
      ? `Scanned ${run.totalScanned} symbols, ${run.matchedCount} matched, ${run.opportunities?.length ?? 0} opportunities.`
      : `Screen failed: ${run.error ?? "unknown error"}.`,
    trigger: run.trigger ?? null,
    createdAt: run.timestamp,
    status: run.success ? "completed" : "failed",
    resultCount: numOrNull(run.matchedCount),
    pdfKey: run.pdfKey ?? null,
    reportUrl: run.pdfKey
      ? `/api/screener/report.pdf?key=${encodeURIComponent(run.pdfKey)}`
      : null,
    xlsxKey: run.xlsxKey ?? null,
    xlsxUrl: run.xlsxKey
      ? `/api/screener/report.xlsx?key=${encodeURIComponent(run.xlsxKey)}`
      : null,
    csvKey: run.csvKey ?? null,
    csvUrl: run.csvKey
      ? `/api/screener/report.csv?key=${encodeURIComponent(run.csvKey)}`
      : null,
    pdfStatus: run.pdfStatus ?? null,
    pdfError: run.pdfError ?? null,
    reportId: null,
    scanRunId: null,
    source: "screener",
  };
}

/**
 * Merge per-store summary lists into one newest-first list,
 * de-duplicated on the exact joins documented above (the canonical
 * row wins), then sliced to `limit`. Ties break by id descending so
 * the order is deterministic across stores.
 */
export function mergeRunSummaries(lists: RunSummary[][], limit: number): RunSummary[] {
  const canonicalScanIds = new Set<string>();
  const canonicalScreenerRunIds = new Set<string>();
  // Consolidation C4 (#1329): the discovery twin of the scan join —
  // canonical discovery rows link their detail run via
  // body.discoveryRunId (see canonicalDiscoveryRunId).
  const canonicalDiscoveryIds = new Set<string>();
  // Issue #1239 (#1209 F3): the detail-store twins a canonical row is
  // about to absorb, keyed by the same exact joins — the winner
  // inherits any PDF facts it lacks from the twin it drops.
  const scanTwins = new Map<string, RunSummary>();
  const screenerTwins = new Map<string, RunSummary>();
  const discoveryTwins = new Map<string, RunSummary>();
  for (const list of lists) {
    for (const row of list) {
      if (row.reportId === null) {
        if (row.kind === "options_scanner") scanTwins.set(row.id, row);
        if (row.kind === "screener") screenerTwins.set(row.runId, row);
        if (row.kind === "discovery" && row.discoveryRunId) discoveryTwins.set(row.discoveryRunId, row);
        continue;
      }
      if (row.kind === "options_scanner" && row.scanRunId) canonicalScanIds.add(row.scanRunId);
      if (row.kind === "screener") canonicalScreenerRunIds.add(row.runId);
      if (row.kind === "discovery" && row.discoveryRunId) canonicalDiscoveryIds.add(row.discoveryRunId);
    }
  }
  const seen = new Set<string>();
  const merged: RunSummary[] = [];
  for (const list of lists) {
    for (const row of list) {
      if (row.reportId === null && row.kind === "options_scanner" && canonicalScanIds.has(row.id)) {
        continue; // the canonical twin wins
      }
      if (row.reportId === null && row.kind === "screener" && canonicalScreenerRunIds.has(row.runId)) {
        continue; // the canonical twin wins
      }
      if (row.reportId === null && row.kind === "discovery" && row.discoveryRunId && canonicalDiscoveryIds.has(row.discoveryRunId)) {
        continue; // the canonical twin wins
      }
      const key = `${row.kind}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (row.reportId !== null) {
        const twin = row.kind === "options_scanner" && row.scanRunId
          ? scanTwins.get(row.scanRunId)
          : row.kind === "screener"
            ? screenerTwins.get(row.runId)
            : row.kind === "discovery" && row.discoveryRunId
              ? discoveryTwins.get(row.discoveryRunId)
              : undefined;
        if (twin) {
          // The status/error describe ONE artifact: they inherit only
          // when they belong to the winner's key — i.e. the key itself
          // was inherited, or both rows name the same key. A twin
          // pointing at a DIFFERENT artifact never rewrites the
          // winner's story.
          const sameArtifact = row.pdfKey === null || twin.pdfKey === row.pdfKey;
          merged.push({
            ...row,
            pdfKey: row.pdfKey ?? twin.pdfKey,
            reportUrl: row.reportUrl ?? twin.reportUrl,
            pdfStatus: row.pdfStatus ?? (sameArtifact ? twin.pdfStatus : null),
            pdfError: row.pdfError ?? (sameArtifact ? twin.pdfError : null),
          });
          continue;
        }
      }
      merged.push(row);
    }
  }
  merged.sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
  return merged.slice(0, Math.max(0, limit));
}
