import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getSessionCached,
  invalidateSessionCache,
  __resetSessionCache,
} from "../src/security/sessionCache";
import type { SessionData } from "../src/types";

/**
 * Issue #329 — the session read cache exists to stop every `/api/*` request
 * from spending one backing-store read. These tests pin the three properties
 * the auth path depends on: it serves repeats without touching the store, it
 * expires, and an explicit invalidation is honoured immediately.
 *
 * #604: the backing store moved from KV to the SessionStore DO, so the probe
 * now sits behind `getSession` (the boundary the cache actually fronts)
 * instead of `env.SESSIONS`.
 */
const SESSION_ID = "test-session-329";

const SESSION: SessionData = {
  githubLogin: "octocat-329",
  githubAvatar: "https://avatars.example/u/329",
  githubName: "Octo Cat",
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

function makeEnv(): { env: Record<string, unknown>; probe: StoreProbe } {
  probe.getCalls = 0;
  probe.store.clear();
  return { env: {}, probe };
}

describe("session read cache (#329)", () => {
  beforeEach(() => {
    __resetSessionCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetSessionCache();
  });

  it("serves repeated reads from the cache instead of KV", async () => {
    const { env, probe } = makeEnv();
    probe.store.set(SESSION_ID, JSON.stringify(SESSION));

    const first = await getSessionCached(env, SESSION_ID);
    const second = await getSessionCached(env, SESSION_ID);

    expect(first).toEqual(SESSION);
    expect(second).toEqual(SESSION);
    // The whole point: two requests, one backing-store read.
    expect(probe.getCalls).toBe(1);
  });

  it("refetches from the store once the TTL lapses", async () => {
    const { env, probe } = makeEnv();
    probe.store.set(SESSION_ID, JSON.stringify(SESSION));

    await getSessionCached(env, SESSION_ID);
    expect(probe.getCalls).toBe(1);

    // #411: the positive TTL is 60s — at 45s the entry is still served
    // from the cache (under the old 30s TTL this read hit the store).
    vi.advanceTimersByTime(45_000);
    await getSessionCached(env, SESSION_ID);
    expect(probe.getCalls).toBe(1);

    vi.advanceTimersByTime(16_000);
    await getSessionCached(env, SESSION_ID);
    expect(probe.getCalls).toBe(2);
  });

  it("holds 2000 entries before evicting the oldest (#411 cap)", async () => {
    const { env, probe } = makeEnv();
    for (let i = 0; i < 2000; i++) {
      probe.store.set(`s-${i}`, JSON.stringify(SESSION));
      await getSessionCached(env as any, `s-${i}`);
    }
    expect(probe.getCalls).toBe(2000);

    // The first entry survives at exactly the cap.
    await getSessionCached(env as any, "s-0");
    expect(probe.getCalls).toBe(2000);

    // One more distinct session evicts the oldest entry only.
    probe.store.set("s-2000", JSON.stringify(SESSION));
    await getSessionCached(env as any, "s-2000");
    expect(probe.getCalls).toBe(2001);
    await getSessionCached(env as any, "s-0");
    expect(probe.getCalls).toBe(2002);
    await getSessionCached(env as any, "s-2000");
    expect(probe.getCalls).toBe(2002);
  });

  it("caches a miss briefly, then trusts the store again", async () => {
    const { env, probe } = makeEnv();

    expect(await getSessionCached(env, SESSION_ID)).toBeNull();
    expect(await getSessionCached(env, SESSION_ID)).toBeNull();
    expect(probe.getCalls).toBe(1);

    // A short negative TTL means a session created moments later is not pinned.
    vi.advanceTimersByTime(11_000);
    probe.store.set(SESSION_ID, JSON.stringify(SESSION));
    expect(await getSessionCached(env, SESSION_ID)).toEqual(SESSION);
    expect(probe.getCalls).toBe(2);
  });

  it("honours an explicit invalidation immediately", async () => {
    const { env, probe } = makeEnv();
    probe.store.set(SESSION_ID, JSON.stringify(SESSION));

    await getSessionCached(env, SESSION_ID);
    invalidateSessionCache(SESSION_ID);
    probe.store.delete(SESSION_ID);

    // Logout path: the stale copy must not keep the session alive.
    expect(await getSessionCached(env, SESSION_ID)).toBeNull();
    expect(probe.getCalls).toBe(2);
  });

  it("keeps distinct sessions in distinct entries", async () => {
    const { env, probe } = makeEnv();
    const other: SessionData = { ...SESSION, githubLogin: "second-user" };
    probe.store.set(SESSION_ID, JSON.stringify(SESSION));
    probe.store.set("other-session", JSON.stringify(other));

    expect(await getSessionCached(env, SESSION_ID)).toEqual(SESSION);
    expect(await getSessionCached(env, "other-session")).toEqual(other);
    expect(probe.getCalls).toBe(2);
  });
});
