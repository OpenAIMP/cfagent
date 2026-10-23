/**
 * Issue #1123 S5c: #277 composition. With report-dispatch HITL
 * enabled, followup.deliver jobs HOLD instead of sending: the job
 * completes as 'held' with a mas_report_confirmations row of kind
 * 'screener' (visible in the same pending-review surface, same 24h
 * TTL). Approval resubmits the delivery with an approval marker and
 * the executor sends it. No unapproved delivery is ever sent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  executeAsyncJob,
  getAsyncJob,
  submitAsyncJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import {
  createReportConfirmation,
  getReportDispatchHitl,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";
import type { ScreenerRunOutcome } from "../src/services/screenerFollowups";

/** Stateful fake (same harness as the S2–S5 suites). */
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

const outcome: ScreenerRunOutcome = {
  kind: "stock",
  trigger: "manual",
  success: true,
  pdfKeys: ["k1"],
  matchedCount: 2,
  totalScanned: 50,
  universe: "NASDAQ100",
  reportUrl: "/api/screener/report.pdf?key=k1",
};

function makeCtx(
  sql: StatefulAsyncSql,
  hitl: boolean,
  sent: string[],
  confirmations: string[],
): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  return {
    env: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x" },
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
      getStockPdf: async () => null,
      getOptionsPdf: async () => null,
    }),
    followupDeliveryPort: () => ({
      deliver: async (input: { channel: string }) => {
        sent.push(input.channel);
        return { ok: true, detail: "sent-1" };
      },
      notify: async () => ({ ok: true }),
    }),
    reportDispatchHitlEnabled: () => hitl,
    createScreenerConfirmation: (payloadJson: string) => {
      confirmations.push(payloadJson);
      return "rc_test123";
    },
  } as unknown as AsyncJobsContext;
}

async function submitDelivery(ctx: AsyncJobsContext, extra?: Record<string, unknown>): Promise<string> {
  const { jobId } = await submitAsyncJob(ctx, {
    capability: "followup.deliver",
    payload: {
      outcome,
      userLogin: "alice",
      channel: "slack",
      artifacts: [{ key: "k1", fileName: "screen.pdf" }],
      ...extra,
    },
    parentJobId: "main-1",
    jobKind: "delivery",
    channel: "slack",
    displayName: "Deliver by Slack — Stock screen",
  } as never);
  return jobId;
}

describe("followup.deliver under report-dispatch HITL (#277)", () => {
  it("holds the delivery: job completes 'held', a screener confirmation carries the full spec, nothing is sent", async () => {
    const sql = new StatefulAsyncSql();
    const sent: string[] = [];
    const confirmations: string[] = [];
    const ctx = makeCtx(sql, true, sent, confirmations);
    const jobId = await submitDelivery(ctx);
    await executeAsyncJob(ctx, { jobId });
    const rec = getAsyncJob(ctx, jobId);
    expect(rec?.status).toBe("completed");
    expect(rec?.result).toMatchObject({ status: "held", confirmationId: "rc_test123", channel: "slack" });
    expect(sent).toEqual([]);
    expect(confirmations).toHaveLength(1);
    const spec = JSON.parse(confirmations[0]) as { delivery: Record<string, unknown> };
    expect(spec.delivery.channel).toBe("slack");
    expect(spec.delivery.parentJobId).toBe("main-1");
    expect(spec.delivery.displayName).toBe("Deliver by Slack — Stock screen");
    expect(spec.delivery.artifacts).toEqual([{ key: "k1", fileName: "screen.pdf" }]);
  });

  it("an approved delivery (approval marker) sends even with HITL on", async () => {
    const sql = new StatefulAsyncSql();
    const sent: string[] = [];
    const confirmations: string[] = [];
    const ctx = makeCtx(sql, true, sent, confirmations);
    const jobId = await submitDelivery(ctx, { approvedConfirmationId: "rc_test123" });
    await executeAsyncJob(ctx, { jobId });
    expect(getAsyncJob(ctx, jobId)?.result).toMatchObject({ status: "sent", channel: "slack" });
    expect(sent).toEqual(["slack"]);
    expect(confirmations).toEqual([]);
  });

  it("with HITL off the delivery sends and no confirmation is created", async () => {
    const sql = new StatefulAsyncSql();
    const sent: string[] = [];
    const confirmations: string[] = [];
    const ctx = makeCtx(sql, false, sent, confirmations);
    const jobId = await submitDelivery(ctx);
    await executeAsyncJob(ctx, { jobId });
    expect(getAsyncJob(ctx, jobId)?.result).toMatchObject({ status: "sent" });
    expect(confirmations).toEqual([]);
  });
});

describe("reportDispatch screener confirmations", () => {
  function dispatchCtx(settings: Array<{ key: string; value: string }>, inserted: unknown[][]): ReportDispatchContext {
    const sql = {
      exec(query: string, ...args: unknown[]) {
        const q = query.trim().replace(/\s+/g, " ");
        if (/^SELECT value FROM mas_settings/i.test(q)) {
          const row = settings.find((s) => s.key === args[0]);
          return Object.assign(row ? [{ value: row.value }] : [], { rowsWritten: 0 });
        }
        if (/^DELETE FROM mas_report_confirmations/i.test(q)) return Object.assign([], { rowsWritten: 0 });
        if (/^INSERT INTO mas_report_confirmations/i.test(q)) {
          inserted.push(args);
          return Object.assign([], { rowsWritten: 1 });
        }
        return Object.assign([], { rowsWritten: 0 });
      },
    };
    return {
      env: {},
      ensureTables: () => sql,
      getOrm: () => {
        throw new Error("no orm");
      },
      reportDispatchHitlKey: "report_dispatch_hitl",
      reportConfirmationTtlMs: 24 * 60 * 60 * 1000,
      sendReportEmail: async () => true,
      sendReportWebhook: async () => ({ success: true }),
    } as unknown as ReportDispatchContext;
  }

  it("getReportDispatchHitl reads the setting (default off)", () => {
    const inserted: unknown[][] = [];
    expect(getReportDispatchHitl(dispatchCtx([], inserted))).toBe(false);
    expect(getReportDispatchHitl(dispatchCtx([{ key: "report_dispatch_hitl", value: "1" }], inserted))).toBe(true);
  });

  it("createReportConfirmation accepts the screener kind and stores the payload as pending", () => {
    const inserted: unknown[][] = [];
    const id = createReportConfirmation(dispatchCtx([], inserted), "screener", "{\"delivery\":{}}", null);
    expect(id).toMatch(/^rc_/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0][1]).toBe("screener");
    expect(inserted[0][2]).toBe("{\"delivery\":{}}");
    expect(inserted[0][3]).toBe("pending");
  });
});

describe("approval-release wiring pins", () => {
  it("the reports approve handler releases screener confirmations via the resubmission port", () => {
    const src = readFileSync("src/agents/routes/reports.ts", "utf8");
    expect(src).toContain('row.kind === "screener"');
    expect(src).toContain("submitFollowupDelivery");
  });
  it("the orchestrator wires the release port and the async-job HITL ports", () => {
    const src = readFileSync("src/agents/orchestrator.ts", "utf8");
    expect(src).toContain("submitFollowupDelivery:");
    expect(src).toContain("reportDispatchHitlEnabled:");
    expect(src).toContain("createScreenerConfirmation:");
  });
});
