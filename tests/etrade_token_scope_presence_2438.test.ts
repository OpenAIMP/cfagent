/**
 * Issue #2438 (ScreenersHub redesign): the provider dashboard must show
 * E*TRADE token presence PER RESOLUTION SCOPE — login-scoped, unscoped,
 * internal-id, alias-login — presence only, never values — so a
 * panel/guard split is visible on the dashboard instead of being
 * discovered via failed runs.
 *
 * These tests pin the server side: getETradeTokenScopePresence reports
 * one boolean per scope, and getETradeAuthStatus carries it as an
 * additive tokenScopes field (existing fields unchanged).
 *
 * Harness mirrors tests/etradeTokenResolution2386.test.ts: the
 * SessionStore fake speaks the store protocol over an in-memory map.
 * This fake additionally exposes the map so a legacy unscoped key can
 * be placed directly (no current writer writes it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getETradeAuthStatus,
  getETradeTokenScopePresence,
  getValidTokens,
  storeAccessTokens,
  revokeStoredTokens,
  type ETradeTokenScopePresence,
} from "../src/services/etradeOAuth";
import { recordLoginAlias } from "../src/security/iaaaMigration";
import { sessionStore } from "../src/security/session";
import type { Env } from "../src/types";
import { __resetTokenCache } from "../src/security/etradeTokenCache";

describe("E*TRADE token scope presence (#2438)", () => {
  let env: Env;
  let store: Map<string, string>;
  const LOGIN = "dhmprstw@gmail.com";
  const OTHER = "nobody@example.com";
  const ALIAS = "old-login";
  const INTERNAL_ID = "v1:0123456789abcdef";
  const PROD = "PROD";

  function makeSessionStore() {
    store = new Map<string, string>();
    return {
      idFromName: (name: string) => name,
      get: (_id: unknown) => ({
        fetch: async (req: Request) => {
          const body = (await req.json()) as {
            op: string;
            key: string;
            value?: string;
            ttl?: number;
          };
          if (body.op === "get") {
            return Response.json({ value: store.get(body.key) ?? null });
          }
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

  beforeEach(() => {
    vi.restoreAllMocks();
    __resetTokenCache();
    env = {
      APP_ENV: "TEST",
      ET_API_KEY: "k",
      ET_API_SECRET: "s",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      SESSION_STORE: makeSessionStore() as any,
    } as Env;
  });

  const allFalse: ETradeTokenScopePresence = {
    loginScoped: false,
    unscoped: false,
    internalId: false,
    aliasLogin: false,
  };

  it("reports only the login-scoped key for a plain connect", async () => {
    await storeAccessTokens(env, LOGIN, "tok", "secret", PROD);
    const scopes = await getETradeTokenScopePresence(env, LOGIN, PROD);
    expect(scopes).toEqual({ ...allFalse, loginScoped: true });
  });

  it("reports only the internal-id key when the login copy was removed", async () => {
    await storeAccessTokens(env, LOGIN, "tok", "secret", PROD, { internalUserId: INTERNAL_ID });
    await revokeStoredTokens(env, LOGIN, PROD);
    expect(await getValidTokens(env, LOGIN, PROD)).toBeNull();
    const scopes = await getETradeTokenScopePresence(env, LOGIN, PROD, { internalUserId: INTERNAL_ID });
    expect(scopes).toEqual({ ...allFalse, internalId: true });
  });

  it("reports only the alias-login key for an alias-stored token", async () => {
    await recordLoginAlias(sessionStore(env), {
      githubLogin: ALIAS,
      internalUserId: INTERNAL_ID,
      nowMs: Date.now(),
    });
    await storeAccessTokens(env, ALIAS, "tok-alias", "secret-alias", PROD);
    expect(await getValidTokens(env, LOGIN, PROD)).toBeNull();
    const scopes = await getETradeTokenScopePresence(env, LOGIN, PROD, { internalUserId: INTERNAL_ID });
    expect(scopes).toEqual({ ...allFalse, aliasLogin: true });
  });

  it("reports the legacy unscoped key placed directly", async () => {
    store.set(
      `etrade:token:${LOGIN}`,
      JSON.stringify({ accessToken: "legacy", accessTokenSecret: "legacy-secret", storedAt: new Date().toISOString(), environment: PROD, userLogin: LOGIN }),
    );
    const scopes = await getETradeTokenScopePresence(env, LOGIN, PROD);
    expect(scopes).toEqual({ ...allFalse, unscoped: true });
  });

  it("reports all false for an unknown login", async () => {
    await storeAccessTokens(env, LOGIN, "tok", "secret", PROD);
    const scopes = await getETradeTokenScopePresence(env, OTHER, PROD);
    expect(scopes).toEqual(allFalse);
  });

  it("getETradeAuthStatus carries tokenScopes as booleans only, never values", async () => {
    await storeAccessTokens(env, LOGIN, "tok-secret-value", "secret-value", PROD);
    const status = await getETradeAuthStatus(env, LOGIN, PROD);
    expect(status.authenticated).toBe(true);
    expect(status.tokenScopes).toEqual({ ...allFalse, loginScoped: true });
    expect(Object.values(status.tokenScopes ?? {}).every((v) => typeof v === "boolean")).toBe(true);
    expect(JSON.stringify(status)).not.toContain("tok-secret-value");
    expect(JSON.stringify(status)).not.toContain("secret-value");
  });

  it("status carries all-false scopes when nothing is stored", async () => {
    const status = await getETradeAuthStatus(env, OTHER, PROD);
    expect(status.authenticated).toBe(false);
    expect(status.tokenScopes).toEqual(allFalse);
  });
});
