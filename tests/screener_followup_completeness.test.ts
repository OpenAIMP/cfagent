/**
 * Issue #1191 (#1173 R3): notification completeness.
 *
 * Pins: outcomes carry the XLSX artifact from every adapter (event,
 * run result, http job); the report sub-job adopts it; the delivery
 * port attaches text + PDF + XLSX (email MIME carries both files
 * with their content types); the pipeline policy gates deliveries
 * and lifecycle notifications per channel+event (explicit 'skipped',
 * never silent); a #277-held delivery announces itself; lifecycle
 * notifications plan per-task override channels too.
 */
import { describe, expect, it } from "vitest";
import {
  formatHeldNotification,
  planLifecycleNotifications,
  resolveScreenerFollowupConfig,
  screenerOutcomeFromEvent,
  screenerOutcomeFromHttpJob,
  screenerOutcomeFromRunResult,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import {
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { createFollowupDeliveryPort } from "../src/services/screenerFollowupDelivery";
import type { ScreenerEvent } from "../src/events/screenerEvents";

const outcome: ScreenerRunOutcome = {
  kind: "stock",
  trigger: "manual",
  success: true,
  pdfKeys: ["k1"],
  pdfStatus: "generated",
  xlsxKey: "x1",
  xlsxStatus: "generated",
  matchedCount: 2,
  totalScanned: 50,
  universe: "NASDAQ100",
  reportUrl: "/api/screener/report.pdf?key=k1",
};

describe("outcome adapters carry the XLSX artifact", () => {
  it("from a bus event", () => {
    const event = {
      type: "screener.completed",
      timestamp: "2026-10-23T09:00:00Z",
      universe: "NASDAQ100",
      pdfKey: "k1",
      pdfStatus: "generated",
      xlsxKey: "x1",
      xlsxStatus: "generated",
      sector: "ALL",
      totalScanned: 50,
      matchedCount: 2,
      opportunities: [],
    } as unknown as ScreenerEvent;
    const o = screenerOutcomeFromEvent(event);
    expect(o.xlsxKey).toBe("x1");
    expect(o.xlsxStatus).toBe("generated");
  });

  it("from a run result and from an http job body", () => {
    const o = screenerOutcomeFromRunResult("stock", {
      success: true, pdfKey: "k1", pdfStatus: "generated",
      xlsxKey: "x1", xlsxStatus: "generated", xlsxError: undefined,
    });
    expect(o.xlsxKey).toBe("x1");
    const h = screenerOutcomeFromHttpJob(
      "/api/etrade/screen",
      200,
      JSON.stringify({ universe: "NASDAQ100", pdfKey: "k1", pdfStatus: "generated", xlsxKey: "x1", xlsxStatus: "generated", matchedCount: 2, totalScanned: 50 }),
    );
    expect(h?.xlsxKey).toBe("x1");
    expect(h?.xlsxStatus).toBe("generated");
  });
});

describe("lifecycle planner honors per-task override channels", () => {
  it("plans notifications for override-only destinations", () => {
    const config = resolveScreenerFollowupConfig({});
    expect(config.channels.slack.configured).toBe(false);
    expect(config.channels.email.configured).toBe(false);
    const withOverrides: ScreenerRunOutcome = {
      ...outcome, emailTo: "owner@example.com", slackChannel: "C123",
    };
    const specs = planLifecycleNotifications("failed", withOverrides, config, "m", "u");
    expect(specs.map((s) => s.channel)).toEqual(["slack", "email"]);
    const bare = planLifecycleNotifications("failed", outcome, config, "m", "u");
    expect(bare).toEqual([]);
  });
});

describe("formatHeldNotification", () => {
  it("announces the hold with the report summary and the remedy", () => {
    const text = formatHeldNotification(outcome);
    expect(text).toContain("held for approval");
    expect(text).toContain("NASDAQ100");
    expect(text).toContain("2 matched");
    expect(text).toContain("Reports panel");
  });
});

/** Stateful fake (same harness as the S2–S4 suites). */
class StatefulAsyncSql {
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

interface Harness {
  ctx: AsyncJobsContext;
  notified: Array<{ channel: string; text: string }>;
  delivered: Array<{ channel: string }>;
  confirmations: string[];
}

function makeCtx(sql: StatefulAsyncSql, env: Record<string, unknown>, opts?: { hitl?: boolean }): Harness {
  const notified: Harness["notified"] = [];
  const delivered: Harness["delivered"] = [];
  const confirmations: string[] = [];
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  const ctx = {
    env,
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => storage,
    sessionKey: () => "session-1",
    schedule: async () => ({}),
    audit: () => {},
    getOrm: () => {
      throw new Error("no orm");
    },
    routeRequest: async () => new Response("{}", { status: 200 }),
    nlqSchedulingPort: () => {
      throw new Error("unused");
    },
    nlqStockScreenPort: () => {
      throw new Error("unused");
    },
    followupReportPort: () => ({
      getStockPdf: async (_u: string, key: string) => (key === "k1" ? { fileName: "screen.pdf" } : null),
      getOptionsPdf: async () => null,
    }),
    followupDeliveryPort: () => ({
      deliver: async (input: { channel: string }) => {
        delivered.push({ channel: input.channel });
        return { ok: true, detail: "sent-1" };
      },
      notify: async (input: { channel: string; text: string }) => {
        notified.push({ channel: input.channel, text: input.text });
        return { ok: true };
      },
    }),
    reportDispatchHitlEnabled: () => opts?.hitl === true,
    createScreenerConfirmation: (payloadJson: string) => {
      confirmations.push(payloadJson);
      return "rc_held_1";
    },
  } as unknown as AsyncJobsContext;
  return { ctx, notified, delivered, confirmations };
}

const ENV = { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" };

describe("executor: policy gates + xlsx adoption + held announcements", () => {
  it("the report sub-job adopts the XLSX artifact next to the PDF", async () => {
    const sql = new StatefulAsyncSql();
    const { ctx } = makeCtx(sql, ENV);
    const job = await submitAsyncJob(ctx, {
      capability: "followup.report",
      payload: { outcome, userLogin: "alice" },
      parentJobId: "main-1",
    });
    await executeAsyncJob(ctx, { jobId: job.jobId });
    const result = getAsyncJob(ctx, job.jobId)?.result as { status: string; artifacts: Array<{ key: string; kind?: string }> };
    expect(result.status).toBe("ready");
    expect(result.artifacts).toEqual([
      { key: "k1", fileName: "screen.pdf", kind: "pdf" },
      { key: "x1", fileName: "screener-report.xlsx", kind: "xlsx" },
    ]);
  });

  it("a policy-off lifecycle event completes the notify job as 'skipped' without sending", async () => {
    const sql = new StatefulAsyncSql();
    const { ctx, notified } = makeCtx(sql, { ...ENV, PIPELINE_NOTIFY_EVENTS: "failed" });
    const job = await submitAsyncJob(ctx, {
      capability: "followup.notify",
      payload: { event: "completed", outcome, userLogin: "alice", channel: "slack" },
      parentJobId: "main-1",
    });
    await executeAsyncJob(ctx, { jobId: job.jobId });
    expect(getAsyncJob(ctx, job.jobId)?.result).toMatchObject({ status: "skipped" });
    expect(notified).toHaveLength(0);
  });

  it("a #277-held delivery announces itself on the delivery channel", async () => {
    const sql = new StatefulAsyncSql();
    const { ctx, notified, delivered, confirmations } = makeCtx(sql, ENV, { hitl: true });
    const job = await submitAsyncJob(ctx, {
      capability: "followup.deliver",
      payload: { outcome, userLogin: "alice", channel: "slack", artifacts: [{ key: "k1", fileName: "screen.pdf", kind: "pdf" }] },
      parentJobId: "main-1",
    });
    await executeAsyncJob(ctx, { jobId: job.jobId });
    expect(getAsyncJob(ctx, job.jobId)?.result).toMatchObject({ status: "held", confirmationId: "rc_held_1" });
    expect(confirmations).toHaveLength(1);
    expect(delivered).toHaveLength(0);
    expect(notified).toHaveLength(1);
    expect(notified[0].channel).toBe("slack");
    expect(notified[0].text).toContain("held for approval");
  });
});

describe("delivery port: email carries text + PDF + XLSX", () => {
  it("attaches both artifacts with their content types in one MIME message", async () => {
    let mime = "";
    const env = {
      SCREENER_EMAIL_TO: "ops@example.com",
      EMAIL: {
        send: async (body: ReadableStream) => {
          mime = await new Response(body).text();
        },
      },
    };
    const agent = {
      getPdfByKey: async () => ({ bytes: new TextEncoder().encode("PDFBYTES"), fileName: "screen.pdf" }),
      getXlsxByKey: async () => ({ bytes: new TextEncoder().encode("XLSXBYTES"), fileName: "screen.xlsx" }),
      getOptionsPdfByKey: async () => null,
    };
    const port = createFollowupDeliveryPort({
      env: env as never,
      getOrm: () => ({}) as never,
      getScreenerAgent: () => agent as never,
    });
    const res = await port.deliver({
      channel: "email",
      userLogin: "alice",
      outcome,
      artifacts: [
        { key: "k1", fileName: "screen.pdf", kind: "pdf" },
        { key: "x1", fileName: "screen.xlsx", kind: "xlsx" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(mime).toContain("screen.pdf");
    expect(mime).toContain("screen.xlsx");
    expect(mime).toContain("application/pdf");
    expect(mime).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("options deliveries attach PDF + XLSX too (#1195 R3b)", async () => {
    let mime = "";
    const env = {
      SCREENER_EMAIL_TO: "ops@example.com",
      EMAIL: {
        send: async (body: ReadableStream) => {
          mime = await new Response(body).text();
        },
      },
    };
    const agent = {
      getPdfByKey: async () => null,
      getXlsxByKey: async () => null,
      getOptionsPdfByKey: async () => ({ bytes: new TextEncoder().encode("OPDF"), fileName: "options.pdf" }),
      getOptionsXlsxByKey: async () => ({ bytes: new TextEncoder().encode("OXLSX"), fileName: "options.xlsx" }),
    };
    const port = createFollowupDeliveryPort({
      env: env as never,
      getOrm: () => ({}) as never,
      getScreenerAgent: () => agent as never,
    });
    const optionsOutcome: ScreenerRunOutcome = {
      kind: "options",
      trigger: "manual",
      success: true,
      pdfKeys: ["ok1"],
      pdfStatus: "generated",
      xlsxKey: "ox1",
      xlsxStatus: "generated",
      matchedCount: 4,
      totalScanned: 12,
      thesis: "bullish",
    };
    const res = await port.deliver({
      channel: "email",
      userLogin: "alice",
      outcome: optionsOutcome,
      artifacts: [
        { key: "ok1", fileName: "options.pdf", kind: "pdf" },
        { key: "ox1", fileName: "options.xlsx", kind: "xlsx" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(mime).toContain("options.pdf");
    expect(mime).toContain("options.xlsx");
  });

  it("a missing XLSX is reported in the detail, the PDF still sends", async () => {
    let mime = "";
    const env = {
      SCREENER_EMAIL_TO: "ops@example.com",
      EMAIL: {
        send: async (body: ReadableStream) => {
          mime = await new Response(body).text();
        },
      },
    };
    const agent = {
      getPdfByKey: async () => ({ bytes: new TextEncoder().encode("PDFBYTES"), fileName: "screen.pdf" }),
      getXlsxByKey: async () => null,
      getOptionsPdfByKey: async () => null,
    };
    const port = createFollowupDeliveryPort({
      env: env as never,
      getOrm: () => ({}) as never,
      getScreenerAgent: () => agent as never,
    });
    const res = await port.deliver({
      channel: "email",
      userLogin: "alice",
      outcome,
      artifacts: [
        { key: "k1", fileName: "screen.pdf", kind: "pdf" },
        { key: "x1", fileName: "screen.xlsx", kind: "xlsx" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("x1");
    expect(mime).toContain("screen.pdf");
    expect(mime).not.toContain("screen.xlsx");
  });
});
