/** @vitest-environment jsdom */
/**
 * Issue #339: Reports-tab research views — the pure body parser and the
 * run-detail rendering (ranked table, trade cards with the §4
 * falsification answers + §7 pre-mortem, and the effective filter/config
 * snapshot). Read-only: fixtures mirror the stored ResearchReport shape
 * from src/services/researchPipeline.ts.
 */
import { describe, it, expect } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  parseResearchRunDetail,
  ResearchRunDetailView,
} from "../src/client/chat/tabs/ResearchRunDetail";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FALSIFICATION = {
  thesis: "AAPL services growth is underpriced",
  whyMarketWrong: "Consensus models services at last year's growth rate",
  resolutionTrigger: "Q4 earnings services print",
  horizon: "30-45 DTE",
  contradictingEvidence: ["Services growth decelerated last quarter"],
  invalidation: "Services guidance cut below 10%",
  whyThisStructure: "Defined-risk call spread caps the earnings gap risk",
};

const RUN_BODY = {
  runId: "run-339",
  generationId: "gen-1",
  trigger: "manual",
  userLogin: "alice",
  createdAt: "2026-10-19T12:00:00.000Z",
  rulesVersion: "research-rules-v3",
  configSnapshot: {
    marketCapMin: 5000000000,
    priceCap: null,
    universe: "NASDAQ100",
    etfsIncluded: true,
    maxIdeas: 5,
    minDte: 21,
  },
  summary: "2 qualified ideas from 98 names",
  ideas: [
    {
      rank: 2,
      symbol: "MSFT",
      outlook: "bullish",
      thesis: "MSFT cloud re-acceleration",
      supportingEvidence: ["Azure growth ticked up"],
      contradictingEvidence: ["Capex rising"],
      falsification: { ...FALSIFICATION, thesis: "MSFT cloud re-acceleration" },
      falsificationWarnings: [],
      premortem: {
        assumedFailure: "The idea lost money because the cloud print disappointed.",
        causes: [{ category: "thesis", detail: "Growth was one-off" }],
      },
      structure: "bull call spread",
      legs: [
        { optionType: "call", strike: 500, expiry: "2026-11-20", dte: 32, bid: 8.1, ask: 8.4 },
        { optionType: "call", strike: 520, expiry: "2026-11-20", dte: 32, bid: 3.0, ask: 3.2 },
      ],
      economics: { netDebit: 5.2, netCredit: 0, maxLoss: 5.2, maxGain: 14.8, breakevens: [505.2] },
      entryCondition: "Enter on a pullback to the 20-day average",
      invalidation: "Close below the 50-day average",
      contractualMaxLoss: 5.2,
      limitations: [],
      sources: [],
      quoteTimestamp: 1760000000000,
      entrySpot: 495,
      score: 71,
      status: "qualified",
    },
    {
      rank: 1,
      symbol: "AAPL",
      outlook: "bullish",
      thesis: "AAPL services growth is underpriced",
      supportingEvidence: ["Install base at record"],
      contradictingEvidence: ["Services growth decelerated last quarter"],
      falsification: FALSIFICATION,
      falsificationWarnings: ["Single-source evidence"],
      premortem: {
        assumedFailure: "The idea lost money because services missed.",
        causes: [{ category: "catalyst", detail: "Earnings slipped a quarter" }],
      },
      structure: "bull call spread",
      legs: [
        { optionType: "call", strike: 250, expiry: "2026-11-20", dte: 32, bid: 6.0, ask: 6.3 },
      ],
      economics: { netDebit: 6.15, netCredit: 0, maxLoss: 6.15, maxGain: null, breakevens: [256.15] },
      entryCondition: "Enter at market",
      invalidation: "Services guidance cut below 10%",
      contractualMaxLoss: 6.15,
      limitations: [],
      sources: [],
      quoteTimestamp: 1760000000000,
      entrySpot: 247,
      score: 88,
      status: "qualified",
    },
  ],
  watchlist: [
    { symbol: "NVDA", outlook: "bullish", thesis: "Watch", structure: "call", reason: "IV too rich", triggerCondition: "IV rank < 40" },
  ],
  rejected: [
    { symbol: "XYZ", outlook: "bearish", structure: "put spread", gate: "liquidity", reason: "Spread too wide" },
  ],
  stats: { universeSize: 98, qualified: 2, watchlist: 1, rejected: 41 },
};

describe("parseResearchRunDetail", () => {
  it("parses a pipeline run body, ranking ideas by rank", () => {
    const view = parseResearchRunDetail(RUN_BODY);
    expect(view?.kind).toBe("run");
    if (view?.kind !== "run") throw new Error("expected run");
    expect(view.ideas.map((i) => i.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(view.ideas[0].falsification.map((f) => f.label)).toContain("Thesis");
    expect(view.ideas[0].falsification.find((f) => f.label === "Invalidation")?.value).toContain("guidance cut");
    expect(view.ideas[0].premortem?.assumedFailure).toContain("services missed");
    expect(view.configEntries).toContainEqual(["Universe", "NASDAQ100"]);
    expect(view.watchlist[0].symbol).toBe("NVDA");
    expect(view.rejected[0].gate).toBe("liquidity");
  });

  it("parses a webhook sheets body", () => {
    const view = parseResearchRunDetail({
      title: "Sheet report",
      query: "tech",
      sheets: [{ name: "Ideas", rows: [{ symbol: "AAPL", score: 88 }] }],
    });
    expect(view?.kind).toBe("sheets");
    if (view?.kind !== "sheets") throw new Error("expected sheets");
    expect(view.sheets[0].columns).toEqual(["symbol", "score"]);
    expect(view.sheets[0].rows[0]).toEqual(["AAPL", "88"]);
  });

  it("treats an email-attachment body as a delivery artifact", () => {
    const view = parseResearchRunDetail({ title: "Emailed", fileName: "r.pdf", attachmentBase64: "QUJD" });
    expect(view?.kind).toBe("artifact");
  });

  it("returns null for unrecognized bodies", () => {
    expect(parseResearchRunDetail({ hello: "world" })).toBeNull();
    expect(parseResearchRunDetail(null)).toBeNull();
    expect(parseResearchRunDetail("text")).toBeNull();
  });
});

describe("ResearchRunDetailView", () => {
  it("renders ranked table, trade cards, falsification, pre-mortem and config snapshot", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ResearchRunDetailView
          title="Research run"
          createdAt="2026-10-19T12:00:00.000Z"
          body={RUN_BODY}
          onBack={() => undefined}
        />
      );
    });
    const text = container.textContent || "";
    // ranked order: AAPL (rank 1) appears before MSFT in the table region
    expect(text.indexOf("AAPL")).toBeLessThan(text.indexOf("MSFT"));
    expect(text).toContain("Why the market may be wrong");
    expect(text).toContain("Consensus models services");
    expect(text).toContain("Pre-mortem");
    expect(text).toContain("services missed");
    expect(text).toContain("Filter / config snapshot");
    expect(text).toContain("NASDAQ100");
    expect(text).toContain("Single-source evidence");
    expect(text).toContain("NVDA");
    act(() => root.unmount());
    container.remove();
  });

  it("renders a fallback for an unrecognized body", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ResearchRunDetailView title="Odd" body={{ hello: "world" }} onBack={() => undefined} />
      );
    });
    expect(container.textContent).toContain("could not be interpreted");
    act(() => root.unmount());
    container.remove();
  });
});
