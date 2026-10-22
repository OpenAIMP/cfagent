/**
 * Issue #542 — Think conformance regression tests (cloudflare.md §8A, §12).
 *
 * Why source-evidence tests: vitest aliases `@cloudflare/think` to
 * `tests/stubs/cloudflareThink.ts` (see vite.config.ts), so the suite
 * cannot instantiate the real Think runtime under Node. What it *can*
 * pin — and what silently regressed before this file existed — is the
 * adoption evidence itself: the framework is pinned, ResearchAgent is
 * the Think subclass with the three framework overrides, the class is
 * exported as a Durable Object, the RESEARCH_AGENT binding + SQLite
 * migration exist, and the orchestrator actually dispatches to it.
 * Removing any anchor fails this suite. (Repo precedent for this
 * style: tests/research-boundary.test.ts.)
 *
 * Scope note: these tests prove the Think path is wired, not that a
 * live Think turn behaves correctly in the Workers runtime — that
 * remains an explicit UNKNOWN in docs/agents/think-conformance.md.
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

describe("Think conformance (issue #542)", () => {
  it("framework packages are pinned to exact versions", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["@cloudflare/think"]).toMatch(EXACT_VERSION);
    expect(pkg.dependencies["agents"]).toMatch(EXACT_VERSION);
  });

  it("ResearchAgent extends Think with the framework overrides", () => {
    const src = read("src/agents/research-agent.ts");
    expect(src).toMatch(/import\s*\{\s*Think\s*\}\s*from\s*"@cloudflare\/think"/);
    expect(src).toMatch(/export\s+class\s+ResearchAgent\s+extends\s+Think</);
    // The three overrides Think 0.19 calls into (verified against the
    // installed package's type declarations — see think-conformance.md).
    expect(src).toContain("getModel()");
    expect(src).toContain("getSystemPrompt()");
    expect(src).toContain("getTools()");
    // The agent's single tool is the read-only research pipeline.
    expect(src).toContain("run_options_research");
  });

  it("Think adopters in src are exactly the designated roles (new adopters update this pin deliberately)", () => {
    const adopters = listTsFiles(path.join(ROOT, "src"))
      .filter((f) => read(path.relative(ROOT, f)).includes('from "@cloudflare/think"'))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
    // ResearchAgent (the designated Think role) + OrchestratorAgent
    // itself since the step-4 cutover (issue #686 — the step-3 shadow
    // in orchestrator-think.ts was absorbed and deleted). Updated
    // deliberately for #686.
    expect(adopters).toEqual([
      "src/agents/orchestrator.ts",
      "src/agents/research-agent.ts",
    ]);
  });

  it("the Worker exports ResearchAgent as a Durable Object class", () => {
    const server = read("src/server.ts");
    expect(server).toMatch(
      /export\s*\{\s*ResearchAgent\s*\}\s*from\s*"\.\/agents\/research-agent"/
    );
  });

  it("wrangler binds RESEARCH_AGENT to ResearchAgent with a SQLite migration", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toMatch(
      /"name":\s*"RESEARCH_AGENT",\s*"class_name":\s*"ResearchAgent"/
    );
    expect(wrangler).toMatch(/"new_sqlite_classes":\s*\[[^\]]*"ResearchAgent"/);
  });

  it("the orchestrator dispatches research through the Think agent", () => {
    const orchestrator = read("src/agents/orchestrator.ts");
    // Per-tenant instance resolution off the DO binding…
    expect(orchestrator).toContain("this.env.RESEARCH_AGENT");
    expect(orchestrator).toContain("research:${login}");
    // …and the agent-tool dispatch that runs the Think turn.
    expect(orchestrator).toContain("runAgentTool(ResearchAgent");
  });

  it("the test stub is acknowledged: vite aliases @cloudflare/think only for tests", () => {
    const vite = read("vite.config.ts");
    expect(vite).toContain('"@cloudflare/think"');
    expect(vite).toContain("./tests/stubs/cloudflareThink.ts");
    // The stub exists and stays minimal — it must never grow fake
    // behavior that these conformance claims could be mistaken for.
    const stub = read("tests/stubs/cloudflareThink.ts");
    expect(stub).toContain("export class Think");
  });
});
