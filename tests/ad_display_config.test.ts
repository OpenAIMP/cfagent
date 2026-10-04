import { describe, expect, it } from "vitest";
import adDisplayConfig from "../src/client/ad-display.config.json";

describe("per-tab ad display configuration", () => {
  it("disables ad banners on Trading and Research tabs", () => {
    expect(adDisplayConfig.trading).toBe(false);
    expect(adDisplayConfig.research).toBe(false);
  });

  it("defines an explicit ad visibility flag for every top-level tab", () => {
    expect(Object.keys(adDisplayConfig).sort()).toEqual([
      "ads",
      "audit",
      "chat",
      "endpoints",
      "nlq",
      "payments",
      "referrals",
      "research",
      "revenue",
      "trading",
    ]);
    expect(Object.values(adDisplayConfig).every((enabled) => typeof enabled === "boolean")).toBe(true);
  });
});
