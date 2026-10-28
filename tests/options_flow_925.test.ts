import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// src/server.ts re-exports the agent classes, whose real module graph pulls
// in `cloudflare:` protocol imports the node test loader cannot resolve.
// Mock the agent SDK entry points with plain stand-ins (same pattern as
// tests/options_flow_provenance.test.ts); the /api/options/flows routes
// under test never touch them.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { makeFakeSessionStore } from "./fake-session-store";
import {
  FLOW_PROVENANCE_LABELS,
  getDynamicLiveFlowItems,
  getDynamicFlowSummary,
} from "../src/trading/options/flows/flowService";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain } from "../src/types";
import worker from "../src/server";

/**
 * Issue #925 ([#913 S7]) — options flow: no generated universe in PROD.
 *
 * PROD (demo gate off, or no explicit demo request): when every chain
 * source fails, getDynamicLiveFlowItems must return an empty result and
 * the API envelope must carry an explicit unavailable state — never the
 * template-generated sample universe, and never any substitute numbers.
 * The generated universe is reachable only under the #65 demo regime:
 * demo gate enabled AND an explicit dataMode "demo" request, the same
 * two-condition regime as calibrated chains. Chain-derived items keep
 * flowing (control), and carry an explicit "modelled" label.
 */

const ENV_KEY = "CFAGENT_DEMO_CALIBRATED_CHAINS";

// #1754: /api/options/flows/* is session-gated. These envelope pins
// keep every assertion and only gain a session: the envelope behavior
// under test is unchanged, the caller is now authenticated.
const FLOWS_SESSION_ID = "0d9a1754-1c2b-4e3f-8a5b-925000000001";
function authedFlowsRequest(path: string) {
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", FLOWS_SESSION_ID, { githubLogin: "octocat-925", userLogin: "octocat-925" });
  return {
    request: new Request(`https://agent.test${path}`, {
      headers: { Cookie: `session_id=${FLOWS_SESSION_ID}` },
    }),
    env: { SESSION_STORE: sessionStoreNs } as any,
  };
}

describe("Issue #925 — no generated universe in PROD", () => {
  // Issue #404: this suite must never make live network calls. Stub global
  // fetch so Yahoo Finance hosts fail fast (ok: false — the crumb session
  // never establishes and the live-flow path yields nothing) while any
  // other URL throws, so a new network dependency fails loudly.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        const host = new URL(rawUrl).hostname.toLowerCase();
        const isYahoo =
          host === "fc.yahoo.com" ||
          host === "finance.yahoo.com" ||
          host.endsWith(".finance.yahoo.com");
        if (isYahoo) {
          return {
            ok: false,
            status: 503,
            headers: { get: () => null },
            text: async () => "",
            json: async () => ({}),
          } as unknown as Response;
        }
        throw new Error(
          `network disabled in tests/options_flow_925.test.ts — unexpected fetch to ${rawUrl}`
        );
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env[ENV_KEY];
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  it("PROD failure path: all chain sources failing returns empty, never generated samples", async () => {
    delete process.env[ENV_KEY];
    const flows = await getDynamicLiveFlowItems(undefined, { tickers: ["ZZZUNKNOWN"] });
    expect(flows).toEqual([]);
    expect(flows.some((f) => f.provenance === "generated")).toBe(false);
    expect(flows.some((f) => f.provenance === "static")).toBe(false);
  });

  it("demo gate ON but no explicit demo request still returns empty (no silent fallback)", async () => {
    process.env[ENV_KEY] = "1";
    const flows = await getDynamicLiveFlowItems(undefined, { tickers: ["ZZZUNKNOWN"] });
    expect(flows).toEqual([]);
  });

  it("demo gate OFF with an explicit demo request still returns empty", async () => {
    delete process.env[ENV_KEY];
    const flows = await getDynamicLiveFlowItems(undefined, { tickers: ["ZZZUNKNOWN"] }, { dataMode: "demo" });
    expect(flows).toEqual([]);
  });

  it("demo regime (gate ON + explicit demo request) serves the generated universe, stamped generated", async () => {
    process.env[ENV_KEY] = "1";
    const flows = await getDynamicLiveFlowItems(undefined, { tickers: ["ZZZUNKNOWN"] }, { dataMode: "demo" });
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.every((f) => f.provenance === "generated")).toBe(true);
  });

  it("control: chain-derived items still flow in PROD when a chain source succeeds", async () => {
    delete process.env[ENV_KEY];
    const customChain: ETradeOptionChain = {
      symbol: "CUSTOM",
      underlyingPrice: 75.0,
      selectedExpiry: { year: 2026, month: 12, day: 18 },
      pairs: [
        {
          call: {
            symbol: "CUSTOM",
            optionType: "CALL",
            strikePrice: 80,
            lastPrice: 3.0,
            bid: 2.8,
            ask: 2.9,
            volume: 1200,
            openInterest: 400,
          },
        },
      ],
    };
    DynamicOptionsScreener.setTestChainsFixture({ CUSTOM: customChain });
    const flows = await getDynamicLiveFlowItems(undefined, { tickers: ["CUSTOM"] });
    expect(flows.length).toBeGreaterThan(0);
    expect(flows.some((f) => f.symbol === "CUSTOM" && f.provenance === "chain-derived")).toBe(true);
    expect(flows.some((f) => f.provenance === "generated")).toBe(false);
  });

  it("PROD failure path: flow summary over no chain data is empty, never substitute totals", async () => {
    delete process.env[ENV_KEY];
    const summary = await getDynamicFlowSummary(undefined, { tickers: ["ZZZUNKNOWN"] });
    expect(summary.totalTrades).toBe(0);
    expect(summary.totalPremium).toBe(0);
    expect(summary.largestTrades).toEqual([]);
    expect(summary.provenance.counts.generated).toBe(0);
    expect(summary.provenance.counts.static).toBe(0);
  });

  it("demo regime: flow summary forwards the demo request and totals generated items", async () => {
    process.env[ENV_KEY] = "1";
    const summary = await getDynamicFlowSummary(undefined, { tickers: ["ZZZUNKNOWN"] }, { dataMode: "demo" });
    expect(summary.totalTrades).toBeGreaterThan(0);
    expect(summary.provenance.counts.generated).toBe(summary.totalTrades);
  });

  it("chain-derived items carry an explicit modelled label in the API label map", () => {
    expect(FLOW_PROVENANCE_LABELS["chain-derived"].toLowerCase()).toContain("modelled");
  });

  it("UI badge for chain-derived items labels them modelled (source pin)", () => {
    const hubSrc = readFileSync("src/client/options/flows/OptionsFlowsHub.tsx", "utf8");
    expect(hubSrc).toContain("modelled · chain-derived");
  });
});

describe("Issue #925 — /api/options/flows envelopes carry the explicit unavailable state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        const host = new URL(rawUrl).hostname.toLowerCase();
        const isYahoo =
          host === "fc.yahoo.com" ||
          host === "finance.yahoo.com" ||
          host.endsWith(".finance.yahoo.com");
        if (isYahoo) {
          return {
            ok: false,
            status: 503,
            headers: { get: () => null },
            text: async () => "",
            json: async () => ({}),
          } as unknown as Response;
        }
        throw new Error(
          `network disabled in tests/options_flow_925.test.ts — unexpected fetch to ${rawUrl}`
        );
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env[ENV_KEY];
  });

  it("GET /live with all sources failing returns empty flows + dataUnavailable, no substitute numbers", async () => {
    delete process.env[ENV_KEY];
    const { request, env } = authedFlowsRequest("/api/options/flows/live?tickers=ZZZUNKNOWN");
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.flows).toEqual([]);
    expect(body.dataUnavailable).toBe(true);
    expect(typeof body.unavailableReason).toBe("string");
    expect(body.unavailableReason.length).toBeGreaterThan(0);
    expect(body.provenance).toBeDefined();
    expect(body.provenance.isModelled).toBe(true);
    expect(
      body.provenance.counts["chain-derived"] +
        body.provenance.counts.generated +
        body.provenance.counts.static
    ).toBe(0);
  }, 30000);

  it("GET /summary with all sources failing returns zero totals + dataUnavailable", async () => {
    delete process.env[ENV_KEY];
    const { request, env } = authedFlowsRequest("/api/options/flows/summary?tickers=ZZZUNKNOWN");
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.summary.totalTrades).toBe(0);
    expect(body.summary.totalPremium).toBe(0);
    expect(body.dataUnavailable).toBe(true);
  }, 30000);
});
