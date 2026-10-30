/**
 * Unified screener report pipeline (issue #914).
 *
 * Single implementation for generate → store → serve → deliver used by:
 * - Stock screener (manual + scheduled)
 * - Options screener (manual + scheduled)
 * - Research runs (issue #1641: generate via generateReportStage;
 *   canonical store + semantic index already lived in researchPublish)
 *
 * Issue #680: PDF generation is owned by ReportAssetAgent (single owner).
 * This pipeline delegates to generatePdfAsset — it does NOT bypass the
 * ReportAssetAgent with direct generator calls.
 *
 * Consolidation C4 (issue #1329, epic #1151): the generate → store
 * fusion is split into separately callable stages, and the serve
 * stage's content is pinned:
 * - generateReportStage — PDF bytes via the ReportAssetAgent (with the
 *   #1278 retry policy). runReportPipeline is this stage's fused
 *   entry and keeps its exact output.
 * - storeReportStage — the shared canonical mas_reports write the
 *   callers previously inlined per run kind (market screen, options
 *   scanner, goal screen, IV collection, discovery).
 * - serveReportStage — serve's schedulable content, verified: the
 *   canonical row exists and every named artifact key resolves.
 *   A stage that cannot verify fails explicitly with its reason;
 *   nothing is fabricated. The #1123 followup.report adoption job is
 *   the serve stage's job form (see asyncJobs.ts).
 * The fused single-call path remains the degenerate case: existing
 * callers of runReportPipeline are unchanged.
 */

import type { ScreenerPdfOptions } from "../trading";

export interface UnifiedReportInput {
  /** "screener" for stock, "options" for options screener, "research" for research runs (#1641) */
  type: "screener" | "options" | "research";
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
  /** Issue #2088: PDF section config, threaded to the screener generator. */
  pdfOptions?: ScreenerPdfOptions;
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

export type ReportAssetKind = "screener" | "options" | "research";

/**
 * Generate the PDF bytes for a report.
 * Dispatches to the type-specific generator. This is the ONE generator
 * dispatch in the repo (consolidation C4, #1329): the ReportAssetAgent
 * calls this instead of the trading generators directly, so the
 * single-PDF-path pin has one definition site.
 * Issue #290: import via the ../trading public surface (index.ts), never
 * a trading-internal path directly.
 * Issue #1731 (R-1/R-2 boundary): the dispatch is EXHAUSTIVE — an
 * unknown type is refused loudly, never silently rendered through the
 * options branch. The old screener-else-options shape silently
 * generated an options PDF for a research input (#1641 fixed that
 * instance by adding the research branch); the remaining else
 * branch would still silently misrender ANY unknown type (notably
 * a goal-screen input, whose pinned path is direct, not pipelined).
 * Typed callers are unaffected: the asset owner accepts only the
 * three pipeline types, and it is this dispatch's only caller.
 */
export async function generateReportPdf(
  type: ReportAssetKind,
  result: unknown,
  pdfOptions?: ScreenerPdfOptions
): Promise<Uint8Array> {
  if (type === "screener") {
    const { generateScreenerPdf } = await import("../trading");
    return generateScreenerPdf(result as any, pdfOptions);
  } else if (type === "research") {
    const { generateResearchPdf } = await import("../trading");
    return generateResearchPdf(result as any);
  } else if (type === "options") {
    const { generateOptionsPdf } = await import("../trading");
    return generateOptionsPdf(result as any);
  }
  throw new Error(
    `Unknown report type: ${String(type)} — the pipeline dispatches only screener, options, and research; goal-screen artifacts use their direct path.`
  );
}

/**
 * Get the PDF filename for a report.
 * Issue #290: import via the ../trading public surface (index.ts).
 * Issue #1731: exhaustive like generateReportPdf above — an unknown
 * type is refused, never silently named as an options report.
 */
export async function getReportFileName(
  type: ReportAssetKind,
  result: unknown
): Promise<string> {
  if (type === "screener") {
    const { screenerPdfFileName } = await import("../trading");
    return screenerPdfFileName(result as any);
  } else if (type === "research") {
    const { researchPdfFileName } = await import("../trading");
    return researchPdfFileName(result as any);
  } else if (type === "options") {
    const { optionsPdfFileName } = await import("../trading");
    return optionsPdfFileName(result as any);
  }
  throw new Error(
    `Unknown report type: ${String(type)} — the pipeline dispatches only screener, options, and research; goal-screen artifacts use their direct path.`
  );
}

/**
 * Generate stage (consolidation C4, #1329): PDF bytes via the
 * ReportAssetAgent + the #1278 retry policy. This is the body
 * runReportPipeline has always executed, extracted so the stage is
 * callable on its own; behavior is identical.
 *
 * Issue #680: PDF generation is owned by ReportAssetAgent (single owner).
 * This stage delegates to generatePdfAsset, which routes through the
 * ReportAssetAgent DO. We do NOT bypass it with direct generator calls.
 */
export async function generateReportStage(
  env: { REPORTS_BUCKET?: unknown; REPORT_ASSET_AGENT?: unknown },
  input: UnifiedReportInput
): Promise<UnifiedReportOutput> {
  const generationId = `${input.type}:${input.trigger}:${input.timestamp}`;
  const { codedMessage, hasOutcomeCodePrefix } = await import("../outcomes/outcomeAspects");

  try {
    // Issue #680: delegate to ReportAssetAgent (single owner for PDF gen).
    const { generatePdfAsset } = await import("../agents/report-asset-agent");
    // Issue #1641: the asset type IS the input type — the old
    // screener-else-options mapping silently generated an OPTIONS pdf
    // for a research input. ReportAssetAgent supports all three.
    const assetType = input.type;
    // Issue #1278 (#1173 R5): retry under the R1 pipeline policy
    // (retry.report — PIPELINE_REPORT_RETRY_* / pipeline.retry.report).
    // generatePdfAsset never throws: null IS its failure signal, so a
    // null asset counts as a failed attempt and is retried like a throw.
    const { resolvePipelinePolicy } = await import("./pipelinePolicy");
    const { withRetry } = await import("./resilience");
    const policy = resolvePipelinePolicy(env as Record<string, unknown>);
    const asset = await withRetry(
      async () => {
        const generated = await generatePdfAsset(env as any, input.userLogin, assetType as any, input.result, input.pdfOptions);
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
      pdfError: hasOutcomeCodePrefix(message) ? message : codedMessage("FAILURE_REPORT_PDF_GENERATION", message),
    };
  }
}

/**
 * Full pipeline entry, kept for existing callers: generate PDF → store
 * blob → return keys. Used by both stock and options screeners, manual
 * and scheduled. Output is identical to before C4 (it is the generate
 * stage); callers that also persist a canonical row keep doing so via
 * storeReportStage below.
 *
 * @param env Worker env (for R2 bucket binding + REPORT_ASSET_AGENT binding)
 * @param storage Blob storage (DO storage; retained for signature
 *   compatibility — the ReportAssetAgent owns blob storage internally)
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
  void storage;
  return generateReportStage(env, input);
}

/** One canonical-report row, as the ORM's storeCanonicalReport takes it. */
export interface CanonicalReportInput {
  runId: string;
  generationId: string;
  title: string;
  source: string;
  summary: string;
  body: unknown;
  createdAt: string;
  /** Owning tenant login — required (multi-tenant SaaS; no "default"). */
  userLogin: string;
}

/**
 * Store stage (consolidation C4, #1329): the ONE canonical mas_reports
 * write. Previously each run kind inlined its own storeCanonicalReport
 * call (market screen, options scanner, goal screen, IV collection);
 * discovery runs wrote none at all. This helper is the shared seam:
 * idempotent on generationId (one row per generation, per #308), and
 * never throws — without an ORM, or on a persistence failure, the
 * absence is returned as null (the caller records it; a missing row
 * must never fail the run that already produced its result).
 */
export function storeReportStage(
  orm: {
    storeCanonicalReport: (
      input: CanonicalReportInput,
      env?: { AI?: any; VECTOR_MEMORY?: any }
    ) => { reportId: string; created: boolean } | null;
  } | null | undefined,
  input: CanonicalReportInput,
  env?: { AI?: any; VECTOR_MEMORY?: any }
): { reportId: string; created: boolean } | null {
  if (!orm || typeof orm.storeCanonicalReport !== "function") return null;
  try {
    return orm.storeCanonicalReport(input, env);
  } catch {
    return null;
  }
}

/**
 * Serve stage (consolidation C4, #1329): serve's schedulable content,
 * verified — the canonical row exists, and every named artifact key
 * resolves. Used by the #1123 followup.report adoption job for runs
 * whose artifact is a canonical row rather than a PDF (discovery,
 * goal screens). Verification failure is explicit (verified: false +
 * reason); nothing is fabricated to pass it.
 */
export async function serveReportStage(input: {
  canonicalReportId?: string;
  pdfKey?: string;
  findCanonicalReport?: (id: string) => unknown | null | Promise<unknown | null>;
  resolvePdfKey?: (key: string) => unknown | null | Promise<unknown | null>;
}): Promise<{ verified: boolean; reason?: string }> {
  if (input.canonicalReportId) {
    if (typeof input.findCanonicalReport !== "function") {
      return { verified: false, reason: "No canonical-report lookup supplied for serve verification." };
    }
    const row = await input.findCanonicalReport(input.canonicalReportId);
    if (!row) {
      return {
        verified: false,
        reason: `Canonical report ${input.canonicalReportId} not found; serve cannot publish a missing record.`,
      };
    }
  }
  if (input.pdfKey) {
    if (typeof input.resolvePdfKey !== "function") {
      return { verified: false, reason: "No artifact resolver supplied for serve verification." };
    }
    const resolved = await input.resolvePdfKey(input.pdfKey);
    if (!resolved) {
      return {
        verified: false,
        reason: `Report artifact key ${input.pdfKey} does not resolve; serve cannot publish a missing artifact.`,
      };
    }
  }
  if (!input.canonicalReportId && !input.pdfKey) {
    return { verified: false, reason: "Nothing to verify: no canonical report id or artifact key was named." };
  }
  return { verified: true };
}
