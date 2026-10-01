/**
 * E*TRADE Security Layer: OAuth 1.0a Token Lifecycle & Agentic Guardian
 *
 * Implements:
 * - Security Layer: Segregation of cryptographic signatures, token lifecycle, and authentication state.
 * - Aspect-Oriented Protection: Sandbox URL guard, externalized error codes, and audit logging.
 * - Agentic Token Guardian: Proactive token health inspection and autonomous renewal before midnight ET.
 * - W3C DID Attestation: Cryptographic stamping of authentication events.
 */

import type { Env } from "../types";
import { generateOAuth1Header, rfc3986 } from "../services/cryptoUtils";
import { resolveEnvironmentConfig } from "../config/environment";
import { ETradeError, ETradeErrorCode } from "../aspects/errorCodes";
import { withAspects } from "../aspects/loggingAspect";
import { createDidAttestationSync, AGENT_DIDS } from "../agents/did";

export interface ETradeTokenSet {
  accessToken: string;
  accessTokenSecret: string;
  storedAt: string;
  environment: string; // TEST | PROD
  userLogin: string;
}

export interface ETradeRequestTokenResult {
  requestToken: string;
  requestTokenSecret: string;
  authorizeUrl: string;
}

export interface ETradeAuthStatus {
  authenticated: boolean;
  userLogin?: string;
  environment: string;
  storedAt?: string;
  expiresAtEt?: string;
  expired?: boolean;
  renewable?: boolean;
}

// KV key constants — environment-scoped to allow independent TEST and PROD sessions
const KV_ACCESS_TOKEN_KEY = (userLogin: string, envName?: string) =>
  envName ? `etrade:token:${envName.toUpperCase()}:${userLogin}` : `etrade:token:${userLogin}`;
const KV_REQUEST_TOKEN_KEY = (userLogin: string, envName?: string) =>
  envName ? `etrade:req_token:${envName.toUpperCase()}:${userLogin}` : `etrade:req_token:${userLogin}`;

function getKv(env: Env): KVNamespace {
  const kv = (env as any).ETRADE_KV || env.SESSIONS || env.KV;
  if (!kv) {
    throw new ETradeError(
      ETradeErrorCode.INTERNAL_ERROR,
      "No KV namespace configured for E*TRADE token storage. Bind ETRADE_KV or SESSIONS."
    );
  }
  return kv;
}

/**
 * Returns today's midnight in US Eastern time (America/New_York) as UTC timestamp (ms).
 */
export function getMidnightEtUtcMs(referenceDateMs: number = Date.now()): number {
  const etDateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(referenceDateMs));

  for (let utcHour = 3; utcHour <= 6; utcHour++) {
    const candidate = new Date(`${etDateStr}T0${utcHour}:00:00Z`);
    const hourInEt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(candidate);
    if (hourInEt === "0" || hourInEt === "24" || hourInEt === "00") {
      return candidate.getTime();
    }
  }

  return new Date(`${etDateStr}T05:00:00Z`).getTime();
}

/**
 * Checks if a token stored at `storedAtIso` has crossed the midnight US Eastern Time threshold.
 */
export function isTokenExpiredEt(storedAtIso: string, nowMs: number = Date.now()): boolean {
  try {
    const storedDate = new Date(storedAtIso);
    if (isNaN(storedDate.getTime())) return true;

    const storedMidnightMs = getMidnightEtUtcMs(storedDate.getTime());
    const nextMidnightMs = storedMidnightMs + 24 * 3600 * 1000;

    return nowMs >= nextMidnightMs;
  } catch {
    return true;
  }
}

/**
 * Stores confirmed access tokens in KV
 */
export async function storeAccessTokens(
  env: Env,
  userLogin: string,
  accessToken: string,
  accessTokenSecret: string,
  overrideEnv?: string
): Promise<void> {
  const kv = getKv(env);
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  const payload: ETradeTokenSet = {
    accessToken,
    accessTokenSecret,
    storedAt: new Date().toISOString(),
    environment: envConfig.name,
    userLogin,
  };
  await Promise.all([
    kv.put(KV_ACCESS_TOKEN_KEY(userLogin, envConfig.name), JSON.stringify(payload), { expirationTtl: 86400 }),
    kv.put(KV_ACCESS_TOKEN_KEY(userLogin), JSON.stringify(payload), { expirationTtl: 86400 }),
  ]);
}

/**
 * Stores temporary request token secret during 3-legged handshake
 */
export async function storeRequestTokenSecret(
  env: Env,
  userLogin: string,
  requestToken: string,
  requestTokenSecret: string,
  overrideEnv?: string
): Promise<void> {
  const kv = getKv(env);
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  const payload = { requestToken, requestTokenSecret, createdAt: new Date().toISOString() };
  await Promise.all([
    kv.put(KV_REQUEST_TOKEN_KEY(userLogin, envConfig.name), JSON.stringify(payload), { expirationTtl: 900 }),
    kv.put(KV_REQUEST_TOKEN_KEY(userLogin), JSON.stringify(payload), { expirationTtl: 900 }),
  ]);
}

/**
 * Retrieves temporary request token secret
 */
export async function getRequestTokenSecret(
  env: Env,
  userLogin: string,
  overrideEnv?: string
): Promise<{ requestToken: string; requestTokenSecret: string } | null> {
  const kv = getKv(env);
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  const raw =
    (await kv.get(KV_REQUEST_TOKEN_KEY(userLogin, envConfig.name))) ||
    (await kv.get(KV_REQUEST_TOKEN_KEY(userLogin)));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Retrieves stored access tokens for a user from KV
 */
export async function getStoredTokens(
  env: Env,
  userLogin: string,
  overrideEnv?: string
): Promise<ETradeTokenSet | null> {
  const kv = getKv(env);
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  const raw =
    (await kv.get(KV_ACCESS_TOKEN_KEY(userLogin, envConfig.name))) ||
    (await kv.get(KV_ACCESS_TOKEN_KEY(userLogin)));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ETradeTokenSet;
  } catch {
    return null;
  }
}

/**
 * Revokes and deletes stored tokens from KV across all environments
 */
export async function revokeStoredTokens(env: Env, userLogin: string, overrideEnv?: string): Promise<void> {
  const kv = getKv(env);
  const logins = Array.from(new Set([userLogin, userLogin.toLowerCase(), userLogin.toUpperCase()]));
  const deletes: Promise<any>[] = [];
  for (const login of logins) {
    deletes.push(
      kv.delete(KV_ACCESS_TOKEN_KEY(login, "PROD")),
      kv.delete(KV_ACCESS_TOKEN_KEY(login, "TEST")),
      kv.delete(KV_REQUEST_TOKEN_KEY(login, "PROD")),
      kv.delete(KV_REQUEST_TOKEN_KEY(login, "TEST")),
      kv.delete(KV_ACCESS_TOKEN_KEY(login)),
      kv.delete(KV_REQUEST_TOKEN_KEY(login))
    );
  }
  await Promise.all(deletes);
}

/**
 * Step 5: Revoke Access Token Upstream & Purge KV
 * Calls GET /oauth/revoke_access_token on E*TRADE servers and removes session from KV
 */
export async function revokeRemoteAccessToken(
  env: Env,
  userLogin: string,
  overrideEnv?: string
): Promise<{ success: boolean; message: string }> {
  const tokens = await getStoredTokens(env, userLogin, overrideEnv);
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  const consumerKey = envConfig.etrade.apiKey;
  const consumerSecret = envConfig.etrade.apiSecret;

  if (tokens && consumerKey && consumerSecret) {
    const baseUrl = envConfig.etrade.baseUrl.replace(/\/v1\/?$/, "");
    const revokeUrl = `${baseUrl}/oauth/revoke_access_token`;

    try {
      const authHeader = await generateOAuth1Header({
        method: "GET",
        url: revokeUrl,
        consumerKey,
        consumerSecret,
        token: tokens.accessToken,
        tokenSecret: tokens.accessTokenSecret,
      });

      const res = await fetch(revokeUrl, {
        method: "GET",
        headers: {
          Authorization: authHeader,
        },
      });

      console.log(`[ETradeOAuth] revoke_access_token status: ${res.status}`);
    } catch (err) {
      console.warn(`[ETradeOAuth] revoke_access_token upstream fetch error:`, err);
    }
  }

  await revokeStoredTokens(env, userLogin, overrideEnv);
  return { success: true, message: "E*TRADE access token revoked upstream and cleared from storage." };
}

/**
 * Step 1: Request Token
 * Calls GET /oauth/request_token
 */
export async function getETradeRequestToken(
  env: Env,
  userLogin: string,
  callbackUrl?: string,
  overrideEnv?: string
): Promise<ETradeRequestTokenResult> {
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  const consumerKey = envConfig.etrade.apiKey;
  const consumerSecret = envConfig.etrade.apiSecret;

  if (!consumerKey || !consumerSecret) {
    throw new ETradeError(
      ETradeErrorCode.CREDENTIALS_MISSING,
      `E*TRADE API Key and Secret are not configured for [${envConfig.name}]. Ensure ET_API_KEY and ET_API_SECRET are set.`
    );
  }

  // Base URL without /v1 trailing (OAuth 1.0a endpoints live at /oauth/*, not /v1/oauth/*)
  const baseUrl = envConfig.etrade.baseUrl.replace(/\/v1\/?$/, "");
  const requestTokenUrl = `${baseUrl}/oauth/request_token`;

  return withAspects(
    { operationName: "request_token", isLive: envConfig.isLive, targetUrl: requestTokenUrl },
    async () => {
      const extraParams: Record<string, string> = {
        oauth_callback: callbackUrl || "oob",
      };

      const authHeader = await generateOAuth1Header({
        method: "GET",
        url: requestTokenUrl,
        consumerKey,
        consumerSecret,
        extraParams,
      });

      const res = await fetch(requestTokenUrl, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/x-www-form-urlencoded",
        },
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        const isLiveProd = envConfig.isLive;
        const diagnosticNote =
          res.status === 401 && isLiveProd
            ? " — E*TRADE Production Gateway (api.etrade.com) rejected credentials. If your ET_API_KEY is a Sandbox key, switch environment to TEST. Live production requires an approved Morgan Stanley Production Key & Secret."
            : "";
        throw new ETradeError(
          ETradeErrorCode.UPSTREAM_ERROR,
          `E*TRADE request_token failed [HTTP ${res.status}]${diagnosticNote}: ${errorBody.slice(0, 300)}`
        );
      }

      const responseBody = await res.text();
      const params = new URLSearchParams(responseBody);
      const requestToken = params.get("oauth_token");
      const requestTokenSecret = params.get("oauth_token_secret");

      if (!requestToken || !requestTokenSecret) {
        throw new ETradeError(
          ETradeErrorCode.UPSTREAM_ERROR,
          `Invalid response from E*TRADE request_token: missing oauth_token in ${responseBody}`
        );
      }

      await storeRequestTokenSecret(env, userLogin, requestToken, requestTokenSecret, overrideEnv);

      const authorizeUrl = `https://us.etrade.com/e/t/etws/authorize?key=${encodeURIComponent(
        consumerKey
      )}&token=${encodeURIComponent(requestToken)}`;

      return { requestToken, requestTokenSecret, authorizeUrl };
    }
  );
}

/**
 * Step 3: Exchange Verifier for Access Token
 * Calls GET /oauth/access_token
 */
export async function exchangeETradeVerifier(
  env: Env,
  userLogin: string,
  verifier: string,
  explicitRequestToken?: string,
  explicitRequestTokenSecret?: string,
  overrideEnv?: string
): Promise<ETradeTokenSet> {
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  const consumerKey = envConfig.etrade.apiKey;
  const consumerSecret = envConfig.etrade.apiSecret;

  if (!consumerKey || !consumerSecret) {
    throw new ETradeError(ETradeErrorCode.CREDENTIALS_MISSING);
  }

  let requestToken = explicitRequestToken;
  let requestTokenSecret = explicitRequestTokenSecret;

  if (!requestToken || !requestTokenSecret) {
    const stored = await getRequestTokenSecret(env, userLogin, overrideEnv);
    if (!stored) {
      throw new ETradeError(
        ETradeErrorCode.AUTH_REQUIRED,
        "No active E*TRADE request token found for this session. Please start authorization again."
      );
    }
    requestToken = stored.requestToken;
    requestTokenSecret = stored.requestTokenSecret;
  }

  const baseUrl = envConfig.etrade.baseUrl.replace(/\/v1\/?$/, "");
  const accessTokenUrl = `${baseUrl}/oauth/access_token`;

  return withAspects(
    { operationName: "access_token", isLive: envConfig.isLive, targetUrl: accessTokenUrl },
    async () => {
      const authHeader = await generateOAuth1Header({
        method: "GET",
        url: accessTokenUrl,
        consumerKey,
        consumerSecret,
        token: requestToken,
        tokenSecret: requestTokenSecret,
        extraParams: { oauth_verifier: verifier.trim() },
      });

      const res = await fetch(accessTokenUrl, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/x-www-form-urlencoded",
        },
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new ETradeError(
          ETradeErrorCode.UPSTREAM_ERROR,
          `E*TRADE access_token exchange failed [HTTP ${res.status}]: ${errorBody.slice(0, 300)}`
        );
      }

      const responseBody = await res.text();
      const params = new URLSearchParams(responseBody);
      const accessToken = params.get("oauth_token");
      const accessTokenSecret = params.get("oauth_token_secret");

      if (!accessToken || !accessTokenSecret) {
        throw new ETradeError(
          ETradeErrorCode.UPSTREAM_ERROR,
          `E*TRADE access_token response missing tokens: ${responseBody.slice(0, 200)}`
        );
      }

      await storeAccessTokens(env, userLogin, accessToken, accessTokenSecret, overrideEnv);

      return {
        accessToken,
        accessTokenSecret,
        storedAt: new Date().toISOString(),
        environment: envConfig.name,
        userLogin,
      };
    }
  );
}

/**
 * Step 4: Renew Access Token before midnight ET expiry
 * Calls GET /oauth/renew_access_token
 */
export async function renewETradeAccessToken(
  env: Env,
  userLogin: string,
  overrideEnv?: string
): Promise<ETradeTokenSet | null> {
  const tokens = await getStoredTokens(env, userLogin, overrideEnv);
  if (!tokens) return null;

  if (isTokenExpiredEt(tokens.storedAt)) {
    console.warn(`Cannot renew E*TRADE token for ${userLogin}: already expired past midnight ET.`);
    await revokeStoredTokens(env, userLogin, overrideEnv);
    return null;
  }

  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  const consumerKey = envConfig.etrade.apiKey;
  const consumerSecret = envConfig.etrade.apiSecret;

  if (!consumerKey || !consumerSecret) return null;

  const baseUrl = envConfig.etrade.baseUrl.replace(/\/v1\/?$/, "");
  const renewUrl = `${baseUrl}/oauth/renew_access_token`;

  return withAspects(
    { operationName: "renew_access_token", isLive: envConfig.isLive, targetUrl: renewUrl },
    async () => {
      const authHeader = await generateOAuth1Header({
        method: "GET",
        url: renewUrl,
        consumerKey,
        consumerSecret,
        token: tokens.accessToken,
        tokenSecret: tokens.accessTokenSecret,
      });

      const res = await fetch(renewUrl, {
        method: "GET",
        headers: {
          Authorization: authHeader,
        },
      });

      if (!res.ok) {
        console.warn(`E*TRADE renew_access_token failed [HTTP ${res.status}] for ${userLogin}`);
        return null;
      }

      const renewedTokens: ETradeTokenSet = {
        ...tokens,
        storedAt: new Date().toISOString(),
        environment: envConfig.name,
      };
      await storeAccessTokens(env, userLogin, renewedTokens.accessToken, renewedTokens.accessTokenSecret, overrideEnv);
      return renewedTokens;
    }
  );
}

/**
 * Returns a valid token set for a user.
 */
export async function getValidTokens(
  env: Env,
  userLogin: string,
  overrideEnv?: string
): Promise<ETradeTokenSet | null> {
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  if (envConfig.etrade.oauthToken && envConfig.etrade.oauthTokenSecret) {
    return {
      accessToken: envConfig.etrade.oauthToken,
      accessTokenSecret: envConfig.etrade.oauthTokenSecret,
      storedAt: new Date().toISOString(),
      environment: envConfig.name,
      userLogin,
    };
  }

  const kv = getKv(env);
  const scopedKey = KV_ACCESS_TOKEN_KEY(userLogin, envConfig.name);
  let raw = await kv.get(scopedKey);
  let tokens: ETradeTokenSet | null = null;

  if (raw) {
    try { tokens = JSON.parse(raw); } catch {}
  }

  // If not found in environment-scoped key, check unscoped fallback key
  if (!tokens) {
    const legacyRaw = await kv.get(KV_ACCESS_TOKEN_KEY(userLogin));
    if (legacyRaw) {
      try {
        const parsed = JSON.parse(legacyRaw) as ETradeTokenSet;
        if (!parsed.environment || parsed.environment.toUpperCase() === envConfig.name.toUpperCase()) {
          tokens = parsed;
          // Adopt active token for current environment in KV so future reads are instantaneous
          await kv.put(scopedKey, JSON.stringify({ ...parsed, environment: envConfig.name }), { expirationTtl: 86400 });
        }
      } catch {}
    }
  }

  if (!tokens) return null;

  if (isTokenExpiredEt(tokens.storedAt)) {
    console.warn(`E*TRADE tokens for ${userLogin} expired at midnight ET.`);
    await revokeStoredTokens(env, userLogin, overrideEnv);
    return null;
  }

  return tokens;
}

/**
 * Returns full authentication status for E*TRADE for a given user
 */
export async function getETradeAuthStatus(
  env: Env,
  userLogin: string,
  overrideEnv?: string
): Promise<ETradeAuthStatus> {
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  const valid = await getValidTokens(env, userLogin, overrideEnv);

  if (!valid) {
    const hasStatic = Boolean(envConfig.etrade.oauthToken && envConfig.etrade.oauthTokenSecret);
    return {
      authenticated: hasStatic,
      userLogin,
      environment: envConfig.name,
    };
  }

  return {
    authenticated: true,
    userLogin,
    environment: envConfig.name,
    storedAt: valid.storedAt,
    expired: false,
    renewable: true,
  };
}

/**
 * Agentic Token Guardian: Autonomous Token Health & Renewal Observer
 */
export class ETradeTokenGuardian {
  constructor(private env: Env, private userLogin: string, private overrideEnv?: string) {}

  async checkHealth(): Promise<{ status: ETradeAuthStatus; actionRecommended: string }> {
    const status = await getETradeAuthStatus(this.env, this.userLogin, this.overrideEnv);

    if (!status.authenticated) {
      return {
        status,
        actionRecommended: "INITIATE_OAUTH_FLOW",
      };
    }

    if (status.expired) {
      return {
        status,
        actionRecommended: "RE_AUTHENTICATE",
      };
    }

    return {
      status,
      actionRecommended: "TOKEN_ACTIVE",
    };
  }

  async ensureActiveToken(): Promise<ETradeTokenSet> {
    const valid = await getValidTokens(this.env, this.userLogin, this.overrideEnv);
    if (!valid) {
      throw new ETradeError(ETradeErrorCode.AUTH_REQUIRED);
    }
    return valid;
  }
}
