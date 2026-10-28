import { describe, expect, it } from "vitest";
import {
  formatLifecycleNotification,
  screenerOutcomeFromEvent,
  screenerOutcomeFromRunResult,
} from "../src/services/screenerFollowups";

const PDF_KEY = "report:pdf:screener:abc123";
const ENCODED = encodeURIComponent(PDF_KEY);
const FALLBACK = "https://agent.openaimp.com";

function stockCompletedEvent() {
  return {
    type: "screener.completed",
    timestamp: new Date().toISOString(),
    universe: "NASDAQ100",
    trigger: "scheduled",
    sector: "ALL",
    totalScanned: 100,
    matchedCount: 100,
    opportunities: [],
    pdfKey: PDF_KEY,
  } as any;
}

describe("issue #1943: follow-up report links are absolute", () => {
  it("the event bridge builds an absolute stock report URL on the fallback base", () => {
    const outcome = screenerOutcomeFromEvent(stockCompletedEvent());
    expect(outcome.reportUrl).toBe(
      `${FALLBACK}/api/screener/report.pdf?key=${ENCODED}`,
    );
  });

  it("the event bridge honors an explicit APP_BASE_URL", () => {
    const outcome = screenerOutcomeFromEvent(
      stockCompletedEvent(),
      "https://staging.example.com/",
    );
    expect(outcome.reportUrl).toBe(
      `https://staging.example.com/api/screener/report.pdf?key=${ENCODED}`,
    );
  });

  it("the run-result bridge builds absolute stock and options URLs from a pdfKey", () => {
    const stock = screenerOutcomeFromRunResult("stock", {
      pdfKey: PDF_KEY,
      success: true,
    });
    expect(stock.reportUrl).toBe(
      `${FALLBACK}/api/screener/report.pdf?key=${ENCODED}`,
    );
    const options = screenerOutcomeFromRunResult("options", {
      pdfKey: PDF_KEY,
      success: true,
    });
    expect(options.reportUrl).toBe(
      `${FALLBACK}/api/options/report.pdf?key=${ENCODED}`,
    );
  });

  it("a relative carried reportUrl is absolutized, an absolute one is unchanged", () => {
    const rel = screenerOutcomeFromRunResult("stock", {
      reportUrl: `/api/screener/report.pdf?key=${ENCODED}`,
      success: true,
    });
    expect(rel.reportUrl).toBe(
      `${FALLBACK}/api/screener/report.pdf?key=${ENCODED}`,
    );
    const abs = screenerOutcomeFromRunResult("stock", {
      reportUrl: `${FALLBACK}/api/screener/report.pdf?key=${ENCODED}`,
      success: true,
    });
    expect(abs.reportUrl).toBe(
      `${FALLBACK}/api/screener/report.pdf?key=${ENCODED}`,
    );
  });

  it("an options event carrying a relative reportUrl is absolutized", () => {
    const outcome = screenerOutcomeFromEvent({
      type: "options.completed",
      timestamp: new Date().toISOString(),
      thesis: "bullish",
      trigger: "scheduled",
      totalScanned: 100,
      reportUrl: `/api/options/report.pdf?key=${ENCODED}`,
    } as any);
    expect(outcome.reportUrl).toBe(
      `${FALLBACK}/api/options/report.pdf?key=${ENCODED}`,
    );
  });

  it("completed and delivered messages carry the absolute URL, never a bare /api link", () => {
    const outcome = screenerOutcomeFromEvent(stockCompletedEvent());
    const completed = formatLifecycleNotification("completed", outcome);
    const delivered = formatLifecycleNotification("delivered", outcome);
    for (const text of [completed, delivered]) {
      expect(text).toContain(
        `${FALLBACK}/api/screener/report.pdf?key=${ENCODED}`,
      );
      expect(text).not.toContain("\n📄 Report: /api/");
    }
  });
});
