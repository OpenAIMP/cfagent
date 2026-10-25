import { describe, it, expect } from "vitest";
import { scheduledReportPdfUrl } from "../src/services/scheduledReports";

describe("scheduledReportPdfUrl (#638)", () => {
  it("builds the screener PDF URL from a body pdfKey", () => {
    expect(scheduledReportPdfUrl("screener", JSON.stringify({ pdfKey: "screener/abc 123.pdf" })))
      .toBe("/api/screener/report.pdf?key=screener%2Fabc%20123.pdf");
  });

  it("builds the options PDF URL from a nested result pdfKey", () => {
    expect(scheduledReportPdfUrl("options_scanner", JSON.stringify({ result: { pdfKey: "options/x.pdf" } })))
      .toBe("/api/options/report.pdf?key=options%2Fx.pdf");
  });

  it("falls back to a stored reportUrl (top-level or nested)", () => {
    expect(scheduledReportPdfUrl("screener", JSON.stringify({ reportUrl: "https://agent.openaimp.com/api/screener/report.pdf?key=k" })))
      .toBe("https://agent.openaimp.com/api/screener/report.pdf?key=k");
    expect(scheduledReportPdfUrl("research_report", JSON.stringify({ result: { reportUrl: "https://x/y.pdf" } })))
      .toBe("https://x/y.pdf");
  });

  it("prefers the key-based relative URL over a stored absolute one", () => {
    const body = JSON.stringify({ pdfKey: "k.pdf", reportUrl: "https://agent.openaimp.com/api/screener/report.pdf?key=k.pdf" });
    expect(scheduledReportPdfUrl("screener", body)).toBe("/api/screener/report.pdf?key=k.pdf");
  });

  it("returns undefined when there is no PDF and never throws on bad bodies", () => {
    expect(scheduledReportPdfUrl("iv_collection", JSON.stringify({ recorded: 3 }))).toBeUndefined();
    expect(scheduledReportPdfUrl("screener", "not json")).toBeUndefined();
    expect(scheduledReportPdfUrl("screener", "")).toBeUndefined();
    expect(scheduledReportPdfUrl("screener", undefined)).toBeUndefined();
    expect(scheduledReportPdfUrl("screener", null)).toBeUndefined();
  });
});
