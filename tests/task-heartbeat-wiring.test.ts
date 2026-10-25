/**
 * Issue #624 (phase-2 P2-3.4) — heartbeat emission during long runs.
 *
 * Research: OrchestratorAgent.runResearchAndPublish heartbeats the
 * task every 2 minutes while dispatch is in flight (both the Think
 * turn and the fallback run are awaited there), cleared in a finally.
 * Screener: runScreen heartbeats its own task at phase checkpoints
 * and during the technicals phase via fetchTechnicalsBatch's onBatch
 * callback, throttled to one write per minute.
 *
 * Source-evidence tests, the repo idiom for Durable Object wiring
 * that vitest cannot instantiate. Ledger heartbeat semantics are
 * covered by the #577/#607/#615 suites.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

/** Slice from a marker to the next top-level method definition. */
function region(src: string, from: string, to = "\n  async "): string {
  const start = src.indexOf(from);
  expect(start, `expected to find: ${from}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end === -1 ? undefined : end);
}

const researchAgent = read("src/agents/research-agent.ts");
const screenerAgent = read("src/agents/screener-agent.ts");
const orchestrator = read("src/agents/orchestrator.ts");
// Issue #992 subset 2: the research-publish bodies moved to this module.
const researchPublish = read("src/agents/orchestrator/researchPublish.ts");
const yahooHistory = read("src/trading/yahooHistory.ts");

describe("task heartbeat wiring (#624)", () => {
  it("ResearchAgent exposes heartbeatResearchTask delegating to the ledger", () => {
    const m = region(researchAgent, "async heartbeatResearchTask(");
    expect(m).toContain("taskLedger().heartbeat(");
  });

  it("ScreenerAgent exposes heartbeatScreenerTask delegating to the ledger", () => {
    const m = region(screenerAgent, "async heartbeatScreenerTask(");
    expect(m).toContain("taskLedger().heartbeat(");
  });

  it("research dispatch heartbeats on a 2-minute timer while in flight", () => {
    expect(orchestrator).toContain("RESEARCH_TASK_HEARTBEAT_MS = 120_000");
    const dispatch = region(researchPublish, "function runResearchAndPublish(");
    expect(dispatch).toContain("setInterval(");
    expect(dispatch).toContain("RESEARCH_TASK_HEARTBEAT_MS");
    expect(dispatch).toContain("heartbeatResearchTask(");
  });

  it("the research heartbeat timer is always cleared (finally)", () => {
    const dispatch = region(researchPublish, "function runResearchAndPublish(");
    expect(dispatch).toContain("finally");
    expect(dispatch).toContain("clearInterval(");
    expect(dispatch.indexOf("setInterval(")).toBeLessThan(dispatch.indexOf("clearInterval("));
  });

  it("runScreen heartbeats at phase checkpoints, throttled to one write per minute", () => {
    expect(screenerAgent).toContain("SCREENER_HEARTBEAT_MIN_MS = 60_000");
    const run = region(screenerAgent, "async runScreen(");
    expect(run).toContain("heartbeatScreenerTask(taskId)");
    expect(run).toContain("SCREENER_HEARTBEAT_MIN_MS");
    const beats = run.match(/await beat\(\)/g) ?? [];
    expect(beats.length).toBeGreaterThanOrEqual(2);
  });

  it("the technicals phase reports progress into the heartbeat", () => {
    const run = region(screenerAgent, "async runScreen(");
    // The batch progress callback passed to fetchTechnicalsBatch is the
    // throttled heartbeat itself (positional 4th argument, yahooHistory).
    expect(run).toContain("() => beat()");
    const batch = region(yahooHistory, "fetchTechnicalsBatch(");
    expect(batch).toContain("onBatch?:");
    expect(batch).toContain("await onBatch(");
  });
});
