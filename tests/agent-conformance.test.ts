/**
 * Issue #1738 — Agents SDK actor conformance regression tests
 * (successor to the #542 Think conformance suite, same idiom).
 *
 * Why source-evidence tests: the agents SDK module graph pulls
 * `cloudflare:` imports the node loader cannot resolve, so the suite
 * cannot instantiate a real Agent under Node. What it *can* pin —
 * and what silently regressed before the #542 file existed — is the
 * adoption evidence itself: the framework is pinned, every agent is
 * an Agents SDK actor (no Think agent class remains) — except
 * ResearchAgent since #1953 (think-fleet, shape (a): Think behind
 * the port via PortThink, pinned by the ResearchAgent test below),
 * each class is exported as a Durable Object, the bindings +
 * SQLite migrations exist, and the orchestrator actually
 * dispatches to the actor.
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

  it("ResearchAgent extends PortThink with the framework overrides (issue #1953, think-fleet)", () => {
    const src = read("src/agents/research-agent.ts");
    // Think behind the actor port (tracker #1951, shape (a)): the
    // class reaches Think only through PortThink, never raw Think
    // and never the Agents SDK base it used before #1953.
    expect(src).toMatch(/import\s*\{\s*PortThink\s*\}\s*from\s*"\.\.\/actors\/thinkAdapter"/);
    expect(src).toMatch(/export\s+class\s+ResearchAgent\s+extends\s+PortThink\b/);
    expect(src).not.toMatch(/import\s*\{\s*Agent\s*\}\s*from\s*"agents"/);
    // The three overrides the SDK calls into (same surface Think
    // 0.19 exposed; verified against the installed agents package).
    expect(src).toContain("getModel()");
    expect(src).toContain("getSystemPrompt()");
    expect(src).toContain("getTools()");
    // The agent's single tool is the read-only research pipeline.
    expect(src).toContain("run_options_research");
    // PortThink translates Think's hook calls into this object.
    expect(src).toContain("portHooks");
  });

  it("Agent adopters in src are exactly the designated roles (new adopters update this pin deliberately)", () => {
    const adopters = listTsFiles(path.join(ROOT, "src"))
      .filter((f) => /extends\s+Agent</.test(read(path.relative(ROOT, f))))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      .sort();
    // No plain-Agent adopter remains: ReportAsset left this list
    // in #1958 (think-fleet), completing the migration — it now
    // extends PortThink, not Agent (its own pin lives in
    // tests/report-asset-agent.test.ts). Orchestrator left in
    // #1952, Research in #1953, Screener in #1955, Trading in
    // #1954, Scheduled in #1956, and Payments in #1957: all
    // seven extend PortThink now, which extends Think, which
    // extends Agent — so they are still Agents SDK actors, but
    // no longer match the plain-Agent pin.
    // BrowserAgent/SlackAgent likewise extend PortThink now
    // (Browser #1959, Slack #1960, tracker #1951) — they never
    // matched this pin (AIChatAgent before, PortThink now), so
    // the empty list is unchanged by their migration.
    expect(adopters).toEqual([]);
  });

  it("ScheduledAgent extends PortThink (issue #1956, think-fleet)", () => {
    const src = read("src/agents/scheduled-agent.ts");
    // Think behind the actor port (tracker #1951, shape (a)): the
    // class reaches Think only through PortThink, never raw Think
    // and never the Agents SDK base it used before #1956. This
    // class has no turn path, so unlike Research/Trading it
    // exposes no getModel/getSystemPrompt/getTools surface and
    // no portHooks — its cron/goal surface is pinned by
    // tests/think_fleet_scheduled_agent_1956.test.ts.
    expect(src).toMatch(/import\s*\{\s*PortThink\s*\}\s*from\s*"\.\.\/actors\/thinkAdapter"/);
    expect(src).toMatch(/export\s+class\s+ScheduledAgent\s+extends\s+PortThink\b/);
    expect(src).not.toMatch(/from\s*"agents"/);
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

  it("TradingAgent extends PortThink with the framework overrides (issue #291, migrated #1738, PortThink #1954)", () => {
    const src = read("src/agents/trading-agent.ts");
    // Think-fleet shape (a): the agent reaches Think ONLY through
    // PortThink (foundation adapter); a bare @cloudflare/think
    // import here would fail the adjacent bare-Think pin.
    expect(src).toMatch(/import\s*\{\s*PortThink[^}]*\}\s*from\s*"\.\.\/actors\/thinkAdapter"/);
    expect(src).toMatch(/export\s+class\s+TradingAgent\s+extends\s+PortThink/);
    expect(src).not.toMatch(/from\s*"agents"/);
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

  it("the test harness is the in-memory actor adapter plus a test-only Think stub", () => {
    const vite = read("vite.config.ts");
    // Issue #2003 (tracker #1951) restates this pin: the bare
    // @cloudflare/think alias is back, but TEST-ONLY — it points at
    // tests/stubs/cloudflareThink.ts, a stub that imports nothing
    // and whose turn methods throw, so the real Think graph (with
    // its `cloudflare:` imports) never loads under Node vitest. The
    // workflows alias stays (workflow files still import that
    // subpath), and no production file may import the stub.
    expect(vite).toContain('"@cloudflare/think":');
    expect(vite).toContain("tests/stubs/cloudflareThink.ts");
    expect(fs.existsSync(path.join(ROOT, "tests/stubs/cloudflareThink.ts"))).toBe(true);
    expect(vite).toContain('"@cloudflare/think/workflows"');
    const stub = read("tests/stubs/cloudflareThink.ts");
    // The stub must import nothing workerd-only (its header may
    // NAME the schemes it avoids, so check imports, not mentions).
    expect(stub).not.toMatch(/from\s+"cloudflare:/);
    expect(stub).not.toMatch(/from\s+"@cloudflare\/think"/);
    expect(stub).toContain("runTurn() is not implemented under Node tests");
    // The turn harness itself is unchanged: the in-memory actor
    // adapter runs the same turn runner with a stubbed provider
    // boundary (see tests/actor-ports-conformance.test.ts).
    const adapter = read("src/actors/inMemoryActorAdapter.ts");
    expect(adapter).toContain("createInMemoryActorTurn");
    expect(adapter).toContain("Stub assistant reply.");
  });
});
