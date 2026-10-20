/**
 * #583 — evaluation datasets + scored quality dimensions (docx §9).
 *
 * TDD: these tests define the expected behavior first. They fail until
 * the dataset loader and the direction dimension are implemented.
 */
import { describe, it, expect } from "vitest";
import {
  runResearchEvaluation,
  type StoredIdeaRecord,
  type QuoteSnapshot,
} from "../src/services/researchPipeline";
import {
  loadEvaluationDataset,
  getDatasetCase,
} from "../src/services/researchEvaluationDatasets";
import { selectRunsDueForEvaluation } from "../src/services/researchPipeline";

function mockProvider(prices: Record<string, number | null>) {
  return {
    getQuote: async (symbol: string): Promise<QuoteSnapshot | null> => {
      const price = prices[symbol];
      if (price == null) return null;
      return {
        symbol,
        price,
        timestamp: Date.now(),
        quoteStatus: "live",
        source: "test",
      };
    },
  };
}

const baseIdea = (over: Partial<StoredIdeaRecord>): StoredIdeaRecord => ({
  runId: "test-run",
  symbol: "AAPL",
  structure: "bull put spread",
  legs: [
    {
      optionType: "put",
      strike: 230,
      expiry: "2026-11-14",
      dte: 32,
      bid: 1.9,
      ask: 2.1,
      quantity: -1,
    },
    {
      optionType: "put",
      strike: 225,
      expiry: "2026-11-14",
      dte: 32,
      bid: 0.6,
      ask: 0.8,
      quantity: 1,
    },
  ],
  economics: {
    structure: "bull put spread",
    legs: [],
    netDebit: 0,
    netCredit: 140,
    maxLoss: 360,
    maxGain: 140,
    breakevens: [225, 235],
  } as StoredIdeaRecord["economics"],
  thesis: "Bullish momentum.",
  invalidation: "Closes below 225.",
  entrySpot: 230,
  quoteTimestamp: 1760049600000,
  rulesVersion: "1.0.0",
  createdAt: "2026-10-10T21:00:00.000Z",
  ...over,
});

const config = { universe: ["AAPL"] } as Parameters<
  typeof runResearchEvaluation
>[3];

describe("#583 evaluation datasets", () => {
  it("loads the v1 manifest with version, provenance, and dimensions", () => {
    const ds = loadEvaluationDataset("v1");
    expect(ds.manifest.version).toBe("v1");
    expect(ds.manifest.provenance.length).toBeGreaterThan(0);
    expect(ds.manifest.dimensions).toContain("direction");
    expect(ds.cases.length).toBeGreaterThanOrEqual(4);
    for (const c of ds.cases) {
      expect(c.caseId).toBeTruthy();
      expect(Array.isArray(c.ideas)).toBe(true);
    }
  });

  it("rejects an unknown dataset version", () => {
    expect(() => loadEvaluationDataset("v999")).toThrow();
  });

  it("zero-qualified run evaluates cleanly with no ideas", async () => {
    const c = getDatasetCase(loadEvaluationDataset("v1"), "zero-qualified-run");
    const res = await runResearchEvaluation(
      { provider: mockProvider({}) },
      c.ideas,
      c.runId,
      config
    );
    expect(res.aggregates.evaluated).toBe(0);
    expect(res.ideas).toEqual([]);
  });

  it("unavailable follow-up quote records a data-quality failure", async () => {
    const c = getDatasetCase(loadEvaluationDataset("v1"), "stale-quote");
    const res = await runResearchEvaluation(
      { provider: mockProvider({}) },
      c.ideas,
      c.runId,
      config
    );
    expect(res.aggregates.dataQualityFailures).toBe(1);
    expect(res.ideas[0].notes.join(" ")).toMatch(/data quality/i);
  });

  it("scores direction correct for a bullish thesis with a favorable move", async () => {
    const c = getDatasetCase(loadEvaluationDataset("v1"), "bullish-hit");
    const res = await runResearchEvaluation(
      { provider: mockProvider(c.followUp) },
      c.ideas,
      c.runId,
      config
    );
    expect(res.ideas[0].directionCorrect).toBe(true);
  });

  it("scores direction incorrect for a bearish thesis with an adverse move", async () => {
    const c = getDatasetCase(loadEvaluationDataset("v1"), "bearish-miss");
    const res = await runResearchEvaluation(
      { provider: mockProvider(c.followUp) },
      c.ideas,
      c.runId,
      config
    );
    expect(res.ideas[0].directionCorrect).toBe(false);
  });

  it("handles a malformed idea without throwing; P&L stays null", async () => {
    const c = getDatasetCase(
      loadEvaluationDataset("v1"),
      "adversarial-empty-legs"
    );
    const res = await runResearchEvaluation(
      { provider: mockProvider(c.followUp) },
      c.ideas,
      c.runId,
      config
    );
    expect(res.aggregates.evaluated).toBe(1);
    expect(res.ideas[0].pnlEstimatePerUnit).toBeNull();
  });

  it("leaves direction unscored when the outlook is non-directional", async () => {
    const idea = baseIdea({ outlook: "unknown" });
    const res = await runResearchEvaluation(
      { provider: mockProvider({ AAPL: 240 }) },
      [idea],
      "test-run",
      config
    );
    expect(res.ideas[0].directionCorrect).toBeNull();
  });
});

describe("#583 evaluation scheduling", () => {
  const NOW = new Date("2026-10-20T21:00:00.000Z").getTime();
  const DAY = 24 * 3600 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("selects runs older than the horizon with no evaluation row", () => {
    const due = selectRunsDueForEvaluation(
      [
        { runId: "old-no-eval", createdAt: iso(NOW - 2 * DAY) },
        { runId: "fresh-no-eval", createdAt: iso(NOW - 1 * 3600 * 1000) },
        { runId: "old-evaluated", createdAt: iso(NOW - 3 * DAY) },
      ],
      new Set(["old-evaluated"]),
      NOW,
      DAY
    );
    expect(due).toEqual(["old-no-eval"]);
  });

  it("returns nothing when every old run is evaluated", () => {
    const due = selectRunsDueForEvaluation(
      [{ runId: "old-evaluated", createdAt: iso(NOW - 3 * DAY) }],
      new Set(["old-evaluated"]),
      NOW,
      DAY
    );
    expect(due).toEqual([]);
  });

  it("caps the selection at the limit, oldest first", () => {
    const runs = [5, 4, 3, 2, 1].map((d) => ({
      runId: `run-${d}`,
      createdAt: iso(NOW - d * DAY),
    }));
    const due = selectRunsDueForEvaluation(runs, new Set(), NOW, DAY, 2);
    expect(due).toEqual(["run-5", "run-4"]);
  });
});
