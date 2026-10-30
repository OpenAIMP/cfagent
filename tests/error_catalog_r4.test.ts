/**
 * Issue #1252 (#1173 R4), re-homed by #2381: outcome-catalog
 * integrity for the screener pipeline. The outcome resolver never
 * invents a code — unknown codes pass through unresolved (the old
 * unexpected-error fallback is gone by design) — so this suite pins every
 * catalog entry's shape and the existence of every code the pipeline
 * now references, plus the codedMessage rendering contract.
 * Pre-rename alias behavior is pinned separately in
 * tests/outcome_catalog_2381.test.ts.
 */
import { describe, expect, it } from "vitest";
import catalog from "../src/outcomes/outcomeCatalog.json";
import { codedMessage, getOutcome } from "../src/outcomes/outcomeAspects";

const outcomes = (catalog as { outcomes: Record<string, unknown> }).outcomes;

/** Codes referenced by the pipeline surfaces, in outcome-catalog names. */
const REFERENCED_CODES = [
  "FAILURE_MCP_PERMISSION_DENIED",
  "FAILURE_AUTH_TOKEN_MISSING",
  "FAILURE_AUTH_TOKEN_EXPIRED",
  "FAILURE_AUTH_NO_SESSION",
  "FAILURE_QUOTE_AUTH_MISSING",
  "FAILURE_QUOTE_SERVICE_UNAVAILABLE",
  "FAILURE_QUOTE_PARTIAL_SYMBOLS",
  "FAILURE_QUOTE_FORMAT_UNEXPECTED",
  "FAILURE_QUOTE_DATA_STALE",
  "FAILURE_QUOTE_RATE_LIMITED",
  "FAILURE_SCREEN_RUN_FAILED",
  "FAILURE_SCREEN_PARTIAL_COVERAGE",
  "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
  "FAILURE_REPORT_PDF_GENERATION",
  "FAILURE_REPORT_XLSX_GENERATION",
  "FAILURE_REPORT_ARTIFACT_MISSING",
  "FAILURE_REPORT_CSV_GENERATION",
  "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED",
  "FAILURE_DELIVERY_CHANNEL_FAILED",
  "FAILURE_DATA_PROVIDER_UNAVAILABLE",
  "FAILURE_UNEXPECTED_ERROR",
  "FAILURE_WATCHLIST_UNAVAILABLE",
];

describe("outcome catalog integrity (#1252, #2381)", () => {
  it("every referenced code exists with the full entry shape", () => {
    for (const code of REFERENCED_CODES) {
      const entry = outcomes[code] as Record<string, unknown> | undefined;
      expect(entry, `catalog entry ${code}`).toBeTruthy();
      expect(entry?.code).toBe(code);
      expect(typeof entry?.businessMessage).toBe("string");
      expect((entry?.businessMessage as string).length).toBeGreaterThan(0);
      expect(typeof entry?.technicalDetail).toBe("string");
      expect((entry?.technicalDetail as string).length).toBeGreaterThan(0);
      expect(typeof entry?.category).toBe("string");
      expect(typeof entry?.retryable).toBe("boolean");
      expect(typeof entry?.httpStatus).toBe("number");
      // getOutcome must resolve to the code itself, never a fallback.
      expect(getOutcome(code)?.code).toBe(code);
    }
  });

  it("every catalog entry is well-formed (no orphan shapes)", () => {
    for (const [key, raw] of Object.entries(outcomes)) {
      const entry = raw as Record<string, unknown>;
      expect(entry.code).toBe(key);
      expect(typeof entry.businessMessage).toBe("string");
      expect(typeof entry.technicalDetail).toBe("string");
    }
  });

  it("codedMessage renders [CODE] + business message + optional detail", () => {
    expect(codedMessage("FAILURE_AUTH_TOKEN_EXPIRED")).toBe(
      "[FAILURE_AUTH_TOKEN_EXPIRED] E*TRADE connection expired. Please reconnect your account in Settings.",
    );
    expect(codedMessage("FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED", "recipient ops@example.com")).toBe(
      "[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED] The delivery recipient is not on the screener email allowlist; delivery refused. — recipient ops@example.com",
    );
    expect(codedMessage("FAILURE_SCREEN_NO_CONTRACTS_EVALUATED")).toContain(
      "[FAILURE_SCREEN_NO_CONTRACTS_EVALUATED]",
    );
  });

  it("unknown codes pass through unresolved instead of falling back", () => {
    expect(getOutcome("NOPE_999")).toBeNull();
    expect(codedMessage("NOPE_999")).toBe("[NOPE_999]");
  });
});
