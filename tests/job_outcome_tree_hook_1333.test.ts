/**
 * Issue #1333: the job-tree hook — recordScreenerRunMainJob lands
 * the run in the job-outcome sink (mas_job_outcomes) alongside the
 * main job row, so bridged runs (scheduled/manual stock/options,
 * goal-screen, discovery) appear in Autopilot Control's job feed.
 * The hook never throws: a sink failure must not fail the run.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { recordScreenerRunMainJob } from "../src/agents/orchestrator/asyncJobs";
import { listJobOutcomes } from "../src/services/jobOutcomes";
import type { ScreenerRunOutcome } from "../src/services/screenerFollowups";

function makeCtx(sql: MockSqlStorage): any {
  return {
    env: {},
    agentCtx: { storage: { sql } },
    ensureTables: () => sql,
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
      deliver: async () => ({ ok: true }),
      notify: async () => ({ ok: true }),
    }),
    reportDispatchHitlEnabled: () => false,
    createScreenerConfirmation: () => "rc_unused",
  };
}

describe("job-tree outcome hook (#1333)", () => {
  it("records a completed bridged run with its artifacts", async () => {
    const sql = new MockSqlStorage();
    const outcome: ScreenerRunOutcome = {
      kind: "stock",
      trigger: "scheduled",
      success: true,
      pdfKeys: ["stocks/abc.pdf"],
      pdfStatus: "generated",
      matchedCount: 12,
      totalScanned: 98,
      universe: "SP100",
      reportUrl: "/api/screener/report.pdf?key=stocks/abc.pdf",
      deliveryId: "sched:sp100:2026-10-24",
    };
    await recordScreenerRunMainJob(makeCtx(sql), outcome, "alice");
    const rows = listJobOutcomes(sql, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("sched:sp100:2026-10-24");
    expect(rows[0].kind).toBe("stock");
    expect(rows[0].status).toBe("completed");
    expect(rows[0].matched).toBe(12);
    expect(rows[0].scanned).toBe(98);
    expect(rows[0].pdfKey).toBe("stocks/abc.pdf");
    expect(rows[0].origin).toBe("job-tree");
  });

  it("records a failed bridged run with its coded error", async () => {
    const sql = new MockSqlStorage();
    const outcome: ScreenerRunOutcome = {
      kind: "options",
      trigger: "scheduled",
      success: false,
      pdfKeys: [],
      error: "[FAILURE_AUTH_NO_SESSION] E*TRADE connection missing",
      thesis: "NASDAQ100",
    };
    await recordScreenerRunMainJob(makeCtx(sql), outcome, "alice");
    const rows = listJobOutcomes(sql, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].codedError).toContain("[FAILURE_AUTH_NO_SESSION]");
  });
});
