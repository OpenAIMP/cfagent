/**
 * #2456: read-only API requests must never become runs.
 *
 * Two pins:
 *  - the queue decision is method-aware: GET/HEAD are never queued,
 *    whatever the delivery mode; mutating methods and an unknown
 *    method keep the legacy behavior.
 *  - the Workflow Runs read model drops standalone http.request
 *    request-traces (no chain, no parent, no stage, no stageChain).
 *    Chain-member http.request stages are real run stages (the
 *    stockChain fixture in workflow_runs.test.ts pins a POST
 *    http.request main job as a chain's generate stage) and stay.
 */
import { describe, it, expect } from "vitest";
import { shouldQueueApiRequest } from "../src/config/asyncJobModes";
import {
  buildWorkflowRuns,
  type WorkflowRunJobRow,
} from "../src/services/workflowRuns";

function queuedOpts(overrides: Record<string, unknown> = {}) {
  return {
    isApiRequest: true,
    isJobsEndpoint: false,
    isMcpEndpoint: false,
    isScheduleEndpoint: false,
    deliveryMode: "queued" as const,
    ...overrides,
  };
}

describe("shouldQueueApiRequest method gate (#2456)", () => {
  it("never queues GET, even when the delivery mode is queued", () => {
    expect(shouldQueueApiRequest(queuedOpts({ method: "GET" }))).toBe(false);
  });

  it("never queues HEAD, even when the delivery mode is queued", () => {
    expect(shouldQueueApiRequest(queuedOpts({ method: "HEAD" }))).toBe(false);
  });

  it("normalizes the method before comparing", () => {
    expect(shouldQueueApiRequest(queuedOpts({ method: "get" }))).toBe(false);
  });

  it("still queues POST when the delivery mode is queued", () => {
    expect(shouldQueueApiRequest(queuedOpts({ method: "POST" }))).toBe(true);
  });

  it("still queues DELETE when the delivery mode is queued", () => {
    expect(shouldQueueApiRequest(queuedOpts({ method: "DELETE" }))).toBe(true);
  });

  it("keeps the legacy behavior when no method is supplied", () => {
    expect(shouldQueueApiRequest(queuedOpts())).toBe(true);
  });

  it("never queues GET in sync mode either", () => {
    expect(
      shouldQueueApiRequest(queuedOpts({ method: "GET", deliveryMode: "sync" as const })),
    ).toBe(false);
  });
});

function traceJob(job_id: string, path: string): WorkflowRunJobRow {
  return {
    job_id,
    capability: "http.request",
    display_name: `GET ${path}`,
    status: "running",
    created_at: "2026-10-30T13:12:00.000Z",
    payload_json: JSON.stringify({ method: "GET", pathAndQuery: path, headers: {}, body: "" }),
  };
}

function chainMain(): WorkflowRunJobRow {
  return {
    job_id: "job-main",
    capability: "http.request",
    display_name: "Stock screen — NASDAQ100",
    status: "completed",
    created_at: "2026-10-27T13:00:00.000Z",
    completed_at: "2026-10-27T13:01:00.000Z",
    job_kind: "main",
    chain_id: "chain-1",
    stage: "generate",
    payload_json: JSON.stringify({
      method: "POST",
      pathAndQuery: "/etrade/screen?universe=NASDAQ100",
      stageChain: ["generate", "serve", "deliver"],
    }),
    result_json: JSON.stringify({ success: true, matchedCount: 12, totalScanned: 100 }),
  };
}

function chainReport(): WorkflowRunJobRow {
  return {
    job_id: "job-report",
    capability: "followup.report",
    display_name: "Generate report — stock screen",
    status: "completed",
    created_at: "2026-10-27T13:01:00.000Z",
    completed_at: "2026-10-27T13:01:20.000Z",
    job_kind: "report",
    parent_job_id: "job-main",
    chain_id: "chain-1",
    stage: "serve",
    payload_json: JSON.stringify({ outcome: { kind: "stock", trigger: "scheduled" } }),
    result_json: JSON.stringify({ status: "completed" }),
  };
}

describe("buildWorkflowRuns request-trace filter (#2456)", () => {
  it("drops a standalone http.request GET trace so it is not a run", () => {
    const runs = buildWorkflowRuns({
      jobs: [traceJob("trace-1", "/autopilot")],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(0);
  });

  it("drops every standalone trace when mixed with a real chain", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        traceJob("trace-1", "/autopilot"),
        traceJob("trace-2", "/runs"),
        traceJob("trace-3", "/market-data/screen"),
        chainMain(),
        chainReport(),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("chain-1");
    expect(runs[0].stages.map((s) => s.stage)).toEqual(["generate", "serve"]);
  });

  it("keeps a chain-member http.request main job as its chain's stage", () => {
    const runs = buildWorkflowRuns({
      jobs: [chainMain(), chainReport()],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].workflow).toBe("Stock screening workflow");
    expect(runs[0].stages.map((s) => s.stage)).toEqual(["generate", "serve"]);
  });

  it("keeps an http.request singleton carrying a stageChain (a chain main in formation)", () => {
    const main = chainMain();
    delete (main as Partial<WorkflowRunJobRow>).chain_id;
    delete (main as Partial<WorkflowRunJobRow>).stage;
    const runs = buildWorkflowRuns({ jobs: [main], outcomes: [], transitions: [] });
    expect(runs).toHaveLength(1);
  });

  it("drops a standalone http.request HEAD trace as well", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        {
          job_id: "trace-head",
          capability: "http.request",
          display_name: "HEAD /autopilot",
          status: "running",
          created_at: "2026-10-30T13:12:00.000Z",
          payload_json: JSON.stringify({ method: "HEAD", pathAndQuery: "/autopilot", headers: {}, body: "" }),
        },
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(0);
  });

  it("keeps a POST http.request singleton: a real submission, not a page load", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        {
          job_id: "post-1",
          capability: "http.request",
          display_name: "POST /etrade/screen",
          status: "completed",
          created_at: "2026-10-30T13:12:00.000Z",
          completed_at: "2026-10-30T13:12:05.000Z",
          payload_json: JSON.stringify({
            method: "POST",
            pathAndQuery: "/etrade/screen",
            body: JSON.stringify({ trigger: "scheduled", universe: "NASDAQ100" }),
          }),
        },
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("scheduled");
  });

  it("keeps a non-http.request standalone job (the filter is http.request-only)", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        {
          job_id: "tool-1",
          capability: "mcp.tool",
          display_name: "MCP: quote",
          status: "completed",
          created_at: "2026-10-30T13:12:00.000Z",
          completed_at: "2026-10-30T13:12:01.000Z",
        },
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
  });
});
