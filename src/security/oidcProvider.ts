/**
 * #945 Google-as-plugin — generic OIDC/OAuth2 provider factory.
 *
 * A login provider that speaks the standard authorization-code flow
 * is one factory call, not a new module: createOidcProvider turns
 * endpoint + env + field-mapping options into a LoginProvider that
 * plugs into the registry (providers.ts) and the generic wired tail
 * (iaaaLogin.ts completeWiredLogin). Google is the worked example;
 * Auth0 or another OIDC provider registers the same way.
 *
 * What the factory owns (per provider instance):
 * - startLogin: redirect to the provider's authorization endpoint
 *   with client_id, redirect_uri, response_type=code, scope, and a
 *   server-side state (createState from ./session). The redirect
 *   URI is ${APP_BASE_URL || "https://agent.openaimp.com"}/auth/callback/<providerId>.
 *   A missing client id OR client secret at start time fails with
 *   an error page — never a redirect to a flow that cannot complete.
 * - handleCallback: state verification, code exchange at the token
 *   endpoint (form-encoded, client_id + client_secret from env),
 *   userinfo fetch with the fresh access token, validation, and
 *   normalization to the generic profile shape. Secrets are sent
 *   only in the token request body; nothing here logs a secret,
 *   a token, or a code.
 *
 * Fail-closed validation (before the generic tail runs, so no
 * binding and no session are created on failure):
 * - provider error parameter, missing code/state, or bad state →
 *   error page (400/403), no upstream call on a bad state.
 * - token endpoint failure or a missing access token → error page.
 * - userinfo failure, a missing/blank subject, a missing/blank
 *   login-key field, or (when requireEmailVerified) a missing or
 *   unverified email → error page. The email is NEVER identity:
 *   it is only the adapter-supplied legacy login key; true identity
 *   is the Slice 1 (issuer, subject) binding in the generic tail.
 */
import type { Env } from "../types";
import type { LoginCallbackOptions, LoginProvider } from "./providers";
import { completeWiredLogin, type NormalizedLoginProfile } from "./iaaaLogin";
import { createState, verifyState } from "./session";

/** Error carrying the HTTP status the callback should answer with. */
export class OidcAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Options for one factory-built provider. Env names are keys, not values. */
export interface OidcProviderOptions {
  providerId: string;
  issuer: string;
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  /** Env key holding the OAuth client id (e.g. "GOOGLE_CLIENT_ID"). */
  clientIdEnv: string;
  /** Env key holding the OAuth client secret (never committed, never logged). */
  clientSecretEnv: string;
  scope: string;
  /** Userinfo field carrying the stable subject. Default "sub". */
  subjectField?: string;
  /** Userinfo field carrying the legacy login key (e.g. "email"). */
  loginKeyField: string;
  /** When true, the userinfo email_verified flag must be true. */
  requireEmailVerified?: boolean;
}

function readEnvString(env: Env, key: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function redirectUri(env: Env, providerId: string): string {
  const base = env.APP_BASE_URL || "https://agent.openaimp.com";
  return `${base}/auth/callback/${providerId}`;
}

function errorPage(message: string, status = 400): Response {
  return new Response(
    `<!DOCTYPE html><html><head><title>Authentication Error</title></head>` +
      `<body><h1>Authentication Error</h1><p>${escapeHtml(message)}</p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Normalize a raw userinfo document to the generic profile shape.
 * Returns an error message on the first fail-closed violation, so
 * the caller never reaches the wired tail with an unproven profile.
 */
export function normalizeUserinfo(
  raw: unknown,
  options: Pick<OidcProviderOptions, "subjectField" | "loginKeyField" | "requireEmailVerified">
): { ok: true; profile: NormalizedLoginProfile } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Provider userinfo was not a usable profile document" };
  }
  const doc = raw as Record<string, unknown>;
  const subjectField = options.subjectField ?? "sub";
  const subjectRaw = doc[subjectField];
  const subject =
    typeof subjectRaw === "string"
      ? subjectRaw
      : typeof subjectRaw === "number" && Number.isFinite(subjectRaw)
        ? String(subjectRaw)
        : "";
  if (subject.trim() === "") {
    return { ok: false, error: "Provider profile did not include a stable subject id; login cannot be bound" };
  }
  const loginKeyRaw = doc[options.loginKeyField];
  const loginKey = typeof loginKeyRaw === "string" ? loginKeyRaw : "";
  if (loginKey.trim() === "") {
    return { ok: false, error: "Provider profile did not include a usable login key; login cannot be bound" };
  }
  if (options.requireEmailVerified) {
    const verified = doc["email_verified"];
    if (verified !== true && verified !== "true") {
      return { ok: false, error: "Provider email is not verified; login cannot be bound" };
    }
  }
  const nameRaw = doc["name"];
  const pictureRaw = doc["picture"];
  return {
    ok: true,
    profile: {
      subject,
      loginKey,
      displayName: typeof nameRaw === "string" && nameRaw.trim() !== "" ? nameRaw : loginKey,
      avatarUrl: typeof pictureRaw === "string" ? pictureRaw : "",
    },
  };
}

/** Build a LoginProvider from OIDC/OAuth2 authorization-code options. */
export function createOidcProvider(options: OidcProviderOptions): LoginProvider {
  const subjectField = options.subjectField ?? "sub";

  async function startLogin(env: Env): Promise<Response> {
    const clientId = readEnvString(env, options.clientIdEnv);
    const clientSecret = readEnvString(env, options.clientSecretEnv);
    if (!clientId || !clientSecret) {
      return errorPage(
        `${options.displayName} login is not configured (missing OAuth client credentials)`,
        500
      );
    }
    const state = await createState(env);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(env, options.providerId),
      response_type: "code",
      scope: options.scope,
      state,
    });
    return new Response(null, {
      status: 302,
      headers: { Location: `${options.authorizationEndpoint}?${params}` },
    });
  }

  async function handleCallback(
    env: Env,
    request: Request,
    callbackOptions?: LoginCallbackOptions
  ): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      return errorPage(`${options.displayName} authentication was cancelled or failed: ${error}`, 400);
    }
    if (!code || !state) {
      return errorPage("Missing required authorization code or state parameter", 400);
    }
    const isValidState = await verifyState(env, state);
    if (!isValidState) {
      return errorPage("Invalid or expired OAuth state session. Please try signing in again.", 403);
    }

    try {
      const clientId = readEnvString(env, options.clientIdEnv);
      const clientSecret = readEnvString(env, options.clientSecretEnv);
      if (!clientId || !clientSecret) {
        return errorPage(
          `${options.displayName} login is not configured (missing OAuth client credentials)`,
          500
        );
      }
      const tokenResp = await fetch(options.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri(env, options.providerId),
          grant_type: "authorization_code",
        }).toString(),
      });
      if (!tokenResp.ok) {
        throw new OidcAuthError(
          `Token exchange failed with upstream status ${tokenResp.status}`,
          502
        );
      }
      const tokenData = (await tokenResp.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenData.access_token) {
        throw new OidcAuthError(
          tokenData.error_description || tokenData.error || "Provider did not grant an access token",
          400
        );
      }
      const profileResp = await fetch(options.userinfoEndpoint, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!profileResp.ok) {
        throw new OidcAuthError("Failed to fetch user profile from provider", 502);
      }
      const normalized = normalizeUserinfo(await profileResp.json(), {
        subjectField,
        loginKeyField: options.loginKeyField,
        requireEmailVerified: options.requireEmailVerified,
      });
      if (!normalized.ok) {
        return errorPage(normalized.error, 400);
      }
      // The userinfo fetch with the fresh access token IS the proof
      // of control; the generic tail binds (issuer, subject) and
      // creates the session. Nothing is persisted before this call.
      return await completeWiredLogin(env, options.issuer, normalized.profile, {
        auditStore: callbackOptions?.auditStore,
        auditTenantId: callbackOptions?.auditTenantId,
        postLoginEnabled: callbackOptions?.postLoginEnabled,
      });
    } catch (err) {
      if (err instanceof OidcAuthError) return errorPage(err.message, err.status);
      const message = err instanceof Error ? err.message : "Unexpected OAuth authentication error";
      return errorPage(message, 500);
    }
  }

  return {
    providerId: options.providerId,
    protocol: "oidc",
    issuer: options.issuer,
    displayName: options.displayName,
    startLogin,
    handleCallback,
  };
}
