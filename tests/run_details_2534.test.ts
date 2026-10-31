/**
 * Run Details (issue #2534): the traceability model behind the
 * Docs & Reports modal, for every run type and for success and
 * failure alike. Pins:
 *  - a success run shows request + defaults + provenance;
 *  - a failed/empty run shows a specific why-no-data reason code
 *    (not a generic failure string);
 *  - messages resolve from the catalog: changing catalog wording
 *    changes the displayed text without a code change;
 *  - a legacy row renders missing fields as unknown, never guessed
 *    (job type is never inferred from the run id);
 *  - a per-stage trace exists for stock, options, goal, strategy,
 *    discovery, and research families.
 */
import { describe, it, expect } from "vitest";
import {
  buildRunDetail,
  resolveRunDetailMessage,
  RUN_DETAIL_MESSAGE_CATALOG,
  type RunDetailMessageCatalog,
} from "../src/services/runDetails";
import { formatRunDetailTimestamp, runDetailVisibleSections } from "../src/client/runDetails";
import type { RunSummary } from "../src/services/runSummaries";

function summary(over: Partial<RunSummary> = {}): RunSummary & { body?: unknown } {
  return {
    kind: "options_scanner",
    id: "rep-1",
    runId: "options:2026-10-31T09:20:56.666Z",
    title: "Options scan — bullish",
    summary: "Scanned 20 symbols, 5 with trades.",
    trigger: "scheduled",
    createdAt: "2026-10-31T09:20:56.666Z",
    status: "completed",
    resultCount: 5,
    pdfKey: "options:pdf:rep-1",
    reportUrl: "/api/options/report.pdf?key=options%3Apdf%3Arep-1",
    xlsxKey: "options:xlsx:rep-1",
    xlsxUrl: "/api/options/report.xlsx?key=options%3Axlsx%3Arep-1",
    csvKey: "options:csv:rep-1",
    csvUrl: "/api/options/report.csv?key=options%3Acsv%3Arep-1",
    pdfStatus: "generated",
    pdfError: null,
    xlsxStatus: "generated",
    xlsxError: null,
    csvStatus: "generated",
    csvError: null,
    reportId: "rep-1",
    scanRunId: "da875555-5e46-4729-a5c9-f76c45e61a2e",
    discoveryRunId: null,
    source: "options_scanner",
    ...over,
  } as RunSummary & { body?: unknown };
}

describe("run details: success run", () => {
  it("shows request, provenance, lineage, and a stage trace", () => {
    const detail = buildRunDetail(
      summary({
        body: {
          thesis: "bullish",
          symbols: ["NVDA"],
          jobType: "options-scheduled",
          strategyMode: "all",
          inputHash: "abc123",
          captureIds: ["cap-1"],
          provenance: { executionMode: "batch", syncAsync: "async", interface: "api", parallelism: "parallel", parallelCount: 4, parallelCap: 4 },
          workflow: { id: "wf-1", name: "ScreenerScreenWorkflow", version: "3", type: "deterministic" },
          submittedVia: { channel: "schedule" },
          deliveredVia: [{ channel: "docs", status: "delivered" }],
        },
      }),
    );
    expect(detail.request.find((f) => f.field === "thesis")?.value).toBe("bullish");
    expect(detail.request.find((f) => f.field === "thesis")?.source).toBe("recorded");
    expect(detail.provenance.jobType).toBe("options-scheduled");
    expect(detail.provenance.executionMode).toBe("batch");
    expect(detail.provenance.parallelCount).toBe(4);
    expect(detail.provenance.workflowName).toBe("ScreenerScreenWorkflow");
    expect(detail.provenance.workflowType).toBe("deterministic");
    expect(detail.lineage.captureIds).toContain("cap-1");
    expect(detail.lineage.inputHash).toBe("abc123");
    expect(detail.stages.map((s) => s.stage)).toEqual(["feed", "gather", "analysis", "generation", "recording", "delivery"]);
    expect(detail.stages.find((s) => s.stage === "generation")?.status).toBe("completed");
    expect(detail.reasons.filter((r) => r.format === "PDF")).toEqual([]);
  });
});

describe("run details: failed / empty run", () => {
  it("shows a specific why-no-data reason per failed format", () => {
    const detail = buildRunDetail(
      summary({
        status: "failed",
        pdfKey: null,
        reportUrl: null,
        pdfStatus: "failed",
        pdfError: "connector unavailable for enriching data",
        xlsxKey: null,
        xlsxUrl: null,
        xlsxStatus: null,
        csvKey: null,
        csvUrl: null,
        csvStatus: null,
      }),
    );
    expect(detail.reasons.some((r) => r.code === "RUN_PDF_FAILED")).toBe(true);
    expect(detail.reasons.some((r) => r.code === "RUN_CONNECTOR_UNAVAILABLE")).toBe(true);
    expect(detail.reasons.some((r) => r.code === "RUN_NO_ARTIFACT_RECORDED" && r.format === "XLSX")).toBe(true);
    expect(detail.stages.find((s) => s.stage === "generation")?.status).toBe("failed");
  });

  it("shows an empty-result reason when the run completed with no results", () => {
    const detail = buildRunDetail(summary({ resultCount: 0, status: "completed", pdfKey: null, reportUrl: null, pdfStatus: null, xlsxKey: null, xlsxUrl: null, csvKey: null, csvUrl: null }));
    expect(detail.reasons.some((r) => r.code === "RUN_EMPTY_RESULT")).toBe(true);
  });

  it("shows never-attempted, not failure, for discovery generation", () => {
    const detail = buildRunDetail(summary({ kind: "discovery", source: "discovery", pdfKey: null, reportUrl: null, pdfStatus: null, xlsxKey: null, xlsxUrl: null, csvKey: null, csvUrl: null, scanRunId: null, discoveryRunId: "disc-1" }));
    expect(detail.stages.find((s) => s.stage === "generation")?.status).toBe("never-attempted");
    expect(detail.reasons.some((r) => r.code === "RUN_NEVER_ATTEMPTED")).toBe(true);
  });
});

describe("run details: message catalog (AOP)", () => {
  it("changing catalog wording changes display without a code change", () => {
    const custom: RunDetailMessageCatalog = {
      ...RUN_DETAIL_MESSAGE_CATALOG,
      RUN_PDF_FAILED: {
        ...RUN_DETAIL_MESSAGE_CATALOG.RUN_PDF_FAILED,
        template: "CUSTOM WORDING for PDF failure{error}.",
      },
    };
    const resolved = resolveRunDetailMessage("RUN_PDF_FAILED", { error: ": boom" }, custom);
    expect(resolved.text).toBe("CUSTOM WORDING for PDF failure: boom.");
    const detail = buildRunDetail(
      summary({ status: "failed", pdfStatus: "failed", pdfError: "boom", pdfKey: null, reportUrl: null }),
      { catalog: custom },
    );
    expect(detail.reasons.find((r) => r.code === "RUN_PDF_FAILED")?.text).toContain("CUSTOM WORDING");
  });

  it("unknown codes render as a catalog-miss, never a guessed message", () => {
    expect(resolveRunDetailMessage("RUN_DOES_NOT_EXIST").text).toContain("RUN_DOES_NOT_EXIST");
  });
});

describe("run details: legacy rows", () => {
  it("renders missing fields as unknown, never guessed — including job type", () => {
    const detail = buildRunDetail(summary({ body: undefined, scanRunId: null }));
    expect(detail.provenance.jobType).toBeNull();
    expect(detail.request.find((f) => f.field === "thesis")?.source).toBe("unknown");
    expect(detail.lineage.inputHash).toBeNull();
    // Job type is never inferred from the run id prefix.
    expect(detail.provenance.jobType).not.toBe("options-scheduled");
  });
});

describe("run details: every family has a stage trace", () => {
  it.each([
    ["screener", "screener"],
    ["options_scanner", "options_scanner"],
    ["goal", "goal_screen"],
    ["discovery", "discovery"],
    ["report", "options_research"],
  ])("kind %s gets all six stages", (kind, source) => {
    const detail = buildRunDetail(summary({ kind: kind as RunSummary["kind"], source }));
    expect(detail.stages.map((s) => s.stage)).toEqual(["feed", "gather", "analysis", "generation", "recording", "delivery"]);
  });
});

describe("run details: display helpers", () => {
  it("formats timestamps in the user timezone with a label, never bare ISO", () => {
    const text = formatRunDetailTimestamp("2026-10-31T09:20:56.666Z", "America/New_York");
    expect(text).toContain("2026");
    expect(text).toMatch(/EDT|EST/);
    expect(text).not.toBe("2026-10-31T09:20:56.666Z");
  });

  it("level filters partition sections without dropping the modal", () => {
    expect(runDetailVisibleSections("error")).toEqual(["reasons"]);
    expect(runDetailVisibleSections("info")).toEqual(["request", "provenance"]);
    expect(runDetailVisibleSections("all")).toHaveLength(5);
  });
});
