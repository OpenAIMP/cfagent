/**
 * Issue #339: getScheduledReportById — the store lookup behind
 * GET /api/reports/:id (Reports-tab research run detail). Owner scoping
 * follows the #584 EP-003 rule used by the list: strict when the caller
 * login is known, legacy unfiltered when it is not.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  ensureScheduledReportsTable,
  storeReportAtGeneration,
  getScheduledReportById,
} from "../src/services/scheduledReports";

function input(over: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    title: "Research run",
    source: "research_report",
    summary: "2 qualified ideas",
    body: { ideas: [] },
    userLogin: "alice",
    createdAt: "2026-10-19T12:00:00.000Z",
    ...over,
  } as any;
}

describe("getScheduledReportById", () => {
  let sql: MockSqlStorage;
  let aliceId: string | null;
  let bobId: string | null;

  beforeEach(() => {
    sql = new MockSqlStorage();
    ensureScheduledReportsTable(sql as any);
    // Persist via the canonical generation-time store (the path the
    // orchestrator uses): it records user_login, unlike the legacy raw
    // persistScheduledReportSql insert.
    aliceId = storeReportAtGeneration(sql as any, input()).reportId;
    bobId = storeReportAtGeneration(
      sql as any,
      input({ runId: "run-2", title: "Bob run", userLogin: "bob" })
    ).reportId;
  });

  it("returns the stored report with its body", () => {
    const hit = getScheduledReportById(sql as any, aliceId!);
    expect(hit).not.toBeNull();
    expect(hit!.title).toBe("Research run");
    expect(hit!.source).toBe("research_report");
    expect(JSON.parse(hit!.body)).toEqual({ ideas: [] });
  });

  it("returns null for an unknown id", () => {
    expect(getScheduledReportById(sql as any, "nope")).toBeNull();
  });

  it("hides another owner's report when the caller login is known", () => {
    expect(
      getScheduledReportById(sql as any, bobId!, { userLogin: "alice" })
    ).toBeNull();
    expect(
      getScheduledReportById(sql as any, bobId!, { userLogin: "bob" })
    )!.not.toBeNull();
  });

  it("never throws on a broken store", () => {
    const broken = {
      exec() {
        throw new Error("db gone");
      },
    } as any;
    expect(getScheduledReportById(broken, "x")).toBeNull();
  });
});
