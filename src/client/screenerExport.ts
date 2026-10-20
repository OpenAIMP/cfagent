/**
 * Issue #125 (PR-B) / issue #126: result-set downloads for a market
 * screen run. The ScreenerResultsView offered only the per-run PDF
 * report; #126's matrix requires the RESULT SET itself downloadable
 * from the UI surface as a file. These serializers produce, for the
 * run being viewed:
 *
 *  - CSV of the standout/opportunities rows (columns mirror the
 *    fields ScreenerResultsView's standouts table displays);
 *  - CSV of the full scanned set (allStocks; columns mirror the
 *    view's all-screened table);
 *  - JSON of the full run result object, exactly as stored.
 *
 * Pure functions (unit-tested); the Blob download follows the repo's
 * client-side precedents (AsyncJobsPanel, optionsIdeasExport.ts).
 *
 * Partial runs (#462 qualification) keep their qualification visible
 * in the file: CSVs carry leading `#` metadata lines — including a
 * PARTIAL line naming the quoted/requested counts — and the JSON is
 * the untouched run object, partial marker included.
 */

import type { ScreenerResultData } from "./ScreenerResultsView";

export type ScreenExportKind = "standouts" | "all-stocks" | "run-json";

type StandoutRow = ScreenerResultData["opportunities"][number];
type ScannedRow = NonNullable<ScreenerResultData["allStocks"]>[number];

// Columns mirror the view's standouts table (Symbol, Company,
// Sentiment, Score, Quant, Val, Mom, Price, Change, Gap, Range,
// Value) — nothing the view does not show, nothing invented.
const STANDOUT_COLUMNS: Array<{ header: string; value: (row: StandoutRow) => unknown }> = [
  { header: "symbol", value: (r) => r.symbol },
  { header: "company", value: (r) => r.companyName },
  { header: "sentiment", value: (r) => r.indicators?.sentiment },
  { header: "screenScore", value: (r) => r.indicators?.screenScore },
  { header: "quantRating", value: (r) => r.factorGrades?.quantRating },
  { header: "valueGrade", value: (r) => r.factorGrades?.value },
  { header: "momentumGrade", value: (r) => r.factorGrades?.momentum },
  { header: "lastPrice", value: (r) => r.lastPrice },
  { header: "changePercent", value: (r) => r.changePercent },
  { header: "gapPercent", value: (r) => r.technicals?.gapPercent },
  { header: "rangeZone", value: (r) => r.indicators?.rangeZone },
  { header: "valueZone", value: (r) => r.indicators?.valueZone },
];

// Columns mirror the view's all-screened table (Symbol, Company,
// Price, Change, Gap, Sentiment, Score, Quant, Val, Mom, Momentum,
// Range, Value, RSI(14), MACD, Source).
const ALL_STOCKS_COLUMNS: Array<{ header: string; value: (row: ScannedRow) => unknown }> = [
  { header: "symbol", value: (r) => r.symbol },
  { header: "company", value: (r) => r.companyName },
  { header: "lastPrice", value: (r) => r.lastPrice },
  { header: "changePercent", value: (r) => r.changePercent },
  { header: "gapPercent", value: (r) => r.technicals?.gapPercent },
  { header: "sentiment", value: (r) => r.indicators?.sentiment },
  { header: "screenScore", value: (r) => r.indicators?.screenScore },
  { header: "quantRating", value: (r) => r.factorGrades?.quantRating },
  { header: "valueGrade", value: (r) => r.factorGrades?.value },
  { header: "momentumGrade", value: (r) => r.factorGrades?.momentum },
  { header: "momentumScore", value: (r) => r.momentumScore },
  { header: "rangeZone", value: (r) => r.indicators?.rangeZone },
  { header: "valueZone", value: (r) => r.indicators?.valueZone },
  { header: "rsi14", value: (r) => r.rsi14 },
  { header: "macdHistogram", value: (r) => r.technicals?.macdHistogram },
  { header: "source", value: (r) => r.source },
];

/** RFC 4180 escaping: quote when the field carries a comma, quote, or line break; double internal quotes. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvHeaderLines(run: ScreenerResultData, setLabel: string): string[] {
  const lines = [
    `# cfagent market screen results — ${setLabel}`,
    // Issue #421 convention: no sector claim when none was selected ("ALL").
    `# run: ${run.timestamp} · trigger: ${run.trigger}` +
      (run.sector && run.sector !== "ALL" ? ` · sector: ${run.sector}` : ""),
    `# scanned: ${run.totalScanned} · matched: ${run.matchedCount} · standouts: ${run.opportunities.length}`,
  ];
  if (run.partial) {
    const reasons = Object.entries(run.partial.failureReasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    lines.push(
      `# PARTIAL RUN: ${run.partial.quotedCount} of ${run.partial.requestedCount} symbols quoted` +
        (reasons ? ` (failure reasons: ${reasons})` : "") +
        "; results cover the quoted subset only — no fallback data substituted.",
    );
  }
  return lines;
}

function toCsv<T>(
  run: ScreenerResultData,
  setLabel: string,
  columns: Array<{ header: string; value: (row: T) => unknown }>,
  rows: T[],
): string {
  const lines = csvHeaderLines(run, setLabel);
  lines.push(columns.map((c) => c.header).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(c.value(row))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** CSV of the run's standout/opportunities rows. */
export function screenStandoutsCsv(run: ScreenerResultData): string {
  return toCsv(run, "standouts", STANDOUT_COLUMNS, run.opportunities);
}

/** CSV of the run's full scanned set (allStocks). */
export function screenAllStocksCsv(run: ScreenerResultData): string {
  return toCsv(run, "all screened symbols", ALL_STOCKS_COLUMNS, run.allStocks ?? []);
}

/** The full run result object as stored — partial qualification included verbatim. */
export function screenRunJson(run: ScreenerResultData): string {
  return JSON.stringify(run, null, 2);
}

function slugifyScope(sector: string | undefined): string | null {
  if (!sector || sector === "ALL") return null;
  const slug = sector
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

/**
 * Filename identifying the run: screen-<YYYYMMDD>-<HHMMSS>[-<sector
 * scope>]-<set>.<ext>, derived from the run's own timestamp (UTC, so
 * the name is stable regardless of the viewer's timezone). Downloads
 * of different runs — or of different sets of the same run — never
 * collide.
 */
export function screenExportFilename(run: ScreenerResultData, kind: ScreenExportKind): string {
  const date = new Date(run.timestamp);
  const stamp = Number.isNaN(date.getTime())
    ? run.timestamp.replace(/[^0-9A-Za-z]+/g, "-")
    : (() => {
        const digits = date.toISOString().replace(/[^0-9]+/g, "");
        return `${digits.slice(0, 8)}-${digits.slice(8, 14)}`;
      })();
  const scope = slugifyScope(run.sector);
  const base = ["screen", stamp, ...(scope ? [scope] : [])].join("-");
  switch (kind) {
    case "standouts":
      return `${base}-standouts.csv`;
    case "all-stocks":
      return `${base}-all-stocks.csv`;
    case "run-json":
      return `${base}.json`;
  }
}

/** Blob download, mirroring AsyncJobsPanel / optionsIdeasExport.ts. */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blobUrl = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}

/** Serialize + download one export of the viewed run. */
export function downloadScreenExport(run: ScreenerResultData, kind: ScreenExportKind): void {
  const filename = screenExportFilename(run, kind);
  if (kind === "run-json") {
    downloadTextFile(filename, screenRunJson(run), "application/json");
  } else if (kind === "all-stocks") {
    downloadTextFile(filename, screenAllStocksCsv(run), "text/csv;charset=utf-8");
  } else {
    downloadTextFile(filename, screenStandoutsCsv(run), "text/csv;charset=utf-8");
  }
}
