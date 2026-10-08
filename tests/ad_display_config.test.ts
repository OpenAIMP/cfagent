import { describe, expect, it } from "vitest";
import adDisplayConfig from "../src/client/ad-display.config.json";

describe("per-tab ad display configuration", () => {
  it("disables ad banners on Trading, Research, API/MCP, Options Flows, and Workflows tabs", () => {
    expect(adDisplayConfig.trading).toBe(false);
    expect(adDisplayConfig.research).toBe(false);
    expect(adDisplayConfig.endpoints).toBe(false);
    expect(adDisplayConfig["options-flows"]).toBe(false);
    expect(adDisplayConfig.workflows).toBe(false);
  });

  it("defines an explicit ad visibility flag for every top-level tab", () => {
    expect(Object.keys(adDisplayConfig).sort()).toEqual([
      "ads",
      "audit",
      "chat",
      "endpoints",
      "nlq",
      "options-flows",
      "payments",
      "referrals",
      "research",
      "revenue",
      "trading",
      "workflows",
    ]);
    expect(Object.values(adDisplayConfig).every((enabled) => typeof enabled === "boolean")).toBe(true);
  });
});
