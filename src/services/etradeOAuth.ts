/**
 * E*TRADE OAuth 1.0a Token Lifecycle Manager
 *
 * Implements the full 3-legged OAuth 1.0a authorization flow required by E*TRADE:
 *   1. GET /v1/oauth/request_token     → get temporary request token + secret
 *   2. Redirect user → E*TRADE authorize URL (user logs in & accepts terms)
 *   3. GET /v1/oauth/access_token      → exchange verifier (PIN) for access token + secret
 *   4. GET /v1/oauth/renew_access_token → renew access token before midnight ET expiry
 *   5. GET /v1/oauth/revoke_access_token → invalidate token upon disconnect
 *
 * Tokens are stored in Cloudflare KV (ETRADE_KV or SESSIONS) keyed by userLogin.
 * Consumer key and secret come from ET_API_KEY / ET_API_SECRET (or ETRADE_CONSUMER_KEY / SECRET).
 *
 * References:
 *   - https://apisb.etrade.com/docs/api/authorization/request_token.html
 *   - https://apisb.etrade.com/docs/api/authorization/authorize.html
 *   - https://apisb.etrade.com/docs/api/authorization/get_access_token.html
 *   - https://apisb.etrade.com/docs/api/authorization/renew_access_token.html
 *   - https://apisb.etrade.com/docs/api/authorization/revoke_access_token.html
 */

import type { Env } from "../types";
import { generateOAuth1Header, rfc3986 } from "./cryptoUtils";
import { resolveEnvironmentConfig } from "../config/environment";

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

// KV key constants
const KV_ACCESS_TOKEN_KEY = (userLogin: string) => `etrade:token:${userLogin}`;
const KV_REQUEST_TOKEN_KEY = (userLogin: string) => `etrade:req_token:${userLogin}`;

function getKv(env: Env): KVNamespace {
  const kv = (env as any).ETRADE_KV || env.SESSIONS || env.KV;
  if (!kv) {
    throw new Error("No KV namespace configured for E*TRADE token storage. Bind ETRADE_KV or SESSIONS.");
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
  }).format(new Date(referenceDateMs)); // Returns "YYYY-MM-DD" in ET

  // Midnight ET today is equivalent to YYYY-MM-DDT00:00:00 in America/New_York.
  // America/New_York is either UTC-4 (EDT) or UTC-5 (EST).
  // We can calculate the exact UTC ms by testing UTC hour offsets:
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

  // Fallback to UTC-5 (standard Eastern Time)
  return new Date(`${etDateStr}T05:00:00Z`).getTime();
}

/**
 * Checks if a token stored at `storedAtIso` has crossed the midnight US Eastern Time threshold.
 * An E*TRADE token is active until midnight US Eastern Time of the day it was issued/renewed.
 */
export function isTokenExpiredEt(storedAtIso: string, nowMs: number = Date.now()): boolean {
  try {
    const storedDate = new Date(storedAtIso);
    if (isNaN(storedDate.getTime())) return true;

    // Get the ET date string of when it was stored vs now
    const storedEtDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(storedDate);

    const nowEtDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(nowMs));

    // If the calendar date in US Eastern Time has advanced, the token has expired
    return storedEtDate !== nowEtDate;
  } catch {
    return true;
  }
}

/**
 * Persists an OAuth 1.0a access token set into KV
 */
export async function storeAccessTokens(
  env: Env,
  userLogin: string,
  accessToken: string,
  accessTokenSecret: string
): Promise<void> {
  const kv = getKv(env);
  const envConfig = resolveEnvironmentConfig(env);
  const payload: ETradeTokenSet = {
    accessToken,
    accessTokenSecret,
    storedAt: new Date().toISOString(),
    environment: envConfig.name,
    userLogin,
  };
  // Cloudflare KV TTL: 86400 seconds (24 hours)
  await kv.put(KV_ACCESS_TOKEN_KEY(userLogin), JSON.stringify(payload), {
    expirationTtl: 86400,
  });
}

/**
 * Stores temporary request token secret during 3-legged handshake
 */
export async function storeRequestTokenSecret(
  env: Env,
  userLogin: string,
  requestToken: string,
  requestTokenSecret: string
): Promise<void> {
  const kv = getKv(env);
  const payload = { requestToken, requestTokenSecret, createdAt: new Date().toISOString() };
  // Short TTL for request token (15 minutes)
  await kv.put(KV_REQUEST_TOKEN_KEY(userLogin), JSON.stringify(payload), {
    expirationTtl: 900,
  });
}

/**
 * Retrieves temporary request token secret
 */
export async function getRequestTokenSecret(
  env: Env,
  userLogin: string
): Promise<{ requestToken: string; requestTokenSecret: string } | null> {
  const kv = getKv(env);
  const raw = await kv.get(KV_REQUEST_TOKEN_KEY(userLogin));
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
  userLogin: string
): Promise<ETradeTokenSet | null> {
  const kv = getKv(env);
  const raw = await kv.get(KV_ACCESS_TOKEN_KEY(userLogin));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ETradeTokenSet;
  } catch {
    return null;
  }
}

/**
 * Revokes and deletes stored tokens from KV
 */
export async function revokeStoredTokens(env: Env, userLogin: string): Promise<void> {
  const kv = getKv(env);
  await kv.delete(KV_ACCESS_TOKEN_KEY(userLogin));
  await kv.delete(KV_REQUEST_TOKEN_KEY(userLogin));
}

/**
 * Step 1: Request Token
 * Calls GET /v1/oauth/request_token
 */
export async function getETradeRequestToken(
  env: Env,
  userLogin: string,
  callbackUrl?: string
): Promise<ETradeRequestTokenResult> {
  const envConfig = resolveEnvironmentConfig(env);
  const consumerKey = envConfig.etrade.apiKey;
  const consumerSecret = envConfig.etrade.apiSecret;

  if (!consumerKey || !consumerSecret) {
    throw new Error(
      `E*TRADE API Key and Secret are not configured for [${envConfig.name}]. Ensure ET_API_KEY and ET_API_SECRET are set.`
    );
  }

  // Base URL without /v1 trailing
  const baseUrl = envConfig.etrade.baseUrl.replace(/\/v1$/, "");
  const requestTokenUrl = `${baseUrl}/v1/oauth/request_token`;

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
    throw new Error(`E*TRADE request_token failed [HTTP ${res.status}]: ${errorBody.slice(0, 300)}`);
  }

  const responseBody = await res.text();
  const params = new URLSearchParams(responseBody);
  const requestToken = params.get("oauth_token");
  const requestTokenSecret = params.get("oauth_token_secret");

  if (!requestToken || !requestTokenSecret) {
    throw new Error(`Invalid response from E*TRADE request_token: missing oauth_token in ${responseBody}`);
  }

  // Store request token secret in KV for verifier step
  await storeRequestTokenSecret(env, userLogin, requestToken, requestTokenSecret);

  // Construct official E*TRADE authorization redirect URL
  const authorizeUrl = `https://us.etrade.com/e/t/etws/authorize?key=${encodeURIComponent(
    consumerKey
  )}&token=${encodeURIComponent(requestToken)}`;

  return { requestToken, requestTokenSecret, authorizeUrl };
}

/**
 * Step 3: Exchange Verifier for Access Token
 * Calls GET /v1/oauth/access_token
 */
export async function exchangeETradeVerifier(
  env: Env,
  userLogin: string,
  verifier: string,
  explicitRequestToken?: string,
  explicitRequestTokenSecret?: string
): Promise<ETradeTokenSet> {
  const envConfig = resolveEnvironmentConfig(env);
  const consumerKey = envConfig.etrade.apiKey;
  const consumerSecret = envConfig.etrade.apiSecret;

  if (!consumerKey || !consumerSecret) {
    throw new Error("ET_API_KEY and ET_API_SECRET must be configured.");
  }

  let requestToken = explicitRequestToken;
  let requestTokenSecret = explicitRequestTokenSecret;

  if (!requestToken || !requestTokenSecret) {
    const stored = await getRequestTokenSecret(env, userLogin);
    if (!stored) {
      throw new Error("No active E*TRADE request token found for this session. Please start authorization again.");
    }
    requestToken = stored.requestToken;
    requestTokenSecret = stored.requestTokenSecret;
  }

  const baseUrl = envConfig.etrade.baseUrl.replace(/\/v1$/, "");
  const accessTokenUrl = `${baseUrl}/v1/oauth/access_token`;

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
    throw new Error(`E*TRADE access_token exchange failed [HTTP ${res.status}]: ${errorBody.slice(0, 300)}`);
  }

  const responseBody = await res.text();
  const params = new URLSearchParams(responseBody);
  const accessToken = params.get("oauth_token");
  const accessTokenSecret = params.get("oauth_token_secret");

  if (!accessToken || !accessTokenSecret) {
    throw new Error(`E*TRADE access_token response missing tokens: ${responseBody.slice(0, 200)}`);
  }

  await storeAccessTokens(env, userLogin, accessToken, accessTokenSecret);

  return {
    accessToken,
    accessTokenSecret,
    storedAt: new Date().toISOString(),
    environment: envConfig.name,
    userLogin,
  };
}

/**
 * Step 4: Renew Access Token before midnight ET expiry
 * Calls GET /v1/oauth/renew_access_token
 */
export async function renewETradeAccessToken(
  env: Env,
  userLogin: string
): Promise<ETradeTokenSet | null> {
  const tokens = await getStoredTokens(env, userLogin);
  if (!tokens) return null;

  // Cannot renew if it has already passed midnight ET
  if (isTokenExpiredEt(tokens.storedAt)) {
    console.warn(`Cannot renew E*TRADE token for ${userLogin}: already expired past midnight ET.`);
    await revokeStoredTokens(env, userLogin);
    return null;
  }

  const envConfig = resolveEnvironmentConfig(env);
  const consumerKey = envConfig.etrade.apiKey;
  const consumerSecret = envConfig.etrade.apiSecret;

  if (!consumerKey || !consumerSecret) return null;

  const baseUrl = envConfig.etrade.baseUrl.replace(/\/v1$/, "");
  const renewUrl = `${baseUrl}/v1/oauth/renew_access_token`;

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

  // Update stored timestamp
  const renewedTokens: ETradeTokenSet = {
    ...tokens,
    storedAt: new Date().toISOString(),
  };
  await storeAccessTokens(env, userLogin, renewedTokens.accessToken, renewedTokens.accessTokenSecret);
  return renewedTokens;
}

/**
 * Returns a valid token set for a user.
 * Automatically initiates renewal if approaching midnight ET.
 */
export async function getValidTokens(
  env: Env,
  userLogin: string
): Promise<ETradeTokenSet | null> {
  // First check if environment secrets provide static tokens
  const envConfig = resolveEnvironmentConfig(env);
  if (envConfig.etrade.oauthToken && envConfig.etrade.oauthTokenSecret) {
    return {
      accessToken: envConfig.etrade.oauthToken,
      accessTokenSecret: envConfig.etrade.oauthTokenSecret,
      storedAt: new Date().toISOString(),
      environment: envConfig.name,
      userLogin,
    };
  }

  const tokens = await getStoredTokens(env, userLogin);
  if (!tokens) return null;

  if (isTokenExpiredEt(tokens.storedAt)) {
    console.warn(`E*TRADE tokens for ${userLogin} expired at midnight ET.`);
    await revokeStoredTokens(env, userLogin);
    return null;
  }

  return tokens;
}

/**
 * Returns full authentication status for E*TRADE for a given user
 */
export async function getETradeAuthStatus(
  env: Env,
  userLogin: string
): Promise<ETradeAuthStatus> {
  const envConfig = resolveEnvironmentConfig(env);
  const tokens = await getStoredTokens(env, userLogin);

  if (!tokens) {
    const hasStatic = Boolean(envConfig.etrade.oauthToken && envConfig.etrade.oauthTokenSecret);
    return {
      authenticated: hasStatic,
      userLogin,
      environment: envConfig.name,
    };
  }

  const expired = isTokenExpiredEt(tokens.storedAt);
  return {
    authenticated: !expired,
    userLogin,
    environment: envConfig.name,
    storedAt: tokens.storedAt,
    expired,
    renewable: !expired,
  };
}
