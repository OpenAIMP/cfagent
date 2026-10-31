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
import { recordJobOutcome } from "./jobOutcomes";
import type { SqlStorage } from "../orm";
import type { ScreenerRunOutcome } from "./screenerFollowups";

export interface OptionsServeRecordDeps {
  orm: {
    storeCanonicalReport: (input: Record<string, unknown>) => { reportId: string; created: boolean } | null;
    /** The DO SQLite behind the ORM — the job-outcome sink lives there. */
    getSql?: () => unknown;
  };
  storage: unknown;
}

/** The canonical store slice every options path needs. */
export interface OptionsCanonicalStore {
  // `any` keeps DatabaseORM's stricter ScheduledReportInput signature
  // assignable while the helper still spreads a plain record into it.
  // Issue #1169 S4-1: the optional env threads the AI/Vectorize
  // bindings to the index hook.
  storeCanonicalReport: (
    input: any,
    env?: { AI?: any; VECTOR_MEMORY?: any }
  ) => { reportId: string; created: boolean } | null;
}

/**
 * The one owner-aware canonical write for options runs (options run-record fix).
 *
 * `mas_reports` rows are owner-scoped on read (`user_login = ?` in
 * listScheduledReports / `/api/runs` / report detail). A write without
 * `userLogin` stores the row under the `default` owner, which no signed-in
 * user can then see — the report exists in the table and in R2, but the
 * Reports tab renders nothing. Every options canonical write goes through
 * here so a new call site cannot forget the owner again.
 *
 * Never throws: a report that was generated must not fail because its
 * index row could not be written.
 */
export function storeOptionsCanonicalReport(
  orm: OptionsCanonicalStore | null | undefined,
  input: Record<string, unknown>,
  env?: { AI?: any; VECTOR_MEMORY?: any },
): { reportId: string; created: boolean } | null {
  if (!orm || typeof orm.storeCanonicalReport !== "function") return null;
  const { userLogin, ...rest } = input as Record<string, unknown> & { userLogin?: unknown };
  try {
    return orm.storeCanonicalReport(
      {
        ...rest,
        ...(typeof userLogin === "string" && userLogin ? { userLogin } : {}),
      },
      env
    );
  } catch (err) {
    console.warn(
      `[optionsServeRecord] canonical write failed for run ${String((input as { runId?: unknown }).runId ?? "?")}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export interface OptionsRunOutcomeRecord {
  id: string;
  trigger: "manual" | "scheduled";
  status: "completed" | "failed" | "partial";
  scanned?: number;
  matched?: number;
  error?: string;
  reportUrl?: string;
  pdfKey?: string;
  xlsxKey?: string;
  csvKey?: string;
  deliveryStates?: Record<string, string>;
  origin: string;
  createdAt?: string;
}

/**
 * Record one options run in the job-outcome sink (options run-record fix). This is
 * what makes a run visible in Workflow Runs: the ledger forms a run from
 * an outcome that has no job twin, and reads the artifact list from that
 * outcome. Paths that already have a job tree (the follow-up bridge)
 * record their own outcome; this is for the paths that do not.
 * Never throws — a sink failure must not fail the run.
 */
export function recordOptionsRunOutcome(
  sql: SqlStorage | null | undefined,
  run: OptionsRunOutcomeRecord,
): void {
  if (!sql) return;
  try {
    recordJobOutcome(sql, {
      id: run.id,
      kind: "options",
      trigger: run.trigger,
      status: run.status,
      scanned: run.scanned,
      matched: run.matched,
      codedError: run.error,
      reportUrl: run.reportUrl,
      pdfKey: run.pdfKey,
      xlsxKey: run.xlsxKey,
      csvKey: run.csvKey,
      deliveryStates: run.deliveryStates,
      origin: run.origin,
      createdAt: run.createdAt,
    });
  } catch (err) {
    console.warn(`[optionsServeRecord] outcome write failed for run ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * One strategy-screener run (the Strategy Discovery panel route,
 * `POST /trading/options/strategies` and `/best-trade`). The route
 * returned ranked strategies but recorded nothing: no canonical row,
 * no outcome, so the run was invisible on the Reports tab and in
 * Workflow Runs. It produces no PDF/XLSX/CSV (its unit is a ranked
 * strategy, not a contract), so the canonical body is the record and
 * the artifact list is honestly empty.
 */
export interface StrategyScreenRecordInput {
  userLogin: string;
  symbol: string;
  trigger: "manual" | "scheduled";
  mode: "strategies" | "best-trade";
  ranked: unknown[];
  bestTrade?: unknown;
  riskReports?: unknown[];
  screenedOut?: unknown[];
  screen?: unknown;
  contracts?: unknown[];
  dataSource?: string;
  asyncJobId?: string;
  createdAt?: string;
  /** Strategy report artifacts (pdf/xlsx/csv), when generated. */
  pdfKey?: string;
  pdfStatus?: "generated" | "failed";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed";
  xlsxError?: string;
  csvKey?: string;
  csvStatus?: "generated" | "failed";
  csvError?: string;
}

export function recordStrategyScreenRun(
  orm: (OptionsCanonicalStore & { getSql?: () => unknown }) | null | undefined,
  input: StrategyScreenRecordInput,
): { reportId: string; created: boolean } | null {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const generationId = `options_strategy:${input.mode}:${input.symbol}:${createdAt}`;
  const matched = input.mode === "best-trade" ? (input.bestTrade ? 1 : 0) : input.ranked.length;
  const summary =
    input.mode === "best-trade"
      ? `Best-trade pick for ${input.symbol}: ${input.bestTrade ? "one selected strategy" : "no qualifying strategy"}.`
      : `Strategy screen for ${input.symbol}: ${matched} ranked strateg${matched === 1 ? "y" : "ies"}.`;
  const stored = storeOptionsCanonicalReport(orm, {
    runId: generationId,
    generationId,
    title: `${input.mode === "best-trade" ? "Best trade" : "Strategy screen"} — ${input.symbol} (${input.trigger})`,
    source: "options_strategy",
    summary,
    body: {
      timestamp: createdAt,
      trigger: input.trigger,
      symbol: input.symbol,
      mode: input.mode,
      dataSource: input.dataSource,
      // Shape parity with the other canonical run bodies: success +
      // the match count the Runs read model renders.
      success: true,
      withTrades: matched,
      ranked: input.ranked,
      ...(input.bestTrade !== undefined ? { bestTrade: input.bestTrade } : {}),
      riskReports: input.riskReports ?? [],
      screenedOut: input.screenedOut ?? [],
      screen: input.screen,
      ...(input.pdfKey ? { pdfKey: input.pdfKey } : {}),
      ...(input.pdfStatus ? { pdfStatus: input.pdfStatus } : {}),
      ...(input.pdfError ? { pdfError: input.pdfError } : {}),
      ...(input.xlsxKey ? { xlsxKey: input.xlsxKey } : {}),
      ...(input.xlsxStatus ? { xlsxStatus: input.xlsxStatus } : {}),
      ...(input.xlsxError ? { xlsxError: input.xlsxError } : {}),
      ...(input.csvKey ? { csvKey: input.csvKey } : {}),
      ...(input.csvStatus ? { csvStatus: input.csvStatus } : {}),
      ...(input.csvError ? { csvError: input.csvError } : {}),
    },
    createdAt,
    userLogin: input.userLogin,
  });
  const sql = orm && typeof orm.getSql === "function" ? (orm.getSql() as any) : undefined;
  recordOptionsRunOutcome(sql, {
    // When the route runs as an async job, the outcome twins that job
    // so the ledger attaches it instead of inventing a second run.
    id: input.asyncJobId ?? generationId,
    trigger: input.trigger,
    status: "completed",
    scanned: input.contracts?.length,
    matched,
    pdfKey: input.pdfKey,
    xlsxKey: input.xlsxKey,
    csvKey: input.csvKey,
    origin: "options-strategy-screener",
    createdAt,
  });
  return stored;
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
  // Per-format statuses: a carried status wins; a key with no carried
  // status means the artifact was generated (the HTTP adapter already
  // infers the same way). A failed leg must record "failed" here —
  // without it the Docs list renders the leg as a bare "—".
  const pdfStatus = outcome.pdfStatus ?? (pdfKey ? "generated" : undefined);
  const xlsxStatus = outcome.xlsxStatus ?? (xlsxKey ? "generated" : undefined);
  const csvStatus = outcome.csvStatus ?? (csvKey ? "generated" : undefined);
  let canonicalOk = false;
  try {
    const stored = storeOptionsCanonicalReport(deps.orm, {
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
        ...(pdfStatus ? { pdfStatus } : {}),
        ...(outcome.pdfError ? { pdfError: outcome.pdfError } : {}),
        ...(xlsxStatus ? { xlsxStatus } : {}),
        ...(outcome.xlsxError ? { xlsxError: outcome.xlsxError } : {}),
        ...(csvStatus ? { csvStatus } : {}),
        ...(outcome.csvError ? { csvError: outcome.csvError } : {}),
        // Dedup join: runSummaryFromReport reads body.scanRunId, so
        // stamping it here lets mergeRunSummaries() absorb the
        // scan-store UUID row into this canonical row.
        ...(outcome.scanRunId ? { scanRunId: outcome.scanRunId } : {}),
        reportUrl: outcome.reportUrl ?? null,
      },
      createdAt: timestamp,
      userLogin: outcome.userLogin,
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
  // Options run-record fix: the sharded serve path owns no job-tree outcome, so
  // without this row the run's artifacts exist but Workflow Runs has
  // nothing to attach them to. Keyed by the run's delivery id when one
  // exists, so a replayed serve converges on the same row.
  const sql = typeof deps.orm.getSql === "function" ? (deps.orm.getSql() as SqlStorage | undefined) : undefined;
  recordOptionsRunOutcome(sql, {
    id: outcome.deliveryId ?? `options:${timestamp}`,
    trigger: outcome.trigger,
    status: outcome.success ? "completed" : "failed",
    scanned: outcome.totalScanned,
    matched: outcome.matchedCount,
    error: outcome.success ? undefined : outcome.error,
    reportUrl: outcome.reportUrl,
    pdfKey: pdfKey ?? undefined,
    xlsxKey: xlsxKey ?? undefined,
    csvKey: csvKey ?? undefined,
    origin: "options-serve",
    createdAt: timestamp,
  });
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
  /** Scan-store run id, when the service result carried it — stamped
   *  into the canonical body for the mergeRunSummaries() join. */
  scanRunId?: string | null;
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
        ...(run.scanRunId ? { scanRunId: run.scanRunId } : {}),
        reportUrl: run.reportUrl ?? null,
      },
      createdAt: new Date().toISOString(),
      ...(run.userLogin ? { userLogin: run.userLogin } : {}),
    });
  } catch (err) {
    console.warn("[OrchestratorAgent] Could not store options report canonical:", err);
  }
}
