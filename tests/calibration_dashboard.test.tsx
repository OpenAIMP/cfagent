/**
 * Issue #654: CalibrationDashboard renders the server's calibration.
 *
 * - A populated calibration renders the overall rate plus the four
 *   breakdown tables, with low-sample rows flagged.
 * - Zero evaluated ideas render the empty state (never fabricated
 *   numbers), and a failed fetch renders the server's error.
 * - Component tests only: jsdom, direct renders, global fetch mocked.
 */
/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoot } from "react-dom/client";
import React, { act } from "react";
import { CalibrationDashboard } from "../src/client/CalibrationDashboard";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CALIBRATION = {
  generatedAt: "2026-10-25T12:00:00.000Z",
  totalEvaluated: 2,
  byThesis: [{ thesis: "bullish", evaluated: 2, hits: 1, hitRate: 0.5 }],
  lowSampleThreshold: 20,
  lowSampleTheses: ["bullish"],
  byStrategy: [{ key: "bull_put_spread", evaluated: 2, hits: 1, hitRate: 0.5 }],
  byRegime: [{ key: "bull", evaluated: 2, hits: 1, hitRate: 0.5 }],
  byMonth: [{ key: "2026-10", evaluated: 2, hits: 1, hitRate: 0.5 }],
  pending: 1,
  overallHitRate: 0.5,
};

async function renderPanel(fetchImpl: (url: string) => Promise<unknown>) {
  (globalThis as any).fetch = vi.fn(fetchImpl as any);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CalibrationDashboard userLogin="alice" />);
  });
  await act(async () => {});
  return { container, root };
}

describe("Issue #654 — CalibrationDashboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the overall rate and all four breakdown tables", async () => {
    const { container } = await renderPanel(async () => ({
      ok: true,
      json: async () => ({ calibration: CALIBRATION }),
    }));
    const text = container.textContent ?? "";
    expect(text).toContain("Overall hit rate: 50.0%");
    expect(text).toContain("2 ideas evaluated");
    expect(text).toContain("1 published but not yet scored");
    expect(text).toContain("bullish");
    expect(text).toContain("bull_put_spread");
    expect(text).toContain("2026-10");
    expect(text).toContain("Low sample");
  });

  it("zero evaluated ideas render the empty state, never numbers", async () => {
    const { container } = await renderPanel(async () => ({
      ok: true,
      json: async () => ({ calibration: { ...CALIBRATION, totalEvaluated: 0, overallHitRate: null } }),
    }));
    const text = container.textContent ?? "";
    expect(text).toContain("No evaluated ideas yet");
    expect(text).not.toContain("Overall hit rate");
  });

  it("a failed fetch renders the server error", async () => {
    const { container } = await renderPanel(async () => ({
      ok: false,
      json: async () => ({ error: "ResearchAgent binding not configured." }),
    }));
    const text = container.textContent ?? "";
    expect(text).toContain("Calibration unavailable");
    expect(text).toContain("ResearchAgent binding not configured.");
  });
});
