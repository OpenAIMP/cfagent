/**
 * #945 Google-as-plugin — generic provider routes in server.ts.
 *
 * Routes /auth/login/<providerId> and /auth/callback/<providerId>
 * dispatch through the provider registry. Since #1254 PR-B they
 * are the ONLY login routes: the exact /auth/login + /auth/callback
 * GitHub branches are deleted (pinned below as static-assets
 * fall-through), and the /login page behaviour is asserted
 * unchanged. Uses the worker-fetch harness pattern from
 * tests/api_chat_auth.test.ts (mocked agent SDK entry points,
 * fake session namespace, mocked fetch for provider HTTP calls —
 * never a live provider).
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
import { createState } from "../src/security/session";
import type { Env } from "../src/types";

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
    ...overrides,
  };
  return { env: env as unknown as Env, store };
}

const req = (path: string) => new Request(`https://agent.test${path}`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generic provider login routes", () => {
  it("wiring off → /auth/login/google is 403, never a fallback to github", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/auth/login/google"), env);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("IAAA login wiring is disabled");
  });

  it("wiring on but google not listed → 403 provider-not-enabled", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github",
    });
    const res = await worker.fetch(req("/auth/login/google"), env);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not enabled");
  });

  it("an unknown provider id → 403, never a fallback", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,unknown-provider",
    });
    const res = await worker.fetch(req("/auth/login/unknown-provider"), env);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not registered");
  });

  it("google listed but no client id → error page, never a redirect", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
    });
    const res = await worker.fetch(req("/auth/login/google"), env);
    expect(res.status).toBe(500);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("google listed with a client id → 302 to Google with the provider callback uri", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
      GOOGLE_CLIENT_ID: "fake-google-client-id",
      GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    });
    const res = await worker.fetch(req("/auth/login/google"), env);
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    const params = new URL(location).searchParams;
    expect(params.get("client_id")).toBe("fake-google-client-id");
    expect(params.get("redirect_uri")).toBe("https://agent.test/auth/callback/google");
    expect(params.get("scope")).toBe("openid email profile");
    expect(params.get("state")).toBeTruthy();
  });

  it("the deleted exact /auth/login and /auth/callback paths fall through to static assets (#1254 PR-B)", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
      GITHUB_CLIENT_ID: "fake-github-client-id",
      ASSETS: {
        fetch: async (r: Request) =>
          new Response(`ASSET:${new URL(r.url).pathname}`, { status: 200 }),
      },
    });
    const login = await worker.fetch(req("/auth/login"), env);
    expect(login.status).toBe(200);
    expect(await login.text()).toBe("ASSET:/auth/login");
    const callback = await worker.fetch(req("/auth/callback"), env);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toBe("ASSET:/auth/callback");
  });

  it("/auth/callback/google rejects a bad state with 403 before any upstream call", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
      GOOGLE_CLIENT_ID: "fake-google-client-id",
      GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    });
    const res = await worker.fetch(req("/auth/callback/google?code=x&state=bogus"), env);
    expect(res.status).toBe(403);
  });

  it("/auth/callback/google completes the full flow with a valid state + mocked provider", async () => {
    const { env, store } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
      GOOGLE_CLIENT_ID: "fake-google-client-id",
      GOOGLE_CLIENT_SECRET: "fake-google-client-secret",
    });
    vi.stubGlobal(
      "fetch",
      async (input: unknown) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fake-google-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            sub: "google-sub-42",
            email: "owner@example.com",
            email_verified: true,
            name: "Owner",
            picture: "https://example.com/pic",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );
    const state = await createState(env);
    const res = await worker.fetch(
      req(`/auth/callback/google?code=fake-code&state=${encodeURIComponent(state)}`),
      env
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const sessionKey = [...store.keys()].find((k) => /^sessions:[0-9a-f-]{36}$/.test(k));
    expect(sessionKey).toBeDefined();
    const session = JSON.parse(store.get(sessionKey!)!);
    expect(session.githubLogin).toBe("owner@example.com");
    expect(session.providerIssuer).toBe("https://accounts.google.com");
    expect(session.providerSubject).toBe("google-sub-42");
    expect(session.internalUserId).toBeTruthy();
  });
});

describe("composable /login page", () => {
  it("wiring off → exactly the current GitHub-only page (no google button)", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/login"), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("/auth/login/google");
  });

  it("wiring off → no-arg page keeps the exact legacy anchor block and intro, byte for byte", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("/login"), env);
    const html = await res.text();
    expect(html).toContain(
      "<p>Sign in with your GitHub account to research and trade with human-approved, audit-logged workflows.</p>"
    );
    // The legacy anchor block, verbatim (indentation included).
    expect(html).toContain('<a href="/auth/login" class="btn">\n      <svg viewBox="0 0 16 16"');
    expect(html).toContain("\n      Sign in with GitHub\n    </a>");
  });

  it("wiring on with google enabled → one button per enabled provider", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github,google",
    });
    const res = await worker.fetch(req("/login"), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/auth/login/github");
    expect(html).toContain("/auth/login/google");
    expect(html).toContain("Sign in with Google");
  });

  it("wiring on with github only → no google button", async () => {
    const { env } = makeEnv({
      IAAA_WIRING_ENABLED: "1",
      IAAA_ENABLED_PROVIDERS: "github",
    });
    const res = await worker.fetch(req("/login"), env);
    const html = await res.text();
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("/auth/login/google");
  });
});
