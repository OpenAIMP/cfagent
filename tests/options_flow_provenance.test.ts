import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// src/server.ts re-exports the agent classes, whose real module graph pulls
// in `cloudflare:` protocol imports the node test loader cannot resolve.
// Mock the agent SDK entry points with plain stand-ins (same pattern as
// tests/schedules_create_route.test.ts); the /api/options/flows routes under
// test never touch them.
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
  return { routeAgentRequest: async () => null };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import {
  RAW_LIVE_FLOW_ITEMS,
  FLOW_PROVENANCE_NOTICE,
  calculateFlowSummary,
  convertOptionChainToFlowItems,
  describeFlowProvenance,
  generateDynamicFlowUniverse,
  summarizeFlowProvenance,
} from "../src/trading/options/flows/flowService";
import type { LiveFlowItem } from "../src/trading/options/flows/types";
import type { ETradeOptionChain } from "../src/types";
import worker from "../src/server";

/**
 * Issue #119 (audit F17/F18): the options flow service has no trade-tape
 * source. Every item must carry a provenance that cannot be mistaken for a
 * real executed print, every surface must disclose the modelled basis, and
 * the fabricated RAW_NEWS_FLOW_ITEMS wire must stay deleted.
 */

const mockChain: ETradeOptionChain = {
  symbol: "NVDA",
  underlyingPrice: 125.5,
  selectedExpiry: { year: 2026, month: 11, day: 20 },
  pairs: [
    {
      call: {
        symbol: "NVDA",
        optionType: "CALL",
        strikePrice: 130,
        lastPrice: 4.5,
        bid: 4.3,
        ask: 4.4,
        volume: 2500,
        openInterest: 1000,
        delta: 0.45,
      },
      put: {
        symbol: "NVDA",
        optionType: "PUT",
        strikePrice: 120,
        lastPrice: 2.2,
        bid: 2.1,
        ask: 2.15,
        volume: 350,
        openInterest: 500,
        delta: -0.35,
      },
    },
  ],
};

const PROVENANCE_VOCABULARY = ["chain-derived", "static", "generated"];

describe("Issue #119 — flow item provenance", () => {
  it("stamps chain-converted items as chain-derived, never as live prints", () => {
    const items = convertOptionChainToFlowItems(mockChain);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.provenance).toBe("chain-derived");
      expect(PROVENANCE_VOCABULARY).toContain(item.provenance);
    }
  });

  it("stamps the generated fallback universe as generated", () => {
    const items = generateDynamicFlowUniverse({ symbols: ["NVDA", "AAPL"] });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.provenance === "generated")).toBe(true);
  });

  it("stamps the static fixture table as static", () => {
    expect(RAW_LIVE_FLOW_ITEMS.length).toBeGreaterThan(0);
    expect(RAW_LIVE_FLOW_ITEMS.every((i) => i.provenance === "static")).toBe(true);
  });

  it("summarizeFlowProvenance counts a mixed set and always discloses the modelled basis", () => {
    const mixed: LiveFlowItem[] = [
      ...convertOptionChainToFlowItems(mockChain),
      ...generateDynamicFlowUniverse({ symbols: ["NVDA"] }),
      RAW_LIVE_FLOW_ITEMS[0],
    ];
    const summary = summarizeFlowProvenance(mixed);
    expect(summary.isModelled).toBe(true);
    expect(summary.notice).toBe(FLOW_PROVENANCE_NOTICE);
    expect(summary.notice).toContain("not a live exchange trade tape");
    expect(summary.provenances.sort()).toEqual(["chain-derived", "generated", "static"]);
    const total =
      summary.counts["chain-derived"] + summary.counts.generated + summary.counts.static;
    expect(total).toBe(mixed.length);
    expect(summary.counts.generated).toBeGreaterThan(0);
    expect(summary.counts.static).toBe(1);
  });

  it("describeFlowProvenance states the basis in words and never claims executions", () => {
    const chainOnly = describeFlowProvenance(convertOptionChainToFlowItems(mockChain));
    expect(chainOnly).toContain("chain-derived from option-chain snapshots");
    expect(chainOnly).toContain("not executed trade prints");

    const withGenerated = describeFlowProvenance([
      ...convertOptionChainToFlowItems(mockChain),
      ...generateDynamicFlowUniverse({ symbols: ["NVDA"] }),
    ]);
    expect(withGenerated).toContain("generated sample items");

    expect(describeFlowProvenance([])).toContain("no flow items were available");
  });

  it("calculateFlowSummary carries the provenance of its input items", () => {
    const items = generateDynamicFlowUniverse({ symbols: ["NVDA"] });
    const summary = calculateFlowSummary(items);
    expect(summary.provenance.isModelled).toBe(true);
    expect(summary.provenance.provenances).toEqual(["generated"]);
    expect(summary.provenance.counts.generated).toBe(items.length);
  });
});

describe("Issue #119 — /api/options/flows route envelopes disclose provenance", () => {
  it("GET /live returns per-item provenance and an envelope provenance summary", async () => {
    const res = await worker.fetch(
      new Request("https://agent.test/api/options/flows/live?tickers=ZZZUNKNOWN"),
      {} as any
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(Array.isArray(body.flows)).toBe(true);
    expect(body.flows.length).toBeGreaterThan(0);
    for (const item of body.flows) {
      expect(PROVENANCE_VOCABULARY).toContain(item.provenance);
    }
    expect(body.provenance).toBeDefined();
    expect(body.provenance.isModelled).toBe(true);
    expect(body.provenance.notice).toContain("not a live exchange trade tape");
    const counted =
      body.provenance.counts["chain-derived"] +
      body.provenance.counts.generated +
      body.provenance.counts.static;
    expect(counted).toBe(body.flows.length);
  }, 30000);

  it("GET /historical discloses that no historical tape exists", async () => {
    const res = await worker.fetch(
      new Request("https://agent.test/api/options/flows/historical?tickers=ZZZUNKNOWN"),
      {} as any
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.provenance?.isModelled).toBe(true);
    expect(body.note).toContain("No historical options trade tape");
  }, 30000);
});

describe("Issue #119 — fabricated news wire stays deleted (source pins)", () => {
  const flowServiceSrc = readFileSync("src/trading/options/flows/flowService.ts", "utf8");
  const serverSrc = readFileSync("src/server.ts", "utf8");
  const nlqSrc = readFileSync("src/agents/nlq.ts", "utf8");

  it("flowService.ts contains no fake news wire and no fabricated outlet attributions", () => {
    expect(flowServiceSrc).not.toContain("RAW_NEWS_FLOW_ITEMS");
    expect(flowServiceSrc).not.toContain("Bloomberg");
    expect(flowServiceSrc).not.toContain("Reuters");
    expect(flowServiceSrc).not.toContain("Wall Street Journal");
    // The generated-universe doc comment must not promise authenticity again.
    expect(flowServiceSrc).not.toContain("authentic execution points");
  });

  it("server.ts no longer imports the deleted news wire and stamps route provenance", () => {
    expect(serverSrc).not.toContain("RAW_NEWS_FLOW_ITEMS");
    expect(serverSrc).toContain("summarizeFlowProvenance(flows)");
  });

  it("NLQ flow answers state the modelled basis instead of claiming prints", () => {
    expect(nlqSrc).not.toContain("dynamic institutional prints");
    expect(nlqSrc).toContain("describeFlowProvenance(filtered)");
    expect(nlqSrc).toContain("no live options trade tape");
  });
});
