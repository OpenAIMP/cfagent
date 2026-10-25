import { describe, it, expect, vi } from "vitest";

/**
 * #680: ReportAssetAgent helpers.
 * The DO class itself needs the Cloudflare runtime; these tests cover the
 * pure helpers. The DO is exercised in integration.
 */

vi.mock("agents", () => ({
  Agent: class {},
}));

describe("#680 report asset agent", () => {
  it("namespaces agent names per user", async () => {
    const { reportAssetAgentName } = await import("../src/agents/report-asset-agent");
    // Issue #1185: the bare "default" name belongs to the configured
    // service identity only — never to a literal login.
    expect(reportAssetAgentName("svc-reports", "svc-reports")).toBe("default");
    expect(reportAssetAgentName("alice", "svc-reports")).toBe("assets:alice");
    expect(reportAssetAgentName("alice")).toBe("assets:alice");
    expect(reportAssetAgentName("default_trader")).toBe("assets:default_trader");
  });

  it("generatePdfAsset returns null without the binding (no throw)", async () => {
    const { generatePdfAsset } = await import("../src/agents/report-asset-agent");
    const result = await generatePdfAsset({}, "alice", "research", {});
    expect(result).toBeNull();
  });

  it("generatePdfAssetWithBytes returns null without the binding", async () => {
    const { generatePdfAssetWithBytes } = await import("../src/agents/report-asset-agent");
    const result = await generatePdfAssetWithBytes({}, "alice", "options", {});
    expect(result).toBeNull();
  });

  it("getPdfAsset returns null without the binding", async () => {
    const { getPdfAsset } = await import("../src/agents/report-asset-agent");
    const result = await getPdfAsset({}, "alice", "some-key");
    expect(result).toBeNull();
  });
});
