/**
 * Issue #65: calibrated chains are gated behind the dev/demo flag and are
 * never a silent fallback on the live path.
 *
 * Behaviors pinned:
 *  - Live mode with an empty live screen returns an EMPTY snapshot stamped
 *    "live" — no generated chains, whatever the gate says.
 *  - Demo mode with the gate OFF returns zero contracts and an explicit
 *    "not enabled" validation error.
 *  - Demo mode with the gate ON returns stamped "calibrated-demo" contracts
 *    whose warning never calls them live.
 */
import { describe, it, expect, afterEach } from "vitest";
import { OptionsDataAgent } from "../src/trading/options/optionsDataAgent";
import type { OptionScreenResult } from "../src/types";

function emptyScreenResult(): OptionScreenResult {
  return {
    totalUnderlyingsScanned: 1,
    totalContractsEvaluated: 0,
    matchedCount: 0,
    filterApplied: { underlyingSymbols: ["ACME"], contractType: "BOTH" } as OptionScreenResult["filterApplied"],
    filterSummary: "test",
    contracts: [],
    scannedAt: new Date().toISOString(),
    fetchErrors: [{ symbol: "ACME", message: "broker unavailable" }] as unknown as OptionScreenResult["fetchErrors"],
  };
}

function makeAgent() {
  const screener = {
    screenOptions: async () => emptyScreenResult(),
    evaluateChains: (chainItems: Array<{ symbol: string; chain: unknown }>, filter: unknown, count: number, opts?: { warnings?: string[] }) => {
      // Minimal stand-in: every chain becomes one matched contract.
      const contracts = chainItems.map((item) => ({ symbol: item.symbol }));
      return {
        ...emptyScreenResult(),
        contracts,
        matchedCount: contracts.length,
        totalContractsEvaluated: contracts.length,
        warnings: opts?.warnings,
      } as unknown as OptionScreenResult;
    },
  };
  return new OptionsDataAgent(screener as never);
}

const ENV_KEY = "CFAGENT_DEMO_CALIBRATED_CHAINS";
afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("OptionsDataAgent provenance (issue #65)", () => {
  it("live mode never falls back to generated chains, gate on or off", async () => {
    process.env[ENV_KEY] = "1";
    const snapshot = await makeAgent().loadSnapshot({ symbol: "ACME" });
    expect(snapshot.contracts).toHaveLength(0);
    expect(snapshot.dataSource).toBe("live");
    expect(snapshot.screen.fetchErrors?.length).toBeGreaterThan(0);
  });

  it("demo mode with the gate OFF fails explicitly", async () => {
    delete process.env[ENV_KEY];
    const snapshot = await makeAgent().loadSnapshot({ symbol: "ACME", dataMode: "calibrated-demo" });
    expect(snapshot.contracts).toHaveLength(0);
    expect(snapshot.dataSource).toBe("calibrated-demo");
    expect(snapshot.validationError).toContain("not enabled");
  });

  it("demo mode with the gate ON serves stamped generated chains", async () => {
    process.env[ENV_KEY] = "1";
    const snapshot = await makeAgent().loadSnapshot({ symbol: "ACME", dataMode: "calibrated-demo" });
    expect(snapshot.contracts.length).toBeGreaterThan(0);
    expect(snapshot.dataSource).toBe("calibrated-demo");
    const warning = (snapshot.screen.warnings ?? []).join(" ");
    expect(warning).toContain("not live market data");
    expect(warning).not.toMatch(/live market calibrated/i);
  });
});
