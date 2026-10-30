/**
 * Issue #1278 (#1173 R5): PDF resilience + provenance integrity +
 * regeneration.
 *
 * A. runReportPipeline retries PDF generation under the R1 pipeline
 *    policy (retry.report) — a null asset from generatePdfAsset (its
 *    failure contract: it never throws) counts as a failed attempt —
 *    and the recorded pdfError carries the FAILURE_REPORT_PDF_GENERATION catalog code.
 * B. The stock screener PDF's provenance lines are built from the
 *    run's actual provider (no more hardcoded "E*TRADE live snapshots"
 *    on Yahoo runs), and partial technicals coverage is stated in the
 *    methodology so blank MACD/Gap columns are explained.
 * C. ScreenerAgent.regenerateLatestReport re-runs the pipeline for the
 *    stored latest run and writes the outcome back to LATEST + the
 *    matching HISTORY entry — the #1123-deferred regeneration path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const hoisted = vi.hoisted(() => ({
  assetCalls: 0,
  assetQueue: [] as Array<unknown>,
  pipelineCalls: [] as any[],
  pipelineResult: null as any,
  blobStore: new Map<string, { fileName: string; bytes: Uint8Array }>(),
}));

vi.mock("agents", () => ({
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../src/agents/report-asset-agent", () => ({
  generatePdfAsset: vi.fn(async () => {
    hoisted.assetCalls++;
    return hoisted.assetQueue.length > 0 ? hoisted.assetQueue.shift() : null;
  }),
  getPdfAsset: vi.fn(async (_env: any, _login: string, key: string) => {
    return hoisted.blobStore.get(key) ?? null;
  }),
}));

vi.mock("../src/services/unifiedReportPipeline", () => ({
  runReportPipeline: vi.fn(async (_env: any, _storage: any, input: any) => {
    hoisted.pipelineCalls.push(input);
    return hoisted.pipelineResult;
  }),
}));

vi.mock("../src/services/reportBlobStore", () => ({
  putReportPdf: vi.fn(async (_env: any, _storage: any, key: string, fileName: string, bytes: Uint8Array) => {
    hoisted.blobStore.set(key, { fileName, bytes });
  }),
  getReportPdf: vi.fn(async (_env: any, _storage: any, key: string) => {
    return hoisted.blobStore.get(key) ?? null;
  }),
}));

import { runReportPipeline } from "../src/services/unifiedReportPipeline";
import { screenerProvenanceLines } from "../src/trading/screenerReportPdf";
import { ScreenerAgent } from "../src/agents/screener-agent";

/* Part A (pipeline retry) lives in tests/report_pipeline_retry_r5.test.ts:
 * it needs the REAL pipeline module, which this file mocks for part C. */

describe("B. screener PDF provenance lines (#1278)", () => {
  it("E*TRADE runs keep the live-snapshot provenance", () => {
    const lines = screenerProvenanceLines({ provider: "etrade" } as any);
    expect(lines.quotesLine).toContain("E*TRADE live snapshots");
    expect(lines.methodologyQuotes).toContain("E*TRADE live snapshots (primary)");
    expect(lines.methodologyQuotes).toContain("No fallback data substituted");
    expect(lines.technicalsNote).toBeUndefined();
  });

  it("Yahoo runs name Yahoo as the quote source — no E*TRADE claim, no 'no fallback' claim", () => {
    const lines = screenerProvenanceLines({ provider: "yahoo" } as any);
    expect(lines.quotesLine).toContain("Yahoo Finance quotes (delayed)");
    expect(lines.quotesLine).not.toContain("E*TRADE");
    expect(lines.methodologyQuotes).toContain("Yahoo Finance");
    expect(lines.methodologyQuotes).not.toContain("E*TRADE live");
    expect(lines.methodologyQuotes).not.toContain("No fallback data substituted");
  });

  it("partial technicals coverage is stated with counts; full coverage adds no note", () => {
    const partial = screenerProvenanceLines({
      provider: "yahoo",
      technicalsCoverage: { symbols: 98, withMacd: 25, withGap: 25 },
    } as any);
    expect(partial.technicalsNote).toContain("25 of 98");
    const full = screenerProvenanceLines({
      provider: "etrade",
      technicalsCoverage: { symbols: 98, withMacd: 98, withGap: 98 },
    } as any);
    expect(full.technicalsNote).toBeUndefined();
  });

  it("a missing provider defaults to the E*TRADE wording (legacy stored runs)", () => {
    const lines = screenerProvenanceLines({} as any);
    expect(lines.quotesLine).toContain("E*TRADE live snapshots");
  });
});

/* ------------------------------------------------------------------ */
/* C. Regeneration                                                     */
/* ------------------------------------------------------------------ */

class FakeStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

function makeAgent(storage: FakeStorage): ScreenerAgent {
  return new ScreenerAgent({ storage } as any, {} as any);
}

const FAILED_RUN = {
  timestamp: "2026-10-23T13:05:29.000Z",
  trigger: "manual",
  provider: "yahoo",
  universe: "nasdaq100",
  success: true,
  totalScanned: 25,
  matchedCount: 25,
  opportunities: [],
  allStocks: [],
  pdfStatus: "failed",
  pdfError: "render blew up",
};

describe("C. ScreenerAgent.regenerateLatestReport (#1278)", () => {
  beforeEach(() => {
    hoisted.pipelineCalls.length = 0;
    hoisted.blobStore.clear();
    hoisted.pipelineResult = {
      pdfKey: "screener:pdf:regen01",
      generationId: "screener:manual:2026-10-23T13:05:29.000Z",
      pdfStatus: "generated",
    };
    // The pipeline's stored asset (what the helper copies to the run key
    // + latest pointer).
    hoisted.blobStore.set("screener:pdf:regen01", {
      fileName: "market-screen.pdf",
      bytes: new Uint8Array([1, 2, 3]),
    });
  });

  it("regenerates the stored latest run's PDF and updates LATEST + HISTORY in place", async () => {
    const storage = new FakeStorage();
    // Issue #1185: a stored run exists only on an instance whose owner was
    // recorded at run entry — regeneration runs under that recorded owner
    // (no default identity to fall back to).
    await storage.put("screener:owner-login", "test-owner");
    await storage.put("screener:latest", { ...FAILED_RUN });
    await storage.put("screener:history", [{ ...FAILED_RUN }]);
    const agent = makeAgent(storage);

    const out = await agent.regenerateLatestReport();
    expect(out.pdfStatus).toBe("generated");
    expect(out.pdfKey).toBe("screener:pdf:regen01");
    expect(hoisted.pipelineCalls).toHaveLength(1);
    expect(hoisted.pipelineCalls[0].result.timestamp).toBe(FAILED_RUN.timestamp);

    const latest = (await storage.get<any>("screener:latest"))!;
    expect(latest.pdfStatus).toBe("generated");
    expect(latest.pdfKey).toBe("screener:pdf:regen01");
    expect(latest.pdfError).toBeUndefined();
    const history = (await storage.get<any[]>("screener:history"))!;
    expect(history).toHaveLength(1);
    expect(history[0].pdfStatus).toBe("generated");
    expect(history[0].pdfKey).toBe("screener:pdf:regen01");
  });

  it("records the new failure on the stored run when regeneration still fails", async () => {
    hoisted.pipelineResult = {
      pdfKey: "",
      generationId: "screener:manual:2026-10-23T13:05:29.000Z",
      pdfStatus: "failed",
      pdfError: "[FAILURE_REPORT_PDF_GENERATION] The PDF report could not be generated. — still broken",
    };
    const storage = new FakeStorage();
    await storage.put("screener:owner-login", "test-owner");
    await storage.put("screener:latest", { ...FAILED_RUN });
    await storage.put("screener:history", [{ ...FAILED_RUN }]);
    const agent = makeAgent(storage);

    const out = await agent.regenerateLatestReport();
    expect(out.pdfStatus).toBe("failed");
    expect(out.pdfError).toContain("FAILURE_REPORT_PDF_GENERATION");
    const latest = (await storage.get<any>("screener:latest"))!;
    expect(latest.pdfStatus).toBe("failed");
    expect(latest.pdfError).toContain("still broken");
  });

  it("with no stored run, reports a coded failure and never calls the pipeline", async () => {
    const agent = makeAgent(new FakeStorage());
    const out = await agent.regenerateLatestReport();
    expect(out.pdfStatus).toBe("failed");
    expect(out.pdfError).toContain("FAILURE_REPORT_ARTIFACT_MISSING");
    expect(hoisted.pipelineCalls).toHaveLength(0);
  });
});
