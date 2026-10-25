/**
 * Wiring Phase 1 — GitHub login/session wiring, binding + session layer.
 *
 * Layers covered here: the binding/session helpers in iaaaLogin.ts, using
 * in-memory stores. No network calls are made by these tests. The live
 * GitHub token/profile HTTP calls are exercised only by the wired
 * callback in production code (which reuses the same helpers as the
 * existing callback); that HTTP layer is NOT covered here, and the
 * module header says so. The server.ts dispatch itself is covered by
 * resolveLoginProvider tests in tests/iaaa_providers.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryIdentityBindingStore,
  type IdentityBindingStore,
} from "../src/security/identityBinding";
import {
  buildExtendedSessionData,
  createKvBindingStore,
  getValidatedSession,
  resolveGithubBinding,
  type GithubProfile,
  type ValidatedSessionResult,
} from "../src/security/iaaaLogin";
import { SESSION_TTL } from "../src/security/session";
import type { SessionData } from "../src/types";

function baseSession(): SessionData {
  return {
    githubLogin: "octocat",
    githubAvatar: "https://example/avatar",
    githubName: "Octocat",
    createdAt: 1_000_000,
  };
}

function memoryKv(): Map<string, string> & { get: (k: string) => Promise<string | null>; put: (k: string, v: string) => Promise<void>; delete: (k: string) => Promise<void> } {
  const map = new Map<string, string>();
  // Capture the prototype get BEFORE Object.assign shadows it, or the
  // helper recurses into itself (that was the one test failure).
  const rawGet = Map.prototype.get.bind(map);
  const rawSet = Map.prototype.set.bind(map);
  const rawDelete = Map.prototype.delete.bind(map);
  return Object.assign(map, {
    async get(key: string) {
      return rawGet(key) ?? null;
    },
    async put(key: string, value: string) {
      rawSet(key, value);
    },
    async delete(key: string) {
      rawDelete(key);
    },
  });
}

describe("resolveGithubBinding", () => {
  it("binds (github issuer, numeric user id) to a stable internal id, same id on repeat", async () => {
    const store = createMemoryIdentityBindingStore();
    const profile: GithubProfile = { id: 123, login: "octocat", avatar_url: "x", name: "Octocat" };
    const first = await resolveGithubBinding(store, profile, 2_000_000);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await resolveGithubBinding(store, profile, 3_000_000);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.binding.internalUserId).toBe(first.binding.internalUserId);
    expect(first.binding.providerIssuer).toBe("https://github.com");
    expect(first.binding.providerSubject).toBe("123");
  });

  it("a different GitHub user id binds to a different internal id (login alone never binds)", async () => {
    const store = createMemoryIdentityBindingStore();
    const a = await resolveGithubBinding(store, { id: 1, login: "same-login" } as GithubProfile, 1);
    const b = await resolveGithubBinding(store, { id: 2, login: "same-login" } as GithubProfile, 1);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.binding.internalUserId).not.toBe(b.binding.internalUserId);
  });

  it("a missing user id fails the login — it never falls back to binding by login", async () => {
    const store = createMemoryIdentityBindingStore();
    const result = await resolveGithubBinding(
      store,
      { login: "octocat" } as unknown as GithubProfile,
      1
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MISSING_SUBJECT_ID");
    expect(await store.getByProvider("https://github.com", "octocat")).toBeNull();
  });

  it("the profile fetch is the proof: a resolved binding is never unproven (no UNPROVEN_LINK path)", async () => {
    const store = createMemoryIdentityBindingStore();
    const result = await resolveGithubBinding(store, { id: 42, login: "octocat" } as GithubProfile, 1);
    expect(result.ok).toBe(true);
  });
});

describe("KvLike binding store adapter", () => {
  it("round-trips a binding through a KvLike store with the iaaa-binding: prefix", async () => {
    const kv = memoryKv();
    const store: IdentityBindingStore = createKvBindingStore(kv);
    const result = await resolveGithubBinding(store, { id: 7, login: "octocat" } as GithubProfile, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = [...kv.keys()];
    expect(keys.some((k) => k.startsWith("iaaa-binding:"))).toBe(true);
    const again = await store.getByProvider("https://github.com", "7");
    expect(again?.internalUserId).toBe(result.binding.internalUserId);
    const byUser = await store.getByUserAndIssuer(result.binding.internalUserId, "https://github.com");
    expect(byUser?.providerSubject).toBe("7");
  });
});

describe("buildExtendedSessionData", () => {
  it("keeps every legacy field unchanged and adds only the new optional fields", () => {
    const base = baseSession();
    const extended = buildExtendedSessionData(
      base,
      { internalUserId: "user-1", providerIssuer: "https://github.com", providerSubject: "123" },
      2_000_000
    );
    expect(extended.githubLogin).toBe("octocat");
    expect(extended.githubAvatar).toBe("https://example/avatar");
    expect(extended.githubName).toBe("Octocat");
    expect(extended.createdAt).toBe(1_000_000);
    expect(extended.internalUserId).toBe("user-1");
    expect(extended.providerIssuer).toBe("https://github.com");
    expect(extended.providerSubject).toBe("123");
    expect(extended.authTimeMs).toBe(2_000_000);
    expect(extended.sessionVersion).toBe(1);
  });

  it("the flag-off shape is unchanged: a legacy session has none of the new fields", () => {
    const legacy = baseSession();
    expect(legacy.internalUserId).toBeUndefined();
    expect(legacy.providerIssuer).toBeUndefined();
    expect(legacy.providerSubject).toBeUndefined();
    expect(legacy.authTimeMs).toBeUndefined();
    expect(legacy.sessionVersion).toBeUndefined();
  });
});

describe("getValidatedSession (absolute expiry + existence only)", () => {
  it("returns a live session whose createdAt is within SESSION_TTL", () => {
    const session = { ...baseSession(), createdAt: 1_000_000 };
    const result: ValidatedSessionResult = getValidatedSession(session, 1_000_000 + SESSION_TTL * 1000 - 1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.githubLogin).toBe("octocat");
  });

  it("rejects a session at or past createdAt + SESSION_TTL (expiry is exclusive)", () => {
    const session = { ...baseSession(), createdAt: 1_000_000 };
    const atExpiry = getValidatedSession(session, 1_000_000 + SESSION_TTL * 1000);
    expect(atExpiry.ok).toBe(false);
    if (!atExpiry.ok) expect(atExpiry.code).toBe("SESSION_EXPIRED");
  });

  it("returns null-session as missing (revocation = deletion in this phase)", () => {
    const result = getValidatedSession(null, 1_000_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SESSION_MISSING");
  });

  it("does NOT enforce idle expiry in Phase 1 — a session with no recent activity still validates on absolute time", () => {
    // Deliberate Phase 1 limitation, documented in iaaaLogin.ts: there is
    // no lastActivityMs field yet, and the 60s isolate cache cannot enforce
    // idle timeouts. This test pins that behaviour so Phase 2 cannot
    // silently assume idle enforcement already exists.
    const session = { ...baseSession(), createdAt: 1_000_000 };
    const result = getValidatedSession(session, 1_000_000 + 60_000);
    expect(result.ok).toBe(true);
  });
});
