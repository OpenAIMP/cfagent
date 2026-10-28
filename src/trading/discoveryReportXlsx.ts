/**
 * Discovery-run workbook (#2180).
 *
 * `Symbols` is the per-symbol ledger (the CSV's exact table), `Legs` the best
 * pick's legs one row each, `Run Summary` the run identity and counts. An
 * empty run still yields headers on every tab.
 */

import * as XLSX from "@e965/xlsx";
import {
  DISCOVERY_SYMBOL_COLUMNS,
  discoveryLegRows,
  discoverySummaryRows,
  discoverySymbolRows,
  type DiscoveryReportInput,
} from "./discoveryReportData";

const LEG_COLUMNS = ["symbol", "side", "quantity", "option_type", "strike", "expiry", "price"] as const;

function sheet<T extends Record<string, unknown>>(rows: T[], header: readonly string[]): XLSX.WorkSheet {
  return XLSX.utils.json_to_sheet(rows, { header: header as string[] });
}

export function generateDiscoveryReportXlsx(input: DiscoveryReportInput): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(discoverySymbolRows(input), DISCOVERY_SYMBOL_COLUMNS), "Symbols");
  XLSX.utils.book_append_sheet(wb, sheet(discoveryLegRows(input) as any, LEG_COLUMNS), "Legs");
  const summary = XLSX.utils.aoa_to_sheet([["field", "value"], ...discoverySummaryRows(input)]);
  XLSX.utils.book_append_sheet(wb, summary, "Run Summary");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Uint8Array;
}
