/**
 * Workflows tab migration pin (#1804 S2, issue #2027): WorkflowsHub runs
 * its subnav on real Tabs + the shared `useUrlSyncedTabs` hook with
 * `?view=` as the canonical param and "faq" as the default — no
 * PillGroup subnav, no bespoke tab state. (The hub is content-heavy, so
 * this pins the wiring; the hook's own behavior is covered by
 * tests/use_url_synced_tabs.test.tsx.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("WorkflowsHub tab wiring (S2 phase 3)", () => {
  const hubSrc = readFileSync("src/client/WorkflowsHub.tsx", "utf8");

  it("uses Tabs + the shared hook with ?view= and the faq default", () => {
    expect(hubSrc).toContain("useUrlSyncedTabs<WorkflowsSubTab>");
    expect(hubSrc).toContain('param: "view"');
    expect(hubSrc).toContain('defaultTab: "faq"');
    expect(hubSrc).toContain("<Tabs");
    expect(hubSrc).toContain('idBase="workflows"');
  });

  it("has no bespoke tab state left", () => {
    expect(hubSrc).not.toContain("setActiveTab");
  });

  it("wires every panel to its tab for ARIA", () => {
    for (const tab of ["faq", "workflows", "decisioning", "matrix", "improvements"]) {
      expect(hubSrc).toContain(`id="workflows-panel-${tab}"`);
      expect(hubSrc).toContain(`aria-labelledby="workflows-tab-${tab}"`);
    }
  });
});
