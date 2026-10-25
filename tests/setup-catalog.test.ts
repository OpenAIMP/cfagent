import { describe, it, expect } from "vitest";
import { listSetups, getSetup } from "../src/trading/setupCatalog";

/**
 * #435: market setup catalog.
 */

describe("#435 setup catalog", () => {
  it("ships the four initial families", () => {
    const setups = listSetups();
    expect(setups.map((s) => s.id).sort()).toEqual(
      ["defined_risk_spread", "pmcc", "pullback_reversion", "trend_breakout"].sort()
    );
  });

  it("every setup has a signature, paired strategies, and risk notes", () => {
    for (const s of listSetups()) {
      expect(s.signature.description.length).toBeGreaterThan(0);
      expect(s.signature.indicators.length).toBeGreaterThan(0);
      expect(s.pairedStrategies.length).toBeGreaterThan(0);
      expect(s.riskNotes.length).toBeGreaterThan(0);
    }
  });

  it("getSetup returns null for unknown ids", () => {
    expect(getSetup("nope" as any)).toBeNull();
    expect(getSetup("pmcc")?.label).toContain("PMCC");
  });
});
