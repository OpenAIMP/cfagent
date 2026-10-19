/**
 * Issue #319 (amendment 1) — config service tests.
 * The spec defaults table is the fallback; every gate reads thresholds
 * from the loaded config; nothing is hardcoded in the pipeline.
 */
import { describe, it, expect } from "vitest";
import {
  ResearchConfigService,
  RESEARCH_CONFIG_DEFAULTS,
  type ResearchSettingsStore,
} from "../src/services/researchConfig";

function memStore(): ResearchSettingsStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    get: (k: string) => (raw.has(k) ? raw.get(k)! : null),
    set: (k: string, v: string) => void raw.set(k, v),
  };
}

describe("ResearchConfigService", () => {
  it("defaults match the spec table", () => {
    expect(RESEARCH_CONFIG_DEFAULTS.marketCapMin).toBe(5_000_000_000);
    expect(RESEARCH_CONFIG_DEFAULTS.priceCap).toBeNull();
    expect(RESEARCH_CONFIG_DEFAULTS.maxIdeas).toBe(5);
    expect(RESEARCH_CONFIG_DEFAULTS.ownershipStrategiesAllowed).toBe(false);
    expect(RESEARCH_CONFIG_DEFAULTS.etfsIncluded).toBe(true);
    expect(RESEARCH_CONFIG_DEFAULTS.rulesVersion).toBe("1.0.0");
  });

  it("loads defaults from an empty store", () => {
    const svc = new ResearchConfigService(memStore());
    expect(svc.load()).toEqual(RESEARCH_CONFIG_DEFAULTS);
  });

  it("round-trips overrides", () => {
    const store = memStore();
    const svc = new ResearchConfigService(store);
    const { config, errors } = svc.save({ maxSpreadPct: 0.1, ownershipStrategiesAllowed: true });
    expect(errors).toEqual([]);
    expect(config.maxSpreadPct).toBe(0.1);
    expect(config.ownershipStrategiesAllowed).toBe(true);
    // A fresh service over the same store sees the overrides.
    expect(new ResearchConfigService(store).load().maxSpreadPct).toBe(0.1);
  });

  it("rejects invalid patches atomically (nothing written)", () => {
    const store = memStore();
    const svc = new ResearchConfigService(store);
    const { config, errors } = svc.save({ maxSpreadPct: -3 as unknown as number });
    expect(errors.length).toBeGreaterThan(0);
    expect(store.raw.size).toBe(0);
    expect(config.maxSpreadPct).toBe(RESEARCH_CONFIG_DEFAULTS.maxSpreadPct);
  });

  it("rejects a malformed email recipient", () => {
    const svc = new ResearchConfigService(memStore());
    const { errors } = svc.save({ emailTo: "not-an-email" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("fails closed to defaults on corrupt stored values", () => {
    const store = memStore();
    store.set("research.maxSpreadPct", "banana");
    const svc = new ResearchConfigService(store);
    expect(svc.load().maxSpreadPct).toBe(RESEARCH_CONFIG_DEFAULTS.maxSpreadPct);
  });

  it("snapshot() deep-copies (report embedding cannot alias live config)", () => {
    const svc = new ResearchConfigService(memStore());
    const snap = svc.snapshot(svc.load());
    snap.maxIdeas = 99;
    expect(svc.load().maxIdeas).toBe(RESEARCH_CONFIG_DEFAULTS.maxIdeas);
  });
});
