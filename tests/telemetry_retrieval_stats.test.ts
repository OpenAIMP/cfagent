/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — TDD red-first.
 *
 * Pins the retrieval.completed accumulator: only well-formed
 * retrieval.completed envelopes fold; foreign types and
 * malformed data change nothing; ingestion never throws.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRetrievalStats,
  ingestRetrievalCompleted,
  retrievalStatsSnapshot,
} from "../src/telemetry/retrievalStats";
import { toRetrievalCompletedEnvelope } from "../src/retrieval/hybridRetrieval";

describe("retrieval stats accumulator (#1742)", () => {
  beforeEach(() => {
    __resetRetrievalStats();
  });

  it("folds well-formed retrieval.completed envelopes (built by #1740's hook)", () => {
    expect(
      ingestRetrievalCompleted(
        toRetrievalCompletedEnvelope({ denseCount: 5, graphCount: 3, degraded: false }),
      ),
    ).toBe(true);
    expect(
      ingestRetrievalCompleted(
        toRetrievalCompletedEnvelope({ denseCount: 2, graphCount: 0, degraded: true }),
      ),
    ).toBe(true);
    expect(retrievalStatsSnapshot()).toMatchObject({
      totalRetrievals: 2,
      totalDense: 7,
      totalGraph: 3,
      degradedCount: 1,
    });
    expect(retrievalStatsSnapshot().lastCompletedAtMs).not.toBeNull();
  });

  it("rejects foreign types and malformed data without changing state", () => {
    const base = retrievalStatsSnapshot();
    expect(
      ingestRetrievalCompleted({
        specversion: "1.0",
        id: "x",
        source: "breaker-registry",
        type: "breaker.state_changed",
        time: new Date().toISOString(),
        data: {},
      }),
    ).toBe(false);
    expect(
      ingestRetrievalCompleted({
        specversion: "1.0",
        id: "y",
        source: "retrieval/hybrid",
        type: "retrieval.completed",
        time: new Date().toISOString(),
        data: { denseCount: "five", graphCount: 1, degraded: false },
      }),
    ).toBe(false);
    expect(
      ingestRetrievalCompleted({
        specversion: "1.0",
        id: "z",
        source: "retrieval/hybrid",
        type: "retrieval.completed",
        time: new Date().toISOString(),
        data: null,
      }),
    ).toBe(false);
    expect(retrievalStatsSnapshot()).toEqual(base);
  });
});
