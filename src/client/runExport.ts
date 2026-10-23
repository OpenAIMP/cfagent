/**
 * The ONE client exporter (issue #1065, consolidation S6; umbrella
 * #958, survey D4). Before S6, result-set export was five modules —
 * screenerExport.ts (#125 PR-B), scannerExport.ts (#126 PR-C),
 * discoveryExport.ts (#126 PR-F), options/optionsIdeasExport.ts and
 * options/optionsDataExporter.tsx — each with its own CSV/JSON
 * builders, filename scheme, and download helper. They are now one
 * module:
 *
 *  - a typed column-map registry (EXPORT_COLUMN_MAPS) keyed by
 *    export kind — every kind keeps exactly the columns its legacy
 *    builder emitted, in the legacy order;
 *  - one CSV builder (buildCsv) and one JSON builder (buildJson);
 *  - shared filename machinery (utcRunStamp for run exports,
 *    datedXlsFilename for the .xls workbooks) — each kind keeps its
 *    legacy filename scheme as registry-level behaviour, including
 *    the legacy invalid-timestamp fallbacks;
 *  - the only export download helpers (downloadTextFile /
 *    downloadBytesFile): every export blob URL in the client is
 *    created here.
 *
 * Byte-equivalence with the legacy builders is pinned by
 * tests/run_export_s6.test.ts against tests/run_export_goldens.json
 * (captured from the legacy modules on pre-S6 main; regeneration
 * procedure in tests/fixtures/generateRunExportGoldens.ts). The
 * per-kind metadata lines, row adapters, and JSON shapes below are
 * the legacy builders' logic, moved — not redesigned.
 *
 * C2 (consolidation #1151, issue #1246) completed the fold: the
 * options-data fetch/build/download wrappers that still lived in
 * options/optionsDataExporter.tsx (fetchOptionsDataForExport,
 * buildExportInput, downloadRawOptionsData,
 * downloadNormalizedOptionsData, downloadBothOptionsData) moved
 * here verbatim; that module is deleted and only its dropdown
 * component remains separate (options/OptionsDataDownloadDropdown).
 */

import type { ScreenerResultData } from "./ScreenerResultsView";
import type {
  OpportunityScanResponse,
  StoredScanRun,
} from "./scannerApi";
import type {
  OpportunityRow,
  OpportunityScanResult,
  ScanMatrixRow,
  ScanMode,
} from "../trading";
import type { DiscoveryConstraintSet, StoredDiscoveryRun } from "./discoveryApi";
import { NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT } from "../trading";
import type { ETradeOptionChainContract } from "../types";
import { apiFetch as fetch } from "./apiFetch";

// ------------------------------------------------------------- machinery ---

/** One export column: the header cell and the row value extractor. */
export interface ExportColumn<Row> {
  header: string;
  value: (row: Row) => unknown;
}

/** RFC 4180 escaping: quote when the field carries a comma, quote, or line break; double internal quotes. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** The one CSV builder: `#` metadata lines, the column-map header
 *  row, then one escaped row per record — CRLF-joined with a
 *  trailing CRLF, exactly as every legacy builder emitted. */
export function buildCsv<Row>(
  headerLines: string[],
  columns: ReadonlyArray<ExportColumn<Row>>,
  rows: ReadonlyArray<Row>,
): string {
  const lines = [...headerLines];
  lines.push(columns.map((c) => c.header).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(c.value(row))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** The one JSON builder: 2-space pretty print, the legacy envelope
 *  for every run export (each kind's value construction — field
 *  order included — lives with its adapter below). */
export function buildJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * UTC stamp for run-export filenames: <YYYYMMDD>-<HHMMSS> derived
 * from the run's own timestamp, so the name is stable regardless of
 * the viewer's timezone. Invalid timestamps fall back per kind —
 * the legacy schemes differ and both are preserved: "raw" keeps
 * the dash-replaced text untouched (legacy screenerExport);
 * "trimmed" trims edge dashes and falls back to "undated" (legacy
 * scannerExport / discoveryExport).
 */
export function utcRunStamp(value: string, fallback: "raw" | "trimmed"): string {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    const digits = date.toISOString().replace(/[^0-9]+/g, "");
    return `${digits.slice(0, 8)}-${digits.slice(8, 14)}`;
  }
  const replaced = value.replace(/[^0-9A-Za-z]+/g, "-");
  return fallback === "raw" ? replaced : replaced.replace(/^-+|-+$/g, "") || "undated";
}

/** The one text download helper (Blob + anchor click + revoke). */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blobUrl = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(blobUrl);
}

/** The one binary download helper (the legacy .xls path: bytes are
 *  copied into a fresh ArrayBuffer before the Blob is created). */
export function downloadBytesFile(filename: string, bytes: Uint8Array, mimeType: string): void {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Legacy .xls filename scheme: <prefix>_<YYYY-MM-DD>.xls, dated by
 *  the download day (the legacy downloadXls behaviour). */
export function datedXlsFilename(filenamePrefix: string, date: Date = new Date()): string {
  return `${filenamePrefix}_${date.toISOString().slice(0, 10)}.xls`;
}

// ------------------------------------------------------- column registry ---

type StandoutRow = ScreenerResultData["opportunities"][number];
type ScannedRow = NonNullable<ScreenerResultData["allStocks"]>[number];

/** One headline scan result row, normalized across the two scan
 *  modes. Fields the view renders as "—" (no pick / no best cell)
 *  stay undefined and serialize as empty cells. */
export interface ScanResultRow {
  symbol: string;
  strategy: string;
  compositeScore?: number;
  probabilityOfProfit?: number;
  targetPrice: number | null;
  targetSource: string | null;
  targetEmUnits: number | null;
  netDebit?: number;
  maxLoss?: number;
  gateBucket: string | null;
  gateReasons: string;
}

/** One discovery CSV row: a ranked candidate plus the saved request
 *  it ran under. */
export interface DiscoveryCandidateRow {
  symbol: string;
  thesis: string;
  targetPrice: number;
  targetDate: string;
  rank: number;
  strategy: string;
  strategyType: string;
  compositeScore: number;
  probabilityOfProfit: number;
  netDebit: number;
  maxProfit: number | null;
  maxLoss: number;
  targetRewardRisk: number;
  expirationDate: string;
  bestTradePick: string;
}

/** One discovery CSV row for a no-view run: a ranked structure under
 *  its constraint set. There is no view to show — no thesis, no
 *  target — so the context columns are the score model and the
 *  structure's own reward/risk (never a target reward/risk). */
export interface DiscoveryNoViewCandidateRow {
  symbol: string;
  scoreModel: string;
  rank: number;
  strategy: string;
  strategyType: string;
  compositeScore: number;
  probabilityOfProfit: number;
  netDebit: number;
  maxProfit: number | null;
  maxLoss: number;
  structureRewardRisk: number | null;
  expirationDate: string;
  bestPick: string;
}

/**
 * The per-kind column maps — the single definition site for every
 * export's columns. Each map is its legacy builder's column list,
 * extracted verbatim (headers, order, extractors).
 */
export const EXPORT_COLUMN_MAPS = {
  // Columns mirror the ScreenerResultsView standouts table (Symbol,
  // Company, Sentiment, Score, Quant, Val, Mom, Price, Change, Gap,
  // Range, Value) — nothing the view does not show, nothing invented.
  "screen-standouts": [
    { header: "symbol", value: (r: StandoutRow) => r.symbol },
    { header: "company", value: (r: StandoutRow) => r.companyName },
    { header: "sentiment", value: (r: StandoutRow) => r.indicators?.sentiment },
    { header: "screenScore", value: (r: StandoutRow) => r.indicators?.screenScore },
    { header: "quantRating", value: (r: StandoutRow) => r.factorGrades?.quantRating },
    { header: "valueGrade", value: (r: StandoutRow) => r.factorGrades?.value },
    { header: "momentumGrade", value: (r: StandoutRow) => r.factorGrades?.momentum },
    { header: "lastPrice", value: (r: StandoutRow) => r.lastPrice },
    { header: "changePercent", value: (r: StandoutRow) => r.changePercent },
    { header: "gapPercent", value: (r: StandoutRow) => r.technicals?.gapPercent },
    { header: "rangeZone", value: (r: StandoutRow) => r.indicators?.rangeZone },
    { header: "valueZone", value: (r: StandoutRow) => r.indicators?.valueZone },
  ] as Array<ExportColumn<StandoutRow>>,
  // Columns mirror the view's all-screened table (Symbol, Company,
  // Price, Change, Gap, Sentiment, Score, Quant, Val, Mom, Momentum,
  // Range, Value, RSI(14), MACD, Source).
  "screen-all-stocks": [
    { header: "symbol", value: (r: ScannedRow) => r.symbol },
    { header: "company", value: (r: ScannedRow) => r.companyName },
    { header: "lastPrice", value: (r: ScannedRow) => r.lastPrice },
    { header: "changePercent", value: (r: ScannedRow) => r.changePercent },
    { header: "gapPercent", value: (r: ScannedRow) => r.technicals?.gapPercent },
    { header: "sentiment", value: (r: ScannedRow) => r.indicators?.sentiment },
    { header: "screenScore", value: (r: ScannedRow) => r.indicators?.screenScore },
    { header: "quantRating", value: (r: ScannedRow) => r.factorGrades?.quantRating },
    { header: "valueGrade", value: (r: ScannedRow) => r.factorGrades?.value },
    { header: "momentumGrade", value: (r: ScannedRow) => r.factorGrades?.momentum },
    { header: "momentumScore", value: (r: ScannedRow) => r.momentumScore },
    { header: "rangeZone", value: (r: ScannedRow) => r.indicators?.rangeZone },
    { header: "valueZone", value: (r: ScannedRow) => r.indicators?.valueZone },
    { header: "rsi14", value: (r: ScannedRow) => r.rsi14 },
    { header: "macdHistogram", value: (r: ScannedRow) => r.technicals?.macdHistogram },
    { header: "source", value: (r: ScannedRow) => r.source },
  ] as Array<ExportColumn<ScannedRow>>,
  // Columns mirror the results tables ScanResultsView displays in
  // both modes (Symbol, Strategy, Composite score, POP, Target,
  // Entry, Max loss, Gate) — the target's source/EM distance and the
  // entry's signed net debit ride as their own columns so the file
  // stays machine-readable; nothing the view does not show.
  "scan-results": [
    { header: "symbol", value: (r: ScanResultRow) => r.symbol },
    { header: "strategy", value: (r: ScanResultRow) => r.strategy },
    { header: "compositeScore", value: (r: ScanResultRow) => r.compositeScore },
    { header: "probabilityOfProfit", value: (r: ScanResultRow) => r.probabilityOfProfit },
    { header: "targetPrice", value: (r: ScanResultRow) => r.targetPrice },
    { header: "targetSource", value: (r: ScanResultRow) => r.targetSource },
    { header: "targetEmUnits", value: (r: ScanResultRow) => r.targetEmUnits },
    { header: "netDebit", value: (r: ScanResultRow) => r.netDebit },
    { header: "maxLoss", value: (r: ScanResultRow) => r.maxLoss },
    { header: "gateBucket", value: (r: ScanResultRow) => r.gateBucket },
    { header: "gateReasons", value: (r: ScanResultRow) => r.gateReasons },
  ] as Array<ExportColumn<ScanResultRow>>,
  // Columns mirror the headline metrics the interactive discovery
  // panel renders for a ranked candidate — nothing the panel does
  // not show, nothing invented.
  "discovery-candidates": [
    { header: "symbol", value: (r: DiscoveryCandidateRow) => r.symbol },
    { header: "thesis", value: (r: DiscoveryCandidateRow) => r.thesis },
    { header: "targetPrice", value: (r: DiscoveryCandidateRow) => r.targetPrice },
    { header: "targetDate", value: (r: DiscoveryCandidateRow) => r.targetDate },
    { header: "rank", value: (r: DiscoveryCandidateRow) => r.rank },
    { header: "strategy", value: (r: DiscoveryCandidateRow) => r.strategy },
    { header: "strategyType", value: (r: DiscoveryCandidateRow) => r.strategyType },
    { header: "compositeScore", value: (r: DiscoveryCandidateRow) => r.compositeScore },
    { header: "probabilityOfProfit", value: (r: DiscoveryCandidateRow) => r.probabilityOfProfit },
    { header: "netDebit", value: (r: DiscoveryCandidateRow) => r.netDebit },
    { header: "maxProfit", value: (r: DiscoveryCandidateRow) => r.maxProfit },
    { header: "maxLoss", value: (r: DiscoveryCandidateRow) => r.maxLoss },
    { header: "targetRewardRisk", value: (r: DiscoveryCandidateRow) => r.targetRewardRisk },
    { header: "expirationDate", value: (r: DiscoveryCandidateRow) => r.expirationDate },
    { header: "bestTradePick", value: (r: DiscoveryCandidateRow) => r.bestTradePick },
  ] as Array<ExportColumn<DiscoveryCandidateRow>>,
  // No-view runs (issue #534): no thesis/target columns exist — the
  // mode has no view. The score-model column travels with every
  // row, and the reward/risk column is the structure's own ratio.
  "discovery-noview-candidates": [
    { header: "symbol", value: (r: DiscoveryNoViewCandidateRow) => r.symbol },
    { header: "scoreModel", value: (r: DiscoveryNoViewCandidateRow) => r.scoreModel },
    { header: "rank", value: (r: DiscoveryNoViewCandidateRow) => r.rank },
    { header: "strategy", value: (r: DiscoveryNoViewCandidateRow) => r.strategy },
    { header: "strategyType", value: (r: DiscoveryNoViewCandidateRow) => r.strategyType },
    { header: "compositeScore", value: (r: DiscoveryNoViewCandidateRow) => r.compositeScore },
    { header: "probabilityOfProfit", value: (r: DiscoveryNoViewCandidateRow) => r.probabilityOfProfit },
    { header: "netDebit", value: (r: DiscoveryNoViewCandidateRow) => r.netDebit },
    { header: "maxProfit", value: (r: DiscoveryNoViewCandidateRow) => r.maxProfit },
    { header: "maxLoss", value: (r: DiscoveryNoViewCandidateRow) => r.maxLoss },
    { header: "structureRewardRisk", value: (r: DiscoveryNoViewCandidateRow) => r.structureRewardRisk },
    { header: "expirationDate", value: (r: DiscoveryNoViewCandidateRow) => r.expirationDate },
    { header: "bestPick", value: (r: DiscoveryNoViewCandidateRow) => r.bestPick },
  ] as Array<ExportColumn<DiscoveryNoViewCandidateRow>>,
} as const;

export type ExportKind = keyof typeof EXPORT_COLUMN_MAPS;

// ---------------------------------------------------------------- screen ---
// Issue #125 (PR-B) / #126: result-set downloads for a market screen
// run — CSV of the standout rows, CSV of the full scanned set, JSON
// of the full run result object exactly as stored. Partial runs
// (#462 qualification) keep their qualification visible in the file:
// CSVs carry leading `#` metadata lines — including a PARTIAL line
// naming the quoted/requested counts — and the JSON is the untouched
// run object, partial marker included.

export type ScreenExportKind = "standouts" | "all-stocks" | "run-json";

function screenCsvHeaderLines(run: ScreenerResultData, setLabel: string): string[] {
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

/** CSV of the run's standout/opportunities rows. */
export function screenStandoutsCsv(run: ScreenerResultData): string {
  return buildCsv(
    screenCsvHeaderLines(run, "standouts"),
    EXPORT_COLUMN_MAPS["screen-standouts"],
    run.opportunities,
  );
}

/** CSV of the run's full scanned set (allStocks). */
export function screenAllStocksCsv(run: ScreenerResultData): string {
  return buildCsv(
    screenCsvHeaderLines(run, "all screened symbols"),
    EXPORT_COLUMN_MAPS["screen-all-stocks"],
    run.allStocks ?? [],
  );
}

/** The full run result object as stored — partial qualification included verbatim. */
export function screenRunJson(run: ScreenerResultData): string {
  return buildJson(run);
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
  const stamp = utcRunStamp(run.timestamp, "raw");
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

// ------------------------------------------------------------------ scan ---
// Issue #126 (PR-C): result-set downloads for a strategy scan run —
// CSV of the run's headline result rows (the gate "fits" in
// strategy_fit mode, the per-name opportunities in per_name_best
// mode) and JSON of the full stored run object (summary stamps +
// result). The export is built from the run being VIEWED — a stored
// run opened from history exports that run, never "the latest".
// The JSON carries every content field of the stored run; the one
// field deliberately not exported is the run's per-user scoping
// stamp (userLogin, issue #103) — an export file is data about the
// scan, not about the account that saved it.

export type ScanExportKind = "results-csv" | "run-json";

/** The run an export targets, in the StoredScanRun shape: for a
 *  stored run this is the stored object itself; for a fresh scan it
 *  is assembled from the live response (the summary stamps are the
 *  result's own fields, exactly as SqlScanRunStore's summarize()
 *  copies them). `id` is present only when the run is known to be
 *  persisted (a stored run, or a live response carrying scanRunId). */
export interface ScanExportRun {
  id?: string;
  generatedAt: string;
  mode: ScanMode;
  modelVersion: string;
  gate: OpportunityScanResult["gate"];
  coverage: OpportunityScanResult["coverage"];
  profileRef: OpportunityScanResult["profileRef"];
  result: OpportunityScanResult;
}

/** A stored run viewed from history exports as itself. */
export function scanExportRunFromStored(run: StoredScanRun): ScanExportRun {
  return {
    id: run.id,
    generatedAt: run.generatedAt,
    mode: run.mode,
    modelVersion: run.modelVersion,
    gate: run.gate,
    coverage: run.coverage,
    profileRef: run.profileRef ?? null,
    result: run.result,
  };
}

/** A fresh scan exports from the live response. The response is the
 *  unified route's envelope (formatForUi): the OpportunityScanResult
 *  spread at the top level plus envelope fields — the envelope is
 *  stripped so the export has the stored shape (the stored run's
 *  result carries no action/success/meta), and the run id rides
 *  along when the route persisted the scan. */
export function scanExportRunFromResult(response: OpportunityScanResponse): ScanExportRun {
  const {
    action: _action,
    success: _success,
    meta: _meta,
    scanRunId,
    persisted: _persisted,
    reportUrl: _reportUrl,
    ...result
  } = response;
  return {
    ...(scanRunId ? { id: scanRunId } : {}),
    generatedAt: result.generatedAt || response.meta?.generatedAt || "",
    mode: result.mode,
    modelVersion: result.modelVersion,
    gate: result.gate,
    coverage: result.coverage,
    profileRef: result.profileRef ?? null,
    result,
  };
}

/** The best passing cell of a fit row — mirrors ScannerPanel's
 *  bestFitCell exactly (highest composite score wins; the first cell
 *  keeps ties), so the CSV names the same strategy the view does. */
function bestFitOf(row: ScanMatrixRow) {
  let best: {
    label: string;
    compositeScore: number;
    probabilityOfProfit: number;
    netDebit: number;
    maxLoss: number;
  } | null = null;
  for (const cell of row.cells ?? []) {
    if (!cell.best) continue;
    if (!best || cell.best.compositeScore > best.compositeScore) {
      best = {
        label: cell.best.label,
        compositeScore: cell.best.compositeScore,
        probabilityOfProfit: cell.best.probabilityOfProfit,
        netDebit: cell.best.netDebit,
        maxLoss: cell.best.maxLoss,
      };
    }
  }
  return best;
}

function fitRow(row: ScanMatrixRow): ScanResultRow {
  const best = bestFitOf(row);
  return {
    symbol: row.symbol,
    strategy: best?.label ?? "",
    compositeScore: best?.compositeScore,
    probabilityOfProfit: best?.probabilityOfProfit,
    targetPrice: row.targetPrice,
    targetSource: row.targetSource,
    targetEmUnits: row.targetEmUnits,
    netDebit: best?.netDebit,
    maxLoss: best?.maxLoss,
    gateBucket: row.gateBucket,
    gateReasons: (row.gateReasons ?? []).join("; "),
  };
}

function opportunityRow(row: OpportunityRow): ScanResultRow {
  const candidate = row.pick?.best?.candidate;
  return {
    symbol: row.symbol,
    // The view's strategy cell: the pick's label, "No qualifying
    // trade" for a no-trade pick, "—" (empty here) otherwise.
    strategy: candidate?.label ?? (row.pick?.status === "no_trade" ? "No qualifying trade" : ""),
    compositeScore: row.pick?.best?.compositeScore ?? row.score,
    probabilityOfProfit: candidate?.modelImpliedProbabilityOfProfit,
    targetPrice: row.targetPrice,
    targetSource: row.targetSource,
    targetEmUnits: row.targetEmUnits,
    netDebit: candidate?.netDebit,
    maxLoss: candidate?.maxLoss,
    gateBucket: row.gateBucket,
    gateReasons: (row.gateReasons ?? []).join("; "),
  };
}

function scanCsvHeaderLines(run: ScanExportRun, setLabel: string, rowCount: number): string[] {
  const { result } = run;
  const lines = [
    `# cfagent strategy scan results — ${setLabel}`,
    `# run: ${run.generatedAt} · mode: ${run.mode} · scan model v${run.modelVersion}` +
      (run.profileRef ? ` · profile: ${run.profileRef.name} v${run.profileRef.version}` : "") +
      (run.id ? ` · run id: ${run.id}` : ""),
  ];
  // Universe/scope: the symbols the run was asked for when the
  // request was recorded (#103); otherwise the symbols its matrix
  // judged — never a scope the run did not have.
  const requested = result.requestSnapshot?.request?.symbols;
  const judged = (result.matrix ?? []).map((r) => r.symbol);
  const symbols = requested && requested.length > 0 ? requested : judged;
  if (symbols.length > 0) {
    lines.push(`# symbols: ${symbols.join(", ")}`);
  }
  const coverage = run.coverage;
  if (coverage) {
    lines.push(
      `# coverage: considered ${coverage.considered} · scanned ${coverage.scanned} · evaluated ${coverage.evaluated} · skipped ${coverage.errors} · truncated ${coverage.truncated}`,
    );
  }
  const gate = run.gate;
  if (gate) {
    lines.push(
      `# gate: ${gate.fit} fit / ${gate.borderline} borderline / ${gate.noFit} no fit` +
        (run.mode === "strategy_fit" ? ` · fits total: ${result.fitsTotal ?? 0}` : "") +
        ` · rows in this file: ${rowCount}`,
    );
  }
  // The fit-gate parameters the run was judged under (#24
  // provenance), when the stored result carries them.
  const gateParams = result.gateParams;
  if (gateParams) {
    lines.push(
      `# fit gate: min composite score ${gateParams.minCompositeScore} · min probability of profit ${gateParams.minProbabilityOfProfit} · require fresh: ${gateParams.requireFresh ? "yes" : "no"} · min confidence: ${gateParams.minConfidence}`,
    );
  }
  return lines;
}

/** CSV of the run's headline result rows: the gate fits in
 *  strategy_fit mode, the per-name opportunities in per_name_best
 *  mode. A completed run with no fits/opportunities exports the
 *  metadata + column header only — the empty result IS the result. */
export function scanResultsCsv(run: ScanExportRun): string {
  const { result } = run;
  const isFitMode = run.mode === "strategy_fit";
  const rows = isFitMode
    ? (result.fits ?? []).map(fitRow)
    : (result.opportunities ?? []).map(opportunityRow);
  return buildCsv(
    scanCsvHeaderLines(run, isFitMode ? "fits" : "opportunities", rows.length),
    EXPORT_COLUMN_MAPS["scan-results"],
    rows,
  );
}

/** The full stored run object — summary stamps plus the complete
 *  result, in the store's field order (minus the userLogin scoping
 *  stamp; see the section note). */
export function scanRunJson(run: ScanExportRun): string {
  return buildJson(
    {
      ...(run.id ? { id: run.id } : {}),
      generatedAt: run.generatedAt,
      mode: run.mode,
      modelVersion: run.modelVersion,
      gate: run.gate,
      coverage: run.coverage,
      profileRef: run.profileRef,
      result: run.result,
    },
  );
}

/**
 * Filename identifying the run: scan-<YYYYMMDD>-<HHMMSS>-<set>.<ext>,
 * derived from the run's own timestamp (UTC, so the name is stable
 * regardless of the viewer's timezone). Downloads of different runs
 * never collide.
 */
export function scanExportFilename(run: ScanExportRun, kind: ScanExportKind): string {
  const stamp = utcRunStamp(run.generatedAt, "trimmed");
  if (kind === "run-json") return `scan-${stamp}.json`;
  return `scan-${stamp}-${run.mode === "strategy_fit" ? "fits" : "opportunities"}.csv`;
}

/** Serialize + download one export of the viewed run. */
export function downloadScanExport(run: ScanExportRun, kind: ScanExportKind): void {
  const filename = scanExportFilename(run, kind);
  if (kind === "run-json") {
    downloadTextFile(filename, scanRunJson(run), "application/json");
  } else {
    downloadTextFile(filename, scanResultsCsv(run), "text/csv;charset=utf-8");
  }
}

// ------------------------------------------------------------- discovery ---
// Issue #126 (PR-F): result-set downloads for a persisted discovery
// run — CSV of the run's ranked candidates (one row per candidate
// across the run's symbols, with the saved request's view as context
// columns) and JSON of the full stored run (saved requests +
// outcomes). Partial and failed runs keep their failures visible in
// the file: CSVs carry leading `#` metadata lines, including one
// FAILED line per failed symbol naming its recorded reason. A
// failed run has no candidate rows by definition — its JSON (the
// diagnostic record) is the export; the panel offers no CSV for it.
//
// Profile-derived runs (issue #533) add, in the same `#` metadata
// block: one DERIVED line per symbol whose target was derived — the
// full derivation (spot, multiple, expected move, window, profile)
// so a derived target in the file can never be mistaken for a
// configured view — and one ABSTAINED line per symbol that
// abstained, with its recorded reason. The JSON export carries the
// derivation records verbatim (they are part of the stored run).
//
// No-view runs (issue #534) are labelled NO-VIEW in the header and
// carry one CONSTRAINTS line per stored constraint set (caps, DTE
// window, floors, the mode's fixed IV assumption) so a reader can
// always see what constrained the run and that no view did. Their
// candidate rows come from the no-view ranked structures — there is
// no thesis/target to show, so the CSV columns are the structure's
// own metrics, every score stamped with its model (no-view-v1;
// no-view scores are not comparable to viewed scores). A no-view
// abstention (a completed outcome flagged `abstained`, its chain
// loaded but nothing qualified) gets an ABSTAINED line naming its
// gate reasons. The JSON export carries the constraint sets and
// no-view outcomes verbatim.
//
// Like the scan JSON, the discovery JSON omits the run's per-user
// scoping stamp (userLogin, issue #103).

export type DiscoveryExportKind = "candidates-csv" | "run-json";

function candidateRows(run: StoredDiscoveryRun): DiscoveryCandidateRow[] {
  const rows: DiscoveryCandidateRow[] = [];
  for (const outcome of run.outcomes) {
    if (outcome.status !== "completed" || !outcome.ranked || !outcome.request) continue;
    const bestId = outcome.bestTrade?.best?.candidate.id;
    for (const entry of outcome.ranked) {
      const c = entry.candidate;
      rows.push({
        symbol: outcome.symbol,
        thesis: outcome.request.thesis,
        targetPrice: outcome.request.targetPrice,
        targetDate: outcome.request.targetDate,
        rank: entry.rank,
        strategy: c.label,
        strategyType: c.type,
        compositeScore: entry.compositeScore,
        probabilityOfProfit: c.modelImpliedProbabilityOfProfit,
        netDebit: c.netDebit,
        maxProfit: c.maxProfit,
        maxLoss: c.maxLoss,
        targetRewardRisk: c.targetRewardRisk,
        expirationDate: c.expirationDate,
        bestTradePick: bestId !== undefined && c.id === bestId ? "yes" : "",
      });
    }
  }
  return rows;
}

function noViewCandidateRows(run: StoredDiscoveryRun): DiscoveryNoViewCandidateRow[] {
  const rows: DiscoveryNoViewCandidateRow[] = [];
  for (const outcome of run.outcomes) {
    if (outcome.status !== "completed" || !outcome.rankedNoView) continue;
    const bestId = outcome.bestNoViewTrade?.best?.candidate.id;
    for (const entry of outcome.rankedNoView) {
      const c = entry.candidate;
      rows.push({
        symbol: outcome.symbol,
        // The candidate's own score-model stamp (no-view-v1) — a
        // no-view score is never exported without its model, because
        // it is not comparable to a viewed score.
        scoreModel: c.scoreModel,
        rank: entry.rank,
        strategy: c.label,
        strategyType: c.type,
        compositeScore: entry.compositeScore,
        probabilityOfProfit: c.modelImpliedProbabilityOfProfit,
        netDebit: c.netDebit,
        maxProfit: c.maxProfit,
        maxLoss: c.maxLoss,
        structureRewardRisk: c.structureRewardRisk,
        expirationDate: c.expirationDate,
        bestPick: bestId !== undefined && c.id === bestId ? "yes" : "",
      });
    }
  }
  return rows;
}

/** Whether the run carries any ranked candidate rows (completed or
 *  partial runs with results). A failed run — or a completed run
 *  whose symbols all came back with no candidates — has none. */
export function discoveryRunHasCandidates(run: StoredDiscoveryRun): boolean {
  return run.outcomes.some(
    (o) =>
      o.status === "completed" &&
      ((Array.isArray(o.ranked) && o.ranked.length > 0) ||
        (Array.isArray(o.rankedNoView) && o.rankedNoView.length > 0)),
  );
}

export function discoveryTriggerLabel(run: Pick<StoredDiscoveryRun, "trigger" | "scheduleId">): string {
  const base = run.trigger === "scheduled" ? "Scheduled" : "Manual trigger";
  return run.scheduleId ? `${base} · schedule ${run.scheduleId}` : base;
}

/** Money in a `#` metadata line: fixed 2dp, no thousands separators
 *  (the line is a comment, but a stable format pins cleanly). */
function metaUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** A fraction (0.1311) rendered as a trimmed percent number (13.11). */
function metaPctNumber(fraction: number): string {
  return String(Number((fraction * 100).toFixed(2)));
}

/** An EM multiple rendered without trailing zeros (0.6, -0.6, 1.2, 0). */
function metaMultiple(value: number): string {
  return String(Number(value.toFixed(4)));
}

/** One stored constraint set as a `#` metadata line (issue #534):
 *  the caps, floors, DTE window and the mode's fixed IV assumption —
 *  everything that constrained the run, and a standing reminder
 *  that no thesis or target did. */
export function formatConstraintSetLine(set: DiscoveryConstraintSet): string {
  const r = set.request;
  const parts = [
    `max planned loss ${metaUsd(r.maxPlannedLoss)}`,
    `min reward/risk ${r.minRewardRisk}×`,
    `min POP ${metaPctNumber(r.minProbabilityOfProfit ?? NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT)}%`,
  ];
  if (r.minDte !== undefined && r.maxDte !== undefined) parts.push(`DTE ${r.minDte}–${r.maxDte}`);
  else if (r.maxDte !== undefined) parts.push(`DTE ≤${r.maxDte}`);
  else if (r.minDte !== undefined) parts.push(`DTE ≥${r.minDte}`);
  if (r.riskProfile !== undefined) parts.push(`risk profile ${r.riskProfile}`);
  parts.push(`IV expected ${set.expectedIvDirection}`);
  return parts.join(" · ");
}

function discoveryCsvHeaderLines(run: StoredDiscoveryRun, rowCount: number): string[] {
  const isNoView = run.inputModel === "no-view";
  const lines = [
    isNoView
      ? `# cfagent discovery run results — NO-VIEW (constraints only): ranked structures under the no-view-v1 score model — no thesis, no target`
      : `# cfagent discovery run results — ranked candidates`,
    `# run: ${run.createdAt} · trigger: ${discoveryTriggerLabel(run)} · input model: ${run.inputModel} · status: ${run.status}`,
    `# symbols: ${run.symbols.join(", ")} · ${isNoView ? "constraint sets" : "requests"}: ${run.requestCount} · completed: ${run.completedCount} · failed: ${run.failedCount} · rows in this file: ${rowCount}`,
  ];
  if (isNoView) {
    // The run's constraint sets, verbatim in effect: what constrained
    // the run is part of the result. Prefer the run-level record;
    // fall back to the per-outcome records (every no-view outcome
    // carries its set).
    const sets =
      run.constraintSets ??
      run.outcomes.flatMap((o) => (o.constraintSet ? [o.constraintSet] : []));
    for (const set of sets) {
      lines.push(`# CONSTRAINTS: ${set.request.symbol} — ${formatConstraintSetLine(set)}`);
    }
  }
  // Per-symbol outcome lines, in outcome order. Partial / failed runs
  // name what failed, with the recorded reason — the file never
  // presents a subset as the whole result. A derived symbol's target
  // is labelled DERIVED with its full derivation (issue #533); an
  // abstention names its reason and carries no target, ever.
  for (const outcome of run.outcomes) {
    const derivation = outcome.derivation;
    if (derivation) {
      lines.push(
        `# DERIVED: ${outcome.symbol} target ${metaUsd(derivation.targetPrice)} = spot ${metaUsd(derivation.spot)} × (1 + ${metaMultiple(derivation.emMultiple)} × EM ${metaPctNumber(derivation.expectedMovePct)}%) · window ${derivation.windowExpiry} (${derivation.windowDays}d) · profile ${derivation.profileRef.name} v${derivation.profileRef.version}`,
      );
    }
    if (outcome.status === "failed") {
      lines.push(`# FAILED: ${outcome.symbol} — ${outcome.error ?? "no reason recorded"}`);
    }
    if (outcome.status === "abstained") {
      lines.push(`# ABSTAINED: ${outcome.symbol} — ${outcome.error ?? "no reason recorded"}`);
    }
    if (outcome.abstained === true) {
      // No-view abstention (issue #534): the chain loaded but no
      // structure cleared the stated constraints. The gate reasons
      // are the recorded exclusions — never a manufactured pick.
      const reasons = (outcome.excluded ?? [])
        .map((e) => `${e.reason} ×${e.count}`)
        .join(", ");
      lines.push(
        `# ABSTAINED: ${outcome.symbol} — no structure qualified under the stated constraints${reasons ? ` (${reasons})` : ""}`,
      );
    }
  }
  return lines;
}

/** CSV of the viewed run's ranked candidates. A completed run with no
 *  candidates exports the metadata + column header only — the empty
 *  result IS the result. No-view runs export their ranked structures
 *  under the no-view column set (see EXPORT_COLUMN_MAPS). */
export function discoveryCandidatesCsv(run: StoredDiscoveryRun): string {
  if (run.inputModel === "no-view") {
    const rows = noViewCandidateRows(run);
    return buildCsv(
      discoveryCsvHeaderLines(run, rows.length),
      EXPORT_COLUMN_MAPS["discovery-noview-candidates"],
      rows,
    );
  }
  const rows = candidateRows(run);
  return buildCsv(
    discoveryCsvHeaderLines(run, rows.length),
    EXPORT_COLUMN_MAPS["discovery-candidates"],
    rows,
  );
}

/** The full stored run object — summary stamps, saved requests, and
 *  per-symbol outcomes (minus the userLogin scoping stamp; see the
 *  section note). For a failed run this is the diagnostic record. */
export function discoveryRunJson(run: StoredDiscoveryRun): string {
  const { userLogin: _userLogin, ...rest } = run;
  return buildJson(rest);
}

/**
 * Filename identifying the run: discovery-<YYYYMMDD>-<HHMMSS>.<ext>,
 * derived from the run's own timestamp (UTC, so the name is stable
 * regardless of the viewer's timezone). Downloads of different runs
 * never collide.
 */
export function discoveryExportFilename(run: StoredDiscoveryRun, kind: DiscoveryExportKind): string {
  const stamp = utcRunStamp(run.createdAt, "trimmed");
  return kind === "run-json" ? `discovery-${stamp}.json` : `discovery-${stamp}.csv`;
}

/** Serialize + download one export of the viewed run. */
export function downloadDiscoveryExport(run: StoredDiscoveryRun, kind: DiscoveryExportKind): void {
  const filename = discoveryExportFilename(run, kind);
  if (kind === "run-json") {
    downloadTextFile(filename, discoveryRunJson(run), "application/json");
  } else {
    downloadTextFile(filename, discoveryCandidatesCsv(run), "text/csv;charset=utf-8");
  }
}

// ---------------------------------------------------------- options XLS ---
// The LLM options-ideas workbooks (legacy Excel 97–2003 .xls,
// BIFF8): the raw retrieved E*TRADE dataset, the normalized LLM
// input dataset, and the post-analysis report workbook. Sheet
// construction is each legacy builder's, moved verbatim; downloads
// go through the shared download helper + filename scheme above.

export interface RawOptionsIdeasExport {
  symbol: string;
  question: string;
  expirations: unknown[];
  optionChains: unknown[];
  systemPrompt: string;
  userPrompt: string;
  selection?: {
    contractsAvailable: number;
    contractsIncluded: number;
    truncated: boolean;
  };
  groupInputs?: Array<{
    id?: string;
    label: string;
    symbol: string;
    question: string;
    expirations: unknown[];
    optionChains: unknown[];
    systemPrompt: string;
    userPrompt: string;
    selection?: {
      contractsAvailable: number;
      contractsIncluded: number;
      truncated: boolean;
    };
  }>;
  finalRanking?: {
    systemPrompt: string;
    userPrompt: string;
  };
}

export interface RetrievedOptionsDataExport {
  symbol: string;
  question: string;
  dataSource?: string;
  expirations: unknown[];
  optionChains: unknown[];
}

export interface OptionsIdeasReportExport {
  symbol: string;
  question: string;
  dataCoverage: {
    expirationCount: number;
    chainCount: number;
    contractCount: number;
    sentContractCount?: number;
    estimatedInputTokens?: number;
    inputTruncated?: boolean;
  };
  groups: Array<{
    id: string;
    label: string;
    status: "complete" | "error";
    model?: string;
    answer?: string;
    error?: string;
    contractSymbols?: string[];
    contractWarnings?: string[];
    contractDetails?: Array<{
      symbol: string;
      expiration: string;
      contract: ETradeOptionChainContract;
    }>;
    expirationCount: number;
    contractCount: number;
    sentContractCount: number;
    inputTruncated: boolean;
  }>;
  finalAnalysis: {
    status: "complete" | "error";
    model?: string;
    answer?: string;
    error?: string;
    rankings?: Array<{ rank: number; groupId: string; strategy: string; rationale: string }>;
    isFallback?: boolean;
  };
}

function rawChainData(chain: unknown): unknown {
  if (chain && typeof chain === "object" && "raw" in chain && chain.raw && typeof chain.raw === "object") {
    return chain.raw;
  }
  return chain;
}

function textChunks(text: string): string[][] {
  const chunkSize = 240;
  const rows: string[][] = [];
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    if (rows.length >= 65_534) {
      throw new Error("The export exceeds the row limit of the legacy .xls format.");
    }
    rows.push([String(rows.length + 1), text.slice(offset, offset + chunkSize)]);
  }
  return rows.length ? rows : [["1", ""]];
}

export async function createRawOptionsIdeasXls(input: RawOptionsIdeasExport): Promise<Uint8Array> {
  const XLSX = await import("@e965/xlsx");
  const workbook = XLSX.utils.book_new();
  const groupInputs = input.groupInputs;
  const requestData = {
    request: { symbol: input.symbol, naturalLanguageQuestion: input.question },
    ...(groupInputs?.length
      ? {
        groupInputs: groupInputs.map((group) => ({
          groupId: group.id,
          label: group.label,
          question: group.question,
          selection: group.selection,
          systemPrompt: group.systemPrompt,
          userPrompt: group.userPrompt,
          etrade: {
            optionExpirations: group.expirations,
            optionChains: group.optionChains.map(rawChainData),
          },
        })),
        finalRanking: input.finalRanking,
      }
      : {
        ...(input.selection ? { dataCoverage: input.selection } : {}),
        etrade: {
          optionExpirations: input.expirations,
          optionChains: input.optionChains.map(rawChainData),
        },
      }),
  };

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Field", "Value"],
      ["Underlying symbol", input.symbol],
      ["Natural-language question", input.question],
      ["Option expirations", groupInputs?.length ? groupInputs.reduce((count, group) => count + group.expirations.length, 0) : input.expirations.length],
      ["Option-chain responses", groupInputs?.length ? groupInputs.reduce((count, group) => count + group.optionChains.length, 0) : input.optionChains.length],
      ...(groupInputs?.length ? [["Expiration groups analyzed", groupInputs.length]] : []),
    ]),
    "Request",
  );
  const systemPromptText = groupInputs?.length
    ? groupInputs.map((group) => `GROUP: ${group.label}\n${group.systemPrompt}`).concat(
      input.finalRanking ? [`FINAL CROSS-GROUP RANKING\n${input.finalRanking.systemPrompt}`] : [],
    ).join("\n\n")
    : input.systemPrompt;
  const userPromptText = groupInputs?.length
    ? groupInputs.map((group) => `GROUP: ${group.label}\n${group.userPrompt}`).concat(
      input.finalRanking ? [`FINAL CROSS-GROUP RANKING\n${input.finalRanking.userPrompt}`] : [],
    ).join("\n\n")
    : input.userPrompt;
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Prompt text"], ...textChunks(systemPromptText)]),
    "LLM System Prompt",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Prompt text"], ...textChunks(userPromptText)]),
    "LLM User Prompt",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Complete JSON input"], ...textChunks(JSON.stringify(requestData))]),
    "Complete Input JSON",
  );

  return new Uint8Array(XLSX.write(workbook, { bookType: "biff8", type: "array" }));
}

export async function createOptionsIdeasReportXls(report: OptionsIdeasReportExport): Promise<Uint8Array> {
  const XLSX = await import("@e965/xlsx");
  const workbook = XLSX.utils.book_new();
  const summaryRows = [
    ["Field", "Value"],
    ["Underlying symbol", report.symbol],
    ["Natural-language question", report.question],
    ["Expiration groups", report.groups.length],
    ["Expirations retrieved", report.dataCoverage.expirationCount],
    ["Option chains retrieved", report.dataCoverage.chainCount],
    ["Contracts retrieved", report.dataCoverage.contractCount],
    ["Contracts sent across group requests", report.dataCoverage.sentContractCount ?? 0],
    ["Any group input truncated", report.dataCoverage.inputTruncated ? "Yes" : "No"],
    ["Final analysis status", report.finalAnalysis.status],
    ["Final analysis model", report.finalAnalysis.model || ""],
    ["Final analysis", report.finalAnalysis.answer || report.finalAnalysis.error || ""],
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "Summary");

  const groupRows: string[][] = [[
    "Group",
    "Status",
    "Expirations",
    "Contracts",
    "Contracts Sent",
    "Input Truncated",
    "Model",
    "Referenced Contracts",
    "Analysis / Error",
  ]];
  for (const group of report.groups) {
    groupRows.push([
      group.label,
      group.status,
      String(group.expirationCount),
      String(group.contractCount),
      String(group.sentContractCount),
      group.inputTruncated ? "Yes" : "No",
      group.model || "",
      (group.contractSymbols || []).join(", "),
      [group.answer || group.error || "", ...(group.contractWarnings || [])].join("\n"),
    ]);
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(groupRows), "Group Evaluations");

  const verifiedContracts = report.groups.flatMap((group) =>
    (group.contractDetails || []).map((detail) => ({
      group: group.label,
      ...detail,
    })),
  );
  if (verifiedContracts.length) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      [
        "Expiration Group",
        "Expiration",
        "E*TRADE Contract Symbol",
        "Option Type",
        "Strike",
        "Bid",
        "Ask",
        "Last",
        "Volume",
        "Open Interest",
        "Delta",
        "Gamma",
        "Theta",
        "Vega",
        "Rho",
        "Implied Volatility",
      ],
      ...verifiedContracts.map(({ group, expiration, contract }) => [
        group,
        expiration,
        contract.symbol,
        contract.optionType,
        contract.strikePrice,
        contract.bid,
        contract.ask,
        contract.lastPrice,
        contract.volume,
        contract.openInterest,
        contract.delta,
        contract.gamma,
        contract.theta,
        contract.vega,
        contract.rho,
        contract.impliedVolatility,
      ]),
    ]), "Verified Contracts");
  }

  const rankings = report.finalAnalysis.rankings || [];
  if (rankings.length) {
    const groupLabels = new Map(report.groups.map((group) => [group.id, group.label]));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["Rank", "Expiration Group", "Winning Strategy", "Rationale"],
      ...rankings.map((item) => [
        String(item.rank),
        groupLabels.get(item.groupId) || item.groupId,
        item.strategy,
        item.rationale,
      ]),
    ]), "Cross-Group Ranking");
  }
  return new Uint8Array(XLSX.write(workbook, { bookType: "biff8", type: "array" }));
}

export async function downloadOptionsIdeasReportXls(report: OptionsIdeasReportExport): Promise<void> {
  const bytes = await createOptionsIdeasReportXls(report);
  downloadBytesFile(
    datedXlsFilename(`${report.symbol.toLowerCase()}_llm_options_analysis`),
    bytes,
    "application/vnd.ms-excel",
  );
}

export async function downloadRawOptionsIdeasXls(input: RawOptionsIdeasExport): Promise<void> {
  const bytes = await createRawOptionsIdeasXls(input);
  downloadBytesFile(
    datedXlsFilename(`${input.symbol.toLowerCase()}_llm_options_input`),
    bytes,
    "application/vnd.ms-excel",
  );
}

export async function createRetrievedOptionsDataXls(input: RetrievedOptionsDataExport): Promise<Uint8Array> {
  const XLSX = await import("@e965/xlsx");
  const workbook = XLSX.utils.book_new();
  const rawData = {
    request: { symbol: input.symbol, naturalLanguageQuestion: input.question },
    etrade: {
      optionExpirations: input.expirations,
      optionChains: input.optionChains.map(rawChainData),
    },
  };
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Field", "Value"],
      ["Underlying symbol", input.symbol],
      ["Natural-language question", input.question],
      ["Option expirations retrieved", input.expirations.length],
      ["Option-chain responses retrieved", input.optionChains.length],
    ]),
    "Request",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Chunk", "Complete retrieved E*TRADE JSON"], ...textChunks(JSON.stringify(rawData))]),
    "Retrieved Raw JSON",
  );
  return new Uint8Array(XLSX.write(workbook, { bookType: "biff8", type: "array" }));
}

export async function downloadRetrievedOptionsDataXls(input: RetrievedOptionsDataExport): Promise<void> {
  const bytes = await createRetrievedOptionsDataXls(input);
  downloadBytesFile(
    datedXlsFilename(`${input.symbol.toLowerCase()}_etrade_options_raw`),
    bytes,
    "application/vnd.ms-excel",
  );
}

// ------------------------------------------------- options-data exports ---
// C2 (issue #1246): moved verbatim from options/optionsDataExporter.tsx —
// the fetch/build/download wrappers over the XLS builders above. The
// dropdown component that drives them lives in
// options/OptionsDataDownloadDropdown.tsx.

export async function fetchOptionsDataForExport(
  symbol: string,
  activeEnv: "TEST" | "PROD" = "TEST",
  userLogin?: string
): Promise<{ retrievedData: RetrievedOptionsDataExport; llmInput?: RawOptionsIdeasExport }> {
  const sym = symbol.trim().toUpperCase() || "SPY";
  const query = `Retrieve complete raw option chains and normalized LLM contract datasets for ${sym}.`;
  const response = await fetch("/api/trading/options/llm-ideas", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-environment": activeEnv,
      ...(userLogin ? { "x-user-login": userLogin } : {}),
    },
    body: JSON.stringify({
      symbol: sym,
      question: query,
    }),
  });

  const data = (await response.json().catch(() => null)) as any;

  if (!response.ok) {
    const hasChains = Boolean(
      data?.retrievedData?.optionChains &&
      Array.isArray(data.retrievedData.optionChains) &&
      data.retrievedData.optionChains.length > 0
    );
    if (!hasChains) {
      throw new Error(data?.error || `Failed to retrieve options data for ${sym} (HTTP ${response.status}).`);
    }
  }

  if (!data || !data.retrievedData) {
    throw new Error(data?.error || `No option chain data was returned for ${sym}.`);
  }

  const rawChains = Array.isArray(data.retrievedData.optionChains) ? data.retrievedData.optionChains : [];
  if (rawChains.length === 0) {
    throw new Error(data?.error || `No option contracts were returned for ${sym} by the broker. Verify ticker and market hours.`);
  }

  return {
    retrievedData: data.retrievedData,
    llmInput: data.llmInput,
  };
}

export function buildExportInput(
  symbol: string,
  retrievedData: RetrievedOptionsDataExport,
  llmInput?: RawOptionsIdeasExport
): RawOptionsIdeasExport {
  if (llmInput && llmInput.optionChains && Array.isArray(llmInput.optionChains) && llmInput.optionChains.length > 0) {
    return llmInput;
  }

  const sym = symbol.trim().toUpperCase() || "SPY";
  const chains = retrievedData.optionChains || [];
  const expirations = retrievedData.expirations || [];
  const contractsCount = chains.reduce((acc: number, c: any) => {
    const pairs = c?.pairs || c?.OptionPair || [];
    return acc + (Array.isArray(pairs) ? pairs.length * 2 : 0);
  }, 0);

  return {
    symbol: sym,
    question: `Normalized option chains and contract analytics for ${sym}`,
    expirations,
    optionChains: chains,
    systemPrompt: `You are an expert options strategist. Analyze the normalized option chain dataset for ${sym} and identify the strongest risk-defined strategies.`,
    userPrompt: `Underlying: ${sym}\nExpirations available: ${expirations.length}\nOption chains: ${chains.length}\nTotal contracts: ${contractsCount}`,
    selection: {
      contractsAvailable: contractsCount,
      contractsIncluded: contractsCount,
      truncated: false,
    },
  };
}

export async function downloadRawOptionsData(
  symbol: string,
  activeEnv: "TEST" | "PROD" = "TEST",
  userLogin?: string
): Promise<void> {
  const sym = symbol.trim().toUpperCase() || "SPY";
  const { retrievedData } = await fetchOptionsDataForExport(sym, activeEnv, userLogin);
  await downloadRetrievedOptionsDataXls(retrievedData);
}

export async function downloadNormalizedOptionsData(
  symbol: string,
  activeEnv: "TEST" | "PROD" = "TEST",
  userLogin?: string
): Promise<void> {
  const sym = symbol.trim().toUpperCase() || "SPY";
  const { retrievedData, llmInput } = await fetchOptionsDataForExport(sym, activeEnv, userLogin);
  const inputToExport = buildExportInput(sym, retrievedData, llmInput);
  await downloadRawOptionsIdeasXls(inputToExport);
}

export async function downloadBothOptionsData(
  symbol: string,
  activeEnv: "TEST" | "PROD" = "TEST",
  userLogin?: string
): Promise<void> {
  const sym = symbol.trim().toUpperCase() || "SPY";
  const { retrievedData, llmInput } = await fetchOptionsDataForExport(sym, activeEnv, userLogin);
  await downloadRetrievedOptionsDataXls(retrievedData);
  // Introduce small delay to prevent browser popup blockers from suppressing consecutive file downloads
  await new Promise((resolve) => setTimeout(resolve, 350));
  const inputToExport = buildExportInput(sym, retrievedData, llmInput);
  await downloadRawOptionsIdeasXls(inputToExport);
}
