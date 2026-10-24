/**
 * #1254 PR-A — CHARACTERIZATION pins for the GitHub login flow.
 *
 * These pins capture the CURRENT (pre-refactor) externally visible
 * behaviour of GitHub login, at the route level (src/server.ts
 * dispatch, unmodified) and at the registry level (providers.ts):
 *
 * - the exact authorize redirect (URL, parameter order and set,
 *   state mechanics) for the wiring-off start, the wiring-on exact
 *   route, and the wiring-on generic /auth/login/github route;
 * - the legacy (wiring-off) callback: session record fields exactly
 *   as today, the upstream token/profile request shapes (the legacy
 *   path is frozen by its server.ts importer, so its wire shape is
 *   part of its contract), and its styled error pages;
 * - the wired (registry) callback: session record fields (legacy +
 *   Slice 1/2 fields), the binding write, the login success/failure
 *   audit events, and the minimal error pages byte for byte;
 * - logout: redirect, cookie clearing, session deletion, and the
 *   wiring-on logout audit event.
 *
 * Scoping note: for the WIRED path the upstream token-request body
 * format is deliberately NOT pinned — rationalizing that exchange
 * onto the shared oauth2 core is the point of #1254 PR-A. What is
 * pinned is everything a user, a session record, an audit log, or
 * an error page can observe. Every pin in this file passes on
 * pristine main BEFORE the refactor; the refactor must keep them
 * all green without editing this file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import { createSession, createState, verifyState } from "../src/security/session";
import { getProvider } from "../src/security/providers";
import type { Env } from "../src/types";

const GH_ID = "fake-github-client-id";
const GH_SECRET = "fake-github-client-secret";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const PROFILE_URL = "https://api.github.com/user";
const PROFILE = {
  id: 4242,
  login: "octocat",
  avatar_url: "https://avatars.example/4242",
  name: "Octo Cat",
};

function makeEnv(overrides: Record<string, unknown> = {}) {
  const { namespace, store } = makeFakeSessionStore();
  const env: Record<string, unknown> = {
    SESSION_STORE: namespace,
    SEARCH_AGENT: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ ok: true }) }),
    },
    APP_NAME: "Test Agent",
    APP_BASE_URL: "https://agent.test",
    SESSION_SECRET: "test-session-secret",
    GITHUB_CLIENT_ID: GH_ID,
    GITHUB_CLIENT_SECRET: GH_SECRET,
    ...overrides,
  };
  return { env: env as unknown as Env, store };
}

const req = (path: string, headers?: Record<string, string>) =>
  new Request(`https://agent.test${path}`, headers ? { headers } : undefined);

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Stub global fetch for the two GitHub upstream calls; capture everything. */
function stubGithub(impl: {
  tokenStatus?: number;
  tokenBody?: unknown;
  tokenRawBody?: string;
  tokenContentType?: string;
  profileStatus?: number;
  profileBody?: unknown;
}): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: Record<string, unknown>) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: (init?.method as string) ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (url === TOKEN_URL) {
      const raw =
        impl.tokenRawBody ??
        JSON.stringify(impl.tokenBody ?? { access_token: "fake-access-token" });
      return new Response(raw, {
        status: impl.tokenStatus ?? 200,
        headers: { "Content-Type": impl.tokenContentType ?? "application/json" },
      });
    }
    if (url === PROFILE_URL) {
      return new Response(JSON.stringify(impl.profileBody ?? PROFILE), {
        status: impl.profileStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected url", { status: 404 });
  });
  return calls;
}

function sessionEntries(store: Map<string, string>): [string, any][] {
  return [...store.entries()]
    .filter(([k]) => /^sessions:[0-9a-f-]{36}$/.test(k))
    .map(([k, v]) => [k, JSON.parse(v)]);
}

function auditEvents(store: Map<string, string>): any[] {
  const raw = store.get("sessions:iaaa-audit:events");
  return raw ? JSON.parse(raw) : [];
}

const minimalPage = (message: string) =>
  `<!DOCTYPE html><html><head><title>Authentication Error</title></head>` +
  `<body><h1>Authentication Error</h1><p>${message}</p></body></html>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("github authorize redirect (characterization)", () => {
  const EXPECTED_PREFIX =
    "https://github.com/login/oauth/authorize?" +
    `client_id=${GH_ID}` +
    "&redirect_uri=https%3A%2F%2Fagent.test%2Fauth%2Fcallback" +
    "&scope=read%3Auser&state=";

  async function expectGithubRedirect(res: Response, env: Env) {
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith(EXPECTED_PREFIX)).toBe(true);
    const params = new URL(location).searchParams;
    // Exactly these parameters, in this order — no response_type.
    expect([...params.keys()]).toEqual(["client_id", "redirect_uri", "scope", "state"]);
    const state = params.get("state")!;
    expect(state.split(".")).toHaveLength(3);
    expect(await verifyState(env, state)).toBe(true);
    return location;
  }

  it("wiring OFF: /auth/login redirects to GitHub with the legacy callback and no response_type", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/auth/login"), env);
    await expectGithubRedirect(res, env);
  });

  it("wiring ON: /auth/login produces the identical redirect shape", async () => {
    const { env } = makeEnv({ IAAA_WIRING_ENABLED: "1" });
    const off = await worker.fetch(req("/auth/login"), makeEnv().env);
    const on = await worker.fetch(req("/auth/login"), env);
    const strip = (r: Response) =>
      (r.headers.get("Location") ?? "").replace(/&state=.*$/, "");
    expect(strip(on)).toBe(strip(off));
    await expectGithubRedirect(on, env);
  });

  it("wiring ON: /auth/login/github (generic route) produces the identical redirect shape", async () => {
    const { env } = makeEnv({ IAAA_WIRING_ENABLED: "1" });
    const res = await worker.fetch(req("/auth/login/github"), env);
    await expectGithubRedirect(res, env);
  });

  it("registry: github is an oauth2 provider with the GitHub issuer and display name", () => {
    const github = getProvider("github");
    expect(github).not.toBeNull();
    expect(github!.providerId).toBe("github");
    expect(github!.protocol).toBe("oauth2");
    expect(github!.issuer).toBe("https://github.com");
    expect(github!.displayName).toBe("GitHub");
  });
});

describe("legacy callback, wiring OFF (characterization)", () => {
  async function legacyCallback(env: Env, extra = "") {
    const state = await createState(env);
    return worker.fetch(
      req(`/auth/callback?code=legacy-code&state=${encodeURIComponent(state)}${extra}`),
      env
    );
  }

  it("success: legacy session fields exactly, JSON token exchange, GitHub profile headers", async () => {
    const { env, store } = makeEnv();
    const calls = stubGithub({});
    const res = await legacyCallback(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("session_id=");
    expect(cookie).toContain("HttpOnly");

    const sessions = sessionEntries(store);
    expect(sessions).toHaveLength(1);
    const session = sessions[0][1];
    expect(Object.keys(session).sort()).toEqual([
      "createdAt",
      "githubAvatar",
      "githubLogin",
      "githubName",
    ]);
    expect(session.githubLogin).toBe("octocat");
    expect(session.githubAvatar).toBe("https://avatars.example/4242");
    expect(session.githubName).toBe("Octo Cat");
    expect(typeof session.createdAt).toBe("number");
    // No binding and no audit material on the legacy path.
    expect([...store.keys()].some((k) => k.includes("iaaa-binding:"))).toBe(false);
    expect(auditEvents(store)).toHaveLength(0);

    const tokenCall = calls.find((c) => c.url === TOKEN_URL)!;
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.headers["Accept"]).toBe("application/json");
    expect(tokenCall.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(tokenCall.body)).toEqual({
      client_id: GH_ID,
      client_secret: GH_SECRET,
      code: "legacy-code",
    });
    const profileCall = calls.find((c) => c.url === PROFILE_URL)!;
    expect(profileCall.headers["Authorization"]).toBe("Bearer fake-access-token");
    expect(profileCall.headers["Accept"]).toBe("application/vnd.github+json");
    expect(profileCall.headers["User-Agent"]).toBe("ai-search-agent");
  });

  it("provider error parameter → 400 on the styled legacy error page", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/auth/callback?error=access_denied"), env);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("GitHub authentication was cancelled or failed: access_denied");
    expect(body).toContain("Return to Sign In");
  });

  it("missing code/state → 400 styled page", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/auth/callback"), env);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Missing required authorization code or state parameter");
    expect(body).toContain("Return to Sign In");
  });

  it("bad state → 403 styled page and zero upstream calls", async () => {
    const { env } = makeEnv();
    const calls = stubGithub({});
    const res = await worker.fetch(req("/auth/callback?code=x&state=bogus"), env);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("Invalid or expired OAuth state session. Please try signing in again.");
    expect(body).toContain("Return to Sign In");
    expect(calls).toHaveLength(0);
  });

  it("token endpoint HTTP failure → 502 styled page with the upstream status", async () => {
    const { env } = makeEnv();
    stubGithub({ tokenStatus: 502, tokenBody: { error: "bad" } });
    const res = await legacyCallback(env);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("Token exchange failed with upstream status 502");
  });

  it("token 200 with an error payload → 400 styled page with the provider description", async () => {
    const { env } = makeEnv();
    stubGithub({
      tokenBody: {
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
      },
    });
    const res = await legacyCallback(env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("The code passed is incorrect or expired.");
  });

  it("profile fetch failure → 502 styled page naming GitHub", async () => {
    const { env } = makeEnv();
    stubGithub({ profileStatus: 500, profileBody: {} });
    const res = await legacyCallback(env);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("Failed to fetch user profile from GitHub");
  });
});

describe("wired callback, wiring ON (characterization)", () => {
  const WIRED = { IAAA_WIRING_ENABLED: "1" };

  async function wiredCallback(env: Env, path = "/auth/callback", code = "wired-code") {
    const state = await createState(env);
    return worker.fetch(
      req(`${path}?code=${code}&state=${encodeURIComponent(state)}`),
      env
    );
  }

  it("success: wired session fields, binding, and a login success audit event", async () => {
    const { env, store } = makeEnv(WIRED);
    stubGithub({});
    const res = await wiredCallback(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    expect(res.headers.get("Set-Cookie")).toContain("session_id=");

    const sessions = sessionEntries(store);
    expect(sessions).toHaveLength(1);
    const [sessionKey, session] = sessions[0];
    expect(Object.keys(session).sort()).toEqual([
      "authTimeMs",
      "createdAt",
      "githubAvatar",
      "githubLogin",
      "githubName",
      "internalUserId",
      "lastActivityMs",
      "providerIssuer",
      "providerSubject",
      "sessionVersion",
    ]);
    expect(session.githubLogin).toBe("octocat");
    expect(session.githubAvatar).toBe("https://avatars.example/4242");
    expect(session.githubName).toBe("Octo Cat");
    expect(session.providerIssuer).toBe("https://github.com");
    expect(session.providerSubject).toBe("4242");
    expect(session.sessionVersion).toBe(1);
    expect(session.authTimeMs).toBe(session.createdAt);
    expect(session.lastActivityMs).toBe(session.createdAt);
    expect(typeof session.internalUserId).toBe("string");
    expect(session.internalUserId.length).toBeGreaterThan(0);

    expect([...store.keys()].some((k) => k.includes("iaaa-binding:"))).toBe(true);

    const events = auditEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("auth.login");
    expect(events[0].outcome).toBe("succeeded");
    expect(events[0].decision).toBe("allow");
    expect(events[0].tenantId).toBe("primary");
    expect(events[0].actorPrincipalId).toBe(session.internalUserId);
    expect(events[0].correlationId).toBe(sessionKey.replace("sessions:", ""));
  });

  it("success via the generic /auth/callback/github route: same wired session shape", async () => {
    const { env, store } = makeEnv(WIRED);
    stubGithub({});
    const res = await wiredCallback(env, "/auth/callback/github");
    expect(res.status).toBe(302);
    const sessions = sessionEntries(store);
    expect(sessions).toHaveLength(1);
    expect(sessions[0][1].providerIssuer).toBe("https://github.com");
    expect(sessions[0][1].providerSubject).toBe("4242");
    expect(sessions[0][1].githubLogin).toBe("octocat");
  });

  it("null profile name falls back to the login in the session", async () => {
    const { env, store } = makeEnv(WIRED);
    stubGithub({ profileBody: { ...PROFILE, name: null } });
    const res = await wiredCallback(env);
    expect(res.status).toBe(302);
    expect(sessionEntries(store)[0][1].githubName).toBe("octocat");
  });

  it("provider error parameter → 400, minimal error page byte for byte", async () => {
    const { env } = makeEnv(WIRED);
    const res = await worker.fetch(req("/auth/callback?error=access_denied"), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      minimalPage("GitHub authentication was cancelled or failed: access_denied")
    );
  });

  it("missing code/state → 400, minimal error page byte for byte", async () => {
    const { env } = makeEnv(WIRED);
    const res = await worker.fetch(req("/auth/callback"), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      minimalPage("Missing required authorization code or state parameter")
    );
  });

  it("bad state → 403, minimal error page byte for byte, zero upstream calls", async () => {
    const { env } = makeEnv(WIRED);
    const calls = stubGithub({});
    const res = await worker.fetch(req("/auth/callback?code=x&state=bogus"), env);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(
      minimalPage("Invalid or expired OAuth state session. Please try signing in again.")
    );
    expect(calls).toHaveLength(0);
  });

  it("token endpoint HTTP failure → 502 minimal page with the upstream status", async () => {
    const { env } = makeEnv(WIRED);
    stubGithub({ tokenStatus: 502, tokenBody: { error: "bad" } });
    const res = await wiredCallback(env);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(
      minimalPage("Token exchange failed with upstream status 502")
    );
  });

  it("token 200 with an error payload → 400 minimal page with the provider description", async () => {
    const { env } = makeEnv(WIRED);
    stubGithub({
      tokenBody: {
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
      },
    });
    const res = await wiredCallback(env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      minimalPage("The code passed is incorrect or expired.")
    );
  });

  it("token 200 with no access token and no error → 400 minimal page naming GitHub", async () => {
    const { env } = makeEnv(WIRED);
    stubGithub({ tokenBody: {} });
    const res = await wiredCallback(env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(minimalPage("GitHub did not grant an access token"));
  });

  it("profile fetch failure → 502 minimal page naming GitHub", async () => {
    const { env } = makeEnv(WIRED);
    stubGithub({ profileStatus: 500, profileBody: {} });
    const res = await wiredCallback(env);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(
      minimalPage("Failed to fetch user profile from GitHub")
    );
  });

  it("profile without a stable id → 400, no session/binding, MISSING_SUBJECT_ID failure audit", async () => {
    const { env, store } = makeEnv(WIRED);
    stubGithub({
      profileBody: { login: "octocat", avatar_url: "https://avatars.example/x" },
    });
    const res = await wiredCallback(env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      minimalPage("Provider profile did not include a stable subject id; login cannot be bound")
    );
    expect(sessionEntries(store)).toHaveLength(0);
    expect([...store.keys()].some((k) => k.includes("iaaa-binding:"))).toBe(false);
    const events = auditEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("auth.login");
    expect(events[0].outcome).toBe("failed");
    expect(events[0].decision).toBe("deny");
    expect(events[0].errorCode).toBe("MISSING_SUBJECT_ID");
    expect(events[0].tenantId).toBe("primary");
  });

  it("profile without a login → 400, no session, and no audit event", async () => {
    const { env, store } = makeEnv(WIRED);
    stubGithub({ profileBody: { id: 99, avatar_url: "https://avatars.example/x" } });
    const res = await wiredCallback(env);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      minimalPage("Provider profile did not include a usable login key; login cannot be bound")
    );
    expect(sessionEntries(store)).toHaveLength(0);
    expect(auditEvents(store)).toHaveLength(0);
  });
});

describe("logout (characterization)", () => {
  it("wiring OFF: clears the cookie, deletes the session, redirects home", async () => {
    const { env, store } = makeEnv();
    const sessionId = await createSession(env, {
      githubLogin: "octocat",
      githubAvatar: "https://avatars.example/4242",
      githubName: "Octo Cat",
      createdAt: Date.now(),
    });
    const res = await worker.fetch(
      req("/auth/logout", { Cookie: `session_id=${sessionId}` }),
      env
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("session_id=;");
    expect(cookie).toContain("Max-Age=0");
    expect(store.has(`sessions:${sessionId}`)).toBe(false);
  });

  it("wiring ON: a wired session's logout records an auth.logout audit event", async () => {
    const { env, store } = makeEnv({ IAAA_WIRING_ENABLED: "1" });
    const sessionId = await createSession(env, {
      githubLogin: "octocat",
      githubAvatar: "https://avatars.example/4242",
      githubName: "Octo Cat",
      createdAt: Date.now(),
      internalUserId: "user-42",
      providerIssuer: "https://github.com",
      providerSubject: "4242",
    } as never);
    const res = await worker.fetch(
      req("/auth/logout", { Cookie: `session_id=${sessionId}` }),
      env
    );
    expect(res.status).toBe(302);
    expect(store.has(`sessions:${sessionId}`)).toBe(false);
    const events = auditEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("auth.logout");
    expect(events[0].action).toBe("auth.logout");
    expect(events[0].decision).toBe("allow");
    expect(events[0].actorPrincipalId).toBe("user-42");
    expect(events[0].tenantId).toBe("primary");
  });
});
