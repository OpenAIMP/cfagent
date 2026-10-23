/**
 * Shared OAuth 2.1 core (issue #1247, owner consolidation directive
 * 2026-10-23).
 *
 * The codebase's existing OAuth flows each hand-roll their protocol
 * mechanics inline: githubOAuth.ts posts its exchange form in place,
 * the generic OIDC factory (oidcProvider.ts) does the same, and
 * E*TRADE speaks OAuth 1.0a (a different protocol — out of scope
 * here). None of them needs PKCE, RFC 8414 discovery, or a refresh
 * grant, so none of those mechanics existed anywhere when the Public
 * resource provider (publicOAuth.ts) needed all three.
 *
 * This module is where those mechanics now live, written ONCE,
 * provider-agnostically, so the next OAuth2 resource provider reuses
 * them instead of growing a fourth inline copy:
 *
 *   - PKCE S256 (verifier generation + challenge derivation)
 *   - RFC 8414 authorization-server metadata fetching (both the
 *     path-inserted and root well-known forms), with the S256
 *     requirement enforced and remote-supplied URLs restricted to
 *     https
 *   - RFC 9728 protected-resource discovery (the 401
 *     WWW-Authenticate resource_metadata elicitation an MCP resource
 *     server performs) feeding the RFC 8414 fetch
 *   - authorization-URL building (incl. RFC 8707 resource indicators)
 *   - the authorization-code exchange and refresh grants (form posts
 *     for PUBLIC clients: token_endpoint_auth_method "none", no
 *     client secret) and token-response parsing
 *
 * Deliberately NOT done in this slice (consolidation residual, named
 * in #1247's report): migrating githubOAuth.ts / oidcProvider.ts onto
 * this core. Their flows are pinned by their own suites and use
 * confidential-client exchanges (client_secret in the form); the
 * grant helper below would need a credentials variant before either
 * could adopt it without behaviour change.
 *
 * CSRF state is NOT re-implemented here: session.ts createState /
 * verifyState is the established primitive and callers use it.
 */

/** The metadata this module consumes from an RFC 8414 document. */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  scopes_supported?: string[];
}

/** A parsed OAuth2 token-grant response. */
export interface OAuth2TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry (ms epoch) when the response carried expires_in. */
  expiresAt?: number;
}

export class OAuth2Error extends Error {
  readonly status?: number;
  readonly errorCode?: string;
  constructor(message: string, status?: number, errorCode?: string) {
    super(message);
    this.name = "OAuth2Error";
    this.status = status;
    this.errorCode = errorCode;
  }
}

type FetchImpl = typeof fetch;

/* ------------------------------ helpers ---------------------------- */

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** True for absolute https: URLs only. Used to validate remote-supplied discovery URLs. */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchJson(
  url: string,
  fetchImpl: FetchImpl,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text.trim() ? JSON.parse(text) : null;
  } catch {
    /* caller decides what to do with text */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/* -------------------------------- PKCE ------------------------------ */

/** PKCE S256 challenge for a verifier: base64url(SHA-256(verifier)). */
export async function pkceChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64Url(new Uint8Array(digest));
}

/** A fresh PKCE pair (256-bit verifier, hex — a valid verifier charset). */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomHex(32);
  return { verifier, challenge: await pkceChallengeFor(verifier) };
}

/* ------------------------------ discovery --------------------------- */

/**
 * Fetch an authorization server's RFC 8414 metadata document,
 * trying the path-inserted form then the root form. Enforces the
 * PKCE S256 requirement: an AS that cannot do S256 is refused, not
 * downgraded to plain.
 */
export async function fetchAuthorizationServerMetadata(
  issuer: string,
  fetchImpl: FetchImpl = fetch
): Promise<AuthorizationServerMetadata> {
  if (!isHttpsUrl(issuer)) {
    throw new OAuth2Error("The authorization server issuer is not an HTTPS URL.");
  }
  const candidates = issuer.endsWith("/")
    ? [`${issuer}.well-known/oauth-authorization-server`]
    : [
        `${issuer}/.well-known/oauth-authorization-server`,
        `${new URL(issuer).origin}/.well-known/oauth-authorization-server${new URL(issuer).pathname}`,
      ];
  for (const candidate of candidates) {
    const meta = await fetchJson(candidate, fetchImpl);
    if (meta.ok && meta.json?.authorization_endpoint && meta.json?.token_endpoint) {
      const parsed = meta.json as AuthorizationServerMetadata;
      if (
        parsed.code_challenge_methods_supported &&
        !parsed.code_challenge_methods_supported.includes("S256")
      ) {
        throw new OAuth2Error(
          "The authorization server does not support the required PKCE S256 method."
        );
      }
      return parsed;
    }
  }
  throw new OAuth2Error("Could not fetch the authorization server's metadata document.");
}

/**
 * Discover the authorization server for a protected resource
 * (RFC 9728): a bare POST elicits the 401 WWW-Authenticate challenge
 * naming the resource-metadata document; that document names the
 * authorization server(s); the first one's RFC 8414 metadata is
 * returned. Remote-supplied URLs are followed over https only.
 */
export async function discoverAuthorizationServerFromResource(
  resourceUrl: string,
  fetchImpl: FetchImpl = fetch
): Promise<AuthorizationServerMetadata> {
  const challenge = await fetchImpl(resourceUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const www = challenge.headers.get("www-authenticate") || "";
  const match = /resource_metadata="([^"]+)"/.exec(www);
  if (!match) {
    throw new OAuth2Error(
      "The resource server did not advertise OAuth resource metadata (WWW-Authenticate)."
    );
  }
  if (!isHttpsUrl(match[1])) {
    throw new OAuth2Error("The resource server advertised a non-HTTPS resource metadata URL.");
  }
  const prm = await fetchJson(match[1], fetchImpl);
  if (
    !prm.ok ||
    !Array.isArray(prm.json?.authorization_servers) ||
    !prm.json.authorization_servers.length
  ) {
    throw new OAuth2Error("The resource metadata lists no authorization server.");
  }
  const issuer: string = prm.json.authorization_servers[0];
  if (!isHttpsUrl(issuer)) {
    throw new OAuth2Error("The resource metadata advertised a non-HTTPS authorization server issuer.");
  }
  return fetchAuthorizationServerMetadata(issuer, fetchImpl);
}

/* --------------------------- authorize URL -------------------------- */

export interface AuthorizationUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string;
  /** RFC 8707 resource indicator pinning the grant to one resource server. */
  resource?: string;
}

export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(params.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.scopes) url.searchParams.set("scope", params.scopes);
  if (params.resource) url.searchParams.set("resource", params.resource);
  return url.toString();
}

/* ----------------------------- token grants ------------------------- */

interface TokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

function parseTokenResponse(body: TokenResponseBody): OAuth2TokenSet {
  if (!body?.access_token) {
    throw new OAuth2Error(
      "The token endpoint returned no access_token: " +
        (body?.error_description || body?.error || "unexpected response").slice(0, 200),
      undefined,
      body?.error
    );
  }
  const expiresIn =
    typeof body.expires_in === "string" ? parseInt(body.expires_in, 10) : body.expires_in;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || undefined,
    expiresAt:
      typeof expiresIn === "number" && Number.isFinite(expiresIn)
        ? Date.now() + expiresIn * 1000
        : undefined,
  };
}

async function postTokenGrant(
  tokenEndpoint: string,
  form: URLSearchParams,
  fetchImpl: FetchImpl,
  failureLabel: string
): Promise<OAuth2TokenSet> {
  const res = await fetchJson(tokenEndpoint, fetchImpl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new OAuth2Error(
      `${failureLabel} failed (${res.status}): ` +
        (res.json?.error_description || res.json?.error || res.text.slice(0, 200)),
      res.status,
      res.json?.error
    );
  }
  return parseTokenResponse(res.json as TokenResponseBody);
}

/**
 * Authorization-code exchange for a PUBLIC client (PKCE instead of a
 * secret: no client_secret is ever sent).
 */
export async function exchangeAuthorizationCode(
  params: {
    tokenEndpoint: string;
    code: string;
    redirectUri: string;
    clientId: string;
    codeVerifier: string;
  },
  fetchImpl: FetchImpl = fetch
): Promise<OAuth2TokenSet> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  return postTokenGrant(params.tokenEndpoint, form, fetchImpl, "The authorization code exchange");
}

/**
 * Refresh grant. A refresh response may omit a new refresh_token; the
 * current one is kept in that case (it remains valid until rotated).
 */
export async function refreshAccessToken(
  params: { tokenEndpoint: string; refreshToken: string; clientId: string },
  fetchImpl: FetchImpl = fetch
): Promise<OAuth2TokenSet> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
  const next = await postTokenGrant(params.tokenEndpoint, form, fetchImpl, "The refresh grant");
  if (!next.refreshToken) next.refreshToken = params.refreshToken;
  return next;
}
