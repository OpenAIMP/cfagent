/**
 * #1750 (parent #1717, IAAA-2): the 60-second isolate-cache
 * interaction for session revocation, proved rather than assumed.
 *
 * The session gate (requireAuth) reads through getSessionCached,
 * which serves a per-isolate copy for up to SESSION_CACHE_POSITIVE_TTL_MS
 * (60 s). That cache is what bounds cross-isolate session-revocation
 * propagation — and what makes the session target two-tiered:
 *
 * - Same isolate as the revoking write: 0 ms. The logout path
 *   (handleLogout) invalidates the isolate cache BEFORE deleting
 *   the store record, so the next read in that isolate misses and
 *   re-reads the (now absent) record.
 * - Any other isolate: within SESSION_CACHE_POSITIVE_TTL_MS of the
 *   revoking write. An isolate that never hears about the delete
 *   keeps serving its stale copy until the TTL lapses — no longer:
 *   at TTL + 0 the entry expires on read and the gate re-reads
 *   the store, which says the session is gone.
 *
 * This file proves both tiers with fake timers against the real
 * cache module (the store behind getSession is a probe, exactly as
 * in tests/session_read_cache.test.ts #329). The stale-serve
 * assertion in the middle is deliberate: it documents the window
 * honestly instead of pretending cross-isolate revocation is
 * instant. A wired session is NOT subject to this window at all —
 * the wired validation path fresh-reads (proved in
 * iaaa_revocation_targets_1750.test.ts) — so the 60 s bound is the
 * legacy / cross-isolate bound, and the session target in
 * revocationTargets.ts states it as the worst case.
 *
 * Written FIRST (TDD Red): the SESSION_CACHE_POSITIVE_TTL_MS
 * export and the revocationTargets session entry do not exist on
 * the pre-change tree, so this file fails to import there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  REVOCATION_TARGET_BY_TRIGGER,
  SESSION_REVOCATION_SAME_ISOLATE_BOUND_MS,
} from "../src/security/revocationTargets";
import {
  getSessionCached,
  invalidateSessionCache,
  SESSION_CACHE_POSITIVE_TTL_MS,
  __resetSessionCache,
} from "../src/security/sessionCache";
import type { SessionData } from "../src/types";

const SESSION_ID = "17500000-0000-4000-8000-000000001750";

const SESSION: SessionData = {
  githubLogin: "octo-1750",
  githubAvatar: "https://avatars.example/u/1750",
  githubName: "Octo 1750",
  createdAt: 1_760_000_000_000,
};

interface StoreProbe {
  getCalls: number;
  store: Map<string, string>;
}

const probe: StoreProbe = { getCalls: 0, store: new Map() };

vi.mock("../src/security/session", () => ({
  getSession: async (_env: unknown, sessionId: string) => {
    probe.getCalls += 1;
    const raw = probe.store.get(sessionId) ?? null;
    return raw ? (JSON.parse(raw) as SessionData) : null;
  },
}));

function makeEnv(): Record<string, unknown> {
  probe.getCalls = 0;
  probe.store.clear();
  return {};
}

describe("session-revocation cache interaction (#1750)", () => {
  beforeEach(() => {
    __resetSessionCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetSessionCache();
  });

  it("target table: session bound equals the cache TTL; same-isolate bound is 0", () => {
    expect(REVOCATION_TARGET_BY_TRIGGER["session-revocation"].boundMs).toBe(
      SESSION_CACHE_POSITIVE_TTL_MS,
    );
    expect(SESSION_CACHE_POSITIVE_TTL_MS).toBe(60_000);
    expect(SESSION_REVOCATION_SAME_ISOLATE_BOUND_MS).toBe(0);
  });

  it("same isolate: invalidation + delete denies on the very next read", async () => {
    const env = makeEnv();
    probe.store.set(SESSION_ID, JSON.stringify(SESSION));

    expect(await getSessionCached(env, SESSION_ID)).toEqual(SESSION);
    expect(probe.getCalls).toBe(1);

    // The logout path: invalidate first, then delete the record.
    invalidateSessionCache(SESSION_ID);
    probe.store.delete(SESSION_ID);

    expect(await getSessionCached(env, SESSION_ID)).toBeNull();
    expect(probe.getCalls).toBe(2);
  });

  it("other isolate: a delete the isolate never hears about is bounded by exactly the TTL", async () => {
    const env = makeEnv();
    probe.store.set(SESSION_ID, JSON.stringify(SESSION));

    expect(await getSessionCached(env, SESSION_ID)).toEqual(SESSION);
    expect(probe.getCalls).toBe(1);

    // Another isolate deletes the record; THIS isolate's cache is
    // not invalidated — the cross-isolate case.
    probe.store.delete(SESSION_ID);

    // Honest window: the stale copy is still served inside the TTL.
    vi.advanceTimersByTime(SESSION_CACHE_POSITIVE_TTL_MS - 1);
    expect(await getSessionCached(env, SESSION_ID)).toEqual(SESSION);
    expect(probe.getCalls).toBe(1);

    // At exactly the TTL the entry expires on read and the gate
    // re-reads the store, which says the session is gone.
    vi.advanceTimersByTime(1);
    expect(await getSessionCached(env, SESSION_ID)).toBeNull();
    expect(probe.getCalls).toBe(2);
  });
});
