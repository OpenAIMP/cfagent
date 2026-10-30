/**
 * Issue #1333 (job-truth program #1332): one outcome-event shape for
 * every job producer (stock/options/goal/discovery, scheduled/manual)
 * into one sink, rendered by Autopilot Control as its job feed.
 * The sink is the mas_job_outcomes table: recordJobOutcome upserts
 * by stable id (deliveryId for bridged/bus runs, run key otherwise),
 * merging delivery states key-wise so a later bus event never wipes
 * states recorded by the job tree, and vice versa.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  recordJobOutcome,
  listJobOutcomes,
  type JobOutcomeInput,
} from "../src/services/jobOutcomes";

const base: JobOutcomeInput = {
  id: "job-1",
  kind: "options",
  trigger: "scheduled",
  status: "failed",
  codedError: "[FAILURE_AUTH_NO_SESSION] E*TRADE connection missing",
  origin: "bus",
};

describe("job outcomes sink (#1333)", () => {
  it("records and lists an outcome with its coded error and artifacts", () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, {
      ...base,
      scanned: 100,
      matched: 0,
      reportUrl: "/api/screening/reports/xyz",
      pdfKey: "options/xyz.pdf",
    });
    const rows = listJobOutcomes(sql, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("job-1");
    expect(rows[0].kind).toBe("options");
    expect(rows[0].status).toBe("failed");
    expect(rows[0].codedError).toContain("[FAILURE_AUTH_NO_SESSION]");
    expect(rows[0].reportUrl).toBe("/api/screening/reports/xyz");
    expect(rows[0].pdfKey).toBe("options/xyz.pdf");
  });

  it("lists newest first and honors the limit", () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, { ...base, id: "old", createdAt: "2026-10-24T04:58:00.000Z" });
    recordJobOutcome(sql, { ...base, id: "new", status: "completed", createdAt: "2026-10-24T10:36:00.000Z" });
    const rows = listJobOutcomes(sql, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("new");
  });

  it("re-recording the same id merges instead of duplicating", () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, {
      ...base,
      deliveryStates: { email: "sent" },
    });
    // A later completed re-record (no error key) clears the stale
    // coded error but merges delivery states key-wise.
    const { codedError: _dropped, ...completed } = base;
    recordJobOutcome(sql, {
      ...completed,
      status: "completed",
      deliveryStates: { slack: "sent" },
    });
    const rows = listJobOutcomes(sql, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].codedError).toBeNull();
    expect(rows[0].deliveryStates).toEqual({ email: "sent", slack: "sent" });
    // The bus re-record carries no artifact links; the tree's survive.
    recordJobOutcome(sql, { ...base, pdfKey: "options/xyz.pdf" });
    recordJobOutcome(sql, { ...base, reportUrl: undefined });
    const merged = listJobOutcomes(sql, 50)[0];
    expect(merged.pdfKey).toBe("options/xyz.pdf");
  });

  it("a partial run keeps its qualified-partial status, never failed", () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, {
      id: "partial-1",
      kind: "stock",
      trigger: "manual",
      status: "partial",
      scanned: 98,
      matched: 12,
      origin: "job-tree",
    });
    expect(listJobOutcomes(sql, 50)[0].status).toBe("partial");
  });
});
