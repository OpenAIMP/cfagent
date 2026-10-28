/**
 * Issue #2137: checkout UI API helpers — pure-function tests.
 * Network behavior is covered by the server route tests; these pin
 * the client-side error mapping, command building, and formatting so
 * the panel can never render server detail or invent a price.
 */
import { describe, expect, it } from "vitest";
import {
  buildNonGoalCommand,
  errorMessageForStatus,
  formatPeriodEnd,
  formatUSD,
  parseSymbols,
} from "../src/client/commercialApi";

describe("checkout UI error mapping (#2137)", () => {
  it("maps every status to a fixed caller-facing string", () => {
    expect(errorMessageForStatus(401)).toBe("Sign in again to continue.");
    expect(errorMessageForStatus(402)).toBe("The checkout is not paid yet. Complete the payment, then try again.");
    expect(errorMessageForStatus(403)).toBe("Payments are currently off, or you do not have access to this. No charge was made.");
    expect(errorMessageForStatus(404)).toBe("This service is not deployed yet. Try again after the next release.");
    expect(errorMessageForStatus(409)).toBe("This payment was already used, or the plan is no longer active.");
    expect(errorMessageForStatus(503)).toBe("The payment service is temporarily unavailable. Try again later.");
    expect(errorMessageForStatus(0)).toContain("could not be reached");
  });
});

describe("checkout UI command building (#2137)", () => {
  it("builds a bounded non-goal command with the caller's symbols", () => {
    const cmd = buildNonGoalCommand("job-1", "stock", ["AAPL", "MSFT"]);
    expect(cmd.jobId).toBe("job-1");
    expect(cmd.shards).toEqual([{ shardId: "stock", symbols: ["AAPL", "MSFT"] }]);
    expect(cmd.trigger).toBe("manual");
    expect(cmd).not.toHaveProperty("userLogin");
  });

  it("parses symbol lists without inventing symbols", () => {
    expect(parseSymbols("AAPL, MSFT ,, TSLA ")).toEqual(["AAPL", "MSFT", "TSLA"]);
    expect(parseSymbols("")).toEqual([]);
  });

  it("formats money and period ends deterministically", () => {
    expect(formatUSD(0.1)).toBe("$0.10");
    expect(formatUSD(2)).toBe("$2.00");
    expect(formatPeriodEnd(null)).toBe("—");
    expect(formatPeriodEnd(0)).toBe("—");
  });
});
