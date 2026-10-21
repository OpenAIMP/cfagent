/**
 * Unified screener report pipeline (issue #914).
 *
 * Single implementation for generate → store → serve → deliver used by:
 * - Stock screener (manual + scheduled)
 * - Options screener (manual + scheduled)
 *
 * Before this, each path had its own PDF generation, storage, and serving
 * logic. Now they all funnel through here.
 */

export interface UnifiedReportInput {
  /** "screener" for stock, "options" for options screener */
  type: "screener" | "options";
  /** "manual" or "scheduled" */
  trigger: "manual" | "scheduled";
  /** The run result data (type-specific) */
  result: unknown;
  /** User login for scoping */
  userLogin: string;
  /** Human-readable title */
  title: string;
  /** Summary text */
  summary: string;
  /** Timestamp ISO string */
  timestamp: string;
}

export interface UnifiedReportOutput {
  /** PDF storage key (for download URL construction) */
  pdfKey: string;
  /** Generation ID (for mas_reports) */
  generationId: string;
  /** Whether PDF generation succeeded */
  pdfStatus: "generated" | "failed";
  pdfError?: string;
}

/**
 * Generate the PDF bytes for a screener report.
 * Dispatches to the type-specific generator.
 */
export async function generateReportPdf(
  type: "screener" | "options",
  result: unknown
): Promise<Uint8Array> {
  if (type === "screener") {
    const { generateScreenerPdf } = await import("../trading/screenerReportPdf");
    return generateScreenerPdf(result as any);
  } else {
    const { generateOptionsPdf } = await import("../trading/optionsReportPdf");
    return generateOptionsPdf(result as any);
  }
}

/**
 * Get the PDF filename for a report.
 */
export async function getReportFileName(
  type: "screener" | "options",
  result: unknown
): Promise<string> {
  if (type === "screener") {
    const { screenerPdfFileName } = await import("../trading/screenerReportPdf");
    return screenerPdfFileName(result as any);
  } else {
    const { optionsPdfFileName } = await import("../trading/optionsReportPdf");
    return optionsPdfFileName(result as any);
  }
}

/**
 * Full pipeline: generate PDF → store blob → return keys.
 * Used by both stock and options screeners, manual and scheduled.
 *
 * @param env Worker env (for R2 bucket binding)
 * @param storage Blob storage (DO storage)
 * @param input Report details
 */
export async function runReportPipeline(
  env: { REPORTS_BUCKET?: unknown },
  storage: {
    put: (key: string, value: unknown) => Promise<void>;
    get: (key: string) => Promise<unknown>;
  },
  input: UnifiedReportInput
): Promise<UnifiedReportOutput> {
  const { putReportPdf } = await import("./reportBlobStore");

  const generationId = `${input.type}:${input.trigger}:${input.timestamp}`;

  try {
    const bytes = await generateReportPdf(input.type, input.result);
    const fileName = await getReportFileName(input.type, input.result);
    const pdfKey = `report:pdf:${input.type}:${input.timestamp}`;

    await putReportPdf(
      env as any,
      storage as any,
      pdfKey,
      fileName,
      bytes
    );

    return {
      pdfKey,
      generationId,
      pdfStatus: "generated",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[UnifiedReport] PDF generation failed (${input.type}/${input.trigger}):`, message);
    return {
      pdfKey: "",
      generationId,
      pdfStatus: "failed",
      pdfError: message,
    };
  }
}
