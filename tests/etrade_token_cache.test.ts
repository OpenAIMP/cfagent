import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getValidTokens, revokeStoredTokens, storeAccessTokens } from "../src/security/etradeOAuth";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import type { Env } from "../src/types";

/**
 * Issue #329 follow-up — the E*TRADE credential cache exists because
 * `getValidTokens` runs from every auth-header builder, i.e. once per E*TRADE
 * request, and an options scan over 25 underlyings paid that KV `get()` dozens
 * of times. These tests pin the properties the auth path depends on: repeats
 * are served without KV, the TTL expires, and every write path (store, revoke)
 * invalidates so a renewed or revoked value is never served stale.
 *
 * Fixture values are generated per run rather than written as literals: the
 * repository's write guard (correctly) refuses credential-shaped literals, and
 * these fakes carry no meaning beyond "value A" and "value B".
 */
const USER = "trader-cache-329";

const fixtureValue = (label: string) => `fixture-${label}-${crypto.randomUUID()}`;

function makeEnv() {
  const store = new Map<string, string>();
  let getCalls = 0;

  const kv = {
    get: async (key: string) => {
      getCalls += 1;
      return store.get(key) ?? null;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };

  // Signing credentials are irrelevant to the read path under test, so the
  // environment config's own defaults apply here.
  const env = {
    APP_ENV: "TEST",
    ETRADE_KV: kv,
    SESSIONS: kv,
  } as unknown as Env;

  return { env, countGets: () => getCalls };
}

describe("E*TRADE credential read cache (#329)", () => {
  beforeEach(() => {
    __resetTokenCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetTokenCache();
  });

  it("serves repeated reads from the cache instead of KV", async () => {
    const { env, countGets } = makeEnv();
    const access = fixtureValue("first-access");
    const secret = fixtureValue("first-secret");
    await storeAccessTokens(env, USER, access, secret);
    __resetTokenCache(); // measure only the read path

    const first = await getValidTokens(env, USER);
    const second = await getValidTokens(env, USER);
    const third = await getValidTokens(env, USER);

    expect(first?.accessToken).toBe(access);
    expect(second?.accessToken).toBe(access);
    expect(third?.accessToken).toBe(access);
    // The whole point: three requests, one KV read.
    expect(countGets()).toBe(1);
  });

  it("refetches from KV once the TTL lapses", async () => {
    const { env, countGets } = makeEnv();
    await storeAccessTokens(env, USER, fixtureValue("ttl-access"), fixtureValue("ttl-secret"));
    __resetTokenCache();

    await getValidTokens(env, USER);
    expect(countGets()).toBe(1);

    vi.advanceTimersByTime(61_000);
    await getValidTokens(env, USER);
    expect(countGets()).toBe(2);
  });

  it("caches a miss briefly, then trusts KV again", async () => {
    const { env, countGets } = makeEnv();

    expect(await getValidTokens(env, USER)).toBeNull();
    expect(await getValidTokens(env, USER)).toBeNull();
    // A miss costs two reads (scoped key, then the legacy fallback) and is
    // then cached: the second call adds nothing.
    expect(countGets()).toBe(2);

    // Past the negative TTL, the next lookup goes back to KV rather than
    // pinning "no credentials" for the life of the isolate.
    vi.advanceTimersByTime(11_000);
    expect(await getValidTokens(env, USER)).toBeNull();
    expect(countGets()).toBe(4);
  });

  it("serves a renewed credential immediately after storeAccessTokens", async () => {
    const { env, countGets } = makeEnv();
    const oldAccess = fixtureValue("old-access");
    const newAccess = fixtureValue("new-access");
    await storeAccessTokens(env, USER, oldAccess, fixtureValue("old-secret"));
    __resetTokenCache();

    expect((await getValidTokens(env, USER))?.accessToken).toBe(oldAccess);

    // Renewal path: store + invalidate, so the cached copy cannot shadow it.
    await storeAccessTokens(env, USER, newAccess, fixtureValue("new-secret"));

    expect((await getValidTokens(env, USER))?.accessToken).toBe(newAccess);
    expect(countGets()).toBe(2);
  });

  it("stops serving a revoked credential from the cache", async () => {
    const { env, countGets } = makeEnv();
    const access = fixtureValue("revoked-access");
    await storeAccessTokens(env, USER, access, fixtureValue("revoked-secret"));
    __resetTokenCache();
    expect((await getValidTokens(env, USER))?.accessToken).toBe(access);

    await revokeStoredTokens(env, USER);

    expect(await getValidTokens(env, USER)).toBeNull();
    // Revocation cleared the cache, so this lookup pays the miss path again
    // (scoped + legacy) instead of serving the revoked value.
    expect(countGets()).toBe(3);
  });

  it("keeps environments apart", async () => {
    const { env, countGets } = makeEnv();
    const access = fixtureValue("scoped-access");
    await storeAccessTokens(env, USER, access, fixtureValue("scoped-secret"), "TEST");
    __resetTokenCache();

    const test = await getValidTokens(env, USER, "TEST");
    const prod = await getValidTokens(env, USER, "PROD");

    expect(test?.accessToken).toBe(access);
    // PROD has no credential of its own: the TEST copy must not leak across.
    expect(prod).toBeNull();
    expect(countGets()).toBeGreaterThanOrEqual(2);
  });
});
