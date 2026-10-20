/**
 * Issue #126 (PR-C): result-set downloads for a strategy scan run.
 * The ScannerPanel offered only a PDF report link; #126's matrix
 * requires the RESULT SET itself downloadable from the UI surface.
 * Following the screen downloads' pattern (screenerExport.ts, #125
 * PR-B), these serializers produce, for the scan run being viewed:
 *
 *  - CSV of the run's headline result rows — the gate "fits" in
 *    strategy_fit mode, the per-name opportunities in per_name_best
 *    mode (columns mirror the tables ScanResultsView displays);
 *  - JSON of the full stored run object (summary stamps + result).
 *
 * Pure functions (unit-tested); the Blob download reuses PR-B's
 * helpers (csvEscape / downloadTextFile from screenerExport.ts).
 *
 * The export is built from the run being VIEWED — a stored run
 * opened from history exports that run, never "the latest". (The
 * neighbouring PDF link's keyless fallback to the latest run's
 * report is a separate hazard, owned by PR-D; nothing here falls
 * back to another run's data.)
 *
 * The JSON carries every content field of the stored run; the one
 * field deliberately not exported is the run's per-user scoping
 * stamp (userLogin, issue #103) — an export file is data about the
 * scan, not about the account that saved it.
 */

import { csvEscape, downloadTextFile } from "./screenerExport";
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

// Row adapters -----------------------------------------------------------

/** One headline result row, normalized across the two modes. Fields
 *  the view renders as "—" (no pick / no best cell) stay undefined
 *  and serialize as empty cells. */
interface ScanResultRow {
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

// Columns mirror the results tables ScanResultsView displays in both
// modes (Symbol, Strategy, Composite score, POP, Target, Entry,
// Max loss, Gate) — the target's source/EM distance and the entry's
// signed net debit ride as their own columns so the file stays
// machine-readable; nothing the view does not show, nothing invented.
const RESULT_COLUMNS: Array<{ header: string; value: (row: ScanResultRow) => unknown }> = [
  { header: "symbol", value: (r) => r.symbol },
  { header: "strategy", value: (r) => r.strategy },
  { header: "compositeScore", value: (r) => r.compositeScore },
  { header: "probabilityOfProfit", value: (r) => r.probabilityOfProfit },
  { header: "targetPrice", value: (r) => r.targetPrice },
  { header: "targetSource", value: (r) => r.targetSource },
  { header: "targetEmUnits", value: (r) => r.targetEmUnits },
  { header: "netDebit", value: (r) => r.netDebit },
  { header: "maxLoss", value: (r) => r.maxLoss },
  { header: "gateBucket", value: (r) => r.gateBucket },
  { header: "gateReasons", value: (r) => r.gateReasons },
];

function csvHeaderLines(run: ScanExportRun, setLabel: string, rowCount: number): string[] {
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
  const lines = csvHeaderLines(run, isFitMode ? "fits" : "opportunities", rows.length);
  lines.push(RESULT_COLUMNS.map((c) => c.header).join(","));
  for (const row of rows) {
    lines.push(RESULT_COLUMNS.map((c) => csvEscape(c.value(row))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** The full stored run object — summary stamps plus the complete
 *  result, in the store's field order (minus the userLogin scoping
 *  stamp; see the module note). */
export function scanRunJson(run: ScanExportRun): string {
  return JSON.stringify(
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
    null,
    2,
  );
}

/**
 * Filename identifying the run: scan-<YYYYMMDD>-<HHMMSS>-<set>.<ext>,
 * derived from the run's own timestamp (UTC, so the name is stable
 * regardless of the viewer's timezone). Downloads of different runs
 * never collide.
 */
export function scanExportFilename(run: ScanExportRun, kind: ScanExportKind): string {
  const date = new Date(run.generatedAt);
  const stamp = Number.isNaN(date.getTime())
    ? run.generatedAt.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "") || "undated"
    : (() => {
        const digits = date.toISOString().replace(/[^0-9]+/g, "");
        return `${digits.slice(0, 8)}-${digits.slice(8, 14)}`;
      })();
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
