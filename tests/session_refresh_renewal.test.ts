/**
 * Session renewal contract (owner request, 2026-10-29).
 *
 * Problem: a session's absolute window was fixed at createdAt + 7 days, so
 * an active user was forced to sign in again every week even while using
 * the app daily. The fix slides the 7-day window on an authenticated page
 * navigation when two days or less remain, and stops at a 30-day hard cap.
 *
 * Pins:
 *  - renewal is due only inside the last 2 days of the 7-day window;
 *  - an already-expired session is never renewed;
 *  - the 30-day lifetime cap stops renewal and expires the session;
 *  - the idle window is owner-overridable (production 8h), with the
 *    settled 30-minute default when unset and safe clamping for typos.
 */
import { describe, it, expect } from "vitest";
import {
  SESSION_MAX_TTL,
  SESSION_RENEW_WINDOW,
  SESSION_TTL,
  renewSessionWithStore,
  sessionRenewalDue,
} from "../src/security/session";
import { getValidatedSession } from "../src/security/iaaaLogin";
import { DEFAULT_IDLE_TIMEOUT_MS, resolveIdleTimeoutMs } from "../src/security/sessionPolicy";
import type { SessionData } from "../src/types";

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function session(over: Partial<SessionData> = {}): SessionData {
  return {
    githubLogin: "owner",
    githubName: "Owner",
    githubAvatar: "",
    createdAt: NOW,
    lastActivityMs: NOW,
    ...over,
  };
}

describe("session renewal window", () => {
  it("is not due while more than two days remain", () => {
    const fresh = session({ createdAt: NOW - (SESSION_TTL * 1000 - 3 * DAY_MS) });
    expect(sessionRenewalDue(fresh, NOW)).toBe(false);
  });

  it("is due inside the last two days", () => {
    const nearExpiry = session({ createdAt: NOW - (SESSION_TTL * 1000 - DAY_MS) });
    expect(sessionRenewalDue(nearExpiry, NOW)).toBe(true);
  });

  it("is not due at or after the absolute expiry", () => {
    const atExpiry = session({ createdAt: NOW - SESSION_TTL * 1000 });
    expect(sessionRenewalDue(atExpiry, NOW)).toBe(false);
  });

  it("is not due once the 30-day lifetime cap is reached", () => {
    const atCap = session({
      createdAt: NOW - (SESSION_TTL * 1000 - DAY_MS),
      firstCreatedAt: NOW - SESSION_MAX_TTL * 1000,
    });
    expect(sessionRenewalDue(atCap, NOW)).toBe(false);
  });

  it("uses createdAt as the first creation time for legacy sessions", () => {
    const legacyNearExpiry = session({ createdAt: NOW - (SESSION_TTL * 1000 - DAY_MS) });
    expect(legacyNearExpiry.firstCreatedAt).toBeUndefined();
    expect(sessionRenewalDue(legacyNearExpiry, NOW)).toBe(true);
  });

  it("pins the renewal window and cap", () => {
    expect(SESSION_RENEW_WINDOW).toBe(2 * 24 * 60 * 60);
    expect(SESSION_MAX_TTL).toBe(30 * 24 * 60 * 60);
  });
});

describe("renewSessionWithStore", () => {
  function fakeStore() {
    const puts: Array<{ key: string; value: string; options: { expirationTtl?: number } }> = [];
    const store = {
      get: async () => null,
      put: async (key: string, value: string, options: { expirationTtl?: number }) => {
        puts.push({ key, value, options });
      },
      delete: async () => undefined,
    };
    return { store, puts };
  }

  it("rewrites the same session id with a fresh 7-day TTL and preserved firstCreatedAt", async () => {
    const { store, puts } = fakeStore();
    const nearExpiry = session({
      createdAt: NOW - (SESSION_TTL * 1000 - DAY_MS),
      firstCreatedAt: NOW - 10 * DAY_MS,
    });
    await expect(renewSessionWithStore(store as any, "sid-1", nearExpiry, NOW)).resolves.toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toBe("sid-1");
    expect(puts[0].options.expirationTtl).toBe(SESSION_TTL);
    const saved = JSON.parse(puts[0].value) as SessionData;
    expect(saved.createdAt).toBe(NOW);
    expect(saved.lastActivityMs).toBe(NOW);
    expect(saved.firstCreatedAt).toBe(NOW - 10 * DAY_MS);
  });

  it("writes nothing when renewal is not due or the cap is reached", async () => {
    const { store, puts } = fakeStore();
    const fresh = session({ createdAt: NOW });
    await expect(renewSessionWithStore(store as any, "sid-1", fresh, NOW)).resolves.toBe(false);
    const atCap = session({
      createdAt: NOW - (SESSION_TTL * 1000 - DAY_MS),
      firstCreatedAt: NOW - SESSION_MAX_TTL * 1000,
    });
    await expect(renewSessionWithStore(store as any, "sid-1", atCap, NOW)).resolves.toBe(false);
    expect(puts).toHaveLength(0);
  });
});

describe("30-day lifetime cap", () => {
  it("rejects a session that reached the cap even inside its 7-day window", () => {
    const atCap = session({
      createdAt: NOW - DAY_MS,
      lastActivityMs: NOW,
      firstCreatedAt: NOW - SESSION_MAX_TTL * 1000,
    });
    const result = getValidatedSession(atCap, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SESSION_EXPIRED");
  });

  it("accepts an active session before the cap", () => {
    const active = session({
      createdAt: NOW - DAY_MS,
      lastActivityMs: NOW,
      firstCreatedAt: NOW - (SESSION_MAX_TTL * 1000 - DAY_MS),
    });
    expect(getValidatedSession(active, NOW).ok).toBe(true);
  });
});

describe("owner idle-window override", () => {
  it("uses the settled 30-minute default when unset or invalid", () => {
    expect(resolveIdleTimeoutMs(undefined)).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs("")).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs("not-a-number")).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(resolveIdleTimeoutMs(0)).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });

  it("honours an 8-hour production override", () => {
    expect(resolveIdleTimeoutMs("28800000")).toBe(8 * 60 * 60 * 1000);
  });

  it("clamps a too-small value up and a too-large value down", () => {
    expect(resolveIdleTimeoutMs("1000")).toBe(5 * 60 * 1000);
    expect(resolveIdleTimeoutMs(String(SESSION_MAX_TTL * 1000))).toBe(SESSION_TTL * 1000);
  });
});
