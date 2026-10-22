/**
 * Issue #291 T1 — TradingAgent shell: config, service registry, and the
 * three doors (tools / A2A / RPC) over one execution path.
 *
 * The pluggability proof lives here: a FAKE provider platform is
 * registered at runtime and the stock-screening service executes against
 * it without the agent or service naming any broker — the same path a
 * future real provider (e.g. Public.com) onboards through.
 */
import { describe, it, expect } from "vitest";
import {
  getTradingAgentConfig,
  TRADING_AGENT_CONFIG_BASELINE,
} from "../src/config/tradingAgentConfig";
import {
  TRADING_SERVICE_REGISTRY,
  buildTradingTools,
  dispatchTradingA2A,
  executeTradingService,
  extractA2AOperation,
  liveTradingServices,
  resolveTradingPlatform,
} from "../src/agents/trading-agent";
import {
  TradingPlatformRegistry,
  type ITradingPlatform,
} from "../src/trading";
import { AGENT_CARDS } from "../src/a2a/agent-cards";
import { OPERATION_CATALOG } from "../src/orchestrate";
import type { Env } from "../src/types";

const env = {} as Env;

const CANNED_SCREEN = {
  totalScanned: 3,
  totalScreened: 1,
  matchedCount: 1,
  filterApplied: {},
  filterSummary: "fake screen",
  stocks: [{ symbol: "FAKE" }],
  scannedAt: "2026-10-22T00:00:00.000Z",
};

function fakePlatform(withScreening: boolean): ITradingPlatform {
  const platform: any = {
    platformId: "fake291",
    name: "Fake Provider (test)",
    getStatus: async () => ({}),
    getQuote: async () => ({}),
    getAccounts: async () => [],
    getPositions: async () => ({ account: {}, positions: [] }),
    previewOrder: async () => ({}),
    executeOrder: () => ({}),
  };
  if (withScreening) {
    platform.screenMarkets = async (filter: unknown) => ({
      ...CANNED_SCREEN,
      filterApplied: filter ?? {},
    });
  }
  return platform as ITradingPlatform;
}

TradingPlatformRegistry.register("fake291" as any, () => fakePlatform(true));
TradingPlatformRegistry.register("noscreen291" as any, () => fakePlatform(false));

const fakeConfig = {
  enabledProviders: ["fake291", "noscreen291", "ghost291"],
  defaultProvider: "fake291",
  enabledServices: [...TRADING_AGENT_CONFIG_BASELINE.enabledServices],
};

describe("TradingAgent config (#291)", () => {
  it("baseline: etrade enabled and default, all services on", () => {
    const config = getTradingAgentConfig({});
    expect(config.enabledProviders).toEqual(["etrade"]);
    expect(config.defaultProvider).toBe("etrade");
    expect(config.enabledServices).toContain("stock_screening");
    expect(config.enabledServices).toContain("options_trading");
  });

  it("env overrides parse lists and drop unknown service ids", () => {
    const config = getTradingAgentConfig({
      TRADING_AGENT_PROVIDERS: "etrade, Public ",
      TRADING_AGENT_DEFAULT_PROVIDER: "public",
      TRADING_AGENT_SERVICES: "stock_screening,bogus_service",
    });
    expect(config.enabledProviders).toEqual(["etrade", "public"]);
    expect(config.defaultProvider).toBe("public");
    expect(config.enabledServices).toEqual(["stock_screening"]);
  });

  it("empty overrides fall back to baseline rather than disabling everything", () => {
    const config = getTradingAgentConfig({
      TRADING_AGENT_PROVIDERS: " , ",
      TRADING_AGENT_SERVICES: "",
    });
    expect(config.enabledProviders).toEqual(["etrade"]);
    expect(config.enabledServices.length).toBeGreaterThan(0);
  });
});

describe("TradingAgent surfaces stay in sync (#291 anti-drift)", () => {
  it("A2A card, operation catalog, and live registry agree on operations", () => {
    const card = AGENT_CARDS.find((c) => c.name === "trading");
    expect(card).toBeDefined();
    const catalog = OPERATION_CATALOG.find((e) => e.agent === "trading");
    expect(catalog).toBeDefined();
    expect(catalog!.binding).toBe("TRADING_AGENT");
    const liveOps = liveTradingServices(TRADING_AGENT_CONFIG_BASELINE).map(
      (s) => s.a2aOperation,
    );
    expect(card!.operations).toEqual(liveOps);
    expect(catalog!.operations).toEqual(liveOps);
  });

  it("tools are generated from the registry and honor the service toggles", () => {
    const tools = buildTradingTools(env, TRADING_AGENT_CONFIG_BASELINE);
    expect(Object.keys(tools)).toEqual(
      liveTradingServices(TRADING_AGENT_CONFIG_BASELINE).map((s) => s.toolName),
    );
    const narrowed = buildTradingTools(env, {
      ...TRADING_AGENT_CONFIG_BASELINE,
      enabledServices: ["options_screening"],
    });
    expect(Object.keys(narrowed)).toEqual([]);
  });
});

describe("TradingAgent execution path (#291)", () => {
  it("stock screening executes against a fake provider — no broker named", async () => {
    const result: any = await executeTradingService(env, fakeConfig as any, {
      serviceId: "stock_screening",
      input: { provider: "fake291", filter: { minPrice: 10 } },
    });
    expect(result.matchedCount).toBe(1);
    expect(result.filterApplied).toEqual({ minPrice: 10 });
  });

  it("the default provider is used when none is named", async () => {
    const result: any = await executeTradingService(env, fakeConfig as any, {
      serviceId: "stock_screening",
      input: {},
    });
    expect(result.filterSummary).toBe("fake screen");
  });

  it("a provider that is not enabled is refused before resolution", async () => {
    await expect(
      executeTradingService(env, TRADING_AGENT_CONFIG_BASELINE, {
        serviceId: "stock_screening",
        input: { provider: "fake291" },
      }),
    ).rejects.toThrow(/not enabled/);
  });

  it("an enabled but unregistered provider fails honestly", () => {
    expect(() => resolveTradingPlatform(env, fakeConfig as any, "ghost291")).toThrow(
      /no platform is registered/,
    );
  });

  it("a provider without screening support fails honestly", async () => {
    await expect(
      executeTradingService(env, fakeConfig as any, {
        serviceId: "stock_screening",
        input: { provider: "noscreen291" },
      }),
    ).rejects.toThrow(/does not support stock screening/);
  });

  it("a disabled service is refused on the execution path", async () => {
    await expect(
      executeTradingService(
        env,
        { ...fakeConfig, enabledServices: ["options_screening"] } as any,
        { serviceId: "stock_screening", input: {} },
      ),
    ).rejects.toThrow(/disabled by configuration/);
  });
});

describe("TradingAgent A2A door (#291)", () => {
  it("extracts the operation from the JSON-RPC data-part envelope", () => {
    const extracted = extractA2AOperation({
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        message: {
          parts: [
            { kind: "data", data: { operation: "trading.screen_stocks", provider: "fake291" } },
          ],
        },
      },
    });
    expect(extracted).toEqual({
      operation: "trading.screen_stocks",
      args: { provider: "fake291" },
    });
  });

  it("dispatches a structured operation to the service", async () => {
    const result = await dispatchTradingA2A(env, fakeConfig as any, {
      operation: "trading.screen_stocks",
      provider: "fake291",
    });
    expect(result.ok).toBe(true);
    expect(result.service).toBe("stock_screening");
    expect((result.result as any).matchedCount).toBe(1);
  });

  it("unknown operations and missing operations return errors, never throw", async () => {
    const unknown = await dispatchTradingA2A(env, fakeConfig as any, {
      operation: "trading.nope",
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Unknown operation/);
    const empty = await dispatchTradingA2A(env, fakeConfig as any, { hello: 1 });
    expect(empty.ok).toBe(false);
  });

  it("the registry's first slice registers exactly the stock screening service", () => {
    expect(TRADING_SERVICE_REGISTRY.map((s) => s.id)).toEqual(["stock_screening"]);
  });
});
