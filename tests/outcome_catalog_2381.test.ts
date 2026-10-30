/**
 * Issue #2381 (phase 1): the single outcome catalog — success AND
 * failure entries under meaningful outcome-encoded names, one
 * resolver, and a read-time-only legacy-alias map.
 *
 * The old strings below appear ONLY as alias fixtures: they assert
 * that pre-rename stored values still resolve at read time. No
 * emitter in src references them (see the phase 1 grep proof).
 * Stored rows are never rewritten: resolving a stored row must not
 * mutate it, and the resolver must never invent a code for an
 * unknown input — unknown codes pass through unresolved.
 */
import { describe, expect, it } from "vitest";
import catalog from "../src/outcomes/outcomeCatalog.json";
import {
  BusinessError,
  codedMessage,
  getOutcome,
  hasOutcomeCodePrefix,
  LEGACY_OUTCOME_ALIASES,
  resolveOutcome,
} from "../src/outcomes/outcomeAspects";

const outcomes = (catalog as {
  outcomes: Record<string, Record<string, unknown>>;
  legacyAliases: Record<string, string>;
}).outcomes;

const LEGACY_ALIASES: Record<string, string> = {
  AUTH_001: "FAILURE_AUTH_TOKEN_MISSING",
  AUTH_002: "FAILURE_AUTH_TOKEN_EXPIRED",
  AUTH_003: "FAILURE_AUTH_NO_SESSION",
  QUOTE_001: "FAILURE_QUOTE_AUTH_MISSING",
  QUOTE_002: "FAILURE_QUOTE_SERVICE_UNAVAILABLE",
  QUOTE_003: "FAILURE_QUOTE_PARTIAL_SYMBOLS",
  QUOTE_004: "FAILURE_QUOTE_FORMAT_UNEXPECTED",
  QUOTE_005: "FAILURE_QUOTE_DATA_STALE",
  QUOTE_006: "FAILURE_QUOTE_RATE_LIMITED",
  SYS_001: "FAILURE_UNEXPECTED_ERROR",
  WATCHLIST_001: "FAILURE_WATCHLIST_UNAVAILABLE",
  SCREEN_001: "FAILURE_SCREEN_RUN_FAILED",
  SCREEN_002: "FAILURE_SCREEN_PARTIAL_COVERAGE",
  SCREEN_003: "FAILURE_SCREEN_NO_CONTRACTS_EVALUATED",
  REPORT_001: "FAILURE_REPORT_PDF_GENERATION",
  REPORT_002: "FAILURE_REPORT_XLSX_GENERATION",
  REPORT_003: "FAILURE_REPORT_ARTIFACT_MISSING",
  REPORT_004: "FAILURE_REPORT_CSV_GENERATION",
  DELIVER_001: "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED",
  DELIVER_002: "FAILURE_DELIVERY_CHANNEL_FAILED",
  DATA_001: "FAILURE_DATA_PROVIDER_UNAVAILABLE",
  MCP_001: "FAILURE_MCP_PERMISSION_DENIED",
};

describe("outcome catalog (#2381)", () => {
  it("carries new names only — no old cryptic code is a catalog key", () => {
    for (const key of Object.keys(outcomes)) {
      expect(key, `catalog key ${key}`).not.toMatch(/^[A-Z]+_[0-9]{3}$/);
      expect(key).toMatch(/^(SUCCESS|FAILURE)_[A-Z_]+$/);
    }
    for (const key of Object.keys(outcomes)) {
      const entry = outcomes[key] as Record<string, unknown>;
      expect(entry.code).toBe(key);
      expect(entry.outcome).toBe(
        key.startsWith("SUCCESS_") ? "success" : "failure",
      );
      expect(typeof entry.businessMessage).toBe("string");
      expect((entry.businessMessage as string).length).toBeGreaterThan(0);
      expect(typeof entry.technicalDetail).toBe("string");
      expect(typeof entry.category).toBe("string");
      expect(typeof entry.retryable).toBe("boolean");
      expect(typeof entry.httpStatus).toBe("number");
    }
  });

  it("covers success entries for job outcomes", () => {
    for (const code of [
      "SUCCESS_SCREEN_COMPLETED",
      "SUCCESS_SCREEN_PARTIAL_RESULTS",
      "SUCCESS_REPORT_PDF_GENERATED",
      "SUCCESS_REPORT_XLSX_GENERATED",
      "SUCCESS_REPORT_CSV_GENERATED",
      "SUCCESS_REPORT_DELIVERED",
      "SUCCESS_JOB_COMPLETED",
    ]) {
      const resolved = resolveOutcome(code);
      expect(resolved.resolved).toBe(true);
      expect(resolved.entry?.outcome).toBe("success");
      expect(codedMessage(code)).toBe(
        `[${code}] ${resolved.entry?.businessMessage}`,
      );
    }
    expect(codedMessage("SUCCESS_SCREEN_COMPLETED")).toContain(
      "Screen completed",
    );
  });

  it("resolves cataloged failure entries", () => {
    const resolved = resolveOutcome("FAILURE_AUTH_TOKEN_EXPIRED");
    expect(resolved.resolved).toBe(true);
    expect(resolved.entry?.outcome).toBe("failure");
    expect(codedMessage("FAILURE_AUTH_TOKEN_EXPIRED")).toBe(
      "[FAILURE_AUTH_TOKEN_EXPIRED] E*TRADE connection expired. Please reconnect your account in Settings.",
    );
    expect(
      codedMessage(
        "FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED",
        "recipient ops@example.com",
      ),
    ).toBe(
      "[FAILURE_DELIVERY_RECIPIENT_NOT_ALLOWED] The delivery recipient is not on the screener email allowlist; delivery refused. — recipient ops@example.com",
    );
    expect(codedMessage("FAILURE_SCREEN_NO_CONTRACTS_EVALUATED")).toContain(
      "[FAILURE_SCREEN_NO_CONTRACTS_EVALUATED]",
    );
  });

  it("passes unknown codes through unresolved — a read never fails, never invents", () => {
    const resolved = resolveOutcome("NOPE_999");
    expect(resolved.resolved).toBe(false);
    expect(resolved.entry).toBeNull();
    expect(resolved.code).toBe("NOPE_999");
    expect(resolved.businessMessage).toBeNull();
    expect(getOutcome("NOPE_999")).toBeNull();
    expect(codedMessage("NOPE_999")).toBe("[NOPE_999]");
    expect(codedMessage("NOPE_999", "some detail")).toBe(
      "[NOPE_999] — some detail",
    );
    // Never silently substituted with the unexpected-error entry.
    expect(codedMessage("NOPE_999")).not.toContain("FAILURE_UNEXPECTED_ERROR");
    expect(() => resolveOutcome("")).not.toThrow();
  });

  it("resolves pre-rename values through the legacy-alias map (read time only)", () => {
    expect(LEGACY_OUTCOME_ALIASES).toEqual(LEGACY_ALIASES);
    expect(
      (catalog as { legacyAliases: Record<string, string> }).legacyAliases,
    ).toEqual(LEGACY_ALIASES);
    for (const [oldCode, newCode] of Object.entries(LEGACY_ALIASES)) {
      const resolved = resolveOutcome(oldCode);
      expect(resolved.resolved).toBe(true);
      expect(resolved.inputCode).toBe(oldCode);
      expect(resolved.code).toBe(newCode);
      expect(resolved.entry?.code).toBe(newCode);
      expect(getOutcome(oldCode)?.code).toBe(newCode);
      // Rendering a stored old value shows the NEW code and message.
      expect(codedMessage(oldCode)).toBe(codedMessage(newCode));
      expect(codedMessage(oldCode)).toContain(`[${newCode}]`);
    }
    // Preserved business messages, verbatim from the old catalog.
    expect(codedMessage("AUTH_002")).toBe(
      "[FAILURE_AUTH_TOKEN_EXPIRED] E*TRADE connection expired. Please reconnect your account in Settings.",
    );
    expect(codedMessage("REPORT_001")).toBe(
      "[FAILURE_REPORT_PDF_GENERATION] The PDF report could not be generated.",
    );
  });

  it("never rewrites a stored row", () => {
    const storedRow = Object.freeze({
      code: "AUTH_002",
      message: "[AUTH_002] E*TRADE connection expired.",
      status: "failed",
    });
    const before = JSON.stringify(storedRow);
    const resolved = resolveOutcome(storedRow.code);
    expect(resolved.code).toBe("FAILURE_AUTH_TOKEN_EXPIRED");
    expect(JSON.stringify(storedRow)).toBe(before);
    expect(storedRow.code).toBe("AUTH_002");
    // A BusinessError built from a stored old code normalizes only
    // its own in-memory code; the stored row above is untouched.
    expect(new BusinessError("AUTH_003").code).toBe(
      "FAILURE_AUTH_NO_SESSION",
    );
    expect(new BusinessError("FAILURE_SCREEN_RUN_FAILED").toJSON()).toEqual({
      code: "FAILURE_SCREEN_RUN_FAILED",
      message: "The screen run failed.",
      retryable: true,
    });
  });

  it("recognizes already-coded messages, old or new, for the report parsers", () => {
    expect(
      hasOutcomeCodePrefix("[FAILURE_REPORT_PDF_GENERATION] boom"),
    ).toBe(true);
    expect(hasOutcomeCodePrefix("[REPORT_001] boom")).toBe(true);
    expect(hasOutcomeCodePrefix("plain failure text")).toBe(false);
    expect(hasOutcomeCodePrefix("[NOPE_999] boom")).toBe(false);
  });
});
