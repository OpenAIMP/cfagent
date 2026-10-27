/**
 * Issue #1763 — tool-attribution audit pin. The audit doc
 * (docs/architecture/security/tool-attribution-audit-1763.md) must
 * name every factory tool (from #1843's MCP_TOOL_SCOPES, pinned
 * against the live registry) and every scanner tool, so a future
 * tool added without an audit row fails loudly instead of silently
 * becoming unattributed. The doc is the record; this test is the
 * drift pin.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_TOOL_SCOPES } from "../src/permissions/mcpPermissionPorts";

describe("Tool-attribution audit coverage (#1763)", () => {
  it("audit doc names all 51 factory tools and the 4 scanner tools", () => {
    const doc = readFileSync(
      join(__dirname, "../docs/architecture/security/tool-attribution-audit-1763.md"),
      "utf8",
    );
    const tools = Object.keys(MCP_TOOL_SCOPES);
    expect(tools).toHaveLength(51);
    for (const tool of tools) {
      expect(doc).toContain(`\`${tool}\``);
    }
    for (const scanner of ["screen_options", "scanner_status", "get_scan_job", "list_scan_jobs"]) {
      expect(doc).toContain(`\`${scanner}\``);
    }
    for (const gap of ["G-AUD-1", "G-AUD-2", "G-AUD-3", "G-AUD-4", "G-AUD-5", "G-AUD-6"]) {
      expect(doc).toContain(gap);
    }
  });
});
