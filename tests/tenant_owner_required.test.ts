/**
 * Multi-tenant owner enforcement for canonical reports.
 *
 * `mas_reports` is tenant-scoped: every row belongs to exactly one
 * `user_login`, and every owner-scoped read filters on it. The old store
 * fell back to a literal `"default"` owner, which in a multi-tenant SaaS
 * files a real run under a fake tenant — visible to nobody (scoped reads)
 * or, worse, to anyone reading unscoped.
 *
 * Pinned here:
 *  1. storeReportAtGeneration refuses a write without an owner and writes
 *     no row (no `"default"` bucket).
 *  2. A write with an owner is visible only to that owner.
 *  3. persistScheduledReportSql refuses the same way.
 *  4. The goal-screen workflow store carries the run owner onto the
 *     canonical row (the reported "goal screen missing from Reports" bug).
 */
import { describe, expect, it, vi } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  listScheduledReports,
  persistScheduledReportSql,
  storeReportAtGeneration,
} from "../src/services/scheduledReports";
import { persistWorkflowGoalScreenReport } from "../src/agents/orchestrator/goalScreenDispatch";
import { listJobOutcomes } from "../src/services/jobOutcomes";
import { recordStrategyScreenRun } from "../src/services/optionsServeRecord";

const OWNER = "tenant-a@example.com";

function rowCount(sql: MockSqlStorage): number {
  const rows = Array.from(sql.exec("SELECT COUNT(*) AS count FROM mas_reports")) as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

const report = {
  runId: "goal-screen:task-1",
  generationId: "goal-screen:task-1",
  title: "Goal screen — growth (bullish)",
  source: "goal_screen",
  summary: "3 hits.",
  body: { hits: 3 },
  createdAt: "2026-10-28T12:00:00.000Z",
};

describe("canonical report owner is mandatory", () => {
  it("refuses a write with no userLogin and stores no row", () => {
    const sql = new MockSqlStorage();
    const stored = storeReportAtGeneration(sql as any, report as any);
    expect(stored).toBeNull();
    expect(rowCount(sql)).toBe(0);
  });

  it("stores a row under its owner and hides it from other tenants", () => {
    const sql = new MockSqlStorage();
    const stored = storeReportAtGeneration(sql as any, { ...report, userLogin: OWNER } as any);
    expect(stored).toMatchObject({ created: true });
    expect(rowCount(sql)).toBe(1);

    const mine = listScheduledReports(sql as any, { userLogin: OWNER });
    expect(mine).toHaveLength(1);
    expect(mine[0].runId).toBe(report.runId);

    const other = listScheduledReports(sql as any, { userLogin: "tenant-b@example.com" });
    expect(other).toHaveLength(0);
  });

  it("dedupes a generation per owner, never across tenants", () => {
    const sql = new MockSqlStorage();
    const a1 = storeReportAtGeneration(sql as any, { ...report, userLogin: "tenant-a@example.com" } as any);
    const a2 = storeReportAtGeneration(sql as any, { ...report, userLogin: "tenant-a@example.com" } as any);
    const b1 = storeReportAtGeneration(sql as any, { ...report, userLogin: "tenant-b@example.com" } as any);
    expect(a2!.reportId).toBe(a1!.reportId);
    expect(b1!.reportId).not.toBe(a1!.reportId);
    expect(rowCount(sql)).toBe(2);
  });

  it("persistScheduledReportSql refuses an ownerless write", () => {
    const sql = new MockSqlStorage();
    const id = persistScheduledReportSql(sql as any, report as any);
    expect(id).toBeNull();
    expect(rowCount(sql)).toBe(0);
  });
});

describe("strategy screener run record", () => {
  it("records the run under its owner and in the outcome ledger", () => {
    const sql = new MockSqlStorage();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "strategy-1", created: true })),
      getSql: () => sql,
    };

    const stored = recordStrategyScreenRun(orm as any, {
      userLogin: OWNER,
      symbol: "NVDA",
      trigger: "manual",
      mode: "strategies",
      ranked: [{ candidate: { type: "iron_condor" } }, { candidate: { type: "credit_spread" } }],
      contracts: [{}, {}, {}],
      createdAt: "2026-10-28T14:00:00.000Z",
    });

    expect(stored).toMatchObject({ reportId: "strategy-1" });
    expect(orm.storeCanonicalReport.mock.calls[0][0]).toMatchObject({
      source: "options_strategy",
      userLogin: OWNER,
    });

    const outcomes = listJobOutcomes(sql as any, 5);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "options",
      status: "completed",
      scanned: 3,
      matched: 2,
      origin: "options-strategy-screener",
    });
  });

  it("twins an async job's id instead of inventing a second run", () => {
    const sql = new MockSqlStorage();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "strategy-2", created: true })),
      getSql: () => sql,
    };

    recordStrategyScreenRun(orm as any, {
      userLogin: OWNER,
      symbol: "AAPL",
      trigger: "manual",
      mode: "best-trade",
      ranked: [{ candidate: { type: "long_call" } }],
      bestTrade: { candidate: { type: "long_call" } },
      asyncJobId: "job-123",
      createdAt: "2026-10-28T14:05:00.000Z",
    });

    expect(listJobOutcomes(sql as any, 5)[0].id).toBe("job-123");
  });
});

describe("goal screen canonical owner", () => {
  it("writes the run owner onto the goal-screen report row", async () => {
    const sql = new MockSqlStorage();
    const orm = {
      storeCanonicalReport: vi.fn(() => ({ reportId: "goal-1", created: true })),
      exec: () => [],
      // recordScreeningActivity takes the SQL exec surface; the outcome
      // sink takes the same DO database.
      ensureTables: () => sql,
      getSql: () => sql,
    };

    const reportId = await persistWorkflowGoalScreenReport(
      { env: {}, getOrm: () => orm as any },
      {
        taskId: "task-1",
        scenarioSource: "built",
        trigger: "scheduled",
        result: {
          goalKind: "growth",
          outlook: "bullish",
          status: "complete",
          counts: { hits: 3, stocksScanned: 10, optionsUnderlyingsScanned: 4 },
          completedAt: "2026-10-28T12:00:00.000Z",
        },
      } as any,
      OWNER,
    );

    expect(reportId).toBe("goal-1");
    expect(orm.storeCanonicalReport).toHaveBeenCalledTimes(1);
    expect(orm.storeCanonicalReport.mock.calls[0][0]).toMatchObject({
      source: "goal_screen",
      userLogin: OWNER,
    });

    // The run is also in the job-outcome ledger, so Workflow Runs can
    // list it (goal runs have no async-job tree).
    const outcomes = listJobOutcomes(sql as any, 5);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      id: "goal-screen:task-1",
      kind: "goal",
      status: "completed",
      scanned: 14,
      matched: 3,
    });
  });
});
