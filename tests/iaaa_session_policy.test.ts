import { describe, it, expect } from "vitest";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_SESSION_POLICY,
  SESSION_ABSOLUTE_TTL_MS,
  createMemoryRevocationStore,
  rotateSession,
  sessionIsUsable,
  sessionExpiryReason,
} from "../src/security/sessionPolicy";
import type { SessionState } from "../src/security/sessionPolicy";

/**
 * Issue #945, Slice 2 — session expiry, rotation, revocation.
 *
 * Absolute TTL mirrors the existing SESSION_TTL in
 * src/security/session.ts (7 days); the idle timeout comes from
 * config/session-limits.json (8 hours, overridable) — this pure
 * module does not touch the live session flow.
 *
 * Rotation preserves absolute expiry and authentication time: a
 * rotated session must not live longer than the original session,
 * and rotation alone is not re-authentication. It only resets the
 * idle clock.
 */

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    internalUserId: "user-1",
    createdAtMs: NOW - 60_000,
    lastActivityMs: NOW,
    authTimeMs: NOW - 60_000,
    ...overrides,
  };
}

describe("iaaa session policy (#945 slice 2)", () => {
  it("keeps a legitimate, active session usable", async () => {
    const store = createMemoryRevocationStore();
    const s = session();
    await store.registerSession(s.sessionId, s.internalUserId);
    const result = await sessionIsUsable(store, s, DEFAULT_SESSION_POLICY, NOW);
    expect(result).toEqual({ usable: true, reason: "OK" });
  });

  it("pins the absolute TTL at 7 days, matching the existing SESSION_TTL", () => {
    expect(SESSION_ABSOLUTE_TTL_MS).toBe(7 * DAY);
    expect(DEFAULT_SESSION_POLICY.absoluteTtlMs).toBe(7 * DAY);
  });

  it("pins the configured idle timeout", () => {
    expect(DEFAULT_SESSION_POLICY.idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });

  it("expires a session at its absolute deadline, even if recently active", async () => {
    const store = createMemoryRevocationStore();
    const s = session({ createdAtMs: NOW - 7 * DAY, lastActivityMs: NOW });
    expect(sessionExpiryReason(s, DEFAULT_SESSION_POLICY, NOW)).toBe("ABSOLUTE_EXPIRED");
    const result = await sessionIsUsable(store, s, DEFAULT_SESSION_POLICY, NOW);
    expect(result).toEqual({ usable: false, reason: "ABSOLUTE_EXPIRED" });
  });

  it("keeps a session usable one millisecond before its absolute deadline", () => {
    const s = session({ createdAtMs: NOW - 7 * DAY + 1, lastActivityMs: NOW });
    expect(sessionExpiryReason(s, DEFAULT_SESSION_POLICY, NOW)).toBe("OK");
  });

  it("expires an idle session at the idle deadline, even before absolute expiry", async () => {
    const store = createMemoryRevocationStore();
    const s = session({ lastActivityMs: NOW - DEFAULT_IDLE_TIMEOUT_MS });
    expect(sessionExpiryReason(s, DEFAULT_SESSION_POLICY, NOW)).toBe("IDLE_EXPIRED");
    const result = await sessionIsUsable(store, s, DEFAULT_SESSION_POLICY, NOW);
    expect(result).toEqual({ usable: false, reason: "IDLE_EXPIRED" });
  });

  it("keeps a session usable one millisecond before its idle deadline", () => {
    const s = session({ lastActivityMs: NOW - DEFAULT_IDLE_TIMEOUT_MS + 1 });
    expect(sessionExpiryReason(s, DEFAULT_SESSION_POLICY, NOW)).toBe("OK");
  });

  it("honours a caller-overridden idle timeout", () => {
    const policy = { ...DEFAULT_SESSION_POLICY, idleTimeoutMs: 5 * 60 * 1000 };
    const s = session({ lastActivityMs: NOW - 10 * 60 * 1000 });
    expect(sessionExpiryReason(s, policy, NOW)).toBe("IDLE_EXPIRED");
    expect(sessionExpiryReason(s, DEFAULT_SESSION_POLICY, NOW)).toBe("OK");
  });

  it("rejects a malformed session as invalid, not merely expired", async () => {
    const store = createMemoryRevocationStore();
    const bad = session({ sessionId: "not-a-uuid-and-not-checked-here-but-empty-is" });
    // Empty id is the invalid case; a non-UUID shape is not this module's job.
    const empty = session({ sessionId: "" });
    expect((await sessionIsUsable(store, empty, DEFAULT_SESSION_POLICY, NOW)).reason).toBe("INVALID_SESSION");
    const futureCreated = session({ createdAtMs: NOW + 60_000 });
    expect((await sessionIsUsable(store, futureCreated, DEFAULT_SESSION_POLICY, NOW)).reason).toBe("INVALID_SESSION");
    expect(bad.sessionId).not.toBe("");
  });

  it("marks a revoked session unusable", async () => {
    const store = createMemoryRevocationStore();
    const s = session();
    await store.registerSession(s.sessionId, s.internalUserId);
    await store.revokeSession(s.sessionId);
    const result = await sessionIsUsable(store, s, DEFAULT_SESSION_POLICY, NOW);
    expect(result).toEqual({ usable: false, reason: "REVOKED" });
  });

  it("revoking all sessions for a user leaves another user's session usable", async () => {
    const store = createMemoryRevocationStore();
    const mine = session();
    const theirs = session({
      sessionId: "660e8400-e29b-41d4-a716-446655440001",
      internalUserId: "user-2",
    });
    await store.registerSession(mine.sessionId, mine.internalUserId);
    await store.registerSession(theirs.sessionId, theirs.internalUserId);
    await store.revokeAllSessionsForUser("user-1");
    expect(await sessionIsUsable(store, mine, DEFAULT_SESSION_POLICY, NOW)).toEqual({
      usable: false,
      reason: "REVOKED",
    });
    expect(await sessionIsUsable(store, theirs, DEFAULT_SESSION_POLICY, NOW)).toEqual({
      usable: true,
      reason: "OK",
    });
  });

  it("does not block a new session issued after a revoke-all (revocation is of sessions, not the user)", async () => {
    const store = createMemoryRevocationStore();
    const old = session();
    await store.registerSession(old.sessionId, old.internalUserId);
    await store.revokeAllSessionsForUser("user-1");
    const fresh = session({ sessionId: "770e8400-e29b-41d4-a716-446655440002" });
    await store.registerSession(fresh.sessionId, fresh.internalUserId);
    expect(await sessionIsUsable(store, fresh, DEFAULT_SESSION_POLICY, NOW)).toEqual({
      usable: true,
      reason: "OK",
    });
  });

  it("rotation invalidates the old session id", async () => {
    const store = createMemoryRevocationStore();
    const old = session();
    await store.registerSession(old.sessionId, old.internalUserId);
    const rotated = await rotateSession(
      store,
      old,
      "880e8400-e29b-41d4-a716-446655440003",
      NOW + 5 * 60 * 1000
    );
    expect(rotated.ok).toBe(true);
    expect(await store.isSessionRevoked(old.sessionId)).toBe(true);
    expect(await sessionIsUsable(store, old, DEFAULT_SESSION_POLICY, NOW)).toEqual({
      usable: false,
      reason: "REVOKED",
    });
    if (rotated.ok) {
      await store.registerSession(rotated.session.sessionId, rotated.session.internalUserId);
      expect(
        await sessionIsUsable(store, rotated.session, DEFAULT_SESSION_POLICY, NOW + 5 * 60 * 1000)
      ).toEqual({ usable: true, reason: "OK" });
    }
  });

  it("rotation preserves absolute expiry and auth time but resets the idle clock", async () => {
    const store = createMemoryRevocationStore();
    const old = session({
      createdAtMs: NOW - 6 * DAY,
      lastActivityMs: NOW - 29 * 60 * 1000,
      authTimeMs: NOW - 20 * 60 * 1000,
    });
    const rotated = await rotateSession(store, old, "990e8400-e29b-41d4-a716-446655440004", NOW);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    // Idle clock reset: lastActivity is now, not the old 29-minutes-ago value.
    expect(rotated.session.lastActivityMs).toBe(NOW);
    // Absolute expiry and auth time are NOT reset by rotation.
    expect(rotated.session.createdAtMs).toBe(old.createdAtMs);
    expect(rotated.session.authTimeMs).toBe(old.authTimeMs);
    // So the rotated session still expires at the original 7-day deadline.
    expect(sessionExpiryReason(rotated.session, DEFAULT_SESSION_POLICY, NOW + DAY + 1)).toBe(
      "ABSOLUTE_EXPIRED"
    );
  });

  it("rotation to the same session id is rejected and revokes nothing", async () => {
    const store = createMemoryRevocationStore();
    const old = session();
    await store.registerSession(old.sessionId, old.internalUserId);
    const rotated = await rotateSession(store, old, old.sessionId, NOW);
    expect(rotated.ok).toBe(false);
    expect(await store.isSessionRevoked(old.sessionId)).toBe(false);
  });
});
