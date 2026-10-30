/**
 * #945 Google-as-plugin — generic OIDC provider factory.
 *
 * Covers createOidcProvider from src/security/oidcProvider.ts with
 * mocked fetch (never a live provider call) and fake credential
 * values only. The wired tail (binding/session/audit/post-login)
 * is exercised here through the factory's handleCallback; the
 * generic tail itself is covered in tests/iaaa_wired_login_generic.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";
import { createState } from "../src/security/session";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import {
  createOidcProvider,
  type OidcProviderOptions,
} from "../src/security/oidcProvider";
import type { Env } from "../src/types";

const OPTIONS: OidcProviderOptions = {
  providerId: "acme",
  issuer: "https://acme.example",
  displayName: "Acme",
  authorizationEndpoint: "https://acme.example/oauth/authorize",
  tokenEndpoint: "https://acme.example/oauth/token",
  userinfoEndpoint: "https://acme.example/oauth/userinfo",
  clientIdEnv: "ACME_CLIENT_ID",
  clientSecretEnv: "ACME_CLIENT_SECRET",
  scope: "openid email profile",
  subjectField: "sub",
  loginKeyField: "email",
  requireEmailVerified: true,
};

function makeEnv(withCreds = true): Env {
  const { namespace } = makeFakeSessionStore();
  const env: Record<string, unknown> = {
    SESSION_STORE: namespace,
    SESSION_SECRET: "test-session-secret",
    APP_BASE_URL: "https://agent.test",
    IAAA_WIRING_ENABLED: "1",
  };
  if (withCreds) {
    env.ACME_CLIENT_ID = "fake-acme-client-id";
    env.ACME_CLIENT_SECRET = "fake-acme-client-secret";
  }
  return env as unknown as Env;
}

interface CapturedRequest {
  url: string;
  method: string;
  body: string;
  auth: string | null;
}

function installFetch(impl: {
  token?: unknown;
  tokenStatus?: number;
  userinfo?: unknown;
  userinfoStatus?: number;
}): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  const stub = async (input: unknown, init?: Record<string, unknown>) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : "";
    captured.push({
      url,
      method: (init?.method as string) ?? "GET",
      body,
      auth: headers["Authorization"] ?? headers["authorization"] ?? null,
    });
    if (url.includes("/oauth/token")) {
      const status = impl.tokenStatus ?? 200;
      return new Response(JSON.stringify(impl.token ?? { access_token: "fake-token" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    const status = impl.userinfoStatus ?? 200;
    return new Response(
      JSON.stringify(
        impl.userinfo ?? {
          sub: "acme-sub-1",
          email: "user@acme.example",
          email_verified: true,
          name: "Acme User",
          picture: "https://acme.example/pic",
        }
      ),
      { status, headers: { "Content-Type": "application/json" } }
    );
  };
  vi.stubGlobal("fetch", stub);
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOidcProvider startLogin", () => {
  it("redirects to the authorization endpoint with client_id, redirect_uri, code, scope, state", async () => {
    const provider = createOidcProvider(OPTIONS);
    const res = await provider.startLogin(makeEnv());
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith("https://acme.example/oauth/authorize?")).toBe(true);
    const params = new URL(location).searchParams;
    expect(params.get("client_id")).toBe("fake-acme-client-id");
    expect(params.get("redirect_uri")).toBe("https://agent.test/auth/callback/acme");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe("openid email profile");
    expect(params.get("state")).toBeTruthy();
    expect(params.get("state")!.split(".")).toHaveLength(3);
  });

  it("redirects to the login page with signin_failed, never to the provider, when the client id is missing", async () => {
    const provider = createOidcProvider(OPTIONS);
    const res = await provider.startLogin(makeEnv(false));
    // #2402: a bare error page is replaced by the login-page outcome;
    // the technical cause stays in the server log.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });
});

describe("createOidcProvider handleCallback", () => {
  async function callbackRequest(env: Env, state: string, extra = ""): Promise<Request> {
    // A real provider URL-encodes the state on the way back; the
    // HMAC signature is base64 and may contain '+' (decoded as a
    // space if embedded raw), which would fail verification.
    return new Request(
      `https://agent.test/auth/callback/acme?code=fake-code&state=${encodeURIComponent(state)}${extra}`
    );
  }

  it("exchanges the code, fetches userinfo, binds, sessions, audits, and redirects home", async () => {
    const env = makeEnv();
    const captured = installFetch({});
    const auditStore = createMemoryAuditStore();
    const provider = createOidcProvider(OPTIONS);
    const state = await createState(env);
    const res = await provider.handleCallback(env, await callbackRequest(env, state), {
      auditStore,
      auditTenantId: "primary",
      postLoginEnabled: true,
    });
    expect(res.status).toBe(302);
    // #2402: the success outcome travels on the redirect for the
    // one-time boot confirmation.
    expect(res.headers.get("Location")).toBe("/?auth_outcome=signed_in");
    expect(res.headers.get("Set-Cookie")).toContain("session_id=");
    // Token exchange carried the code and client id (secret is sent but never logged — nothing is logged here).
    const tokenCall = captured.find((c) => c.url.includes("/oauth/token"));
    expect(tokenCall).toBeDefined();
    expect(tokenCall!.body).toContain("code=fake-code");
    expect(tokenCall!.body).toContain("client_id=fake-acme-client-id");
    // Userinfo was fetched with the fresh access token.
    const userinfoCall = captured.find((c) => c.url.includes("/oauth/userinfo"));
    expect(userinfoCall).toBeDefined();
    expect(userinfoCall!.auth).toBe("Bearer fake-token");
    // #1760: post-login work runs before the login-success audit,
    // so a fresh login now records TWO events in order: the alias
    // recording, then the login success. The pin is the pair, not
    // the login event alone — the alias event is new evidence, not
    // a duplicate login event.
    const events = await auditStore.list();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("iaaa.alias.record");
    expect(events[1].type).toBe("auth.login");
    expect(events[1].tenantId).toBe("primary");
  });

  it("rejects a provider error parameter and a missing code/state with a login redirect", async () => {
    const provider = createOidcProvider(OPTIONS);
    const env = makeEnv();
    const errRes = await provider.handleCallback(
      env,
      new Request("https://agent.test/auth/callback/acme?error=access_denied")
    );
    // #2402: every callback failure redirects to the login page with
    // the generic outcome; fail-closed (no session, no binding) is
    // unchanged, only the user-visible shape changes.
    expect(errRes.status).toBe(302);
    expect(errRes.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    const missingRes = await provider.handleCallback(
      env,
      new Request("https://agent.test/auth/callback/acme")
    );
    expect(missingRes.status).toBe(302);
    expect(missingRes.headers.get("Location")).toBe(
      "/login?auth_outcome=signin_failed"
    );
  });

  it("rejects an invalid state with a login redirect before any upstream call", async () => {
    const captured = installFetch({});
    const provider = createOidcProvider(OPTIONS);
    const res = await provider.handleCallback(
      makeEnv(),
      new Request("https://agent.test/auth/callback/acme?code=x&state=bogus")
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect(captured).toHaveLength(0);
  });

  it("fails closed on a token endpoint failure", async () => {
    installFetch({ tokenStatus: 502, token: { error: "bad" } });
    const provider = createOidcProvider(OPTIONS);
    const env = makeEnv();
    const state = await createState(env);
    const res = await provider.handleCallback(env, await callbackRequest(env, state));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
  });

  it("fails closed on a missing subject — no session, no binding", async () => {
    const { namespace, store } = makeFakeSessionStore();
    const env = makeEnv();
    (env as unknown as Record<string, unknown>).SESSION_STORE = namespace;
    installFetch({ userinfo: { email: "user@acme.example", email_verified: true } });
    const provider = createOidcProvider(OPTIONS);
    const state = await createState(env);
    const res = await provider.handleCallback(env, await callbackRequest(env, state));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=signin_failed");
    expect([...store.keys()].some((k) => k.includes("iaaa-binding:"))).toBe(false);
    expect([...store.keys()].filter((k) => /^sessions:[0-9a-f-]{36}$/.test(k))).toHaveLength(0);
  });

  it("fails closed on a missing or unverified email when verification is required", async () => {
    const provider = createOidcProvider(OPTIONS);
    const env = makeEnv();
    installFetch({ userinfo: { sub: "s1", email_verified: true } });
    const state = await createState(env);
    const noEmail = await provider.handleCallback(env, await callbackRequest(env, state));
    expect(noEmail.status).toBe(302);
    expect(noEmail.headers.get("Location")).toBe(
      "/login?auth_outcome=signin_failed"
    );

    installFetch({ userinfo: { sub: "s1", email: "user@acme.example", email_verified: false } });
    const unverified = await provider.handleCallback(env, await callbackRequest(env, state));
    expect(unverified.status).toBe(302);
    expect(unverified.headers.get("Location")).toBe(
      "/login?auth_outcome=signin_failed"
    );
  });

  it("normalizes display name from the login key when name is absent", async () => {
    const { namespace, store } = makeFakeSessionStore();
    const env = makeEnv();
    (env as unknown as Record<string, unknown>).SESSION_STORE = namespace;
    installFetch({
      userinfo: { sub: "s9", email: "noname@acme.example", email_verified: true },
    });
    const provider = createOidcProvider(OPTIONS);
    const state = await createState(env);
    const res = await provider.handleCallback(env, await callbackRequest(env, state));
    expect(res.status).toBe(302);
    const sessionKey = [...store.keys()].find((k) => /^sessions:[0-9a-f-]{36}$/.test(k));
    expect(sessionKey).toBeDefined();
    const session = JSON.parse(store.get(sessionKey!)!);
    expect(session.githubLogin).toBe("noname@acme.example");
    expect(session.githubName).toBe("noname@acme.example");
    expect(session.providerSubject).toBe("s9");
    expect(session.providerIssuer).toBe("https://acme.example");
    expect(session.internalUserId).toBeTruthy();
  });
});
