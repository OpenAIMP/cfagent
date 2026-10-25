import { describe, it, expect } from "vitest";
import {
  DEFAULT_SESSION_POLICY,
  requiresStepUp,
  type SessionState,
} from "../src/security/sessionPolicy";

/**
 * Issue #945, Slice 2 — step-up (authentication freshness).
 *
 * The freshness window is a policy default, not a settled CISO
 * decision: the merged spec (§8) still lists step-up thresholds as
 * an open decision for CISO, due before Slice 2. Callers may override
 * the window; this file pins the default at 15 minutes so a change
 * to it is a deliberate, visible decision, not a silent drift.
 *
 * requiresStepUp answers only "is authentication fresh enough?".
 * Callers must check session usability (revocation, absolute and
 * idle expiry) separately via sessionIsUsable.
 */

const NOW = 1_800_000_000_000;

function session(authTimeMs: number): SessionState {
  return {
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    internalUserId: "user-1",
    createdAtMs: NOW - 60_000,
    lastActivityMs: NOW,
    authTimeMs,
  };
}

describe("iaaa step-up (#945 slice 2)", () => {
  it("does not require step-up for a freshly authenticated session (legitimate workflow succeeds)", () => {
    expect(requiresStepUp(session(NOW), DEFAULT_SESSION_POLICY, NOW)).toBe(false);
  });

  it("does not require step-up one millisecond inside the freshness window", () => {
    const authTime = NOW - DEFAULT_SESSION_POLICY.stepUpFreshnessMs + 1;
    expect(requiresStepUp(session(authTime), DEFAULT_SESSION_POLICY, NOW)).toBe(false);
  });

  it("requires step-up exactly at the freshness boundary", () => {
    const authTime = NOW - DEFAULT_SESSION_POLICY.stepUpFreshnessMs;
    expect(requiresStepUp(session(authTime), DEFAULT_SESSION_POLICY, NOW)).toBe(true);
  });

  it("requires step-up for a stale authentication", () => {
    const authTime = NOW - DEFAULT_SESSION_POLICY.stepUpFreshnessMs - 60_000;
    expect(requiresStepUp(session(authTime), DEFAULT_SESSION_POLICY, NOW)).toBe(true);
  });

  it("requires step-up when authentication time is missing or invalid", () => {
    const missing = { ...session(NOW), authTimeMs: Number.NaN };
    expect(requiresStepUp(missing, DEFAULT_SESSION_POLICY, NOW)).toBe(true);
  });

  it("requires step-up for an authentication time in the future (clock skew is not freshness)", () => {
    expect(requiresStepUp(session(NOW + 60_000), DEFAULT_SESSION_POLICY, NOW)).toBe(true);
  });

  it("honours a caller-overridden freshness window", () => {
    const policy = { ...DEFAULT_SESSION_POLICY, stepUpFreshnessMs: 60_000 };
    // 5 minutes old: stale under the 1-minute override, fresh under the default.
    expect(requiresStepUp(session(NOW - 5 * 60_000), policy, NOW)).toBe(true);
    expect(requiresStepUp(session(NOW - 5 * 60_000), DEFAULT_SESSION_POLICY, NOW)).toBe(false);
  });

  it("pins the documented default freshness window at 15 minutes", () => {
    expect(DEFAULT_SESSION_POLICY.stepUpFreshnessMs).toBe(15 * 60 * 1000);
  });
});
