import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, resetRateLimits } from "../src/security/rateLimiter";

/**
 * Issue #241 — in-worker token-bucket rate limiter for expensive ingress
 * routes (NLQ webhook, memory search).
 */
describe("rate limiter (#241)", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("allows up to the cap, then blocks with a retry hint", () => {
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit("k1", 5, 60_000, now).allowed).toBe(true);
    }
    const blocked = checkRateLimit("k1", 5, 60_000, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills continuously over the window", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 2; i++) checkRateLimit("k2", 2, 1_000, t0);
    expect(checkRateLimit("k2", 2, 1_000, t0).allowed).toBe(false);
    // Half the window later: one token has refilled.
    expect(checkRateLimit("k2", 2, 1_000, t0 + 500).allowed).toBe(true);
    expect(checkRateLimit("k2", 2, 1_000, t0 + 500).allowed).toBe(false);
    // Full window later: bucket is full again.
    expect(checkRateLimit("k2", 2, 1_000, t0 + 1_500).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const now = 3_000_000;
    checkRateLimit("a", 1, 60_000, now);
    expect(checkRateLimit("a", 1, 60_000, now).allowed).toBe(false);
    expect(checkRateLimit("b", 1, 60_000, now).allowed).toBe(true);
  });

  it("retryAfterMs shrinks as the window elapses", () => {
    const t0 = 4_000_000;
    checkRateLimit("k3", 1, 10_000, t0);
    const r1 = checkRateLimit("k3", 1, 10_000, t0);
    const r2 = checkRateLimit("k3", 1, 10_000, t0 + 5_000);
    expect(r1.allowed).toBe(false);
    expect(r2.allowed).toBe(false);
    expect(r2.retryAfterMs).toBeLessThan(r1.retryAfterMs);
  });

  it("is permissive on degenerate config rather than fail-closed", () => {
    expect(checkRateLimit("k4", 0, 60_000).allowed).toBe(true);
  });
});
