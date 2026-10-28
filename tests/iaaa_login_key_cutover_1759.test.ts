/**
 * Issue #1759 (#1717 slice): IAAA login-keyed state cutover +
 * provider-neutral login key and DID prefix.
 *
 * TDD-first cases for the recorded cutover decision (alias-forever
 * for DO names + dual-read for tokens; copy-cutover rejected):
 *
 * 1. Provider-neutral DID: a session never renders another
 *    provider's prefix. Google sessions render `google:`, not
 *    `github:`. Legacy sessions (no providerIssuer, historically
 *    GitHub-only) keep `github:`; an unknown issuer renders
 *    `unknown:`, never a guessed provider.
 * 2. DO rename: a user whose login changed still resolves to the
 *    alias login their DO state lives under — never to another
 *    user's login, never to a fresh empty name.
 * 3. E*TRADE dual-read: a token stored under the old login is
 *    still found after a rename via the alias, and a token stored
 *    under an internal id is found by that id.
 */
import { describe, it, expect } from "vitest";
import { getUserDid, getLoginDid, getDisplayUserDid } from "../src/agents/did";
import { getSessionDid } from "../src/security/iaaaLoginKey";
import {
  recordLoginAlias,
  resolveDoNameForUser,
} from "../src/security/iaaaMigration";
import { sessionStore } from "../src/security/session";
import {
  getRequestTokenSecret,
  getStoredTokens,
  revokeStoredTokens,
  storeAccessTokens,
  storeRequestTokenSecret,
} from "../src/security/etradeOAuth";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";

function makeEnv() {
  const { namespace } = makeFakeSessionStore();
  return {
    APP_ENV: "TEST",
    ET_API_KEY: "test-key",
    ET_API_SECRET: "test-secret",
    ET_BASE_URL: "https://apisb.etrade.com/v1",
    SESSION_STORE: namespace,
  } as unknown as Env;
}

describe("provider-neutral DID (#1759)", () => {
  it("derives a github DID for the github provider", () => {
    expect(getLoginDid("github", "OctoCat")).toBe("did:user:github:octocat");
  });

  it("derives a google DID for a Google session — never github:", () => {
    expect(getLoginDid("google", "User@Example.com")).toBe(
      "did:user:google:userexamplecom",
    );
  });

  it("renders unknown: for an unknown or empty provider, never another provider", () => {
    expect(getLoginDid("", "alice")).toBe("did:user:unknown:alice");
    expect(getLoginDid("   ", "alice")).toBe("did:user:unknown:alice");
  });

  it("normalizes the provider id (case/whitespace) like the login", () => {
    expect(getLoginDid("  GitHub ", "octocat")).toBe("did:user:github:octocat");
  });

  it("keeps the legacy getUserDid derivation unchanged (pin)", () => {
    expect(getUserDid("octocat")).toBe("did:user:github:octocat");
  });

  it("renders github: for a legacy session with no providerIssuer (historically GitHub-only)", () => {
    expect(
      getSessionDid({ githubLogin: "octocat" }),
    ).toBe("did:user:github:octocat");
  });

  it("renders google: for a Google wired session", () => {
    expect(
      getSessionDid({
        githubLogin: "user@example.com",
        providerIssuer: "https://accounts.google.com",
      }),
    ).toBe("did:user:google:userexamplecom");
  });

  it("renders github: for a GitHub wired session", () => {
    expect(
      getSessionDid({
        githubLogin: "octocat",
        providerIssuer: "https://github.com",
      }),
    ).toBe("did:user:github:octocat");
  });

  it("display helper: known provider wins, absent provider keeps the legacy derivation", () => {
    expect(getDisplayUserDid("user@example.com", "google")).toBe(
      "did:user:google:userexamplecom",
    );
    expect(getDisplayUserDid("octocat")).toBe("did:user:github:octocat");
    expect(getDisplayUserDid("octocat", "")).toBe("did:user:github:octocat");
  });

  it("renders unknown: for an unregistered issuer, never a guessed provider", () => {
    expect(
      getSessionDid({
        githubLogin: "someone@example.com",
        providerIssuer: "https://idp.example.invalid",
      }),
    ).toBe("did:user:unknown:someoneexamplecom");
  });
});

describe("DO-name cutover: alias-forever (#1759)", () => {
  it("resolves to the current login when there is no internal id", async () => {
    const { namespace } = makeFakeSessionStore();
    const env = { SESSION_STORE: namespace } as unknown as Env;
    const kv = sessionStore(env);
    expect(
      await resolveDoNameForUser(kv, { currentLogin: "octo-new" }),
    ).toEqual({ kind: "current-login", login: "octo-new" });
  });

  it("resolves to the current login for a wired user with no alias yet", async () => {
    const { namespace } = makeFakeSessionStore();
    const env = { SESSION_STORE: namespace } as unknown as Env;
    const kv = sessionStore(env);
    expect(
      await resolveDoNameForUser(kv, {
        currentLogin: "fresh-user",
        internalUserId: "user-fresh",
      }),
    ).toEqual({ kind: "current-login", login: "fresh-user" });
  });

  it("rename: resolves to the alias login the DO state already lives under", async () => {
    const { namespace } = makeFakeSessionStore();
    const env = { SESSION_STORE: namespace } as unknown as Env;
    const kv = sessionStore(env);
    const recorded = await recordLoginAlias(kv, {
      githubLogin: "octo-old",
      internalUserId: "user-1",
      nowMs: 1000,
    });
    expect(recorded.ok).toBe(true);
    // The user renamed octo-old -> octo-new. The DO name must stay
    // octo-old: resolving to octo-new would address a fresh empty DO.
    expect(
      await resolveDoNameForUser(kv, {
        currentLogin: "octo-new",
        internalUserId: "user-1",
      }),
    ).toEqual({ kind: "alias-login", login: "octo-old" });
  });

  it("rename safety: a second user cannot steal the alias login", async () => {
    const { namespace } = makeFakeSessionStore();
    const env = { SESSION_STORE: namespace } as unknown as Env;
    const kv = sessionStore(env);
    await recordLoginAlias(kv, {
      githubLogin: "octo-old",
      internalUserId: "user-1",
      nowMs: 1000,
    });
    const steal = await recordLoginAlias(kv, {
      githubLogin: "octo-old",
      internalUserId: "user-2",
      nowMs: 2000,
    });
    expect(steal.ok).toBe(false);
    expect(
      await resolveDoNameForUser(kv, {
        currentLogin: "octo-new",
        internalUserId: "user-1",
      }),
    ).toEqual({ kind: "alias-login", login: "octo-old" });
    expect(
      await resolveDoNameForUser(kv, {
        currentLogin: "octo-new",
        internalUserId: "user-2",
      }),
    ).toEqual({ kind: "current-login", login: "octo-new" });
  });
});

describe("E*TRADE token dual-read (#1759)", () => {
  it("rename: a token stored under the old login is found via the alias", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, "octo-old", "tok-old", "sec-old");
    const kv = sessionStore(env);
    const recorded = await recordLoginAlias(kv, {
      githubLogin: "octo-old",
      internalUserId: "user-1",
      nowMs: 1000,
    });
    expect(recorded.ok).toBe(true);
    const found = await getStoredTokens(env, "octo-new", "TEST", {
      internalUserId: "user-1",
    });
    expect(found?.accessToken).toBe("tok-old");
  });

  it("new tokens stored with an identity are found by that identity", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, "octo-new", "tok-new", "sec-new", undefined, {
      internalUserId: "user-2",
    });
    const found = await getStoredTokens(env, "some-other-login", "TEST", {
      internalUserId: "user-2",
    });
    expect(found?.accessToken).toBe("tok-new");
  });

  it("rename: a request-token secret stored under the old login is found via the alias", async () => {
    const env = makeEnv();
    await storeRequestTokenSecret(env, "octo-old", "req-old", "reqsec-old");
    const kv = sessionStore(env);
    await recordLoginAlias(kv, {
      githubLogin: "octo-old",
      internalUserId: "user-1",
      nowMs: 1000,
    });
    const found = await getRequestTokenSecret(env, "octo-new", "TEST", {
      internalUserId: "user-1",
    });
    expect(found?.requestToken).toBe("req-old");
  });

  it("revoke with an identity deletes the internal-id key too", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, "octo-new", "tok-new", "sec-new", undefined, {
      internalUserId: "user-3",
    });
    expect(
      (await getStoredTokens(env, "octo-new", "TEST", {
        internalUserId: "user-3",
      }))?.accessToken,
    ).toBe("tok-new");
    await revokeStoredTokens(env, "octo-new", "TEST", {
      internalUserId: "user-3",
    });
    expect(
      await getStoredTokens(env, "octo-new", "TEST", {
        internalUserId: "user-3",
      }),
    ).toBeNull();
    expect(
      await getStoredTokens(env, "some-other-login", "TEST", {
        internalUserId: "user-3",
      }),
    ).toBeNull();
  });

  it("unchanged behavior without an identity: login key read, unknown login null", async () => {
    const env = makeEnv();
    await storeAccessTokens(env, "octo-old", "tok-old", "sec-old");
    expect(
      (await getStoredTokens(env, "octo-old", "TEST"))?.accessToken,
    ).toBe("tok-old");
    expect(await getStoredTokens(env, "nobody", "TEST")).toBeNull();
  });
});
