/**
 * Issue #1123 S2: the screener follow-up scheduler core.
 * - planInitialFollowups (pure): a completed screener main-job schedules
 *   exactly one report sub-job (deliveries/notifications join in S3/S4).
 * - screenerOutcomeFromHttpJob (pure adapter): recognizes the stock and
 *   options screen responses among http.request job results.
 * - executeAsyncJob integration: completing a screener http job submits
 *   the report sub-job (parent = main job); executing it verifies the
 *   run-generated PDF artifact via the report port; a failed run
 *   generation completes the sub-job as 'skipped' with the reason.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  formatHeldNotification,
  formatUndeliverableNotification,
  planInitialFollowups,
  planLifecycleNotifications,
  plannedDeliveryChannels,
  resolveScreenerFollowupConfig,
  screenerOutcomeFromHttpJob,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import {
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";

const STOCK_BODY = JSON.stringify({
  universe: "NASDAQ100",
  totalScanned: 100,
  matchedCount: 7,
  opportunities: [],
  stocks: [],
  scannedAt: "2026-10-23T04:00:00Z",
  pdfKey: "screener-pdf-1",
  pdfStatus: "generated",
  reportUrl: "/api/screener/report.pdf?key=screener-pdf-1",
});
const OPTIONS_BODY = JSON.stringify({
  summary: "3 matched",
  matchedCount: 3,
  totalUnderlyingsScanned: 12,
  pdfKey: "options-pdf-9",
  reportUrl: "/api/options/report.pdf?key=options-pdf-9",
});

describe("screenerOutcomeFromHttpJob", () => {
  it("maps a stock screen response (single universe)", () => {
    const outcome = screenerOutcomeFromHttpJob("/api/etrade/screen", 200, STOCK_BODY);
    expect(outcome).toMatchObject({
      kind: "stock",
      success: true,
      pdfKeys: ["screener-pdf-1"],
      pdfStatus: "generated",
      matchedCount: 7,
      totalScanned: 100,
      universe: "NASDAQ100",
    });
  });

  it("maps a sharded stock response, extracting keys from reportUrls", () => {
    const body = JSON.stringify({
      sharded: true,
      universes: [
        { universe: "SP500", totalScanned: 500, matchedCount: 2, reportUrl: "/api/screener/report.pdf?key=k-a", success: true },
        { universe: "NASDAQ100", totalScanned: 100, matchedCount: 1, reportUrl: "/api/screener/report.pdf?key=k-b", success: true },
      ],
    });
    const outcome = screenerOutcomeFromHttpJob("/api/etrade/screen", 200, body);
    expect(outcome?.pdfKeys).toEqual(["k-a", "k-b"]);
    expect(outcome?.matchedCount).toBe(3);
    expect(outcome?.totalScanned).toBe(600);
  });

  it("maps an options screen response", () => {
    const outcome = screenerOutcomeFromHttpJob("/api/trading/options/screen", 200, OPTIONS_BODY);
    expect(outcome).toMatchObject({ kind: "options", success: true, pdfKeys: ["options-pdf-9"], matchedCount: 3 });
  });

  it("maps an options screen response carrying XLSX/CSV keys, statuses, and scanRunId", () => {
    const body = JSON.stringify({
      summary: "3 matched",
      matchedCount: 3,
      totalUnderlyingsScanned: 12,
      pdfKey: "options-pdf-9",
      pdfStatus: "generated",
      xlsxKey: "options-xlsx-9",
      xlsxStatus: "failed",
      xlsxError: "workbook render failed",
      csvKey: "options-csv-9",
      csvStatus: "generated",
      scanRunId: "scan-uuid-9",
    });
    const outcome = screenerOutcomeFromHttpJob("/api/trading/options/screen", 200, body);
    expect(outcome).toMatchObject({
      kind: "options",
      success: true,
      pdfKeys: ["options-pdf-9"],
      pdfStatus: "generated",
      xlsxKey: "options-xlsx-9",
      xlsxStatus: "failed",
      xlsxError: "workbook render failed",
      csvKey: "options-csv-9",
      csvStatus: "generated",
      scanRunId: "scan-uuid-9",
    });
  });

  it("returns a failed outcome for a 502 screen response and null for unrelated paths", () => {
    const failed = screenerOutcomeFromHttpJob("/api/etrade/screen", 502, JSON.stringify({ error: "E*TRADE unavailable" }));
    expect(failed?.success).toBe(false);
    expect(screenerOutcomeFromHttpJob("/api/etrade/quote?symbol=AAPL", 200, "{}")).toBeNull();
    expect(screenerOutcomeFromHttpJob("/api/etrade/screen", 200, "not json")).toBeNull();
  });
});

describe("planInitialFollowups", () => {
  const outcome: ScreenerRunOutcome = {
    kind: "stock",
    trigger: "manual",
    success: true,
    pdfKeys: ["screener-pdf-1"],
    pdfStatus: "generated",
    matchedCount: 7,
    totalScanned: 100,
    universe: "NASDAQ100",
  };
  const config = resolveScreenerFollowupConfig({ SCREENER_EMAIL_TO: "ops@example.com" });

  it("plans exactly one report sub-job parented to the main job", () => {
    const specs = planInitialFollowups(outcome, config, "main-1", "alice");
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      capability: "followup.report",
      parentJobId: "main-1",
      jobKind: "report",
      displayName: "Generate report — Stock screen (NASDAQ100)",
    });
    expect(specs[0].payload.userLogin).toBe("alice");
    expect(specs[0].payload.outcome.pdfKeys).toEqual(["screener-pdf-1"]);
  });

  it("plans nothing when disabled, when the run failed, or when reports are off", () => {
    const off = resolveScreenerFollowupConfig({ SCREENER_FOLLOWUPS: "off" });
    expect(planInitialFollowups(outcome, off, "m", "u")).toEqual([]);
    expect(planInitialFollowups({ ...outcome, success: false }, config, "m", "u")).toEqual([]);
    const noReport = resolveScreenerFollowupConfig({ SCREENER_FOLLOWUP_REPORT: "off" });
    expect(planInitialFollowups(outcome, noReport, "m", "u")).toEqual([]);
  });

  it("config: email allowlist defaults to the configured recipient; channels reflect env", () => {
    expect(config.enabled).toBe(true);
    expect(config.channels.email.to).toBe("ops@example.com");
    expect(config.emailAllowlist).toEqual(["ops@example.com"]);
    const slack = resolveScreenerFollowupConfig({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" });
    expect(slack.channels.slack.configured).toBe(true);
    expect(slack.channels.email.to).toBeUndefined();
  });
});

describe("#1228 composition truth (planner suppression + formatters)", () => {
  const outcome: ScreenerRunOutcome = {
    kind: "stock",
    trigger: "manual",
    success: true,
    pdfKeys: ["screener-pdf-1"],
    pdfStatus: "generated",
    reportUrl: "/api/screener/report.pdf?key=screener-pdf-1",
    matchedCount: 7,
    totalScanned: 100,
    universe: "NASDAQ100",
  };
  const config = resolveScreenerFollowupConfig({
    SCREENER_EMAIL_TO: "ops@example.com",
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
  });

  it("plannedDeliveryChannels: env-configured channels, in channel order", () => {
    expect(plannedDeliveryChannels(outcome, config)).toEqual(["slack", "email"]);
  });

  it("plannedDeliveryChannels: a per-task override counts without env config", () => {
    const bare = resolveScreenerFollowupConfig({});
    expect(plannedDeliveryChannels(outcome, bare)).toEqual([]);
    expect(plannedDeliveryChannels({ ...outcome, slackChannel: "#desk" }, bare)).toEqual(["slack"]);
  });

  it("completed notify is suppressed exactly on the suppressed channels", () => {
    const specs = planLifecycleNotifications("completed", outcome, config, "m", "alice", undefined, { suppressChannels: ["slack", "email"] });
    expect(specs).toEqual([]);
    const partial = planLifecycleNotifications("completed", outcome, config, "m", "alice", undefined, { suppressChannels: ["slack"] });
    expect(partial.map((s) => s.channel)).toEqual(["email"]);
  });

  it("suppression never applies to other events", () => {
    const failed = planLifecycleNotifications("failed", { ...outcome, success: false }, config, "m", "alice", undefined, { suppressChannels: ["slack", "email"] });
    expect(failed.map((s) => s.channel)).toEqual(["slack", "email"]);
    const started = planLifecycleNotifications("started", outcome, config, "m", "alice", undefined, { suppressChannels: ["slack", "email"] });
    expect(started.map((s) => s.channel)).toEqual(["slack", "email"]);
  });

  it("held announcement carries the report link and the exact expiry when provided", () => {
    const text = formatHeldNotification(outcome, { expiresAtIso: "2026-10-24T14:36:00.000Z" });
    expect(text).toContain("📄 Report: /api/screener/report.pdf?key=screener-pdf-1");
    expect(text).toContain("expires 2026-10-24T14:36:00.000Z");
    const bare = formatHeldNotification({ ...outcome, reportUrl: undefined });
    expect(bare).not.toContain("📄 Report:");
    expect(bare).not.toContain("expires");
  });

  it("undeliverable notice is the completion text plus the reason", () => {
    const text = formatUndeliverableNotification(outcome, "PDF generation failed: boom");
    expect(text).toContain("Screen completed");
    expect(text).toContain("⚠️ No report is attached: PDF generation failed: boom");
  });
});

/** Stateful fake: applies UPDATE SET assignments so job results persist. */
class StatefulAsyncSql {
  columns = [
    "job_id", "session_id", "capability", "display_name", "status",
    "payload_json", "result_json", "response_status", "error",
    "created_at", "updated_at", "started_at", "completed_at",
    "parent_job_id", "job_kind", "channel",
  ];
  rows: Array<Record<string, unknown>> = [];

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<Record<string, unknown>> {
    const q = query.trim().replace(/\s+/g, " ");
    const wrap = (rows: Array<Record<string, unknown>>, rowsWritten = 0) => Object.assign(rows, { rowsWritten });
    if (/^CREATE TABLE|^CREATE INDEX|^PRAGMA|^ALTER/i.test(q)) return wrap([]);
    if (/^DELETE FROM mas_async_jobs/i.test(q)) return wrap([]);
    if (/^INSERT INTO mas_async_jobs/i.test(q)) {
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const tokens = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: Record<string, unknown> = {};
      let ai = 0;
      cols.forEach((col, i) => {
        row[col] = tokens[i] === "?" ? (args[ai++] ?? null) : tokens[i].replace(/^'|'$/g, "");
      });
      this.rows.push(row);
      return wrap([], 1);
    }
    if (/^UPDATE mas_async_jobs/i.test(q)) {
      const setPart = q.match(/SET (.+?) WHERE/i)![1];
      const assigns = setPart.split(",").map((s) => s.trim());
      let ai = 0;
      const updates: Array<[string, unknown]> = assigns.map((a) => {
        const [col, expr] = a.split("=").map((s) => s.trim());
        return [col, expr === "?" ? args[ai++] : expr.replace(/^'|'$/g, "")] as [string, unknown];
      });
      // Resolve the job_id argument by walking WHERE placeholders in order.
      const wherePart = q.split(/ WHERE /i)[1] ?? "";
      let jobId: unknown;
      let wi = ai;
      for (const cond of wherePart.split(/ AND /i)) {
        if (cond.includes("?")) {
          if (/job_id\s*=\s*\?/.test(cond)) jobId = args[wi];
          wi++;
        }
      }
      let written = 0;
      for (const row of this.rows) {
        if (row.job_id === jobId) {
          for (const [col, val] of updates) row[col] = val;
          written = 1;
        }
      }
      return wrap([], written);
    }
    if (/^SELECT/i.test(q)) {
      const listMatch = q.match(/SELECT (.+?) FROM mas_async_jobs/i);
      if (!listMatch) return wrap([]);
      const cols = listMatch[1].split(",").map((c) => c.trim());
      let rows = [...this.rows];
      if (/WHERE job_id = \?/i.test(q)) rows = rows.filter((r) => r.job_id === args[0]);
      if (/ORDER BY created_at DESC/i.test(q)) rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      if (/LIMIT \?/i.test(q)) rows = rows.slice(0, Number(args[args.length - 1]));
      return wrap(rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const col of cols) out[col] = row[col] ?? null;
        return out;
      }));
    }
    throw new Error(`StatefulAsyncSql: unsupported: ${q.slice(0, 80)}`);
  }
}

function makeCtx(sql: StatefulAsyncSql, pdfs: Record<string, { fileName: string } | null>): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  return {
    env: {},
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => storage,
    sessionKey: () => "session-1",
    schedule: async () => ({}),
    audit: () => {},
    getOrm: () => {
      throw new Error("no orm");
    },
    routeRequest: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/etrade/screen")) {
        // The replay must carry the async-job seam header (S3/S5 use it).
        expect(request.headers.get("x-async-job-id")).toBeTruthy();
        return new Response(STOCK_BODY, { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200 });
    },
    nlqSchedulingPort: () => {
      throw new Error("unused");
    },
    nlqStockScreenPort: () => {
      throw new Error("unused");
    },
    followupReportPort: () => ({
      getStockPdf: async (_userLogin: string, key: string) => pdfs[key] ?? null,
      getOptionsPdf: async (_userLogin: string, key: string) => pdfs[key] ?? null,
    }),
  } as unknown as AsyncJobsContext;
}

describe("executeAsyncJob follow-up integration", () => {
  it("a completed stock screen job spawns a report sub-job that verifies the artifact", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql, { "screener-pdf-1": { fileName: "screen-report.pdf" } });
    const main = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
    });
    await executeAsyncJob(ctx, { jobId: main.jobId });

    const reportRow = sql.rows.find((r) => r.capability === "followup.report");
    expect(reportRow).toBeTruthy();
    expect(reportRow?.parent_job_id).toBe(main.jobId);
    expect(reportRow?.job_kind).toBe("report");
    expect(reportRow?.display_name).toBe("Generate report — Stock screen (NASDAQ100)");

    await executeAsyncJob(ctx, { jobId: String(reportRow?.job_id) });
    const report = getAsyncJob(ctx, String(reportRow?.job_id));
    expect(report?.status).toBe("completed");
    expect(report?.result).toMatchObject({
      status: "ready",
      artifacts: [{ key: "screener-pdf-1", fileName: "screen-report.pdf" }],
    });
  });

  it("a run whose PDF generation failed yields a 'skipped' report result, not a failure", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql, {});
    const body = JSON.stringify({ universe: "SP500", totalScanned: 10, matchedCount: 0, pdfStatus: "failed", pdfError: "render blew up" });
    (ctx as { routeRequest: unknown }).routeRequest = async () => new Response(body, { status: 200 });
    const main = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/etrade/screen", method: "POST", headers: { "x-user-login": "alice" }, body: "{}" },
    });
    await executeAsyncJob(ctx, { jobId: main.jobId });
    const reportRow = sql.rows.find((r) => r.capability === "followup.report");
    expect(reportRow).toBeTruthy();
    await executeAsyncJob(ctx, { jobId: String(reportRow?.job_id) });
    const report = getAsyncJob(ctx, String(reportRow?.job_id));
    expect(report?.status).toBe("completed");
    expect(report?.result).toMatchObject({ status: "skipped" });
    // #1252: the skip reason carries its catalog code (FAILURE_REPORT_PDF_GENERATION).
    expect((report?.result as { reason?: string }).reason).toContain("[FAILURE_REPORT_PDF_GENERATION]");
    expect((report?.result as { reason?: string }).reason).toContain("render blew up");
  });

  it("non-screener jobs spawn no follow-ups", async () => {
    const sql = new StatefulAsyncSql();
    const ctx = makeCtx(sql, {});
    const main = await submitAsyncJob(ctx, {
      capability: "http.request",
      payload: { pathAndQuery: "/api/etrade/quote?symbol=AAPL", method: "GET", headers: {}, body: "" },
    });
    await executeAsyncJob(ctx, { jobId: main.jobId });
    expect(sql.rows.filter((r) => r.capability === "followup.report")).toHaveLength(0);
  });
});

describe("wiring pins", () => {
  it("orchestrator wires the follow-up report port", () => {
    const src = readFileSync("src/agents/orchestrator.ts", "utf8");
    expect(src).toContain("followupReportPort");
    expect(src).toContain("getPdfByKey");
  });
});
