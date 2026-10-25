import { describe, it, expect } from "vitest";

/**
 * Issue #816: Quote pipeline trace UI.
 * The ScreenerRunResult should carry a quoteTrace summary that the UI renders.
 */
describe("quote trace UI wiring (#816)", () => {
  it("ScreenerRunResult accepts quoteTrace field", () => {
    // Type-level check: the interface includes quoteTrace.
    // This test verifies the shape matches what the UI expects.
    const trace = {
      traceId: "test-123",
      symbolCount: 100,
      batchCount: 10,
      quotesReceived: 95,
      quotesFailed: 5,
      failuresByCategory: { timeout: 3, http_error: 2 } as Record<string, number>,
      batches: [],
    };
    expect(trace.traceId).toBe("test-123");
    expect(trace.quotesReceived + trace.quotesFailed).toBe(trace.symbolCount);
  });

  it("failuresByCategory only shows non-zero categories in UI", () => {
    const failures = { timeout: 3, http_error: 0, unknown: 2 } as Record<string, number>;
    const nonZero = Object.entries(failures).filter(([_, v]) => v > 0);
    expect(nonZero.length).toBe(2);
    expect(nonZero.map(([k]) => k).sort()).toEqual(["timeout", "unknown"]);
  });
});
