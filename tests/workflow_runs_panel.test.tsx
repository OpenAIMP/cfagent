/** @vitest-environment jsdom */
/**
 * Workflow Runs page: the run ledger renders the server's recorded
 * facts — trigger, stages, reasons, inputs/outputs, artifacts — and
 * never fabricates what the stores did not record.
 *
 * Pins:
 *  - one row per run with its trigger, status, duration, and stage count;
 *  - Details opens the run's stage table, the recorded failure reason,
 *    its inputs/outputs, and its artifact links;
 *  - a run whose store recorded no stages says so explicitly;
 *  - trigger/status filters narrow the table to the recorded rows;
 *  - a failed load is stated, not rendered as an empty ledger.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowRunsPanel } from "../src/client/WorkflowRunsPanel";
import type { WorkflowRun } from "../src/services/workflowRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "chain-1",
    runId: "chain-1",
    workflow: "Stock screening workflow",
    family: "stock",
    title: "Stock screen — NASDAQ100",
    source: "job-chain",
    trigger: "scheduled",
    triggerDetail: "Scheduled — recorded on the run's job tree",
    triggeredBy: null,
    status: "failed",
    startedAt: "2026-10-27T13:00:00.000Z",
    finishedAt: "2026-10-27T13:01:25.000Z",
    durationMs: 85000,
    stageCount: 2,
    completedStages: 1,
    failedStages: 1,
    stages: [
      {
        key: "job-main",
        order: 1,
        stage: "generate",
        label: "Generate — screen / analysis",
        status: "completed",
        recordedBy: "job",
        startedAt: "2026-10-27T13:00:00.000Z",
        finishedAt: "2026-10-27T13:01:00.000Z",
        durationMs: 60000,
        detail: "Stock screen — NASDAQ100",
        reason: null,
        error: null,
        capability: "http.request",
        jobKind: "main",
        channel: null,
        input: { method: "POST", path: "/etrade/screen" },
        output: { matchedCount: 12 },
      },
      {
        key: "job-deliver",
        order: 2,
        stage: "deliver",
        label: "Deliver — channel dispatch",
        status: "failed",
        recordedBy: "job",
        startedAt: "2026-10-27T13:01:00.000Z",
        finishedAt: "2026-10-27T13:01:25.000Z",
        durationMs: 25000,
        detail: "Deliver by Slack — stock screen",
        reason: "[SLACK_002] channel not configured",
        error: "[SLACK_002] channel not configured",
        capability: "followup.deliver",
        jobKind: "delivery",
        channel: "slack",
        input: { channel: "slack" },
        output: { ok: false },
      },
    ],
    inputs: { method: "POST", trigger: "scheduled" },
    outputs: { outcome: { status: "completed", scanned: 100, matched: 12 } },
    artifacts: [{ kind: "pdf", label: "PDF report", url: "/api/screener/report.pdf?key=report" }],
    deliveryStates: { slack: "failed" },
    error: "[SLACK_002] channel not configured",
    ...over,
  };
}

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;
let payload: unknown = { count: 0, runs: [] };
let status = 200;

function stubFetch() {
  globalThis.fetch = vi.fn(async () => {
    if (status !== 200) return Response.json({ error: "boom" }, { status });
    return Response.json(payload);
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPanel() {
  root = createRoot(container);
  await act(async () => {
    root.render(<WorkflowRunsPanel />);
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`button "${text}" not found`);
  return button as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  status = 200;
  stubFetch();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  globalThis.fetch = realFetch;
});

describe("WorkflowRunsPanel", () => {
  it("renders a row per run with trigger, status, and stage progress", async () => {
    payload = { count: 1, runs: [run()] };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("Stock screen — NASDAQ100");
    expect(text).toContain("Scheduled");
    expect(text).toContain("Failed");
    expect(text).toContain("1/2 completed");
    expect(text).toContain("chain-1");
  });

  it("opens the run detail with stages, reasons, inputs, outputs, and artifacts", async () => {
    payload = { count: 1, runs: [run()] };
    await renderPanel();
    await act(async () => {
      buttonByText("Details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Run detail");
    expect(text).toContain("Generate — screen / analysis");
    expect(text).toContain("Deliver — channel dispatch");
    expect(text).toContain("[SLACK_002] channel not configured");
    expect(text).toContain("Scheduled — recorded on the run's job tree");
    expect(text).toContain("matchedCount");
    const pdf = [...container.querySelectorAll("a")].find((a) => a.textContent === "PDF report");
    expect(pdf?.getAttribute("href")).toBe("/api/screener/report.pdf?key=report");
    expect(text).toContain("slack: failed");
  });

  it("says a run has no stage records instead of inventing stages", async () => {
    payload = {
      count: 1,
      runs: [
        run({
          id: "discovery-1",
          runId: "discovery-1",
          source: "job-outcome",
          workflow: "Strategy discovery workflow",
          title: "Discovery run — discovery-1",
          status: "completed",
          stageCount: 0,
          completedStages: 0,
          failedStages: 0,
          stages: [],
          error: null,
          artifacts: [],
          deliveryStates: {},
        }),
      ],
    };
    await renderPanel();
    await act(async () => {
      buttonByText("Details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("No stage records exist for this run");
    expect(container.textContent).toContain("Stages are never inferred");
  });

  it("filters by status and trigger", async () => {
    payload = {
      count: 2,
      runs: [
        run(),
        run({
          id: "chain-2",
          runId: "chain-2",
          title: "Manual options run",
          trigger: "manual",
          triggerDetail: "Manual — recorded by the operator",
          status: "completed",
          failedStages: 0,
          stages: [],
          stageCount: 0,
          error: null,
          artifacts: [],
          deliveryStates: {},
        }),
      ],
    };
    await renderPanel();
    await act(async () => {
      buttonByText("Failed").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Stock screen — NASDAQ100");
    expect(container.textContent).not.toContain("Manual options run");

    await act(async () => {
      buttonByText("All statuses").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      buttonByText("Manual").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Manual options run");
    expect(container.textContent).not.toContain("Stock screen — NASDAQ100");
  });

  it("states a failed load instead of showing an empty ledger", async () => {
    status = 500;
    await renderPanel();
    expect(container.textContent).toContain("Could not load workflow runs");
  });
});
