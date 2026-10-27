/**
 * Issue #1252 (#1173 R4): error-catalog integrity for the screener
 * pipeline. getError() falls back to SYS_001 for unknown codes, so a
 * typo'd code in a converted surface would silently render the wrong
 * message — this suite pins every catalog entry's shape and the
 * existence of every code the pipeline now references, plus the
 * codedMessage rendering contract.
 */
import { describe, expect, it } from "vitest";
import catalog from "../src/errors/errorCatalog.json";
import { codedMessage, getError } from "../src/errors/errorAspects";

const errors = (catalog as { errors: Record<string, unknown> }).errors;

/** Codes referenced by the #1173 pipeline surfaces after R4, plus #1744's MCP_001. */
const REFERENCED_CODES = [
  "MCP_001",
  "AUTH_001",
  "AUTH_002",
  "AUTH_003",
  "QUOTE_001",
  "QUOTE_002",
  "QUOTE_003",
  "QUOTE_004",
  "QUOTE_005",
  "QUOTE_006",
  "SCREEN_001",
  "SCREEN_002",
  "SCREEN_003",
  "REPORT_001",
  "REPORT_002",
  "REPORT_003",
  "DELIVER_001",
  "DELIVER_002",
  "DATA_001",
  "SYS_001",
  "WATCHLIST_001",
];

describe("error catalog integrity (#1252)", () => {
  it("every referenced code exists with the full entry shape", () => {
    for (const code of REFERENCED_CODES) {
      const entry = errors[code] as Record<string, unknown> | undefined;
      expect(entry, `catalog entry ${code}`).toBeTruthy();
      expect(entry?.code).toBe(code);
      expect(typeof entry?.businessMessage).toBe("string");
      expect((entry?.businessMessage as string).length).toBeGreaterThan(0);
      expect(typeof entry?.technicalDetail).toBe("string");
      expect((entry?.technicalDetail as string).length).toBeGreaterThan(0);
      expect(typeof entry?.category).toBe("string");
      expect(typeof entry?.retryable).toBe("boolean");
      expect(typeof entry?.httpStatus).toBe("number");
      // getError must resolve to the code itself, never the fallback.
      expect(getError(code).code).toBe(code);
    }
  });

  it("every catalog entry is well-formed (no orphan shapes)", () => {
    for (const [key, raw] of Object.entries(errors)) {
      const entry = raw as Record<string, unknown>;
      expect(entry.code).toBe(key);
      expect(typeof entry.businessMessage).toBe("string");
      expect(typeof entry.technicalDetail).toBe("string");
    }
  });

  it("codedMessage renders [CODE] + business message + optional detail", () => {
    expect(codedMessage("AUTH_002")).toBe(
      "[AUTH_002] E*TRADE connection expired. Please reconnect your account in Settings."
    );
    expect(codedMessage("DELIVER_001", "recipient ops@example.com")).toBe(
      "[DELIVER_001] The delivery recipient is not on the screener email allowlist; delivery refused. — recipient ops@example.com"
    );
    expect(codedMessage("SCREEN_003")).toContain("[SCREEN_003]");
  });
});
