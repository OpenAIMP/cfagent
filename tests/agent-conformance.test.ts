/**
 * Issue #1738 — Agents SDK actor conformance regression tests
 * (successor to the #542 Think conformance suite, same idiom).
 *
 * Why source-evidence tests: the agents SDK module graph pulls
 * `cloudflare:` imports the node loader cannot resolve, so the suite
 * cannot instantiate a real Agent under Node. What it *can* pin —
 * and what silently regressed before the #542 file existed — is the
 * adoption evidence itself: the framework is pinned, every agent is
 * an Agents SDK actor (no Think agent class remains), each class is
 * exported as a Durable Object, the bindings + SQLite migrations
 * exist, and the orchestrator actually dispatches to the actor.
 * Removing any anchor fails this suite. (Repo precedent for this
 * style: tests/research-boundary.test.ts.)
 *
 * Scope note: these tests prove the actor path is wired, not that a
 * live actor turn behaves correctly in the Workers runtime — the
 * turn lifecycle itself is pinned by tests/actor-ports-conformance
 * (port + both adapters) and tests/orchestrator-actor-cutover.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("Agent conformance (issue #1738)", () => {
  it("the agents framework package is pinned to an exact version", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["agents"]).toMatch(EXACT_VERSION);
  });

  it("ResearchAgent extends Agent with the framework overrides", () => {
    const src = read("src/agents/research-agent.ts");
    expect(src).toMatch(/import\s*\{\s*Agent\s*\}\s*from\s*"agents"/);
    expect(src).toMatch(/export\s+class\s+ResearchAgent\s+extends\s+Agent</);
    // The three overrides the SDK calls into (same surface Think
    // 0.19 exposed; verified against the installed agents package).
    expect(src).toContain("getModel()");
    expect(src).toContain("getSystemPrompt()");
    expect(src).toContain("getTools()");
    // The agent's single tool is the read-only research pipeline.
    expect(src).toContain("run_options_research");
  });

  it("Agent adopters in src are exactly the designated roles (new adopters update this pin deliberately)", () => {
    const adopters = listTsFiles(path.join(ROOT, "src"))
      .filter((f) => /extends\s+Agent</.test(read(path.relative(ROOT, f))))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      .sort();
    // The three remaining pre-#1738 actors (Screener, Scheduled,
    // Payments) plus the three #1738 migrations (Orchestrator,
    // Research, Trading). ReportAsset left this list in #1958: it
    // now extends PortThink, not Agent (its own pin lives in
    // tests/report-asset-agent.test.ts). BrowserAgent/SlackAgent
    // extend AIChatAgent and are deliberately NOT in this list —
    // they are chat agents, not actor-role agents.
    expect(adopters).toEqual([
      "src/agents/orchestrator.ts",
      "src/agents/payments-agent.ts",
      "src/agents/research-agent.ts",
      "src/agents/scheduled-agent.ts",
      "src/agents/screener-agent.ts",
      "src/agents/trading-agent.ts",
    ]);
  });

  it("no agent code imports the Think base directly, except the foundation adapter files (workflows subpath excepted)", () => {
    // Deliberate exception, not drift: the owner decision of
    // 2026-10-27 supersedes #1738's "no Think agent class remains"
    // criterion for shape (a) — Think behind the existing actor
    // port. Agent classes still must not import Think directly;
    // they reach it only through PortThink. The two foundation
    // adapter files (tracker #1951, foundation issue #1962) are
    // the sole files allowed to import the Think base, mirroring
    // the adjacent adopter pin's "new adopters update this pin
    // deliberately" pattern. Any other bare import still fails.
    const bareThink = listTsFiles(path.join(ROOT, "src"))
      .filter((f) => read(path.relative(ROOT, f)).includes('from "@cloudflare/think"'))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      .sort();
    expect(bareThink).toEqual([
      "src/actors/thinkAdapter.ts",
      "src/actors/thinkPortMapping.ts",
    ]);
    // The workflows subpath is a different specifier and stays:
    // both workflow classes are ThinkWorkflow by ADR 0004 W13.
    const workflowFiles = listTsFiles(path.join(ROOT, "src")).filter((f) =>
      read(path.relative(ROOT, f)).includes('from "@cloudflare/think/workflows"')
    );
    expect(workflowFiles.map((f) => path.relative(ROOT, f)).sort()).toEqual([
      "src/agents/trading-trade-workflow.ts",
      "src/workflows/screenerWorkflow.ts",
    ]);
  });

  it("the Worker exports ResearchAgent as a Durable Object class", () => {
    const server = read("src/server.ts");
    expect(server).toMatch(
      /export\s*\{\s*ResearchAgent\s*\}\s*from\s*"\.\/agents\/research-agent"/
    );
  });

  it("TradingAgent extends Agent with the framework overrides (issue #291, migrated #1738)", () => {
    const src = read("src/agents/trading-agent.ts");
    expect(src).toMatch(/import\s*\{\s*Agent\s*\}\s*from\s*"agents"/);
    expect(src).toMatch(/export\s+class\s+TradingAgent\s+extends\s+Agent</);
    expect(src).toContain("getModel()");
    expect(src).toContain("getSystemPrompt()");
    expect(src).toContain("getTools()");
  });

  it("the Worker exports TradingAgent as a Durable Object class (issue #291)", () => {
    const server = read("src/server.ts");
    expect(server).toMatch(
      /export\s*\{\s*TradingAgent\s*\}\s*from\s*"\.\/agents\/trading-agent"/
    );
  });

  it("wrangler binds TRADING_AGENT to TradingAgent with a SQLite migration (issue #291)", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toMatch(
      /"name":\s*"TRADING_AGENT",\s*"class_name":\s*"TradingAgent"/
    );
    expect(wrangler).toMatch(/"new_sqlite_classes":\s*\[[^\]]*"TradingAgent"/);
  });

  it("wrangler binds RESEARCH_AGENT to ResearchAgent with a SQLite migration", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toMatch(
      /"name":\s*"RESEARCH_AGENT",\s*"class_name":\s*"ResearchAgent"/
    );
    expect(wrangler).toMatch(/"new_sqlite_classes":\s*\[[^\]]*"ResearchAgent"/);
  });

  it("the orchestrator dispatches research through the Agent actor", () => {
    const orchestrator = read("src/agents/orchestrator.ts");
    // The dispatch call itself lives in the extracted researchPublish
    // module (#992 subset 2); the class wires that module in.
    const researchPublish = read("src/agents/orchestrator/researchPublish.ts");
    // Per-tenant instance resolution off the DO binding…
    expect(orchestrator).toContain("this.env.RESEARCH_AGENT");
    expect(orchestrator).toContain("research:${login}");
    // …and the agent-tool dispatch that runs the SDK actor run.
    expect(researchPublish).toContain("runAgentTool(ResearchAgent");
  });

  it("the test harness is the in-memory actor adapter, not a Think stub", () => {
    const vite = read("vite.config.ts");
    // The bare @cloudflare/think alias is gone: agent code no longer
    // imports it, so no stub is needed for it. The workflows alias
    // stays (workflow files still import that subpath).
    expect(vite).not.toContain('"@cloudflare/think":');
    expect(vite).toContain('"@cloudflare/think/workflows"');
    expect(fs.existsSync(path.join(ROOT, "tests/stubs/cloudflareThink.ts"))).toBe(false);
    // The replacement harness: the in-memory actor adapter runs the
    // same turn runner with a stubbed provider boundary (see
    // tests/actor-ports-conformance.test.ts).
    const adapter = read("src/actors/inMemoryActorAdapter.ts");
    expect(adapter).toContain("createInMemoryActorTurn");
    expect(adapter).toContain("Stub assistant reply.");
  });
});
