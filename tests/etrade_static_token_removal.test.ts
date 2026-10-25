/**
 * #1185 Phase B — the static-token exception is deleted (#1066).
 *
 * Pins:
 *  - getValidTokens returns null when no stored per-user token exists,
 *    even when ETRADE_OAUTH_TOKEN / ETRADE_OAUTH_TOKEN_SECRET are set in
 *    the environment — the vars are unread, for the legacy identity and
 *    for any other login alike.
 *  - An expired stored token resolves to null, never to an env pair.
 *  - getETradeAuthStatus reports authenticated: false in the same setup
 *    (it previously reported true for the legacy identity whenever the
 *    env pair existed).
 *  - A valid stored per-user token is still served exactly as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getValidTokens,
  getETradeAuthStatus,
  storeAccessTokens,
} from "../src/security/etradeOAuth";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import type { Env } from "../src/types";

/** Same SessionStore fake protocol as tests/etrade_oauth.test.ts (#604). */
function makeSessionStore() {
  const store = new Map<string, string>();
  return {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: async (req: Request) => {
        const body = (await req.json()) as { op: string; key: string; value?: string };
        if (body.op === "get") return Response.json({ value: store.get(body.key) ?? null });
        if (body.op === "put") {
          store.set(body.key, body.value ?? "");
          return Response.json({ ok: true });
        }
        if (body.op === "delete") {
          store.delete(body.key);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unknown op" }, { status: 400 });
      },
    }),
  };
}

const LEGACY_IDENTITY = "default_trader";

function envWithStaticPair(): Env {
  return {
    APP_ENV: "TEST",
    ET_API_KEY: "sandbox_consumer_key_123",
    ET_API_SECRET: "sandbox_consumer_secret_456",
    ETRADE_OAUTH_TOKEN: "static_tok",
    ETRADE_OAUTH_TOKEN_SECRET: "static_secret",
    SESSION_STORE: makeSessionStore() as any,
  } as Env;
}

describe("static-token exception removal (#1185 Phase B)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetTokenCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null with no stored token even when the env pair is set (legacy identity)", async () => {
    const env = envWithStaticPair();
    expect(await getValidTokens(env, LEGACY_IDENTITY)).toBeNull();
  });

  it("returns null with no stored token even when the env pair is set (any login)", async () => {
    const env = envWithStaticPair();
    expect(await getValidTokens(env, "trader_alice")).toBeNull();
  });

  it("reports authenticated: false with no stored token even when the env pair is set", async () => {
    const env = envWithStaticPair();
    const status = await getETradeAuthStatus(env, LEGACY_IDENTITY);
    expect(status.authenticated).toBe(false);
  });

  it("resolves an expired stored token to null, never to the env pair", async () => {
    const env = envWithStaticPair();
    await storeAccessTokens(env, "trader_bob", "tok_old", "sec_old");
    __resetTokenCache();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 48 * 3600 * 1000);
    expect(await getValidTokens(env, "trader_bob")).toBeNull();
  });

  it("still serves a valid stored per-user token", async () => {
    const env = envWithStaticPair();
    await storeAccessTokens(env, "trader_alice", "tok_live", "sec_live");
    const tokens = await getValidTokens(env, "trader_alice");
    expect(tokens?.accessToken).toBe("tok_live");
    expect(tokens?.accessTokenSecret).toBe("sec_live");
  });
});
