import { describe, expect, it, vi } from "vitest";
import { runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";

const etradeStub = {
  client: {} as never,
  fetchQuoteRemote: async () => ({ lastPrice: 260 }),
  getWatchlists: async () => [],
  screenMarketsAsync: async () => ({ stocks: [] }),
};

function cannedResult() {
  const arm = (ids: string[]) => ({
    attrition: { generated: ids.length + 1, gatePassed: ids.length, priced: ids.length, falsified: ids.length, ranked: ids.length },
    ranked: ids.map((id, i) => ({ id, structure: "iron_condor", label: `Iron condor ${id}`, status: "qualified", score: 10 - i })),
  });
  return {
    artifact: {
      runId: "cmp-test-1",
      arms: { llm: arm(["llm-1", "llm-2"]), quant: arm(["q-1"]), hybrid: arm(["h-1", "h-2", "h-3"]) },
      overlap: { sharedStructures: ["iron_condor"], armUnique: { llm: [], quant: [], hybrid: [] } },
      stats: { armRankedCounts: { llm: 2, quant: 1, hybrid: 3 }, sharedStructureCount: 1 },
    },
    generationNotes: { model: "test-model", citedCount: 4, droppedCount: 1, llmGenerated: 2, llmBuilderLimitations: [], skippedReason: null },
  };
}

const baseFilters = {
  request: {
    symbol: "NVDA", thesis: "bullish", targetPrice: 260, targetDate: "2026-11-20",
    expectedIvDirection: "unchanged", allowedStrategies: ["iron_condor"],
    maxPlannedLoss: 500, minRewardRisk: 1, minDte: 7, maxDte: 90,
  },
  riskProfile: "balanced" as const,
};

describe("options comparison NLQ action", () => {
  it("renders a three-way comparison envelope from the runner result", async () => {
    const run = vi.fn(async () => ({ ok: true as const, result: cannedResult(), ledgerPersisted: true }));
    const out = await runOptionsStrategyAction(etradeStub, "options_comparison", baseFilters as never, { comparisonRunner: { run } as never });
    expect(out.status).toBe("compared");
    expect(out.count).toBe(6);
    expect(out.summary).toContain("cmp-test-1");
    expect(out.summary).toContain("llm ranked 2");
    expect(out.summary).toContain("quant ranked 1");
    expect(out.summary).toContain("hybrid ranked 3");
    expect(out.summary).toContain("No winner");
    expect(out.rows.map((r) => r.arm)).toEqual(expect.arrayContaining(["llm", "quant", "hybrid"]));
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0][0] as { request: { symbol: string } }).request.symbol).toBe("NVDA");
  });

  it("derives an assumed target from the quote when none is stated", async () => {
    const run = vi.fn(async () => ({ ok: true as const, result: cannedResult(), ledgerPersisted: false }));
    const filters = { ...baseFilters, request: { ...baseFilters.request, targetPrice: undefined } };
    const out = await runOptionsStrategyAction(etradeStub, "options_comparison", filters as never, { comparisonRunner: { run } as never });
    expect(out.status).toBe("compared");
    // Bullish factor 1.05 on the 260 quote.
    expect((run.mock.calls[0][0] as { request: { targetPrice: number } }).request.targetPrice).toBe(273);
    expect(out.summary).toContain("not persisted to the ledger");
  });

  it("fails clearly when no comparison runner is configured", async () => {
    const out = await runOptionsStrategyAction(etradeStub, "options_comparison", baseFilters as never, {});
    expect(out.status).toBe("invalid_request");
    expect(out.summary).toMatch(/unavailable/i);
  });

  it("fails clearly when no symbol is given, instead of answering a scan", async () => {
    const run = vi.fn(async () => ({ ok: true as const, result: cannedResult(), ledgerPersisted: true }));
    const out = await runOptionsStrategyAction(etradeStub, "options_comparison", { request: undefined } as never, { comparisonRunner: { run } as never });
    expect(out.status).toBe("invalid_request");
    expect(out.summary).toMatch(/needs a symbol/i);
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates a runner failure as an invalid request, not a partial answer", async () => {
    const run = vi.fn(async () => ({ ok: false as const, error: "snapshot has no screened contracts", ledgerPersisted: false }));
    const out = await runOptionsStrategyAction(etradeStub, "options_comparison", baseFilters as never, { comparisonRunner: { run } as never });
    expect(out.status).toBe("invalid_request");
    expect(out.summary).toContain("snapshot has no screened contracts");
  });
});
