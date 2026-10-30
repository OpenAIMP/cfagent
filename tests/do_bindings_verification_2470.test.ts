/**
 * Issue #2470 S3 — verify the supposedly unused DO bindings.
 *
 * The doc claimed ORCHESTRATOR_AGENT and SANDBOX_AGENT have no `env.`
 * call sites and consume nothing. Both claims are REFUTED against
 * current main, so neither binding is removed:
 *
 * - ORCHESTRATOR_AGENT: the merged #2465 cross-tenant slice fans out
 *   through it (adminTenantQueues instanceStub: idFromName + get on
 *   env.ORCHESTRATOR_AGENT) — a live production path, not a
 *   declaration.
 * - SANDBOX_AGENT: the A2A edge resolves it DYNAMICALLY
 *   (a2a/index.ts reads env[resolution.binding], and resolution.ts
 *   maps the sandbox surface to SANDBOX_AGENT) — a grep for a
 *   literal `env.SANDBOX_AGENT` misses it, which is exactly how the
 *   doc's claim went wrong. The class export from the entrypoint
 *   and the conformance pins are secondary evidence.
 *
 * These tests pin the access paths so a future removal attempt fails
 * loudly instead of silently dropping a live binding.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const wrangler = readFileSync("wrangler.jsonc", "utf8");

describe("DO bindings verification (#2470 S3)", () => {
  it("ORCHESTRATOR_AGENT is bound and used by the merged cross-tenant fan-out (#2465)", () => {
    expect(wrangler).toMatch(/"name":\s*"ORCHESTRATOR_AGENT",\s*"class_name":\s*"OrchestratorAgent"/);
    const queues = readFileSync("src/agents/routes/adminTenantQueues.ts", "utf8");
    expect(queues).toContain("ORCHESTRATOR_AGENT");
    expect(queues).toContain("idFromName");
    // instanceStub resolves the target instance through the binding.
    expect(queues).toMatch(/ORCHESTRATOR_AGENT[\s\S]*?idFromName[\s\S]*?\.get\(/);
  });

  it("SANDBOX_AGENT is bound and reached through the A2A dynamic binding lookup", () => {
    expect(wrangler).toMatch(/"name":\s*"SANDBOX_AGENT",\s*"class_name":\s*"SandboxAgent"/);
    const resolution = readFileSync("src/a2a/resolution.ts", "utf8");
    expect(resolution).toContain('sandbox: { binding: "SANDBOX_AGENT" }');
    const edge = readFileSync("src/a2a/index.ts", "utf8");
    // Dynamic access: no literal env.SANDBOX_AGENT exists, which is
    // why the doc's static call-site search missed this path.
    expect(edge).toMatch(/\(env as any\)\[resolution\.binding\]/);
    const server = readFileSync("src/server.ts", "utf8");
    expect(server).toContain('export { SandboxAgent } from "./agents/sandbox-agent"');
  });
});
