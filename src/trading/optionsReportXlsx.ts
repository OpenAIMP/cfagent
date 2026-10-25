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
import type { OptionScreenResult } from "../types";

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

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buffer);
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
