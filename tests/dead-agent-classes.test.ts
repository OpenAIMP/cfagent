/**
 * Issue #597 (phase-2 P2-0.3; finding F5) — the unreferenced standalone
 * agent classes stay removed.
 *
 * `src/agents/{search,tasks,memory,payments}.ts` were dead AIChatAgent
 * classes, verified unreferenced across src/tests/config, whose names
 * collided with live classes (SearchAgent was the orchestrator's
 * export alias, renamed OrchestratorAgent in #2523; PaymentsAgent =
 * the payments Durable Object). Live behavior
 * for those domains is the mas.ts tool factory. If one of these paths
 * reappears, it must arrive wired and exported deliberately — this
 * test forces that conversation instead of a silent resurrection.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..");
const DEAD_PATHS = [
  "src/agents/search.ts",
  "src/agents/tasks.ts",
  "src/agents/memory.ts",
  "src/agents/payments.ts",
];

describe("removed standalone agent classes (F5)", () => {
  it("the four dead files are absent", () => {
    for (const rel of DEAD_PATHS) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(false);
    }
  });

  it("the live export surface in src/server.ts is unchanged", () => {
    const server = fs.readFileSync(path.join(root, "src/server.ts"), "utf8");
    for (const name of [
      'export { OrchestratorAgent } from "./agents/orchestrator"',
      "OptionsScannerMCP",
      "BrowserAgent",
      "SlackAgent",
      "PaymentsAgent",
      "ScheduledAgent",
      "ScreenerAgent",
      "ResearchAgent",
      "SessionStore",
    ]) {
      expect(server).toContain(name);
    }
  });

  it("no source file imports the removed modules", () => {
    const agentsDir = path.join(root, "src/agents");
    const offenders: string[] = [];
    for (const file of fs.readdirSync(agentsDir)) {
      if (!file.endsWith(".ts")) continue;
      const src = fs.readFileSync(path.join(agentsDir, file), "utf8");
      if (/from\s+["']\.\/(search|tasks|memory|payments)["']/.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
