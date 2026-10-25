/**
 * Issue #1387 — Research Think turn can never bootstrap.
 *
 * The agents SDK resolves sub-agents through `ctx.exports`, keyed by the
 * parent's `constructor.name`: OrchestratorAgent's `runAgentTool` requires
 * `ctx.exports["OrchestratorAgent"]` to expose `idFromName`. This repo
 * exported the class ONLY as `SearchAgent` and bound ONLY SEARCH_AGENT,
 * so every Think dispatch from OrchestratorAgent threw the SDK's
 * "Sub-agent bootstrap requires the root agent class" error.
 *
 * The fix keeps the SearchAgent alias (the live orchestrator address;
 * its stored state must not move) and ADDS the own-name export, the
 * ORCHESTRATOR_AGENT binding, and a migration covering the new class.
 * This suite pins all three plus the alias preservation, reading the
 * entrypoint and wrangler.jsonc as text (same idiom as
 * tests/kv_bindings_removed.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

const serverTs = readFileSync(resolve(root, "src/server.ts"), "utf8");
const wrangler = JSON.parse(
  stripJsonc(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"))
) as {
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{ tag: string; new_sqlite_classes?: string[] }>;
};

describe("OrchestratorAgent root namespace (issue #1387)", () => {
  it("server.ts exports OrchestratorAgent under its own class name", () => {
    // Bare `export { OrchestratorAgent }` (or `as OrchestratorAgent`).
    // The pre-fix line `export { OrchestratorAgent as SearchAgent }`
    // must NOT satisfy this — the SDK looks up ctx.exports by the
    // constructor name, not by the alias.
    expect(serverTs).toMatch(
      /export\s*\{\s*OrchestratorAgent\s*(as\s+OrchestratorAgent\s*)?\}/
    );
  });

  it("the SearchAgent alias is preserved (live orchestrator address + state)", () => {
    expect(serverTs).toContain(
      "export { OrchestratorAgent as SearchAgent }"
    );
    expect(
      wrangler.durable_objects.bindings.some(
        (b) => b.name === "SEARCH_AGENT" && b.class_name === "SearchAgent"
      )
    ).toBe(true);
  });

  it("wrangler.jsonc binds ORCHESTRATOR_AGENT to the OrchestratorAgent class", () => {
    expect(
      wrangler.durable_objects.bindings.some(
        (b) =>
          b.name === "ORCHESTRATOR_AGENT" &&
          b.class_name === "OrchestratorAgent"
      )
    ).toBe(true);
  });

  it("a migration covers the new OrchestratorAgent sqlite class", () => {
    expect(
      wrangler.migrations.some((m) =>
        (m.new_sqlite_classes ?? []).includes("OrchestratorAgent")
      )
    ).toBe(true);
  });
});
