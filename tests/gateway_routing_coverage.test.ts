/**
 * Issue #1741 ([AGENTIC] AI Gateway fallback integration).
 *
 * Code-search pin: every LLM text-inference call site routes
 * through the gateway port. generateText/generateObject may appear
 * only in the gateway module (executors + shared model-call
 * helper) and in the actor turn runner's legacy fallback (kept
 * for when no gateway port exists). createWorkersAI may appear
 * only in the model layer (the factory seam) and the gateway
 * executors. Exemptions are recorded in ADR 0010, not hidden:
 * verifier.ts uses env.AI.run (not generateText) and is #1717 S1
 * territory; embeddings are out of scope.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

const SRC = new URL("../src", import.meta.url).pathname;

describe("gateway routing coverage (#1741)", () => {
  it("generateText/generateObject appear only in the gateway module and the legacy actor-turn fallback", () => {
    const allowed = new Set([
      "gateway/cfGatewayExecutor.ts",
      "gateway/directExecutor.ts",
      "gateway/gatewayModelCall.ts",
      "actors/actorTurnRunner.ts",
    ]);
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, "utf8");
      if ((text.includes("generateText(") || text.includes("generateObject(")) && !allowed.has(rel)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("createWorkersAI appears only in the model layer and the gateway executors", () => {
    const allowed = new Set(["agents/model.ts", "gateway/cfGatewayExecutor.ts", "gateway/directExecutor.ts"]);
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, "utf8");
      if (text.includes("createWorkersAI(") && !allowed.has(rel)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
