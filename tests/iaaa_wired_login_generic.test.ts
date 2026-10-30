/**
 * #945 Google-as-plugin — the generic wired login tail.
 *
 * completeWiredLogin (src/security/iaaaLogin.ts) parameterizes the
 * binding/session/audit/post-login flow over a normalized profile
 * { subject, loginKey, displayName, avatarUrl } + issuer. GitHub's
 * factory-built adapter delegates to it (the GitHub-specific wired
 * callback was deleted in #1254), so GitHub behaviour runs through
 * this same tail; this file covers the generic tail directly and
 * through a factory-built (fake) adapter, using in-memory stores
 * and a fake session namespace — no network, no live provider.
 */
import { describe, expect, it } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import { createMemoryIdentityBindingStore } from "../src/security/identityBinding";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import {
  completeWiredLogin,
  type NormalizedLoginProfile,
} from "../src/security/iaaaLogin";
import type { Env } from "../src/types";

function makeEnv() {
  const { namespace, store } = makeFakeSessionStore();
  const env = {
    SESSION_STORE: namespace,
    SESSION_SECRET: "test-session-secret",
    APP_BASE_URL: "https://agent.test",
  } as unknown as Env;
  return { env, store };
}

function profile(overrides: Partial<NormalizedLoginProfile> = {}): NormalizedLoginProfile {
  return {
    subject: "google-sub-1",
    loginKey: "user@example.com",
    displayName: "Example User",
    avatarUrl: "https://example.com/pic",
    ...overrides,
  };
}

function sessionEntries(store: Map<string, string>) {
  return [...store.entries()].filter(([k]) => /^sessions:[0-9a-f-]{36}$/.test(k));
}

describe("completeWiredLogin", () => {
  it("creates a wired session keyed by the normalized profile, with binding + audit", async () => {
    const { env, store } = makeEnv();
    const bindingStore = createMemoryIdentityBindingStore();
    const auditStore = createMemoryAuditStore();
    const res = await completeWiredLogin(env, "https://accounts.google.com", profile(), {
      bindingStore,
      nowMs: 5_000_000,
      auditStore,
      auditTenantId: "primary",
    });
    expect(res.status).toBe(302);
    // #2402: the success outcome travels on the redirect so the app
    // boot can show the one-time confirmation.
    expect(res.headers.get("Location")).toBe("/?auth_outcome=signed_in");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("session_id=");
    const sessions = sessionEntries(store);
    expect(sessions).toHaveLength(1);
    const session = JSON.parse(sessions[0][1]);
    expect(session.githubLogin).toBe("user@example.com");
    expect(session.githubName).toBe("Example User");
    expect(session.githubAvatar).toBe("https://example.com/pic");
    expect(session.providerIssuer).toBe("https://accounts.google.com");
    expect(session.providerSubject).toBe("google-sub-1");
    expect(session.internalUserId).toBeTruthy();
    expect(session.sessionVersion).toBe(1);
    expect(session.authTimeMs).toBe(5_000_000);
    expect(session.lastActivityMs).toBe(5_000_000);
    // The binding resolves back to the same internal id.
    const binding = await bindingStore.getByProvider(
      "https://accounts.google.com",
      "google-sub-1"
    );
    expect(binding).not.toBeNull();
    expect(binding!.internalUserId).toBe(session.internalUserId);
    // A login success audit event was recorded for that internal id.
    const events = await auditStore.list();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("auth.login");
    expect(events[0].actorPrincipalId).toBe(session.internalUserId);
  });

  it("the same subject re-binds to the same internal id; a different subject gets a new one", async () => {
    const { env, store } = makeEnv();
    const bindingStore = createMemoryIdentityBindingStore();
    const first = await completeWiredLogin(env, "https://accounts.google.com", profile(), {
      bindingStore,
      nowMs: 1,
    });
    expect(first.status).toBe(302);
    const again = await completeWiredLogin(env, "https://accounts.google.com", profile(), {
      bindingStore,
      nowMs: 2,
    });
    expect(again.status).toBe(302);
    const other = await completeWiredLogin(
      env,
      "https://accounts.google.com",
      profile({ subject: "google-sub-2", loginKey: "other@example.com" }),
      { bindingStore, nowMs: 3 }
    );
    expect(other.status).toBe(302);
    const ids = sessionEntries(store).map(([, v]) => JSON.parse(v).internalUserId as string);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("a missing subject fails closed: login redirect, failure audit, no session, no binding", async () => {
    const { env, store } = makeEnv();
    const bindingStore = createMemoryIdentityBindingStore();
    const auditStore = createMemoryAuditStore();
    const res = await completeWiredLogin(
      env,
      "https://accounts.google.com",
      profile({ subject: "" }),
      { bindingStore, nowMs: 1, auditStore, auditTenantId: "primary" }
    );
    // #2402: the failure redirects to the login page with the generic
    // outcome; the technical cause stays in the server log.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect(sessionEntries(store)).toHaveLength(0);
    expect(
      await bindingStore.getByProvider("https://accounts.google.com", "")
    ).toBeNull();
    const events = await auditStore.list();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("auth.login");
    expect(events[0].decision).toBe("deny");
  });

  it("a missing login key fails closed with no session and no binding", async () => {
    const { env, store } = makeEnv();
    const bindingStore = createMemoryIdentityBindingStore();
    const res = await completeWiredLogin(
      env,
      "https://accounts.google.com",
      profile({ loginKey: "" }),
      { bindingStore, nowMs: 1 }
    );
    // #2402: login redirect with the generic outcome, as above.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect(sessionEntries(store)).toHaveLength(0);
    expect(
      await bindingStore.getByProvider("https://accounts.google.com", "google-sub-1")
    ).toBeNull();
  });

  it("post-login work runs when enabled: the login-key alias is recorded", async () => {
    const { env, store } = makeEnv();
    const bindingStore = createMemoryIdentityBindingStore();
    const res = await completeWiredLogin(env, "https://accounts.google.com", profile(), {
      bindingStore,
      nowMs: 1,
      postLoginEnabled: true,
    });
    expect(res.status).toBe(302);
    // runWiredPostLogin records iaaa-alias:<loginKey> in the same store.
    expect([...store.keys()].some((k) => k.startsWith("sessions:iaaa-alias:"))).toBe(true);
  });
});
