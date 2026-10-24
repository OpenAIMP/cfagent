/**
 * Issue #1361 (epic #1151 slice C5).
 *
 * Serve-side contracts for bundles + goal runs through the one
 * generate/store/serve pipeline:
 * - Goal canonical rows surface in Runs under kind "goal" (C4
 *   limitation: they surfaced under kind "report" because the Runs
 *   shape had no goal kind).
 * - Bundle canonical rows (source "bundle", written via the shared
 *   storeReportStage seam) surface in Reports under the "report"
 *   fallthrough with their source preserved — the serve contract the
 *   bundle decision card relies on.
 * - GET /api/runs accepts kind=goal as a filter (unknown kinds still
 *   400, never a silent "all").
 */
import { describe, it, expect } from "vitest";
import { runSummaryFromReport } from "../src/services/runSummaries";
import { parseRunsListKind } from "../src/trading/screeningSchemas";
import type { ScheduledReportHit } from "../src/services/scheduledReports";

function hit(overrides: Partial<ScheduledReportHit>): ScheduledReportHit {
  return {
    id: "rep-1",
    runId: "run-1",
    title: "t",
    source: "screener",
    summary: "s",
    body: "{}",
    createdAt: "2026-10-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("Runs kind: goal", () => {
  it("goal_screen canonical rows map to kind goal (not report)", () => {
    const row = runSummaryFromReport(hit({
      id: "rep-goal-1",
      runId: "goal:2026-10-24",
      title: "Goal screen — directional",
      source: "goal_screen",
      body: JSON.stringify({ trigger: "scheduled", result: { status: "complete" } }),
    }));
    expect(row.kind).toBe("goal");
    expect(row.source).toBe("goal_screen");
    expect(row.status).toBe("completed");
  });

  it("GET /api/runs accepts kind=goal and still rejects unknown kinds", () => {
    expect(parseRunsListKind("goal")).toEqual({ ok: true, value: "goal" });
    const bad = parseRunsListKind("bogus");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("screener");
  });
});

describe("Runs serve: bundle canonical rows", () => {
  it("bundle rows surface under the report fallthrough with source preserved", () => {
    const row = runSummaryFromReport(hit({
      id: "rep-bundle-1",
      runId: "bundle_abc",
      title: "Recommendation Bundle — XYZ 200/210 bull call spread",
      source: "bundle",
      summary: "Decision: trade · Qualification: Qualified",
      body: JSON.stringify({ trigger: "manual", success: true, bundleId: "bundle_abc" }),
    }));
    expect(row.kind).toBe("report");
    expect(row.source).toBe("bundle");
    expect(row.status).toBe("completed");
  });
});
