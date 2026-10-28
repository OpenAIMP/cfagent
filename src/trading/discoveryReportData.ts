/**
 * Discovery-run report data (#2180): one row model for the PDF, the workbook
 * and the CSV.
 *
 * A discovery run is a per-symbol ledger: for each symbol, what ran (a saved
 * request, a derived target, or a constraint set), what the engine judged
 * (the best structure, its economics and legs), and — when nothing traded —
 * the recorded reason. Every renderer projects from this module, so the
 * three formats cannot drift apart.
 *
 * Honesty rules that live here, not in the renderers:
 *  - an abstained or failed symbol shows its recorded reason and no pick;
 *  - a no-view run says "constraints only" — it never invents a thesis;
 *  - an unbounded max profit stays null (rendered as "—"/"unbounded").
 */

import type { DiscoverySymbolOutcome } from "./options/discoveryRunStore";

export type DiscoveryReportFormat = "pdf" | "xlsx" | "csv";

export type DiscoveryVerdict = "fit" | "no_trade" | "abstained" | "failed";

/** The run facts a report renders. The outcomes are the run's own record. */
export interface DiscoveryReportInput {
  runId: string;
  createdAt: string;
  trigger: string;
  inputModel: string;
  status: string;
  summary?: string;
  symbols: string[];
  matchedCount?: number;
  totalScanned?: number;
  outcomes: DiscoverySymbolOutcome[];
}

export const DISCOVERY_SYMBOL_COLUMNS = [
  "symbol",
  "status",
  "input",
  "ranked",
  "best_strategy",
  "expiration",
  "score",
  "probability_of_profit",
  "max_loss",
  "max_profit",
  "legs",
  "verdict",
  "reason",
] as const;

export type DiscoverySymbolRow = Record<(typeof DISCOVERY_SYMBOL_COLUMNS)[number], string | number | null>;

export interface DiscoveryLegRow {
  symbol: string;
  side: string;
  quantity: number;
  option_type: string;
  strike: number | null;
  expiry: string;
  price: number | null;
}

export interface DiscoveryReportArtifactOutcome {
  pdfKey?: string;
  pdfStatus: "generated" | "failed";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus: "generated" | "failed";
  xlsxError?: string;
  csvKey?: string;
  csvStatus: "generated" | "failed";
  csvError?: string;
}

/** Download links a stored discovery run serves, on the discovery routes. */
export interface DiscoveryReportArtifactLinks {
  pdfKey?: string;
  reportUrl?: string;
  xlsxKey?: string;
  xlsxUrl?: string;
  csvKey?: string;
  csvUrl?: string;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bestCandidate(outcome: DiscoverySymbolOutcome): Record<string, any> | null {
  const candidate =
    (outcome.bestTrade as any)?.best?.candidate ?? (outcome.bestNoViewTrade as any)?.best?.candidate;
  return candidate && typeof candidate === "object" ? candidate : null;
}

function rankedCount(outcome: DiscoverySymbolOutcome): number {
  return (outcome.ranked?.length ?? 0) + (outcome.rankedNoView?.length ?? 0);
}

function verdictOf(outcome: DiscoverySymbolOutcome): DiscoveryVerdict {
  if (outcome.status === "failed") return "failed";
  if (outcome.status === "abstained" || outcome.abstained === true) return "abstained";
  if (rankedCount(outcome) === 0 && !bestCandidate(outcome)) return "no_trade";
  return "fit";
}

function humanStatus(value: unknown): string {
  return typeof value === "string" && value ? value.replaceAll("_", " ") : "";
}

function reasonOf(outcome: DiscoverySymbolOutcome): string {
  if (outcome.error) return outcome.error;
  const status = humanStatus((outcome.bestTrade as any)?.status ?? (outcome.bestNoViewTrade as any)?.status);
  if (status) return status;
  const screenedOut = outcome.screenedOut?.length ?? 0;
  if (screenedOut > 0) return `${screenedOut} structure(s) screened out`;
  return "";
}

/** What ran for this symbol — a saved view, a derived target, or constraints. */
function inputText(outcome: DiscoverySymbolOutcome): string {
  const request: any = outcome.request;
  if (request) {
    const bits = [
      request.thesis ? `thesis ${request.thesis}` : null,
      request.riskProfile ? `risk ${request.riskProfile}` : null,
      typeof request.targetPrice === "number" ? `target ${request.targetPrice}` : null,
    ].filter(Boolean);
    return bits.length > 0 ? bits.join(" · ") : "saved request";
  }
  const derivation: any = outcome.derivation;
  if (derivation) {
    return [
      "profile-derived",
      derivation.thesis ? `thesis ${derivation.thesis}` : null,
      typeof derivation.targetPrice === "number" ? `target ${derivation.targetPrice}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (outcome.constraintSet) {
    const constraints: any = outcome.constraintSet;
    const bits = [
      constraints.riskProfile ? `risk ${constraints.riskProfile}` : null,
      typeof constraints.minDte === "number" ? `DTE ${constraints.minDte}-${constraints.maxDte ?? "?"}` : null,
    ].filter(Boolean);
    return `constraints only (no-view)${bits.length > 0 ? ` · ${bits.join(" · ")}` : ""}`;
  }
  return "—";
}

/** One leg, stated the same way in all three formats. */
export function discoveryLegLine(leg: Record<string, any>): string {
  const quantity = finite(leg?.quantity);
  const side = String(leg?.side ?? ((quantity ?? 0) < 0 ? "SELL" : "BUY")).toUpperCase();
  const qty = Math.abs(quantity ?? 0);
  const type = String(leg?.optionType ?? "OPTION").toUpperCase();
  const strike = leg?.strike ?? "—";
  const expiry = leg?.expirationDate ?? leg?.expiry ?? "—";
  const price = finite(leg?.entryPrice ?? leg?.price);
  return `${side} ${qty} ${type} ${strike} ${expiry}${price === null ? "" : ` @ ${price.toFixed(2)}`}`;
}

function legsText(candidate: Record<string, any> | null): string {
  if (!candidate) return "";
  return ((candidate.legs as Array<Record<string, any>> | undefined) ?? [])
    .map((leg) => discoveryLegLine(leg))
    .join(" · ");
}

export function discoverySymbolRows(input: DiscoveryReportInput): DiscoverySymbolRow[] {
  return (input?.outcomes ?? []).map((outcome) => {
    const candidate = bestCandidate(outcome);
    const verdict = verdictOf(outcome);
    return {
      symbol: String(outcome.symbol ?? ""),
      status: String(outcome.status ?? ""),
      input: inputText(outcome),
      ranked: rankedCount(outcome),
      best_strategy: candidate ? String(candidate.label ?? candidate.type ?? "—") : "—",
      expiration: candidate ? String(candidate.expirationDate ?? "") : "",
      score: candidate
        ? finite((outcome.bestTrade as any)?.best?.compositeScore ?? (outcome.bestNoViewTrade as any)?.best?.compositeScore)
        : null,
      probability_of_profit: candidate ? finite(candidate.modelImpliedProbabilityOfProfit) : null,
      max_loss: candidate ? finite(candidate.maxLoss) : null,
      max_profit: candidate ? finite(candidate.maxProfit ?? candidate.maxGain) : null,
      legs: legsText(candidate),
      verdict,
      reason: reasonOf(outcome),
    };
  });
}

export function discoveryLegRows(input: DiscoveryReportInput): DiscoveryLegRow[] {
  const rows: DiscoveryLegRow[] = [];
  for (const outcome of input?.outcomes ?? []) {
    const candidate = bestCandidate(outcome);
    for (const leg of ((candidate?.legs as Array<Record<string, any>> | undefined) ?? [])) {
      const quantity = finite(leg?.quantity);
      rows.push({
        symbol: String(outcome.symbol ?? ""),
        side: String(leg?.side ?? ((quantity ?? 0) < 0 ? "SELL" : "BUY")).toUpperCase(),
        quantity: Math.abs(quantity ?? 0),
        option_type: String(leg?.optionType ?? "").toUpperCase(),
        strike: finite(leg?.strike),
        expiry: String(leg?.expirationDate ?? leg?.expiry ?? ""),
        price: finite(leg?.entryPrice ?? leg?.price),
      });
    }
  }
  return rows;
}

/** The run-level field/value rows, mirroring the PDF's summary block. */
export function discoverySummaryRows(input: DiscoveryReportInput): Array<[string, string | number | null]> {
  return [
    ["run_id", String(input?.runId ?? "")],
    ["created_at", String(input?.createdAt ?? "")],
    ["trigger", String(input?.trigger ?? "")],
    ["input_model", String(input?.inputModel ?? "")],
    ["status", String(input?.status ?? "")],
    ["symbols", (input?.symbols ?? []).length],
    ["matched", finite(input?.matchedCount)],
    ["scanned", finite(input?.totalScanned)],
    ["summary", String(input?.summary ?? "")],
  ];
}

/** `discovery_<trigger>_<timestamp>_<runId>.<format>`. */
export function discoveryReportFileName(input: DiscoveryReportInput, format: DiscoveryReportFormat): string {
  const createdAt = input?.createdAt ? new Date(input.createdAt) : new Date(0);
  const stamp = Number.isNaN(createdAt.getTime())
    ? "unknown"
    : `${createdAt.toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z`;
  const trigger = String(input?.trigger || "scheduled").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const runId = String(input?.runId || "adhoc").replace(/[^a-zA-Z0-9-]+/g, "").slice(0, 24);
  return `discovery_${trigger}_${stamp}_${runId}.${format}`;
}

/**
 * Map a run's stored keys to the discovery download URLs. A failed leg has
 * no key, so it contributes no link — never a URL that 404s.
 */
export function discoveryReportArtifactLinks(
  outcome: DiscoveryReportArtifactOutcome,
): DiscoveryReportArtifactLinks {
  const links: DiscoveryReportArtifactLinks = {};
  if (outcome.pdfKey) {
    links.pdfKey = outcome.pdfKey;
    links.reportUrl = `/api/discovery/report.pdf?key=${encodeURIComponent(outcome.pdfKey)}`;
  }
  if (outcome.xlsxKey) {
    links.xlsxKey = outcome.xlsxKey;
    links.xlsxUrl = `/api/discovery/report.xlsx?key=${encodeURIComponent(outcome.xlsxKey)}`;
  }
  if (outcome.csvKey) {
    links.csvKey = outcome.csvKey;
    links.csvUrl = `/api/discovery/report.csv?key=${encodeURIComponent(outcome.csvKey)}`;
  }
  return links;
}
