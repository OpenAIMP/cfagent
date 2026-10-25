/**
 * Issue #1334 (job-truth program #1332): /api/trading/options/catalog
 * had TWO handlers — the first won and returned `name` without `label`,
 * while the Scanner browser list and StrategyLibraryModal render
 * `label`, so every strategy name came out blank. The live handler
 * must emit BOTH fields, the dead handler must go, and the Scanner
 * must enrich by id from the client STRATEGY_LIBRARY as a backstop
 * so a label-less entry can never render blank again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  handleEtradeOptionsRoutes,
  type EtradeOptionsRouteContext,
} from "../src/agents/routes/etradeOptions";
import { defaultRegistry } from "../src/trading";
import { resolveCatalogStrategyLabels } from "../src/client/options/strategyLibrary";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (): EtradeOptionsRouteContext =>
  ({
    env: {},
    getOrm: () => {
      throw new Error("boom");
    },
    agentCtx: {},
    ensureTables: () => ({} as any),
    requestedEnv: undefined,
  }) as EtradeOptionsRouteContext;

const req = (method: string, path: string) => new Request(`https://agent.internal${path}`, { method });
const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

describe("options catalog name/label (#1334)", () => {
  it("every catalog strategy carries both name and label, equal to the registry label", async () => {
    const res = await handleEtradeOptionsRoutes(
      req("GET", "/api/trading/options/catalog"),
      urlOf("/api/trading/options/catalog"),
      "/api/trading/options/catalog",
      "s",
      baseCtx()
    );
    expect(res).not.toBeNull();
    const data = (await res!.json()) as { strategies?: Array<{ id: string; name?: string; label?: string }> };
    expect(Array.isArray(data.strategies)).toBe(true);
    expect(data.strategies!.length).toBeGreaterThan(0);
    const byId = new Map(defaultRegistry.list().map((s) => [s.id, s.label]));
    for (const st of data.strategies!) {
      expect(typeof st.label, `strategy ${st.id} must carry label`).toBe("string");
      expect(st.label!.length).toBeGreaterThan(0);
      expect(st.name).toBe(st.label);
      expect(st.label).toBe(byId.get(st.id));
    }
  });

  it("exactly one catalog condition remains in the route module (dead handler gone)", () => {
    const moduleSrc = src("agents/routes/etradeOptions.ts");
    const occurrences = moduleSrc.split('path.endsWith("/trading/options/catalog")').length - 1;
    expect(occurrences).toBe(1);
  });

  it("the Scanner backstop resolves labels by id from the client library", () => {
    const resolved = resolveCatalogStrategyLabels([
      { id: "long_call", label: "Keep Me" },
      { id: "covered_call" },
      { id: "no_such_strategy", name: "Server Name" },
      { id: "bare_id" },
    ]);
    expect(resolved[0].label).toBe("Keep Me");
    // covered_call exists in the client library: its name fills the label.
    expect(resolved[1].label).toBe("Covered Call");
    expect(resolved[2].label).toBe("Server Name");
    expect(resolved[3].label).toBe("bare_id");
  });
});
