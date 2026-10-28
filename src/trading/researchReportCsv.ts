/**
 * Research-run CSV (#2167).
 *
 * The machine-readable mirror of the workbook's `Ideas` tab: one row per
 * ranked idea, the same 15 columns in the same order, so a spreadsheet,
 * a notebook and a diff all agree with the PDF.
 */

import type { ResearchReport } from "../services/researchPipeline";
import { RESEARCH_IDEA_COLUMNS, researchIdeaRows } from "./researchReportData";

function csvEscape(value: string | number | null): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function generateResearchReportCsv(report: ResearchReport): string {
  const lines = [
    RESEARCH_IDEA_COLUMNS.join(","),
    ...researchIdeaRows(report).map((row) =>
      RESEARCH_IDEA_COLUMNS.map((column) => csvEscape(row[column])).join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}
