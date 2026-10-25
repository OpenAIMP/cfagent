import { describe, it, expect } from "vitest";
import { optionsPdfFileName } from "../src/trading/optionsReportPdf";
import type { OptionScreenResult } from "../src/types";

/**
 * #334: options-scanner PDF naming parity with the stock screener (#297).
 */

function result(overrides: Record<string, unknown> = {}): OptionScreenResult {
  return {
    scannedAt: "2026-10-20T12:00:00.000Z",
    ...overrides,
  } as unknown as OptionScreenResult;
}

describe("#334 options PDF naming parity", () => {
  it("follows the #297 convention", () => {
    const name = optionsPdfFileName(
      result({ universe: "NASDAQ100", schedule: "hourly", jobId: "job-1" })
    );
    expect(name).toBe("options-scan_nasdaq100_hourly_2026-10-20T12-00-00Z_job-1.pdf");
  });

  it("falls back to adhoc when schedule/jobId are absent", () => {
    const name = optionsPdfFileName(result());
    expect(name).toBe("options-scan_options_adhoc_2026-10-20T12-00-00Z_adhoc.pdf");
  });

  it("produces unique names per timestamp", () => {
    const a = optionsPdfFileName(result({ scannedAt: "2026-10-20T12:00:00.000Z" }));
    const b = optionsPdfFileName(result({ scannedAt: "2026-10-20T13:00:00.000Z" }));
    expect(a).not.toBe(b);
  });
});
