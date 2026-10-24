/**
 * Unified screener report pipeline (issue #914).
 *
 * Single implementation for generate → store → serve → deliver used by:
 * - Stock screener (manual + scheduled)
 * - Options screener (manual + scheduled)
 *
 * Issue #680: PDF generation is owned by ReportAssetAgent (single owner).
 * This pipeline delegates to generatePdfAsset — it does NOT bypass the
 * ReportAssetAgent with direct generator calls.
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
 * Issue #290: import via the ../trading public surface (index.ts), never
 * a trading-internal path directly.
 */
export async function generateReportPdf(
  type: "screener" | "options",
  result: unknown
): Promise<Uint8Array> {
  if (type === "screener") {
    const { generateScreenerPdf } = await import("../trading");
    return generateScreenerPdf(result as any);
  } else {
    const { generateOptionsPdf } = await import("../trading");
    return generateOptionsPdf(result as any);
  }
}

/**
 * Get the PDF filename for a report.
 * Issue #290: import via the ../trading public surface (index.ts).
 */
export async function getReportFileName(
  type: "screener" | "options",
  result: unknown
): Promise<string> {
  if (type === "screener") {
    const { screenerPdfFileName } = await import("../trading");
    return screenerPdfFileName(result as any);
  } else {
    const { optionsPdfFileName } = await import("../trading");
    return optionsPdfFileName(result as any);
  }
}

/**
 * Full pipeline: generate PDF → store blob → return keys.
 * Used by both stock and options screeners, manual and scheduled.
 *
 * Issue #680: PDF generation is owned by ReportAssetAgent (single owner).
 * This pipeline delegates to generatePdfAsset, which routes through the
 * ReportAssetAgent DO. We do NOT bypass it with direct generator calls.
 *
 * @param env Worker env (for R2 bucket binding + REPORT_ASSET_AGENT binding)
 * @param storage Blob storage (DO storage)
 * @param input Report details
 */
export async function runReportPipeline(
  env: { REPORTS_BUCKET?: unknown; REPORT_ASSET_AGENT?: unknown },
  storage: {
    put: (key: string, value: unknown) => Promise<void>;
    get: (key: string) => Promise<unknown>;
  },
  input: UnifiedReportInput
): Promise<UnifiedReportOutput> {
  const generationId = `${input.type}:${input.trigger}:${input.timestamp}`;
  const { codedMessage } = await import("../errors/errorAspects");

  try {
    // Issue #680: delegate to ReportAssetAgent (single owner for PDF gen).
    const { generatePdfAsset } = await import("../agents/report-asset-agent");
    const assetType = input.type === "screener" ? "screener" : "options";
    // Issue #1278 (#1173 R5): retry under the R1 pipeline policy
    // (retry.report — PIPELINE_REPORT_RETRY_* / pipeline.retry.report).
    // generatePdfAsset never throws: null IS its failure signal, so a
    // null asset counts as a failed attempt and is retried like a throw.
    const { resolvePipelinePolicy } = await import("./pipelinePolicy");
    const { withRetry } = await import("./resilience");
    const policy = resolvePipelinePolicy(env as Record<string, unknown>);
    const asset = await withRetry(
      async () => {
        const generated = await generatePdfAsset(env as any, input.userLogin, assetType as any, input.result);
        if (!generated) {
          throw new Error("generatePdfAsset returned null");
        }
        return generated;
      },
      policy.retry.report,
      {
        label: `report-pdf:${input.type}/${input.trigger}`,
        onRetry: (event) => {
          console.warn(
            `[UnifiedReport] PDF generation attempt ${event.attempt} failed (${input.type}/${input.trigger}):`,
            event.error,
            `— retrying in ${Math.round(event.delayMs)}ms`
          );
        },
      }
    );

    return {
      pdfKey: asset.key,
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
      // Issue #1252 (R4): the recorded error carries its catalog code.
      pdfError: message.startsWith("[REPORT_") ? message : codedMessage("REPORT_001", message),
    };
  }
}
