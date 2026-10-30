/**
 * #945 Wiring Phase 2a — idle enforcement, touch, step-up helper, auth audit.
 *
 * TDD red file: these tests were written before the implementation.
 * Coverage:
 * - getValidatedSession idle expiry (default 30 min, caller-overridable),
 *   with legacy sessions (no lastActivityMs) still validating — the
 *   Phase 1 contract is preserved, not silently tightened.
 * - touchSession's >= 300s rule (documented ±300s precision; #2470 S2).
 * - updateSessionWithStore persisting under the SAME id with TTL =
 *   remaining absolute time, never extending absolute expiry.
 * - Auth audit event builders + best-effort recording (Slice 5).
 * - sessionRequiresStepUp wrapping Slice 2 requiresStepUp (helper only,
 *   no route wiring in this phase).
 *
 * Deliberately NOT covered here (documented gaps, see module headers):
 * - The wired callback's end-to-end audit recording: the callback's
 *   upstream GitHub HTTP calls have no seam (same limitation Phase 1
 *   documents), so recording is covered at the helper level.
 * - server.ts requireAuth wiring: Phase 2a adds helpers only; no
 *   live route changes.
 * - The logout hook: logout lives in githubOAuth.ts, not iaaaLogin.ts,
 *   so only the logout event builder is covered here.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryAuditStore,
  verifyChain,
  type AuditStore,
} from "../src/security/iaaaAudit";
import {
  buildLoginFailureAuditEventInput,
  buildLoginSuccessAuditEventInput,
  buildLogoutAuditEventInput,
  recordWiredAuthAudit,
} from "../src/security/iaaaAuthAudit";
import {
  buildExtendedSessionData,
  getValidatedSession,
} from "../src/security/iaaaLogin";
import {
  IAAA_TOUCH_MIN_INTERVAL_MS,
  sessionRequiresStepUp,
  touchSession,
} from "../src/security/iaaaSessionActivity";
import { SESSION_TTL, updateSessionWithStore } from "../src/security/session";
import { DEFAULT_IDLE_TIMEOUT_MS } from "../src/security/sessionPolicy";
import type { SessionData } from "../src/types";

const NOW = 10_000_000;

function baseSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    githubLogin: "octocat",
    githubAvatar: "https://example/avatar",
    githubName: "Octocat",
    createdAt: 1_000_000,
    ...overrides,
  };
}

function memoryKv(): {
  get: (k: string) => Promise<string | null>;
  put: (k: string, v: string, o?: { expirationTtl?: number }) => Promise<void>;
  delete: (k: string) => Promise<void>;
  puts: Array<{ key: string; value: string; ttl: number | undefined }>;
} {
  const map = new Map<string, string>();
  const puts: Array<{ key: string; value: string; ttl: number | undefined }> = [];
  return {
    puts,
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      map.set(key, value);
      puts.push({ key, value, ttl: options?.expirationTtl });
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// getValidatedSession idle enforcement
// ---------------------------------------------------------------------------

describe("getValidatedSession idle enforcement (Phase 2a)", () => {
  it("validates a session active within the default 30-minute idle timeout", () => {
    const session = baseSession({ lastActivityMs: NOW - DEFAULT_IDLE_TIMEOUT_MS + 1 });
    expect(getValidatedSession(session, NOW).ok).toBe(true);
  });

  it("rejects a session idle exactly at the default timeout (deadline is exclusive)", () => {
    const session = baseSession({ lastActivityMs: NOW - DEFAULT_IDLE_TIMEOUT_MS });
    const result = getValidatedSession(session, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SESSION_IDLE_EXPIRED");
  });

  it("rejects a session idle past the default timeout", () => {
    const session = baseSession({ lastActivityMs: NOW - DEFAULT_IDLE_TIMEOUT_MS - 60_000 });
    const result = getValidatedSession(session, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SESSION_IDLE_EXPIRED");
  });

  it("honours a caller-overridable idle timeout", () => {
    const session = baseSession({ lastActivityMs: NOW - 5 * 60_000 });
    // 5 minutes idle: expired under a 5-minute timeout, live under the default.
    const short = getValidatedSession(session, NOW, { idleTimeoutMs: 5 * 60_000 });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.code).toBe("SESSION_IDLE_EXPIRED");
    expect(getValidatedSession(session, NOW).ok).toBe(true);
  });

  it("does NOT idle-reject legacy sessions without lastActivityMs (Phase 1 contract preserved)", () => {
    const session = baseSession();
    expect(session.lastActivityMs).toBeUndefined();
    expect(getValidatedSession(session, NOW).ok).toBe(true);
  });

  it("absolute expiry still takes precedence over idle expiry", () => {
    const session = baseSession({
      createdAt: 1_000_000,
      lastActivityMs: NOW - DEFAULT_IDLE_TIMEOUT_MS - 60_000,
    });
    const result = getValidatedSession(session, 1_000_000 + SESSION_TTL * 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SESSION_EXPIRED");
  });

  it("an invalid idle timeout option falls back to the default", () => {
    const session = baseSession({ lastActivityMs: NOW - DEFAULT_IDLE_TIMEOUT_MS - 1 });
    const result = getValidatedSession(session, NOW, { idleTimeoutMs: Number.NaN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SESSION_IDLE_EXPIRED");
  });
});

describe("buildExtendedSessionData (Phase 2a)", () => {
  it("sets lastActivityMs to the login time alongside authTimeMs", () => {
    const extended = buildExtendedSessionData(
      baseSession(),
      { internalUserId: "user-1", providerIssuer: "https://github.com", providerSubject: "123" },
      2_000_000
    );
    expect(extended.lastActivityMs).toBe(2_000_000);
    expect(extended.authTimeMs).toBe(2_000_000);
  });
});

// ---------------------------------------------------------------------------
// touchSession
// ---------------------------------------------------------------------------

describe("touchSession (Phase 2a, ±300s precision)", () => {
  it("touches a session that has never recorded activity", () => {
    const session = baseSession();
    const result = touchSession(session, NOW);
    expect(result.touched).toBe(true);
    expect(result.session.lastActivityMs).toBe(NOW);
    expect(session.lastActivityMs).toBeUndefined(); // never mutates the input
  });

  it("does not touch a session active less than 300s ago", () => {
    const session = baseSession({ lastActivityMs: NOW - 299_000 });
    const result = touchSession(session, NOW);
    expect(result.touched).toBe(false);
    expect(result.session.lastActivityMs).toBe(NOW - 299_000);
  });

  it("touches a session active exactly one touch interval ago", () => {
    const session = baseSession({ lastActivityMs: NOW - IAAA_TOUCH_MIN_INTERVAL_MS });
    const result = touchSession(session, NOW);
    expect(result.touched).toBe(true);
    expect(result.session.lastActivityMs).toBe(NOW);
  });

  it("touches a session active more than 300s ago and preserves every other field", () => {
    const session = baseSession({ lastActivityMs: NOW - 301_000, internalUserId: "user-1" });
    const result = touchSession(session, NOW);
    expect(result.touched).toBe(true);
    expect(result.session).toEqual({ ...session, lastActivityMs: NOW });
  });

  it("does not touch a session whose last activity is in the future (clock skew)", () => {
    const session = baseSession({ lastActivityMs: NOW + 60_000 });
    const result = touchSession(session, NOW);
    expect(result.touched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateSessionWithStore
// ---------------------------------------------------------------------------

describe("updateSessionWithStore (Phase 2a)", () => {
  it("persists under the SAME session id with TTL = remaining absolute time", async () => {
    const store = memoryKv();
    const data = baseSession({ lastActivityMs: 2_000_000 });
    const result = await updateSessionWithStore(store, "session-1", data, 1_000_500);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // createdAt 1_000_000 + 604_800_000 - 1_000_500 = 604_799_500ms -> 604_799s floored.
    expect(result.remainingTtlSeconds).toBe(604_799);
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0].key).toBe("session-1");
    expect(store.puts[0].ttl).toBe(604_799);
    expect(JSON.parse(store.puts[0].value)).toEqual(data);
  });

  it("refuses to write a session already past absolute expiry", async () => {
    const store = memoryKv();
    const result = await updateSessionWithStore(
      store,
      "session-1",
      baseSession(),
      1_000_000 + SESSION_TTL * 1000
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SESSION_ABSOLUTE_EXPIRED");
    expect(store.puts).toHaveLength(0);
  });

  it("refuses to write a session with an invalid createdAt", async () => {
    const store = memoryKv();
    const result = await updateSessionWithStore(
      store,
      "session-1",
      baseSession({ createdAt: Number.NaN }),
      NOW
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SESSION_INVALID_CREATED_AT");
    expect(store.puts).toHaveLength(0);
  });

  it("refuses to write when less than one second of absolute life remains (TTL 0 is not written)", async () => {
    const store = memoryKv();
    const result = await updateSessionWithStore(
      store,
      "session-1",
      baseSession(),
      1_000_000 + SESSION_TTL * 1000 - 500
    );
    expect(result.ok).toBe(false);
    expect(store.puts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Auth audit builders + recording
// ---------------------------------------------------------------------------

describe("auth audit builders (Phase 2a, Slice 5)", () => {
  it("login success attributes the actor as the internal user id", () => {
    const input = buildLoginSuccessAuditEventInput({
      internalUserId: "user-1",
      tenantId: "tenant-1",
      timestamp: NOW,
      correlationId: "session-1",
    });
    expect(input.actorPrincipalId).toBe("user-1");
    expect(input.initiatingPrincipalId).toBe("user-1");
    expect(input.actorType).toBe("human");
    expect(input.type).toBe("auth.login");
    expect(input.action).toBe("auth.login");
    expect(input.decision).toBe("allow");
    expect(input.outcome).toBe("succeeded");
    expect(input.policyVersion).toBe("iaaa-audit-1");
    expect(input.correlationId).toBe("session-1");
    expect(input.timestamp).toBe(NOW);
  });

  it("login failure for a missing subject id attributes an explicitly unknown actor", () => {
    const input = buildLoginFailureAuditEventInput({
      code: "MISSING_SUBJECT_ID",
      tenantId: "tenant-1",
      timestamp: NOW,
      correlationId: "attempt-1",
    });
    expect(input.actorPrincipalId).toBe("unknown");
    expect(input.initiatingPrincipalId).toBe("unknown");
    expect(input.decision).toBe("deny");
    expect(input.outcome).toBe("failed");
    expect(input.errorCode).toBe("MISSING_SUBJECT_ID");
    expect(input.action).toBe("auth.login");
  });

  it("login failure for a binding failure carries BINDING_FAILED", () => {
    const input = buildLoginFailureAuditEventInput({
      code: "BINDING_FAILED",
      tenantId: "tenant-1",
      timestamp: NOW,
      correlationId: "attempt-2",
    });
    expect(input.decision).toBe("deny");
    expect(input.outcome).toBe("failed");
    expect(input.errorCode).toBe("BINDING_FAILED");
  });

  it("logout attributes the internal user id when known, unknown otherwise", () => {
    const known = buildLogoutAuditEventInput({
      internalUserId: "user-1",
      tenantId: "tenant-1",
      timestamp: NOW,
      correlationId: "session-1",
    });
    expect(known.actorPrincipalId).toBe("user-1");
    expect(known.action).toBe("auth.logout");
    expect(known.decision).toBe("allow");
    expect(known.outcome).toBe("succeeded");

    const unknown = buildLogoutAuditEventInput({
      tenantId: "tenant-1",
      timestamp: NOW,
      correlationId: "session-2",
    });
    expect(unknown.actorPrincipalId).toBe("unknown");
  });

  it("recorded login events chain-verify in a memory store", async () => {
    const store = createMemoryAuditStore();
    const success = await recordWiredAuthAudit(
      store,
      buildLoginSuccessAuditEventInput({
        internalUserId: "user-1",
        tenantId: "tenant-1",
        timestamp: NOW,
        correlationId: "session-1",
      })
    );
    expect(success.ok).toBe(true);
    const failure = await recordWiredAuthAudit(
      store,
      buildLoginFailureAuditEventInput({
        code: "BINDING_FAILED",
        tenantId: "tenant-1",
        timestamp: NOW + 1,
        correlationId: "attempt-2",
      })
    );
    expect(failure.ok).toBe(true);
    const events = await store.list();
    expect(events).toHaveLength(2);
    expect(await verifyChain(events)).toBe(true);
  });

  it("best-effort recording never throws, even when the store fails", async () => {
    const failingStore: AuditStore = {
      async append() {
        throw new Error("store down");
      },
      async list() {
        throw new Error("store down");
      },
    };
    const result = await recordWiredAuthAudit(
      failingStore,
      buildLoginSuccessAuditEventInput({
        internalUserId: "user-1",
        tenantId: "tenant-1",
        timestamp: NOW,
        correlationId: "session-1",
      })
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Step-up helper (helper only — no route wiring in this phase)
// ---------------------------------------------------------------------------

describe("sessionRequiresStepUp (Phase 2a helper only)", () => {
  it("does not require step-up for a freshly authenticated session", () => {
    expect(sessionRequiresStepUp(baseSession({ authTimeMs: NOW }), NOW)).toBe(false);
  });

  it("requires step-up exactly at the default 15-minute freshness boundary", () => {
    const session = baseSession({ authTimeMs: NOW - 15 * 60_000 });
    expect(sessionRequiresStepUp(session, NOW)).toBe(true);
  });

  it("requires step-up for a stale authentication", () => {
    const session = baseSession({ authTimeMs: NOW - 16 * 60_000 });
    expect(sessionRequiresStepUp(session, NOW)).toBe(true);
  });

  it("requires step-up when authTimeMs is missing (legacy sessions are stale, never fresh)", () => {
    expect(sessionRequiresStepUp(baseSession(), NOW)).toBe(true);
  });

  it("requires step-up for an authentication time in the future", () => {
    expect(sessionRequiresStepUp(baseSession({ authTimeMs: NOW + 60_000 }), NOW)).toBe(true);
  });

  it("honours a caller-overridable freshness window", () => {
    const session = baseSession({ authTimeMs: NOW - 10 * 60_000 });
    expect(sessionRequiresStepUp(session, NOW)).toBe(false); // inside default 15 min
    expect(sessionRequiresStepUp(session, NOW, 5 * 60_000)).toBe(true); // past 5 min
  });

  it("an invalid freshness falls back to the default", () => {
    const session = baseSession({ authTimeMs: NOW - 10 * 60_000 });
    expect(sessionRequiresStepUp(session, NOW, Number.NaN)).toBe(false);
    expect(sessionRequiresStepUp(session, NOW, 0)).toBe(false);
  });
});
