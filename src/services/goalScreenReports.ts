/**
 * Goal-screen report artifacts (issue #1335, job-truth program #1332).
 *
 * A completed goal-screen run produces a real report even with 0
 * records: PDF + CSV + XLSX, generated from the run result and stored
 * through the shared blob store (R2 when bound, DO-storage base64
 * otherwise — the same store the stock/options artifacts use).
 *
 * The 0-record case is the point: an empty report states its counts
 * and carries 0 data rows; it never skips, and a generation failure
 * is recorded per format (REPORT_001) without failing the run — the
 * #1278 (R5) failure contract, applied to goal-screen artifacts.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "@e965/xlsx";
import type { GoalDrivenScreenResult } from "./goalDrivenScreen";

export type GoalScreenArtifactFormat = "pdf" | "xlsx" | "csv";

export const GOAL_SCREEN_CSV_HEADERS = [
  "symbol",
  "asset_class",
  "provider_id",
  "structures",
] as const;

export const GOAL_SCREEN_ARTIFACT_PREFIX = "goal_screen:";

export function goalScreenArtifactKey(
  format: GoalScreenArtifactFormat,
  id: string
): string {
  return `${GOAL_SCREEN_ARTIFACT_PREFIX}${format}:${id}`;
}

export function isGoalScreenArtifactKey(key: string): boolean {
  return key.startsWith(GOAL_SCREEN_ARTIFACT_PREFIX);
}

export function goalScreenFileName(
  format: GoalScreenArtifactFormat,
  result: GoalDrivenScreenResult
): string {
  return `goal-screen-${result.goalKind}-${result.outlook}.${format}`;
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function hitRows(result: GoalDrivenScreenResult): string[][] {
  return result.hits.map((h) => [
    h.symbol,
    h.assetClass,
    h.providerId,
    (h.structures ?? []).join(";"),
  ]);
}

/** CSV: header row plus one row per hit; headers only at 0 records. */
export function generateGoalScreenCsv(result: GoalDrivenScreenResult): string {
  const lines = [
    GOAL_SCREEN_CSV_HEADERS.join(","),
    ...hitRows(result).map((row) => row.map(csvEscape).join(",")),
  ];
  return lines.join("\n") + "\n";
}

/** XLSX: a Hits sheet (headers + rows) and a Summary sheet (counts). */
export function generateGoalScreenXlsx(result: GoalDrivenScreenResult): Uint8Array {
  const wb = XLSX.utils.book_new();
  const wsHits = XLSX.utils.aoa_to_sheet([
    [...GOAL_SCREEN_CSV_HEADERS],
    ...hitRows(result),
  ]);
  XLSX.utils.book_append_sheet(wb, wsHits, "Hits");
  const wsSummary = XLSX.utils.aoa_to_sheet([
    ["field", "value"],
    ["goal", result.goalKind],
    ["outlook", result.outlook],
    ["status", result.status],
    ["stocks_scanned", result.counts.stocksScanned],
    ["stocks_matched", result.counts.stocksMatched],
    ["options_underlyings_scanned", result.counts.optionsUnderlyingsScanned],
    ["options_contracts_matched", result.counts.optionsContractsMatched],
    ["hits", result.counts.hits],
  ]);
  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Uint8Array;
}

/** PDF: title, outcome, counts, and the hit list (or the 0-record note). */
export async function generateGoalScreenPdf(
  result: GoalDrivenScreenResult
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([612, 792]);
  let y = 752;
  const draw = (text: string, size: number, useBold = false, color = rgb(0, 0, 0)) => {
    if (y < 56) {
      page = doc.addPage([612, 792]);
      y = 752;
    }
    page.drawText(text, { x: 48, y, size, font: useBold ? bold : font, color });
    y -= size + 9;
  };
  draw(`Goal screen — ${result.goalKind} (${result.outlook})`, 16, true);
  draw(`Status: ${result.status}  ·  Completed: ${result.completedAt}`, 10);
  draw(
    `Stocks scanned: ${result.counts.stocksScanned}  ·  Stocks matched: ${result.counts.stocksMatched}`,
    10
  );
  draw(
    `Options underlyings scanned: ${result.counts.optionsUnderlyingsScanned}  ·  Contracts matched: ${result.counts.optionsContractsMatched}`,
    10
  );
  draw(`Records: ${result.counts.hits}`, 12, true);
  if (result.hits.length === 0) {
    draw("No records matched this goal screen.", 10, false, rgb(0.4, 0.4, 0.4));
  } else {
    draw("Hits:", 12, true);
    const shown = result.hits.slice(0, 100);
    for (const h of shown) {
      draw(
        `${h.symbol} — ${h.assetClass}${h.structures?.length ? ` (${h.structures.join(", ")})` : ""}`,
        10
      );
    }
    if (result.hits.length > shown.length) {
      draw(`... and ${result.hits.length - shown.length} more`, 10);
    }
  }
  return doc.save();
}

export interface GoalScreenArtifactOutcome {
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

interface BlobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/**
 * Generate + store all three artifacts for a goal-screen result, each
 * retried under the R1 report policy. A per-format failure is recorded
 * on the outcome (REPORT_001) and never throws — the run completed,
 * the artifact did not.
 */
export async function generateAndStoreGoalScreenArtifacts(
  env: { REPORTS_BUCKET?: unknown },
  storage: BlobStorage,
  result: GoalDrivenScreenResult
): Promise<GoalScreenArtifactOutcome> {
  const { putReportPdf } = await import("./reportBlobStore");
  const { resolvePipelinePolicy } = await import("./pipelinePolicy");
  const { withRetry } = await import("./resilience");
  const { codedMessage } = await import("../errors/errorAspects");
  const policy = resolvePipelinePolicy(env as Record<string, unknown>);
  const contentTypes: Record<GoalScreenArtifactFormat, string> = {
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
  };
  const outcome: GoalScreenArtifactOutcome = {
    pdfStatus: "failed",
    xlsxStatus: "failed",
    csvStatus: "failed",
  };
  const formats: GoalScreenArtifactFormat[] = ["pdf", "xlsx", "csv"];
  for (const format of formats) {
    const statusKey = `${format}Status` as "pdfStatus" | "xlsxStatus" | "csvStatus";
    const keyKey = `${format}Key` as "pdfKey" | "xlsxKey" | "csvKey";
    const errorKey = `${format}Error` as "pdfError" | "xlsxError" | "csvError";
    try {
      const key = goalScreenArtifactKey(format, crypto.randomUUID().slice(0, 8));
      const bytes =
        format === "pdf"
          ? await generateGoalScreenPdf(result)
          : format === "xlsx"
            ? generateGoalScreenXlsx(result)
            : new TextEncoder().encode(generateGoalScreenCsv(result));
      await withRetry(
        async () => {
          await putReportPdf(
            env as { REPORTS_BUCKET?: R2Bucket },
            storage,
            key,
            goalScreenFileName(format, result),
            bytes,
            contentTypes[format]
          );
        },
        policy.retry.report,
        { label: `goal-screen-artifact:${format}` }
      );
      outcome[keyKey] = key;
      outcome[statusKey] = "generated";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome[statusKey] = "failed";
      outcome[errorKey] = message.startsWith("[REPORT_")
        ? message
        : codedMessage("REPORT_001", message);
      console.error(`[GoalScreenReports] ${format} artifact failed:`, outcome[errorKey]);
    }
  }
  return outcome;
}
