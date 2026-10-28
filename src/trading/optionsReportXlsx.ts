/**
 * Options scanner XLSX report generator (issue #1195, #1173 R3b).
 *
 * The options leg of the delivery-completeness requirement: stock
 * runs have carried a per-run XLSX since #953; options runs had
 * none, so their deliveries could never attach text + PDF + XLSX.
 * This mirrors screenerReportXlsx.ts on the same @e965/xlsx stack:
 *   - Tab 1: "Screened Contracts" — one row per matched contract
 *     with quotes, greeks, and screening context.
 *   - Tab 2: "Run Summary & Methodology" — the run's parameters,
 *     counts, provenance, and quality notes, so the workbook is
 *     self-describing exactly like the stock one.
 */

import * as XLSX from "@e965/xlsx";
import type { OptionScreenResult, ScreenedOptionContractItem } from "../types";
// Type-only: the adapter maps the opportunity-scan shape to the workbook
// shape, so importing the scanner module here costs nothing at runtime.
import type { OpportunityScanResult } from "./options/opportunityScanner";
import type { StrategyCandidate } from "./options/strategyEngine";
import { buildNamesByStrategyRows } from "./optionsReportMatrix";

function num(value: number | undefined, digits = 2): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : null;
}

export function generateOptionsXlsx(result: OptionScreenResult): Uint8Array {
  const wb = XLSX.utils.book_new();

  // Tab 1: Screened Contracts
  const contracts = Array.isArray(result.contracts) ? result.contracts : [];
  const rows = contracts.map((c) => ({
    "Underlying": c.underlyingSymbol || c.symbol || "",
    "Underlying Price": num(c.underlyingPrice),
    "Type": c.optionType || "",
    "Strike": num(c.strikePrice),
    "Expiration": c.expirationDate || "",
    "DTE": c.daysToExpiration ?? null,
    "Moneyness": c.moneyness || "",
    "Bid": num(c.bid),
    "Ask": num(c.ask),
    "Last": num((c as { lastPrice?: number }).lastPrice),
    "Spread %": num(c.spreadPct, 1),
    "Volume": c.volume ?? null,
    "Open Interest": c.openInterest ?? null,
    "Vol/OI": num(c.volumeOiRatio, 2),
    "IV %": typeof c.impliedVolatility === "number" ? Number((c.impliedVolatility * 100).toFixed(1)) : null,
    "Delta": num(c.delta, 3),
    "Gamma": num(c.gamma, 3),
    "Theta": num(c.theta, 3),
    "Vega": num(c.vega, 3),
    "Quote Freshness": c.quoteFreshness || "",
    "Technical Signal": c.technicalSignal || "",
    "Highlight": c.highlightReason || "",
  }));
  const wsContracts = XLSX.utils.json_to_sheet(
    rows.length > 0 ? rows : [{ "Underlying": "(no contracts matched)" }]
  );
  wsContracts["!cols"] = [
    { wch: 11 }, { wch: 13 }, { wch: 7 }, { wch: 10 }, { wch: 12 },
    { wch: 6 }, { wch: 10 }, { wch: 9 }, { wch: 9 }, { wch: 9 },
    { wch: 9 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 8 },
    { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 13 },
    { wch: 18 }, { wch: 40 },
  ];
  XLSX.utils.book_append_sheet(wb, wsContracts, "Screened Contracts");

  // Tab 2: Run Summary & Methodology
  const summaryRows: Array<{ Field: string; Value: string }> = [
    { Field: "Scanned at", Value: result.scannedAt || "" },
    { Field: "Filter summary", Value: result.filterSummary || "" },
    { Field: "Underlyings scanned", Value: String(result.totalUnderlyingsScanned ?? "") },
    { Field: "Contracts evaluated", Value: String(result.totalContractsEvaluated ?? "") },
    { Field: "Contracts matched", Value: String(result.matchedCount ?? contracts.length) },
    ...(typeof result.totalMatches === "number"
      ? [{ Field: "Total matches (before limit)", Value: String(result.totalMatches) }]
      : []),
    ...(typeof result.rejectionCount === "number"
      ? [{ Field: "Contracts rejected", Value: String(result.rejectionCount) }]
      : []),
    { Field: "Data source", Value: result.dataSource || "live" },
    ...(result.quoteQuality
      ? [
          { Field: "Stale contracts returned", Value: String(result.quoteQuality.staleContractsReturned ?? 0) },
          { Field: "Unknown-freshness contracts", Value: String(result.quoteQuality.unknownFreshnessContracts ?? 0) },
        ]
      : []),
    { Field: "Status", Value: result.status || "" },
    // Issue #1291: the R6 partial qualification (same `(result as any)
    // .partial` convention the options PDF uses) renders as the Coverage
    // row — wording mirrors optionsPartialBanner's counts line.
    ...(() => {
      const partial = (result as unknown as {
        partial?: {
          evaluatedCount: number;
          consideredCount: number;
          coverageErrors: number;
          truncatedCount: number;
          topSkipReason?: string;
        };
      }).partial;
      if (!partial) return [];
      return [
        {
          Field: "Coverage",
          Value:
            `Qualified partial: ${partial.evaluatedCount} of ${partial.consideredCount} underlyings evaluated; ` +
            `${partial.coverageErrors} quote/chain failures, ${partial.truncatedCount} truncated.` +
            (partial.topSkipReason ? ` Top skip reason: ${partial.topSkipReason}.` : "") +
            " Results cover the evaluated subset only.",
        },
      ];
    })(),
    ...((result.warnings ?? []).map((w, i) => ({ Field: `Warning ${i + 1}`, Value: w }))),
    {
      Field: "Methodology",
      Value:
        "Contracts are screened from live E*TRADE option chains against the run's filter (DTE, delta, IV, spread, volume, open interest). Greeks and IV are the broker's chain values at scan time. Quote freshness labels (FRESH/STALE/UNKNOWN) reflect each contract's quote age against the run's reference threshold.",
    },
  ];
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary["!cols"] = [{ wch: 30 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, "Run Summary & Methodology");

  // Issue #2091 matrix tabs: the two directions of the chain-vs-
  // strategies evaluation, as full rows (no caps — a workbook is not
  // a page). Rendered only when the run carries a matrix; manual runs
  // without a scan and legacy rows keep the two-tab shape. Read
  // through the scan type (this module is inside src/trading, so the
  // #290 boundary allows it) — the fields ride the result object
  // via the adapter's cast, not via OptionScreenResult.
  const scan = result as unknown as Partial<OpportunityScanResult>;
  if (Array.isArray(scan.matrix) && scan.matrix.length > 0) {
    const byNameRows = scan.matrix.flatMap((row) =>
      row.cells.map((cell) => ({
        "Symbol": row.symbol,
        "Strategy Type": cell.strategyType,
        "Evaluated": cell.evaluatedCount,
        "Passed": cell.passedCount,
        "Rejected": cell.rejectedCount,
        "Best Label": cell.best?.label ?? "",
        "Best Composite": cell.best?.compositeScore ?? null,
        "Best Score": cell.best?.score ?? null,
        "Best Expiry": cell.best?.expirationDate ?? "",
        "Rejection Reasons": Object.entries(cell.rejectionReasons ?? {})
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([reason, count]) => (count > 1 ? `${reason} (×${count})` : reason))
          .join("; "),
      })),
    );
    const wsByName = XLSX.utils.json_to_sheet(
      byNameRows.length > 0 ? byNameRows : [{ "Symbol": "(no strategy cells)" }],
    );
    wsByName["!cols"] = [
      { wch: 11 }, { wch: 20 }, { wch: 10 }, { wch: 8 }, { wch: 9 },
      { wch: 30 }, { wch: 13 }, { wch: 11 }, { wch: 12 }, { wch: 60 },
    ];
    XLSX.utils.book_append_sheet(wb, wsByName, "Strategies by Name");
    if (Array.isArray(scan.typeRollup) && scan.typeRollup.length > 0) {
      const byStrategyRows = buildNamesByStrategyRows(scan.typeRollup).map((row) => ({
        "Strategy Type": row.strategyType,
        "Label": row.label,
        "Symbols Evaluated": row.symbolsEvaluated,
        "Symbols Passed": row.symbolsPassed,
        "Evaluated": row.evaluatedCount,
        "Passed": row.passedCount,
        "Rejected": row.rejectedCount,
        "Best Symbol": row.bestSymbol ?? "",
        "Best Label": row.bestLabel ?? "",
        "Best Composite": row.bestComposite ?? null,
      }));
      const wsByStrategy = XLSX.utils.json_to_sheet(byStrategyRows);
      wsByStrategy["!cols"] = [
        { wch: 20 }, { wch: 30 }, { wch: 17 }, { wch: 14 }, { wch: 10 },
        { wch: 8 }, { wch: 9 }, { wch: 12 }, { wch: 30 }, { wch: 13 },
      ];
      XLSX.utils.book_append_sheet(wb, wsByStrategy, "Names by Strategy");
    }
    const coverage = scan.strategyCoverage as
      | { scope?: string; evaluatedStrategyIds?: string[]; notEvaluated?: Array<{ id: string; label: string; reason: string }> }
      | undefined;
    if (coverage) {
      const coverageRows: Array<{ Field: string; Value: string }> = [
        {
          Field: "Strategy coverage",
          Value: `${coverage.scope === "all" ? "All wanted strategies" : "Thesis strategies"}: ${(coverage.evaluatedStrategyIds ?? []).length} evaluated, ${(coverage.notEvaluated ?? []).length} not evaluated.`,
        },
        ...((coverage.notEvaluated ?? []).map((entry) => ({
          Field: "Not evaluated strategy",
          Value: `${entry.id} (${entry.label}) — ${entry.reason}`,
        }))),
      ];
      const wsCoverage = XLSX.utils.json_to_sheet(coverageRows);
      wsCoverage["!cols"] = [{ wch: 30 }, { wch: 110 }];
      XLSX.utils.book_append_sheet(wb, wsCoverage, "Strategy Coverage");
    }
  }

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buffer);
}

/**
 * Issue #1291 (R3b follow-up): adapt a scheduled opportunity-scan
 * result to the workbook's OptionScreenResult input.
 *
 * The scheduled path runs the unified opportunity scan, whose
 * opportunities are per-symbol best-trade STRATEGY picks (multi-leg
 * candidates), not the single screened contracts generateOptionsXlsx
 * reads. Passing the scan straight in rendered "(no contracts
 * matched)" and empty summary fields on good runs. This adapter sits
 * at the scheduled seam only; the manual route already produces a
 * true OptionScreenResult and passes through untouched (a result that
 * already carries a contracts array is returned as-is).
 *
 * Mapping, all from the scan's own fields (nothing invented):
 * - One workbook row per opportunity WITH a best pick, from the
 *   pick's first non-STOCK leg (a covered-call-style pick's stock leg
 *   is not a contract; a pick with no option leg yields no row).
 *   Strike/expiry/greeks/quote fields come from that leg; moneyness
 *   and strike distance use the screener's own formulas (strict spot
 *   comparison for moneyness — the adapter has no ATM-band config —
 *   and |strike − spot| / spot × 100 for distance); lastPrice is the
 *   leg's entry price, the leg's own price field.
 * - Summary counts from coverage/scanned/generatedAt: underlyings
 *   scanned = coverage.scanned (falling back to the top-level
 *   scanned count); contracts evaluated = coverage.evaluated — the
 *   opportunity scan evaluates symbols, not individual contracts,
 *   and the column carries that evaluated count.
 * - Status from withTrades (any actionable setup, or any adapted
 *   row, means matches_found).
 * - Warnings carry the scan's assumption disclosures verbatim.
 * - The R6 partial qualification rides on the result (same
 *   `(result as any).partial` convention the options PDF uses) so
 *   the generator renders it as the Coverage row.
 */
export function adaptOpportunityScanToOptionScreenResult(
  scan: OpportunityScanResult,
): OptionScreenResult {
  const input = scan as unknown as Record<string, unknown>;
  if (input && Array.isArray(input.contracts)) {
    return scan as unknown as OptionScreenResult;
  }
  const opportunities = Array.isArray(input?.opportunities)
    ? (input.opportunities as Array<Record<string, any>>)
    : [];
  const coverage = (input?.coverage ?? {}) as Record<string, number | undefined>;
  const snapshot = (input?.requestSnapshot ?? {}) as {
    template?: { thesis?: string };
    mode?: string;
    riskProfile?: string;
  };
  const contracts: ScreenedOptionContractItem[] = [];
  for (const row of opportunities) {
    const candidate = row?.pick?.best?.candidate as StrategyCandidate | undefined;
    if (!candidate) continue;
    const legs = Array.isArray(candidate.legs) ? candidate.legs : [];
    const leg = legs.find((l) => l.optionType !== "STOCK");
    if (!leg) continue;
    const spot = typeof row.underlyingPrice === "number" ? row.underlyingPrice : 0;
    const strike = leg.strike;
    const strikeDistancePct =
      spot > 0 ? Number((Math.abs(strike - spot) / spot * 100).toFixed(2)) : 0;
    const moneyness: "ITM" | "OTM" | "ATM" =
      leg.optionType === "CALL"
        ? strike < spot ? "ITM" : strike > spot ? "OTM" : "ATM"
        : strike > spot ? "ITM" : strike < spot ? "OTM" : "ATM";
    const daysToExpiration =
      leg.daysToExpiration ??
      (() => {
        const gen = typeof input.generatedAt === "string" ? Date.parse(input.generatedAt) : NaN;
        const exp = Date.parse(leg.expirationDate);
        return Number.isFinite(gen) && Number.isFinite(exp)
          ? Math.max(0, Math.round((exp - gen) / 86400000))
          : 0;
      })();
    contracts.push({
      symbol: leg.symbol,
      underlyingSymbol: row.symbol ?? "",
      underlyingPrice: spot,
      optionType: leg.optionType as "CALL" | "PUT",
      strikePrice: strike,
      expirationDate: leg.expirationDate,
      daysToExpiration,
      moneyness,
      strikeDistancePct,
      spreadPct: leg.spreadPct,
      bid: leg.bid,
      ask: leg.ask,
      lastPrice: leg.entryPrice,
      volume: leg.volume,
      openInterest: leg.openInterest,
      volumeOiRatio:
        leg.openInterest && leg.openInterest > 0 && leg.volume !== undefined
          ? Number((leg.volume / leg.openInterest).toFixed(2))
          : undefined,
      impliedVolatility: leg.impliedVolatility,
      delta: leg.delta,
      gamma: leg.gamma,
      theta: leg.theta,
      vega: leg.vega,
      quoteFreshness: leg.quoteFreshness,
      technicalSignal: "",
      highlightReason:
        `${candidate.label} (strategy pick, gate ${row.gateBucket ?? "unknown"}${typeof row.score === "number" ? `, score ${row.score}` : ""})`,
    });
  }
  const filterParts = [
    "Opportunity scan",
    snapshot.template?.thesis ? `thesis ${snapshot.template.thesis}` : undefined,
    snapshot.mode ? `mode ${snapshot.mode}` : undefined,
    snapshot.riskProfile ? `risk ${snapshot.riskProfile}` : undefined,
  ].filter(Boolean);
  const adapted: OptionScreenResult = {
    totalUnderlyingsScanned: coverage.scanned ?? (typeof input.scanned === "number" ? input.scanned : 0),
    totalContractsEvaluated: coverage.evaluated ?? 0,
    matchedCount: contracts.length,
    filterApplied: {} as OptionScreenResult["filterApplied"],
    filterSummary: filterParts.join(" · "),
    contracts,
    scannedAt:
      typeof input.generatedAt === "string" ? input.generatedAt : new Date().toISOString(),
    dataSource: "live",
    status:
      (typeof input.withTrades === "number" && input.withTrades > 0) || contracts.length > 0
        ? "matches_found"
        : "no_matches",
    warnings: Array.isArray(input.assumptions) ? [...(input.assumptions as string[])] : [],
  };
  if (input.partial !== undefined) {
    (adapted as unknown as { partial: unknown }).partial = input.partial;
  }
  // Issue #2091: carry the scan's matrix views through — the report
  // builders render them when present and render nothing when absent
  // (manual runs without a scan, legacy rows). Attached via cast:
  // OptionScreenResult deliberately does NOT declare these fields —
  // the #290 trading boundary forbids src/types.ts from importing
  // trading-internal paths, and the builders (inside src/trading)
  // read them through the OpportunityScanResult type instead.
  const attached = adapted as unknown as Partial<OpportunityScanResult>;
  if (Array.isArray(input.matrix)) attached.matrix = input.matrix as OpportunityScanResult["matrix"];
  if (Array.isArray(input.typeRollup)) attached.typeRollup = input.typeRollup as OpportunityScanResult["typeRollup"];
  if (input.strategyCoverage !== undefined) attached.strategyCoverage = input.strategyCoverage as OpportunityScanResult["strategyCoverage"];
  if (typeof input.fetchedMaxDte === "number") attached.fetchedMaxDte = input.fetchedMaxDte;
  return adapted;
}

/** Standard filename for an options run's XLSX report. */
export function optionsXlsxFileName(result: { scannedAt?: string }): string {
  const ts = (result.scannedAt || new Date().toISOString()).slice(0, 10);
  return `options-report-${ts}.xlsx`;
}

/** Helper for tests */
export function parseOptionsXlsx(bytes: Uint8Array): XLSX.WorkBook {
  return XLSX.read(bytes, { type: "array" });
}
