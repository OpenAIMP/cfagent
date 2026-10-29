/**
 * Issue #2178 (Q7 S1) — tamper-evident chain on live mas_events.
 * TDD: written before the implementation.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalizeAuditRow,
  linkAuditRow,
  sha256HexSync,
  verifyAuditChain,
  type AuditChainRow,
} from "../src/security/auditChain";

function row(overrides: Partial<AuditChainRow> = {}): AuditChainRow {
  return {
    id: "e1",
    sessionId: "alice",
    type: "goal_screen.workflow_submitted",
    agent: "orchestrator",
    payload: JSON.stringify({ principalKind: "session", jobId: "j1" }),
    createdAt: "2026-10-28T00:00:00.000Z",
    previousEventHash: null,
    eventHash: "",
    ...overrides,
  };
}

describe("sha256HexSync (#2178)", () => {
  it("matches NIST vectors", () => {
    expect(sha256HexSync("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256HexSync("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256HexSync("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("audit chain (#2178)", () => {
  it("canonicalization is deterministic and field-ordered", () => {
    const a = canonicalizeAuditRow(row());
    const b = canonicalizeAuditRow(row({ id: "e1" }));
    expect(a).toBe(b);
    expect(a).toContain('"previousEventHash"');
  });

  it("linking chains hashes and verification passes", () => {
    const r1 = linkAuditRow(row({ id: "e1" }), null);
    const r2 = linkAuditRow(row({ id: "e2", type: "goal_screen.run_failed" }), r1.eventHash);
    const r3 = linkAuditRow(row({ id: "e3", type: "screener.failed" }), r2.eventHash);
    expect(r1.previousEventHash).toBeNull();
    expect(r2.previousEventHash).toBe(r1.eventHash);
    expect(r3.previousEventHash).toBe(r2.eventHash);
    expect(verifyAuditChain([r1, r2, r3])).toBe(true);
  });

  it("tampering with a payload fails verification", () => {
    const r1 = linkAuditRow(row({ id: "e1" }), null);
    const r2 = linkAuditRow(row({ id: "e2" }), r1.eventHash);
    const tampered = { ...r2, payload: JSON.stringify({ principalKind: "system" }) };
    expect(verifyAuditChain([r1, tampered])).toBe(false);
  });

  it("reordering fails verification", () => {
    const r1 = linkAuditRow(row({ id: "e1" }), null);
    const r2 = linkAuditRow(row({ id: "e2" }), r1.eventHash);
    expect(verifyAuditChain([r2, r1])).toBe(false);
  });

  it("a missing hash mid-chain fails verification", () => {
    const r1 = linkAuditRow(row({ id: "e1" }), null);
    const r2 = linkAuditRow(row({ id: "e2" }), r1.eventHash);
    const gap = row({ id: "e3", previousEventHash: r2.eventHash, eventHash: "" });
    expect(verifyAuditChain([r1, r2, gap])).toBe(false);
  });

  it("pre-chain rows are a genesis boundary, not a failure", () => {
    const old = row({ id: "old", previousEventHash: null, eventHash: "" });
    const r1 = linkAuditRow(row({ id: "e1" }), null);
    const r2 = linkAuditRow(row({ id: "e2" }), r1.eventHash);
    expect(verifyAuditChain([old, r1, r2])).toBe(true);
  });
});
