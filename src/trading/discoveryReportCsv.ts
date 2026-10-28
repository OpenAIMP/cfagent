/**
 * Discovery-run CSV (#2180): the machine-readable mirror of the workbook's
 * `Symbols` tab — one row per symbol, the same 13 columns in the same order.
 */

import {
  DISCOVERY_SYMBOL_COLUMNS,
  discoverySymbolRows,
  type DiscoveryReportInput,
} from "./discoveryReportData";

function csvEscape(value: string | number | null): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function generateDiscoveryReportCsv(input: DiscoveryReportInput): string {
  const lines = [
    DISCOVERY_SYMBOL_COLUMNS.join(","),
    ...discoverySymbolRows(input).map((row) =>
      DISCOVERY_SYMBOL_COLUMNS.map((column) => csvEscape(row[column])).join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}
