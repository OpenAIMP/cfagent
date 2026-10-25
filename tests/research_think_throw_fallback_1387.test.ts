/**
 * Issue #1387 — a THROWN Think dispatch must degrade to the direct
 * pipeline, not fail the run.
 *
 * `runAgentTool`'s fresh path awaits `subAgent` with no try/catch, and
 * `runResearchAndPublish`'s outer try has only a `finally`. So the SDK
 * bootstrap throw (missing OrchestratorAgent root namespace) skipped
 * the #543 fallback — which triggers only on a returned non-completed
 * status — and failed the whole research run.
 *
 * The fix converts a thrown dispatch into an error-status child before
 * the existing fallback guard, so the established fallback branch (with
 * its #543 structured warning) runs unchanged. The orchestrator cannot
 * be instantiated under Node, so — following the #543 suite's idiom —
 * the pinned contract is the branch structure itself.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const publish = fs.readFileSync(
  path.resolve(__dirname, "../src/agents/orchestrator/researchPublish.ts"),
  "utf8"
);

function dispatchSection(): string {
  const start = publish.indexOf(
    'let executionPath: ResearchExecutionPath = "think";'
  );
  expect(start).toBeGreaterThan(-1);
  const guard = publish.indexOf('child.status !== "completed"', start);
  expect(guard).toBeGreaterThan(-1);
  return publish.slice(start, guard);
}

describe("Think dispatch throw falls back to the direct pipeline (#1387)", () => {
  const section = dispatchSection();

  it("the runAgentTool dispatch is wrapped in try/catch", () => {
    expect(section).toContain("runAgentTool(ResearchAgent");
    expect(section.indexOf("try {")).toBeGreaterThan(-1);
    expect(section.indexOf("try {")).toBeLessThan(
      section.indexOf("runAgentTool(ResearchAgent")
    );
    expect(section.indexOf("catch")).toBeGreaterThan(
      section.indexOf("runAgentTool(ResearchAgent")
    );
  });

  it("a thrown dispatch becomes an error-status child carrying the message", () => {
    expect(section).toMatch(/status:\s*"error"/);
    expect(section).toMatch(/err(?:or)?\s*instanceof\s*Error\s*\?\s*err\.message/);
  });

  it("the existing fallback guard still follows the dispatch", () => {
    const guard = publish.indexOf('child.status !== "completed"');
    const warn = publish.indexOf("Think research turn bypassed");
    const fallback = publish.indexOf("const fallback = await agent.runResearch");
    expect(guard).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(guard);
    expect(fallback).toBeGreaterThan(warn);
  });
});
