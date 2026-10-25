/**
 * #1254 PR-A — TDD pins for the confidential-client grant added to
 * the shared OAuth2 core (src/security/oauth2Core.ts).
 *
 * The core shipped with #1247 knowing only PUBLIC-client grants
 * (PKCE, no secret). The login-provider factory needs the
 * confidential-client variant both existing login flows use:
 * client_secret in the token-request body (client_secret_post).
 * GitHub's token endpoint additionally answers form-encoded by
 * default and reports errors with HTTP 200 + an error payload, so
 * the core's token-response parsing must tolerate form-encoded
 * bodies. These pins fail on pristine main (the export does not
 * exist) and pass once the variant lands; the public-client grants
 * are pinned by tests/data_provider_public_p1247.test.ts and are
 * not re-pinned here.
 */
import { describe, expect, it, vi } from "vitest";
import {
  exchangeAuthorizationCodeConfidential,
  OAuth2Error,
} from "../src/security/oauth2Core";

const ENDPOINT = "https://provider.example/oauth/token";

function stubToken(impl: {
  status?: number;
  body: string;
  contentType?: string;
}): { calls: { url: string; init: any }[]; fetchImpl: typeof fetch } {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (input: unknown, init?: unknown) => {
    calls.push({ url: String(input), init });
    return new Response(impl.body, {
      status: impl.status ?? 200,
      headers: { "Content-Type": impl.contentType ?? "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("exchangeAuthorizationCodeConfidential", () => {
  it("posts a form grant with the secret in the body (client_secret_post)", async () => {
    const { calls, fetchImpl } = stubToken({
      body: JSON.stringify({ access_token: "tok-1", token_type: "bearer" }),
    });
    const tokens = await exchangeAuthorizationCodeConfidential(
      {
        tokenEndpoint: ENDPOINT,
        code: "the-code",
        redirectUri: "https://agent.test/auth/callback",
        clientId: "client-1",
        clientSecret: "test-client-secret",
      },
      fetchImpl
    );
    expect(tokens.accessToken).toBe("tok-1");
    expect(calls).toHaveLength(1);
    const init = calls[0].init as { method: string; headers: Record<string, string>; body: string };
    expect(calls[0].url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe("https://agent.test/auth/callback");
    expect(form.get("client_id")).toBe("client-1");
    expect(form.get("client_secret")).toBe("test-client-secret");
  });

  it("omits redirect_uri and client_secret when not supplied", async () => {
    const { calls, fetchImpl } = stubToken({
      body: JSON.stringify({ access_token: "tok-2" }),
    });
    await exchangeAuthorizationCodeConfidential(
      { tokenEndpoint: ENDPOINT, code: "c", clientId: "client-1" },
      fetchImpl
    );
    const form = new URLSearchParams((calls[0].init as { body: string }).body);
    expect(form.get("redirect_uri")).toBeNull();
    expect(form.get("client_secret")).toBeNull();
  });

  it("parses a form-encoded success body (GitHub's default response shape)", async () => {
    const { fetchImpl } = stubToken({
      body: "access_token=form-tok&scope=read%3Auser&token_type=bearer",
      contentType: "application/x-www-form-urlencoded",
    });
    const tokens = await exchangeAuthorizationCodeConfidential(
      { tokenEndpoint: ENDPOINT, code: "c", clientId: "client-1", clientSecret: "s" },
      fetchImpl
    );
    expect(tokens.accessToken).toBe("form-tok");
  });

  it("HTTP 200 with an error payload throws OAuth2Error carrying code + description, no status", async () => {
    const { fetchImpl } = stubToken({
      body: "error=bad_verification_code&error_description=The+code+passed+is+incorrect+or+expired.",
      contentType: "application/x-www-form-urlencoded",
    });
    const err = await exchangeAuthorizationCodeConfidential(
      { tokenEndpoint: ENDPOINT, code: "c", clientId: "client-1", clientSecret: "s" },
      fetchImpl
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuth2Error);
    const oauthErr = err as OAuth2Error & { errorDescription?: string };
    expect(oauthErr.status).toBeUndefined();
    expect(oauthErr.errorCode).toBe("bad_verification_code");
    expect(oauthErr.errorDescription).toBe("The code passed is incorrect or expired.");
  });

  it("an HTTP failure throws OAuth2Error carrying the upstream status", async () => {
    const { fetchImpl } = stubToken({
      status: 502,
      body: JSON.stringify({ error: "upstream_error" }),
    });
    const err = await exchangeAuthorizationCodeConfidential(
      { tokenEndpoint: ENDPOINT, code: "c", clientId: "client-1", clientSecret: "s" },
      fetchImpl
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuth2Error);
    expect((err as OAuth2Error).status).toBe(502);
  });

  it("a JSON success keeps refresh token and expiry semantics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const { fetchImpl } = stubToken({
        body: JSON.stringify({ access_token: "tok-3", refresh_token: "ref-3", expires_in: 3600 }),
      });
      const tokens = await exchangeAuthorizationCodeConfidential(
        { tokenEndpoint: ENDPOINT, code: "c", clientId: "client-1", clientSecret: "s" },
        fetchImpl
      );
      expect(tokens.accessToken).toBe("tok-3");
      expect(tokens.refreshToken).toBe("ref-3");
      expect(tokens.expiresAt).toBe(1_000_000 + 3600 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});
