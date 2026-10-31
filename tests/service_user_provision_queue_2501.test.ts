import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Issue #2501 — pins the queue exemption for the provision route.
 * This is a source-shape pin, in the style of the orchestrator
 * inventory gate: it proves the early branch exists ahead of the
 * queue decision, so a later edit cannot silently drop it and
 * return the Provision button to 202-queued behavior. Whether the
 * branch actually executes in production is proven by live proof
 * on #2501, not by this test.
 */
describe("service-user provision queue exemption (#2501)", () => {
  it("routes POST /api/admin/service-user/provision synchronously before the queue decision", () => {
    const text = readFileSync("src/agents/orchestrator.ts", "utf8");
    // The branch is a regex literal, so anchor on its escaped form:
    // the plain path string never occurs in this file.
    const branch = text.indexOf("service-user\\/provision");
    expect(branch).toBeGreaterThan(-1);
    const branchSlice = text.slice(branch, branch + 400);
    expect(branchSlice).toContain('request.method === "POST"');
    expect(branchSlice).toContain("return this.routeRequest(request);");
    const queueDecision = text.indexOf("shouldQueueApiRequest({");
    expect(queueDecision).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(queueDecision);
  });
});
