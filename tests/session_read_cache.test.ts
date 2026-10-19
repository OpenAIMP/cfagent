import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getSessionCached,
  invalidateSessionCache,
  __resetSessionCache,
} from "../src/security/sessionCache";
import type { Env, SessionData } from "../src/types";

/**
 * Issue #329 — the session read cache exists to stop every `/api/*` request
 * from spending one Workers KV read. These tests pin the three properties the
 * auth path depends on: it serves repeats without touching KV, it expires, and
 * an explicit invalidation is honoured immediately.
 */
const SESSION_ID = "test-session-329";

const SESSION: SessionData = {
  githubLogin: "octocat-329",
  githubAvatar: "https://avatars.example/u/329",
  githubName: "Octo Cat",
  createdAt: 1_760_000_000_000,
};

interface KvProbe {
  getCalls: number;
  store: Map<string, string>;
}

function makeEnv(): { env: Env; probe: KvProbe } {
  const probe: KvProbe = { getCalls: 0, store: new Map() };
  const env = {
    SESSIONS: {
      get: async (key: string) => {
        probe.getCalls += 1;
        return probe.store.get(key) ?? null;
      },
      put: async (key: string, value: string) => {
        probe.store.set(key, value);
      },
      delete: async (key: string) => {
        probe.store.delete(key);
      },
    },
  } as unknown as Env;
  return { env, probe };
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
    // The whole point: two requests, one KV read.
    expect(probe.getCalls).toBe(1);
  });

  it("refetches from KV once the TTL lapses", async () => {
    const { env, probe } = makeEnv();
    probe.store.set(SESSION_ID, JSON.stringify(SESSION));

    await getSessionCached(env, SESSION_ID);
    expect(probe.getCalls).toBe(1);

    vi.advanceTimersByTime(31_000);
    await getSessionCached(env, SESSION_ID);
    expect(probe.getCalls).toBe(2);
  });

  it("caches a miss briefly, then trusts KV again", async () => {
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
