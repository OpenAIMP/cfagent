/**
 * Issue #826: BusinessError for watchlist 404.
 * UI gets business message, logs get technical detail.
 */
import { describe, it, expect } from "vitest";
import { BusinessError, getError } from "../src/errors/errorAspects";

describe("WATCHLIST_001", () => {
  it("has a business message for UI (not technical)", () => {
    const entry = getError("WATCHLIST_001");
    expect(entry.businessMessage).toBe("Watchlist is not available. Your portfolio data is shown below.");
    expect(entry.businessMessage).not.toContain("404");
    expect(entry.businessMessage).not.toContain("E*TRADE");
  });

  it("BusinessError.toJSON() is safe for UI", () => {
    const err = new BusinessError("WATCHLIST_001", { httpStatus: 404 });
    const json = err.toJSON();
    expect(json.code).toBe("WATCHLIST_001");
    expect(json.message).toBe("Watchlist is not available. Your portfolio data is shown below.");
    expect(json.retryable).toBe(false);
    // No technical details leak
    expect(JSON.stringify(json)).not.toContain("Resource not found");
    expect(JSON.stringify(json)).not.toContain("stack");
  });
});
