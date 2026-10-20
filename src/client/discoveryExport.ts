/**
 * Issue #126 (PR-F): result-set downloads for a persisted discovery
 * run. The Discovery runs surface (DiscoveryRunsPanel) reviews runs
 * persisted by the scheduled-discovery backend (PR-E); this module
 * produces, for the run being VIEWED:
 *
 *  - CSV of the run's ranked candidates — one row per candidate
 *    across the run's symbols, with the saved request's view
 *    (thesis / target) as context columns. Columns mirror the
 *    headline fields the interactive panel shows for a ranked
 *    candidate (strategy, rank, composite score, POP, net debit,
 *    max profit / max loss, target reward/risk);
 *  - JSON of the full stored run (saved requests + outcomes).
 *
 * Pure functions (unit-tested); the Blob download reuses PR-B's
 * helpers (csvEscape / downloadTextFile from screenerExport.ts).
 *
 * Partial and failed runs keep their failures visible in the file:
 * CSVs carry leading `#` metadata lines, including one FAILED line
 * per failed symbol naming its recorded reason. A failed run has no
 * candidate rows by definition — its JSON (the diagnostic record)
 * is the export; the panel offers no CSV for it.
 *
 * Profile-derived runs (issue #533) add, in the same `#` metadata
 * block: one DERIVED line per symbol whose target was derived —
 * the full derivation (spot, multiple, expected move, window,
 * profile) so a derived target in the file can never be mistaken
 * for a configured view — and one ABSTAINED line per symbol that
 * abstained, with its recorded reason. The JSON export carries the
 * derivation records verbatim (they are part of the stored run).
 *
 * Like scannerExport.ts (PR-C), the JSON omits the run's per-user
 * scoping stamp (userLogin, issue #103): an export file is data
 * about the run, not about the account that saved it.
 */

import { csvEscape, downloadTextFile } from "./screenerExport";
import type { StoredDiscoveryRun } from "./discoveryApi";

export type DiscoveryExportKind = "candidates-csv" | "run-json";

/** One CSV row: a ranked candidate plus the saved request it ran under. */
interface DiscoveryCandidateRow {
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

/** Whether the run carries any ranked candidate rows (completed or
 *  partial runs with results). A failed run — or a completed run
 *  whose symbols all came back with no candidates — has none. */
export function discoveryRunHasCandidates(run: StoredDiscoveryRun): boolean {
  return run.outcomes.some(
    (o) => o.status === "completed" && Array.isArray(o.ranked) && o.ranked.length > 0,
  );
}

// Columns mirror the headline metrics the interactive panel renders
// for a ranked candidate (name + "Composite X · Rank #N" subtitle +
// "Max loss $… · POP …%" risk line, plus the net debit / max profit /
// target reward-risk the candidate detail shows) — nothing the panel
// does not show, nothing invented.
const CANDIDATE_COLUMNS: Array<{ header: string; value: (row: DiscoveryCandidateRow) => unknown }> = [
  { header: "symbol", value: (r) => r.symbol },
  { header: "thesis", value: (r) => r.thesis },
  { header: "targetPrice", value: (r) => r.targetPrice },
  { header: "targetDate", value: (r) => r.targetDate },
  { header: "rank", value: (r) => r.rank },
  { header: "strategy", value: (r) => r.strategy },
  { header: "strategyType", value: (r) => r.strategyType },
  { header: "compositeScore", value: (r) => r.compositeScore },
  { header: "probabilityOfProfit", value: (r) => r.probabilityOfProfit },
  { header: "netDebit", value: (r) => r.netDebit },
  { header: "maxProfit", value: (r) => r.maxProfit },
  { header: "maxLoss", value: (r) => r.maxLoss },
  { header: "targetRewardRisk", value: (r) => r.targetRewardRisk },
  { header: "expirationDate", value: (r) => r.expirationDate },
  { header: "bestTradePick", value: (r) => r.bestTradePick },
];

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

function csvHeaderLines(run: StoredDiscoveryRun, rowCount: number): string[] {
  const lines = [
    `# cfagent discovery run results — ranked candidates`,
    `# run: ${run.createdAt} · trigger: ${discoveryTriggerLabel(run)} · input model: ${run.inputModel} · status: ${run.status}`,
    `# symbols: ${run.symbols.join(", ")} · requests: ${run.requestCount} · completed: ${run.completedCount} · failed: ${run.failedCount} · rows in this file: ${rowCount}`,
  ];
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
  }
  return lines;
}

/** CSV of the viewed run's ranked candidates. A completed run with no
 *  candidates exports the metadata + column header only — the empty
 *  result IS the result. */
export function discoveryCandidatesCsv(run: StoredDiscoveryRun): string {
  const rows = candidateRows(run);
  const lines = csvHeaderLines(run, rows.length);
  lines.push(CANDIDATE_COLUMNS.map((c) => c.header).join(","));
  for (const row of rows) {
    lines.push(CANDIDATE_COLUMNS.map((c) => csvEscape(c.value(row))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** The full stored run object — summary stamps, saved requests, and
 *  per-symbol outcomes (minus the userLogin scoping stamp; see the
 *  module note). For a failed run this is the diagnostic record. */
export function discoveryRunJson(run: StoredDiscoveryRun): string {
  const { userLogin: _userLogin, ...rest } = run;
  return JSON.stringify(rest, null, 2);
}

/**
 * Filename identifying the run: discovery-<YYYYMMDD>-<HHMMSS>.<ext>,
 * derived from the run's own timestamp (UTC, so the name is stable
 * regardless of the viewer's timezone). Downloads of different runs
 * never collide.
 */
export function discoveryExportFilename(run: StoredDiscoveryRun, kind: DiscoveryExportKind): string {
  const date = new Date(run.createdAt);
  const stamp = Number.isNaN(date.getTime())
    ? run.createdAt.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "") || "undated"
    : (() => {
        const digits = date.toISOString().replace(/[^0-9]+/g, "");
        return `${digits.slice(0, 8)}-${digits.slice(8, 14)}`;
      })();
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
