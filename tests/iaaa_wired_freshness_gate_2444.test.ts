/**
 * Issue #2444 — wired session freshness gate (DO request meter).
 *
 * Tests written FIRST (TDD): this file must fail on the missing gate
 * before the implementation lands. Coverage:
 * - Fresh-within-window cached copy → served WITHOUT a freshRead.
 * - Stale copy → freshRead + touch exactly as today.
 * - Window boundary (elapsed == window) → stale, freshRead happens.
 * - Window 0 → gating disabled, freshRead always happens.
 * - No fetchedAt → gate inactive, behavior unchanged.
 * - Revoked session within window → still served until the window
 *   elapses (the SECURITY TRADE-OFF, pinned by test, not hidden:
 *   revocation/step-up propagation is delayed up to the window —
 *   CISO domain, #945 open item).
 * - Local validation failure on a fresh copy → falls through to the
 *   authoritative fresh-read path (expiry is NOT delayed by the gate;
 *   only revocation/step-up, which are invisible in cached fields).
 * - Window resolution from env: default 30s when unset, well-formed
 *   non-negative integers win (0 = disabled), anything else falls
 *   back to the default.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SessionData } from "../src/types";
import {
  DEFAULT_WIRED_FRESHNESS_MS,
  resolveWiredFreshnessMs,
  validateAndTouchWiredSession,
  type WiredSessionStoreDeps,
} from "../src/security/iaaaEnforcement";
import {
  __resetSessionCache,
  getSessionCached,
  getSessionCachedFetchedAt,
  invalidateSessionCache,
} from "../src/security/sessionCache";

const NOW_MS = 1_060_000;
const WINDOW_MS = 30_000;
const IDLE_TIMEOUT_MS = 1_800_000;

function wiredSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    githubLogin: "octo",
    githubAvatar: "",
    githubName: "Octo",
    createdAt: 1_000_000,
    internalUserId: "user-1",
    providerIssuer: "https://github.com",
    providerSubject: "42",
    authTimeMs: 1_000_000,
    sessionVersion: 1,
    lastActivityMs: 1_000_000,
    ...overrides,
  };
}

function depsFor(store: {
  fresh: SessionData | null;
  persistOk?: boolean;
}): WiredSessionStoreDeps & {
  freshReads: number;
  persists: number;
  invalidates: string[];
} {
  const deps = {
    freshReads: 0,
    persists: 0,
    invalidates: [] as string[],
    async freshRead() {
      deps.freshReads += 1;
      return store.fresh;
    },
    async persist() {
      deps.persists += 1;
      return { ok: store.persistOk ?? true };
    },
    invalidate(sessionId: string) {
      deps.invalidates.push(sessionId);
    },
  };
  return deps;
}

function gateOptions(over: {
  fetchedAtMs?: number;
  freshnessWindowMs?: number;
  idleTimeoutMs?: number;
} = {}) {
  return {
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    fetchedAtMs: NOW_MS - 10_000,
    freshnessWindowMs: WINDOW_MS,
    ...over,
  };
}

describe("validateAndTouchWiredSession freshness gate (#2444)", () => {
  it("fresh within window → no freshRead, cached session served", async () => {
    const cached = wiredSession();
    const fresh = wiredSession({ lastActivityMs: 999_000 });
    const deps = depsFor({ fresh });
    const result = await validateAndTouchWiredSession(
      deps,
      cached,
      "sess-1",
      NOW_MS,
      gateOptions(),
    );
    expect(deps.freshReads).toBe(0);
    expect(deps.persists).toBe(0);
    expect(deps.invalidates).toEqual([]);
    expect(result).toEqual({ wired: true, session: cached });
  });

  it("stale copy → freshRead + touch exactly as today", async () => {
    const cached = wiredSession();
    const fresh = wiredSession();
    const deps = depsFor({ fresh });
    const result = await validateAndTouchWiredSession(
      deps,
      cached,
      "sess-1",
      NOW_MS,
      gateOptions({ fetchedAtMs: NOW_MS - 60_000 }),
    );
    expect(deps.freshReads).toBe(1);
    expect(deps.persists).toBe(1);
    expect(result.wired).toBe(true);
    if (result.wired && result.session) {
      expect(result.session.lastActivityMs).toBe(NOW_MS);
    } else {
      throw new Error("expected a served session from the stale path");
    }
  });

  it("boundary: elapsed exactly the window → stale, freshRead happens", async () => {
    const deps = depsFor({ fresh: wiredSession() });
    const result = await validateAndTouchWiredSession(
      deps,
      wiredSession(),
      "sess-1",
      NOW_MS,
      gateOptions({ fetchedAtMs: NOW_MS - WINDOW_MS }),
    );
    expect(deps.freshReads).toBe(1);
    expect(result.wired).toBe(true);
  });

  it("window 0 disables gating: fresh copy still freshReads", async () => {
    const deps = depsFor({ fresh: wiredSession() });
    await validateAndTouchWiredSession(
      deps,
      wiredSession(),
      "sess-1",
      NOW_MS,
      gateOptions({ freshnessWindowMs: 0 }),
    );
    expect(deps.freshReads).toBe(1);
  });

  it("no fetchedAt → gate inactive, behavior unchanged", async () => {
    const deps = depsFor({ fresh: wiredSession() });
    const { fetchedAtMs: _dropped, ...options } = gateOptions();
    void _dropped;
    await validateAndTouchWiredSession(
      deps,
      wiredSession(),
      "sess-1",
      NOW_MS,
      options,
    );
    expect(deps.freshReads).toBe(1);
  });

  it("SECURITY TRADE-OFF: revoked session within window is still served until the window elapses", async () => {
    // The store record is gone (revoked/deleted after the fetch), but
    // the gate never consults the store within the window — so the
    // cached copy is served. Revocation propagation is delayed up to
    // the window. This is the CISO-domain trade-off (#945), pinned
    // here so it can never be hidden by a refactor.
    const cached = wiredSession();
    const deps = depsFor({ fresh: null });
    const result = await validateAndTouchWiredSession(
      deps,
      cached,
      "sess-1",
      NOW_MS,
      gateOptions(),
    );
    expect(deps.freshReads).toBe(0);
    expect(deps.invalidates).toEqual([]);
    expect(result).toEqual({ wired: true, session: cached });
  });

  it("local validation failure on a fresh copy falls through to the fresh-read path", async () => {
    // Cached copy idle-expired locally (60s idle window, last activity
    // 60s ago), but fetched within the window: expiry must NOT be
    // delayed by the gate. The fresh path runs; the authoritative
    // record (touched in another isolate 30s ago) passes and is
    // served. This is the case the gate must never mask: a stale
    // cached copy cannot rescue — or condemn — a session.
    const cached = wiredSession();
    const fresh = wiredSession({ lastActivityMs: 1_030_000 });
    const deps = depsFor({ fresh });
    const result = await validateAndTouchWiredSession(
      deps,
      cached,
      "sess-1",
      NOW_MS,
      gateOptions({ idleTimeoutMs: 60_000 }),
    );
    expect(deps.freshReads).toBe(1);
    expect(result.wired).toBe(true);
    if (result.wired && result.session) {
      expect(result.session.lastActivityMs).toBe(1_030_000);
    } else {
      throw new Error("expected a served session from the fall-through path");
    }
  });
});

describe("resolveWiredFreshnessMs (#2444)", () => {
  it("default is 30s", () => {
    expect(DEFAULT_WIRED_FRESHNESS_MS).toBe(30_000);
  });

  it("unset → default", () => {
    expect(resolveWiredFreshnessMs(undefined)).toBe(30_000);
    expect(resolveWiredFreshnessMs(null)).toBe(30_000);
    expect(resolveWiredFreshnessMs("")).toBe(30_000);
    expect(resolveWiredFreshnessMs("   ")).toBe(30_000);
  });

  it("well-formed non-negative integers win", () => {
    expect(resolveWiredFreshnessMs("5000")).toBe(5000);
    expect(resolveWiredFreshnessMs(5000)).toBe(5000);
    expect(resolveWiredFreshnessMs("120000")).toBe(120_000);
  });

  it("0 disables gating", () => {
    expect(resolveWiredFreshnessMs("0")).toBe(0);
    expect(resolveWiredFreshnessMs(0)).toBe(0);
  });

  it("invalid values fall back to the default", () => {
    expect(resolveWiredFreshnessMs("abc")).toBe(30_000);
    expect(resolveWiredFreshnessMs("-5")).toBe(30_000);
    expect(resolveWiredFreshnessMs(Number.NaN)).toBe(30_000);
  });
});

/**
 * The gate's fetchedAt source: the isolate cache records when each entry
 * was fetched. The store behind the cache is mocked (same pattern as
 * tests/session_read_cache.test.ts) so the accessor is exercised without
 * a live SessionStore. importOriginal keeps the session module's other
 * exports (SESSION_TTL and friends, needed by iaaaLogin) intact.
 */
vi.mock("../src/security/session", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/security/session")>();
  return {
    ...actual,
    getSession: async (_env: unknown, sessionId: string) => {
      const raw = cacheProbe.store.get(sessionId) ?? null;
      return raw ? (JSON.parse(raw) as SessionData) : null;
    },
  };
});

const cacheProbe = { store: new Map<string, string>() };

describe("getSessionCachedFetchedAt (#2444)", () => {
  beforeEach(() => {
    __resetSessionCache();
    cacheProbe.store.clear();
  });

  afterEach(() => {
    __resetSessionCache();
    cacheProbe.store.clear();
  });

  it("returns the fetch time of the live cache entry", async () => {
    const session = wiredSession();
    cacheProbe.store.set("sess-cache-1", JSON.stringify(session));
    const before = Date.now();
    const found = await getSessionCached({} as never, "sess-cache-1");
    const after = Date.now();
    expect(found).toEqual(session);
    const fetchedAt = getSessionCachedFetchedAt("sess-cache-1");
    expect(typeof fetchedAt).toBe("number");
    expect(fetchedAt as number).toBeGreaterThanOrEqual(before);
    expect(fetchedAt as number).toBeLessThanOrEqual(after);
  });

  it("returns null with no live entry, and after reset/invalidate", async () => {
    expect(getSessionCachedFetchedAt("sess-absent")).toBeNull();
    const session = wiredSession();
    cacheProbe.store.set("sess-cache-2", JSON.stringify(session));
    await getSessionCached({} as never, "sess-cache-2");
    expect(getSessionCachedFetchedAt("sess-cache-2")).not.toBeNull();
    invalidateSessionCache("sess-cache-2");
    expect(getSessionCachedFetchedAt("sess-cache-2")).toBeNull();
    await getSessionCached({} as never, "sess-cache-2");
    expect(getSessionCachedFetchedAt("sess-cache-2")).not.toBeNull();
    __resetSessionCache();
    expect(getSessionCachedFetchedAt("sess-cache-2")).toBeNull();
  });
});
