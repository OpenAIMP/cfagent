/**
 * Issue #826: BusinessError for watchlist 404.
 * UI gets business message, logs get technical detail.
 * Issue #2381: resolved through the outcome catalog.
 */
import { describe, it, expect } from "vitest";
import { BusinessError, getOutcome } from "../src/outcomes/outcomeAspects";

describe("FAILURE_WATCHLIST_UNAVAILABLE", () => {
  it("has a business message for UI (not technical)", () => {
    const entry = getOutcome("FAILURE_WATCHLIST_UNAVAILABLE");
    expect(entry?.businessMessage).toBe("Watchlist is not available. Your portfolio data is shown below.");
    expect(entry?.businessMessage).not.toContain("404");
    expect(entry?.businessMessage).not.toContain("E*TRADE");
  });

  it("BusinessError.toJSON() is safe for UI", () => {
    const err = new BusinessError("FAILURE_WATCHLIST_UNAVAILABLE", { httpStatus: 404 });
    const json = err.toJSON();
    expect(json.code).toBe("FAILURE_WATCHLIST_UNAVAILABLE");
    expect(json.message).toBe("Watchlist is not available. Your portfolio data is shown below.");
    expect(json.retryable).toBe(false);
    // No technical details leak
    expect(JSON.stringify(json)).not.toContain("Resource not found");
    expect(JSON.stringify(json)).not.toContain("stack");
  });
});
