/**
 * Record a sharded options run at serve time (issue #2091).
 *
 * The sharded chain produces PDF + XLSX + CSV blobs and a serve outcome
 * carrying their keys — but before #2091 it wrote NO canonical row and
 * NO scan-row keys, so Docs and Reports showed nothing for the run
 * (the blobs existed, unlisted). The monolithic path already writes
 * its own canonical row; this helper is the sharded path's equivalent,
 * called from the serve executor's key-adoption path.
 *
 * Writes, both idempotent:
 * - one canonical mas_reports row (generationId `options:<timestamp>`,
 *   so a re-delivery replays to the same row, never a duplicate),
 *   carrying pdfKey/xlsxKey/csvKey + reportUrl in its body;
 * - the Durable Object options history row (timestamp-keyed upsert via
 *   recordOptionsRun), carrying the same keys so /api/options/latest
 *   surfaces them.
 *
 * Failures warn and return false, never fail the serve job: a run that
 * produced artifacts must not fail because its record did not land.
 * The history-row write is attempted even when the canonical write
 * fails — one record landing beats neither.
 */

import { recordOptionsRun } from "../agents/optionsRuns";
import type { ScreenerRunOutcome } from "./screenerFollowups";

export interface OptionsServeRecordDeps {
  orm: {
    storeCanonicalReport: (input: Record<string, unknown>) => { reportId: string; created: boolean } | null;
  };
  storage: unknown;
}

export async function recordOptionsServeReport(
  deps: OptionsServeRecordDeps,
  outcome: ScreenerRunOutcome & { userLogin?: string },
): Promise<boolean> {
  if (outcome.kind !== "options" || !outcome.timestamp) return false;
  const timestamp = outcome.timestamp;
  const pdfKey = outcome.pdfKeys?.[0] ?? null;
  const xlsxKey = outcome.xlsxKey ?? null;
  const csvKey = outcome.csvKey ?? null;
  let canonicalOk = false;
  try {
    const stored = deps.orm.storeCanonicalReport({
      runId: `options:${timestamp}`,
      generationId: `options:${timestamp}`,
      title: `Options scanner — ${outcome.thesis ?? "bullish"}`,
      source: "options_scanner",
      summary: outcome.summary ?? "",
      body: {
        timestamp,
        trigger: outcome.trigger,
        thesis: outcome.thesis ?? "bullish",
        success: outcome.success,
        symbols: outcome.symbols ?? [],
        withTrades: outcome.matchedCount ?? 0,
        opportunities: outcome.opportunities ?? [],
        pdfKey,
        xlsxKey,
        csvKey,
        reportUrl: outcome.reportUrl ?? null,
      },
      createdAt: timestamp,
      ...(outcome.userLogin ? { userLogin: outcome.userLogin } : {}),
    });
    canonicalOk = stored !== null;
    if (!canonicalOk) console.warn(`[optionsServeRecord] canonical write returned null for run ${timestamp}`);
  } catch (err) {
    console.warn(`[optionsServeRecord] canonical write failed for run ${timestamp}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let historyOk = false;
  try {
    await recordOptionsRun(deps.storage, {
      timestamp,
      success: outcome.success,
      trigger: outcome.trigger,
      thesis: outcome.thesis ?? "bullish",
      symbols: outcome.symbols ?? [],
      withTrades: outcome.matchedCount ?? 0,
      summary: outcome.summary ?? "",
      opportunities: (outcome.opportunities ?? []) as unknown[],
      pdfKey,
      xlsxKey,
      csvKey,
      ...(outcome.reportUrl ? { reportUrl: outcome.reportUrl } : {}),
    });
    historyOk = true;
  } catch (err) {
    console.warn(`[optionsServeRecord] history write failed for run ${timestamp}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return canonicalOk && historyOk;
}

/**
 * The orchestrator wrapper's record step (issue #223 history +
 * issue #910 canonical), extracted from OrchestratorAgent so the
 * #992 orchestrator size budget holds: the wrapper calls this with
 * the service result instead of inlining both writes. Semantics are
 * exactly the wrapper's: the history row is always written; the
 * canonical row is skipped when the service already wrote one
 * (canonicalReportId set — issue #2091, otherwise a second keyless
 * row hides the artifacts); failures warn, never throw.
 */
export interface OptionsOrchestratorRun {
  timestamp: string;
  success: boolean;
  trigger: "manual" | "scheduled";
  thesis: string;
  symbols: string[];
  withTrades: number;
  summary: string;
  opportunities: unknown[];
  error?: string;
  pdfKey?: string | null;
  xlsxKey?: string | null;
  csvKey?: string | null;
  reportUrl?: string | null;
  canonicalReportId?: string | null;
  userLogin?: string;
}

export async function recordOptionsOrchestratorRun(
  deps: OptionsServeRecordDeps,
  run: OptionsOrchestratorRun,
): Promise<void> {
  try {
    await recordOptionsRun(deps.storage, {
      timestamp: run.timestamp,
      success: run.success,
      trigger: run.trigger,
      thesis: run.thesis,
      symbols: run.symbols,
      withTrades: run.withTrades,
      summary: run.summary,
      opportunities: run.opportunities.slice(0, 10),
      ...(run.success ? {} : { error: run.error }),
      pdfKey: run.pdfKey ?? null,
      xlsxKey: run.xlsxKey ?? null,
      csvKey: run.csvKey ?? null,
      ...(run.reportUrl ? { reportUrl: run.reportUrl } : {}),
    });
  } catch (err) {
    console.warn("[OrchestratorAgent] Could not persist options run:", err);
  }
  if (run.canonicalReportId) return;
  try {
    deps.orm.storeCanonicalReport({
      runId: `options:${run.timestamp}`,
      generationId: `options:${run.timestamp}`,
      title: `Autonomous options analysis — ${run.thesis} (${run.trigger})`,
      source: "options_scanner",
      summary: run.success
        ? run.summary || `Analyzed ${run.symbols.length} symbols.`
        : `Options analysis failed: ${run.error ?? "unknown error"}.`,
      body: {
        timestamp: run.timestamp,
        trigger: run.trigger,
        thesis: run.thesis,
        success: run.success,
        symbols: run.symbols,
        withTrades: run.withTrades,
        opportunities: run.opportunities,
        error: run.error,
        pdfKey: run.pdfKey ?? null,
        xlsxKey: run.xlsxKey ?? null,
        csvKey: run.csvKey ?? null,
        reportUrl: run.reportUrl ?? null,
      },
      createdAt: new Date().toISOString(),
      ...(run.userLogin ? { userLogin: run.userLogin } : {}),
    });
  } catch (err) {
    console.warn("[OrchestratorAgent] Could not store options report canonical:", err);
  }
}
