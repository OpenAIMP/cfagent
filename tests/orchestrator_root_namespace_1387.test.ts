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
 *
 * Transitional state (#2330, Agent Mesh S2-A; gate record #2326): the
 * two-deploy G0 rename tombstones the v9 namespace first (migration
 * v14, deleted_classes). Following the legacy Delete-migration
 * procedure, Deploy A removes the ORCHESTRATOR_AGENT binding and the
 * own-name export, so those two pins below assert the TRANSITIONAL
 * shape (binding absent + v14 tombstone present; own-name export
 * absent) until Deploy B renames SearchAgent → OrchestratorAgent and
 * restores both. The alias-preservation pin and the v9 migration
 * history pin are unchanged — v9 stays in the append-only migrations
 * array as the record of how the namespace was created.
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
  migrations: Array<{
    tag: string;
    new_sqlite_classes?: string[];
    deleted_classes?: string[];
  }>;
};

describe("OrchestratorAgent root namespace (issue #1387)", () => {
  it("server.ts does NOT export OrchestratorAgent under its own name during the A→B window (#2330 transitional)", () => {
    // Pre-#2330 this pin asserted the opposite: the own-name export
    // existed so the SDK could look up ctx.exports by constructor
    // name. Deploy A removed it — legacy Delete-migration procedure
    // step 2 (remove references to the deleted class name from the
    // Worker code) — together with the v14 tombstone of its
    // namespace. Deploy B restores the export with the rename, and
    // this pin flips back. The alias line
    // `export { OrchestratorAgent as SearchAgent }` must NOT satisfy
    // the pattern either way (it names a different export).
    expect(serverTs).not.toMatch(
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

  it("wrangler.jsonc no longer binds ORCHESTRATOR_AGENT, and migration v14 tombstones the class (#2330 transitional)", () => {
    // Legacy Delete-migration procedure step 1: remove the binding in
    // the same change as the deleted_classes entry. Deploy B does not
    // re-add this binding — the rename gives the class its namespace
    // back under the SEARCH_AGENT binding instead.
    expect(
      wrangler.durable_objects.bindings.some(
        (b) => b.name === "ORCHESTRATOR_AGENT"
      )
    ).toBe(false);
    expect(
      wrangler.migrations.some(
        (m) =>
          m.tag === "v14" &&
          (m.deleted_classes ?? []).includes("OrchestratorAgent")
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
