/**
 * #584 — tenant isolation + usage metering for research runs (EP-003, EP-009).
 *
 * TDD: these tests define the expected behavior first. They fail until the
 * user_login scoping and usage-events ledger are implemented.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  storeReportAtGeneration,
  searchScheduledReports,
  listScheduledReports,
  recordUsageEvent,
  listUsageEvents,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";

const baseInput = (over: Partial<ScheduledReportInput>): ScheduledReportInput => ({
  runId: "run-1",
  generationId: `gen-${Math.random().toString(36).slice(2)}`,
  title: "Research report",
  source: "research",
  summary: "bullish ideas",
  body: "full report body",
  userLogin: "alice",
  ...over,
});

describe("#584 report isolation (EP-003)", () => {
  it("stores the owning user on the canonical report row", () => {
    const sql = new MockSqlStorage();
    const res = storeReportAtGeneration(sql, baseInput({ userLogin: "alice" }));
    expect(res).not.toBeNull();
    const rows = Array.from(
      sql.exec("SELECT user_login FROM mas_reports WHERE id = ?", res!.reportId)
    ) as Array<{ user_login?: string }>;
    expect(rows[0]?.user_login).toBe("alice");
  });

  it("lists only the requesting user's reports", () => {
    const sql = new MockSqlStorage();
    storeReportAtGeneration(sql, baseInput({ userLogin: "alice" }));
    storeReportAtGeneration(sql, baseInput({ userLogin: "bob" }));
    const alice = listScheduledReports(sql, { userLogin: "alice" });
    const bob = listScheduledReports(sql, { userLogin: "bob" });
    expect(alice.length).toBe(1);
    expect(bob.length).toBe(1);
    expect(alice[0]).not.toEqual(bob[0]);
  });

  it("search excludes other users' reports", () => {
    const sql = new MockSqlStorage();
    storeReportAtGeneration(
      sql,
      baseInput({ userLogin: "alice", summary: "zephyr bullish outlook" })
    );
    storeReportAtGeneration(
      sql,
      baseInput({ userLogin: "bob", summary: "zephyr bearish outlook" })
    );
    const hits = searchScheduledReports(sql, "zephyr", 50, {
      userLogin: "bob",
    });
    expect(hits.length).toBe(1);
    expect(hits[0].summary).toContain("bearish");
  });

  it("refuses to backfill an ownerless report into a synthetic tenant", () => {
    const sql = new MockSqlStorage();
    // Multi-tenant SaaS: no login means no tenant. The write is refused
    // rather than filed under "default".
    expect(storeReportAtGeneration(sql, baseInput({ userLogin: "" }))).toBeNull();
    const rows = Array.from(
      sql.exec("SELECT user_login FROM mas_reports")
    ) as Array<{ user_login?: string }>;
    expect(rows).toHaveLength(0);
  });

  it("without a user, list and search keep legacy unfiltered behavior", () => {
    const sql = new MockSqlStorage();
    storeReportAtGeneration(sql, baseInput({ userLogin: "alice" }));
    storeReportAtGeneration(sql, baseInput({ userLogin: "bob" }));
    // No userLogin → no filter (identity strings not yet unified; #488).
    expect(listScheduledReports(sql, {}).length).toBe(2);
    expect(listScheduledReports(sql).length).toBe(2);
  });
});

describe("#584 usage metering (EP-009)", () => {
  it("records a research run usage event attributed to the user", () => {
    const sql = new MockSqlStorage();
    recordUsageEvent(sql, {
      userLogin: "alice",
      runId: "run-1",
      category: "research_run",
    });
    const events = listUsageEvents(sql, "alice");
    expect(events.length).toBe(1);
    expect(events[0].runId).toBe("run-1");
    expect(events[0].category).toBe("research_run");
  });

  it("usage events are scoped per user", () => {
    const sql = new MockSqlStorage();
    recordUsageEvent(sql, {
      userLogin: "alice",
      runId: "run-1",
      category: "research_run",
    });
    recordUsageEvent(sql, {
      userLogin: "bob",
      runId: "run-2",
      category: "research_evaluation",
    });
    expect(listUsageEvents(sql, "alice").length).toBe(1);
    expect(listUsageEvents(sql, "bob").length).toBe(1);
    expect(listUsageEvents(sql, "carol").length).toBe(0);
  });
});
