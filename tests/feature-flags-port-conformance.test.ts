// @vitest-environment node
/**
 * Issue #1815: FeatureFlagPort Conformance Suite (ADR 0006).
 *
 * Verifies that all adapters (InMemoryFeatureFlagAdapter, EnvFeatureFlagAdapter,
 * and CfFlagshipAdapter) strictly satisfy the FeatureFlagPort contract:
 *  - Unknown flags fail closed (return false)
 *  - Boolean resolution behaves deterministically across all adapters
 *  - getAllFlags returns the complete dictionary of all registered features
 *  - Composition root createFeatureFlagPort wires the appropriate adapter
 *  - Port definition module (src/features/featureFlagPorts.ts) contains zero cloud-specific types.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ALL_FEATURE_FLAGS,
  type FeatureFlag,
  type FeatureFlagPort,
  isKnownFeatureFlag,
} from "../src/features/featureFlagPorts";
import { InMemoryFeatureFlagAdapter } from "../src/features/inMemoryFeatureFlagAdapter";
import { EnvFeatureFlagAdapter } from "../src/features/envFeatureFlagAdapter";
import { CfFlagshipAdapter, type FlagshipBindingLike } from "../src/features/cfFlagshipAdapter";
import { createFeatureFlagPort } from "../src/features/createFeatureFlagPort";

describe("FeatureFlagPort Conformance Suite (Issue #1815)", () => {
  describe("Port Contract Purity", () => {
    it("src/features/featureFlagPorts.ts does not leak any cloud or provider types", () => {
      const src = readFileSync(
        resolve(__dirname, "../src/features/featureFlagPorts.ts"),
        "utf8"
      );
      expect(src).not.toContain("cloudflare");
      expect(src).not.toContain("Flagship");
      expect(src).not.toContain("process.env");
      expect(src).not.toContain("D1Database");
      expect(src).not.toContain("Env");
    });
  });

  describe("InMemoryFeatureFlagAdapter", () => {
    it("defaults to closed (false) for all registered flags", async () => {
      const port: FeatureFlagPort = new InMemoryFeatureFlagAdapter();
      for (const flag of ALL_FEATURE_FLAGS) {
        expect(await port.isEnabled(flag)).toBe(false);
      }
      expect(await port.isEnabled("unknown_feature")).toBe(false);
    });

    it("respects initial configuration and dynamic setFlag updates", async () => {
      const port = new InMemoryFeatureFlagAdapter({ screener: true, autopilot: false });
      expect(await port.isEnabled("screener")).toBe(true);
      expect(await port.isEnabled("autopilot")).toBe(false);

      port.setFlag("autopilot", true);
      expect(await port.isEnabled("autopilot")).toBe(true);

      const all = await port.getAllFlags();
      expect(all.screener).toBe(true);
      expect(all.autopilot).toBe(true);
      expect(all.trading_orders).toBe(false);
    });

    it("fails closed on unknown flags", async () => {
      const port = new InMemoryFeatureFlagAdapter();
      expect(await port.isEnabled("non_existent_flag")).toBe(false);
      expect(await port.isEnabled("")).toBe(false);
    });
  });

  describe("EnvFeatureFlagAdapter", () => {
    it("evaluates direct FEATURE_<FLAG> environment variables", async () => {
      const port: FeatureFlagPort = new EnvFeatureFlagAdapter({
        FEATURE_SCREENER: "1",
        FEATURE_OPTIONS_RESEARCH: "true",
        FEATURE_AUTOPILOT: "0",
      });

      expect(await port.isEnabled("screener")).toBe(true);
      expect(await port.isEnabled("options_research")).toBe(true);
      expect(await port.isEnabled("autopilot")).toBe(false);
      expect(await port.isEnabled("trading_orders")).toBe(false);
    });

    it("evaluates FEATURE_FLAGS bulk JSON configuration", async () => {
      const port: FeatureFlagPort = new EnvFeatureFlagAdapter({
        FEATURE_FLAGS: JSON.stringify({
          screener: true,
          voice_trading: true,
          payments: false,
        }),
      });

      expect(await port.isEnabled("screener")).toBe(true);
      expect(await port.isEnabled("voice_trading")).toBe(true);
      expect(await port.isEnabled("payments")).toBe(false);
      expect(await port.isEnabled("autopilot")).toBe(false);
    });

    it("preserves documented legacy SOCIAL_POSTING_ENABLED fallback", async () => {
      const port: FeatureFlagPort = new EnvFeatureFlagAdapter({
        SOCIAL_POSTING_ENABLED: "1",
      });
      expect(await port.isEnabled("social_publishing")).toBe(true);
    });

    it("fails closed on unknown flags or null env", async () => {
      const port = new EnvFeatureFlagAdapter(null);
      expect(await port.isEnabled("screener")).toBe(false);
      expect(await port.isEnabled("random_flag")).toBe(false);
    });

    it("keeps goal_workflow strictly closed in a bare env (issue #1997)", async () => {
      // The bare-env default-TRUE rule ("baseline routes do not
      // fail closed prematurely") must never silently enable a
      // new execution path: goal_workflow is default-OFF and
      // needs explicit enablement (bulk JSON or direct var).
      const bare = new EnvFeatureFlagAdapter({});
      expect(await bare.isEnabled("goal_workflow")).toBe(false);
      const enabled = new EnvFeatureFlagAdapter({
        FEATURE_FLAGS: JSON.stringify({ goal_workflow: true }),
      });
      expect(await enabled.isEnabled("goal_workflow")).toBe(true);
    });
  });

  describe("CfFlagshipAdapter", () => {
    it("evaluates through Flagship binding getBooleanValue with context", async () => {
      const getBooleanValue = vi.fn().mockImplementation((flag: string) => {
        if (flag === "screener") return Promise.resolve(true);
        if (flag === "autopilot") return Promise.resolve(false);
        return Promise.resolve(false);
      });

      const binding: FlagshipBindingLike = { getBooleanValue };
      const port: FeatureFlagPort = new CfFlagshipAdapter(binding);

      const ctx = { userLogin: "test-user-1815" };
      expect(await port.isEnabled("screener", ctx)).toBe(true);
      expect(await port.isEnabled("autopilot", ctx)).toBe(false);
      expect(getBooleanValue).toHaveBeenCalledWith("screener", false, ctx);
    });

    it("fails closed when Flagship throws an error", async () => {
      const binding: FlagshipBindingLike = {
        getBooleanValue: vi.fn().mockRejectedValue(new Error("Flagship service unavailable")),
      };
      const port: FeatureFlagPort = new CfFlagshipAdapter(binding);

      expect(await port.isEnabled("screener")).toBe(false);
      expect(await port.isEnabled("autopilot")).toBe(false);
    });

    it("fails closed on unknown flags without invoking Flagship binding", async () => {
      const getBooleanValue = vi.fn();
      const binding: FlagshipBindingLike = { getBooleanValue };
      const port: FeatureFlagPort = new CfFlagshipAdapter(binding);

      expect(await port.isEnabled("completely_unknown_flag")).toBe(false);
      expect(getBooleanValue).not.toHaveBeenCalled();
    });
  });

  describe("createFeatureFlagPort composition root", () => {
    it("returns InMemoryFeatureFlagAdapter when runtime is in-memory", () => {
      const port = createFeatureFlagPort("in-memory", {
        initialFlags: { screener: true },
      });
      expect(port).toBeInstanceOf(InMemoryFeatureFlagAdapter);
    });

    it("returns CfFlagshipAdapter when FLAGS binding is provided in env", () => {
      const fakeBinding: FlagshipBindingLike = {
        getBooleanValue: vi.fn().mockResolvedValue(true),
      };
      const port = createFeatureFlagPort({ FLAGS: fakeBinding });
      expect(port).toBeInstanceOf(CfFlagshipAdapter);
    });

    it("returns EnvFeatureFlagAdapter when FLAGS binding is absent in env", () => {
      const port = createFeatureFlagPort({ FEATURE_SCREENER: "1" });
      expect(port).toBeInstanceOf(EnvFeatureFlagAdapter);
    });

    it("returns an EnvFeatureFlagAdapter with empty config when env is undefined", () => {
      const port = createFeatureFlagPort();
      expect(port).toBeInstanceOf(EnvFeatureFlagAdapter);
    });
  });

  describe("Adapter Parity (getAllFlags)", () => {
    it("all adapters return the exact same schema structure for getAllFlags", async () => {
      const inMemoryPort = new InMemoryFeatureFlagAdapter({ screener: true });
      const envPort = new EnvFeatureFlagAdapter({ FEATURE_SCREENER: "1" });
      const cfPort = new CfFlagshipAdapter({
        getBooleanValue: (flag) => Promise.resolve(flag === "screener"),
      });

      const inMemoryFlags = await inMemoryPort.getAllFlags();
      const envFlags = await envPort.getAllFlags();
      const cfFlags = await cfPort.getAllFlags();

      expect(Object.keys(inMemoryFlags).sort()).toEqual([...ALL_FEATURE_FLAGS].sort());
      expect(Object.keys(envFlags).sort()).toEqual([...ALL_FEATURE_FLAGS].sort());
      expect(Object.keys(cfFlags).sort()).toEqual([...ALL_FEATURE_FLAGS].sort());

      expect(inMemoryFlags.screener).toBe(true);
      expect(envFlags.screener).toBe(true);
      expect(cfFlags.screener).toBe(true);

      expect(inMemoryFlags.autopilot).toBe(false);
      expect(envFlags.autopilot).toBe(false);
      expect(cfFlags.autopilot).toBe(false);
    });
  });
});
