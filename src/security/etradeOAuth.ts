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
import {
  invalidateTokenCacheFor,
  readTokenCache,
  tokenCacheEpoch,
  tokenCacheKey,
  writeTokenCache,
} from "./etradeTokenCache";
import { consumeStoreKey, createStoreKv, listStoreEntries, type DoNamespaceLike } from "./durableKv";
import { type KvLike } from "./kvResilience";
import { lookupLoginByUserId } from "./iaaaMigration";
import { sessionStore } from "./session";
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

// Token storage key constants (SessionStore DO keys; the KV_ identifier
// names predate the #329 move off Workers KV) — environment-scoped to
// allow independent TEST and PROD sessions
const KV_ACCESS_TOKEN_KEY = (userLogin: string, envName?: string) =>
  envName ? `etrade:token:${envName.toUpperCase()}:${userLogin}` : `etrade:token:${userLogin}`;
const KV_REQUEST_TOKEN_KEY = (userLogin: string, envName?: string) =>
  envName ? `etrade:req_token:${envName.toUpperCase()}:${userLogin}` : `etrade:req_token:${userLogin}`;

/**
 * Issue #1759 — identity-aware token reads (the token half of the
 * alias-forever + dual-read cutover decision). Callers that know
 * the session's internalUserId pass it; callers that do not behave
 * exactly as before. The identity is NEVER user-supplied at the
 * route layer: it must come from the verified session, or the
 * lookup is a cross-principal read. A caller passing another
 * user's internal id would read that user's token — the same
 * trust rule as passing another user's login today.
 */
export interface ETradeTokenIdentity {
  internalUserId?: string;
}

/**
 * The alias login for an internal user, best-effort: the alias
 * lives in the sessions namespace while tokens live in the etrade
 * namespace (same DO, different ns). Any store failure yields null
 * and the caller falls back to login-only keys — an alias-store
 * blip must never break token reads.
 */
async function resolveAliasLogin(
  env: Env,
  internalUserId?: string,
): Promise<string | null> {
  if (!internalUserId) return null;
  try {
    return await lookupLoginByUserId(sessionStore(env), internalUserId);
  } catch {
    return null;
  }
}

/**
 * Ordered candidate keys for one token read. Internal-id scoped
 * first (the primary for identity-aware writes), then the alias
 * login (the pre-rename key — this is what makes a rename
 * reachable), then the current login, then the unscoped variants
 * in the same order. The pre-#1759 order (scoped login, then
 * unscoped login) is preserved as a subsequence for
 * identity-less callers. A corrupt candidate never blocks a
 * healthy fallback: callers skip unparseable values.
 */
function tokenCandidateKeys(
  keyFn: (login: string, envName?: string) => string,
  userLogin: string,
  envName: string | undefined,
  identity: ETradeTokenIdentity | undefined,
  aliasLogin: string | null,
): string[] {
  const keys: string[] = [];
  const push = (key: string) => {
    if (!keys.includes(key)) keys.push(key);
  };
  if (identity?.internalUserId) push(keyFn(identity.internalUserId, envName));
  if (aliasLogin) push(keyFn(aliasLogin, envName));
  push(keyFn(userLogin, envName));
  if (aliasLogin) push(keyFn(aliasLogin));
  push(keyFn(userLogin));
  return keys;
}

async function readFirstParsable<T>(
  kv: KvLike,
  keys: readonly string[],
  parse: (raw: string) => T | null,
): Promise<T | null> {
  for (const key of keys) {
    const raw = await kv.get(key);
    if (!raw) continue;
    const parsed = parse(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Token storage, moved off KV (issue #329).
 *
 * Same reasoning as sessions: a KV quota throw here surfaced as a 1101 on any
 * E*TRADE route. Tokens live in the SessionStore DO; the legacy KV fallback
 * was removed in #604 (migration window passed). Auth material stays in the
 * DO — never moves back to KV.
 */
function getKv(env: Env): KvLike {
  return createStoreKv({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "etrade",
    legacyFallback: false,
  });
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
 * Stores confirmed access tokens in the SessionStore DO
 */
export async function storeAccessTokens(
  env: Env,
  userLogin: string,
  accessToken: string,
  accessTokenSecret: string,
  overrideEnv?: string,
  identity?: ETradeTokenIdentity
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
  // Issue #329 P3: only the environment-scoped key is written. The unscoped
  // legacy key is still *read* (getValidTokens falls back to it once, to migrate
  // older tokens), but writing it doubled every store for a key nothing new
  // depends on.
  await kv.put(KV_ACCESS_TOKEN_KEY(userLogin, envConfig.name), JSON.stringify(payload), {
    expirationTtl: 86400,
  });
  // Issue #1759: when the caller's internal id is known, the same
  // token also lands under the internal-id scoped key — the
  // primary key for identity-aware reads. This is dual-read's
  // primary, not a replacement for the alias fallback: tokens
  // stored BEFORE any identity was known are still reachable only
  // via the alias login (see getStoredTokens).
  if (identity?.internalUserId) {
    await kv.put(
      KV_ACCESS_TOKEN_KEY(identity.internalUserId, envConfig.name),
      JSON.stringify(payload),
      { expirationTtl: 86400 },
    );
  }
  // Issue #329 follow-up: a fresh token must never be shadowed by a cached copy.
  invalidateTokenCacheFor(userLogin);
  if (identity?.internalUserId) invalidateTokenCacheFor(identity.internalUserId);
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
  overrideEnv?: string,
  identity?: ETradeTokenIdentity
): Promise<{ requestToken: string; requestTokenSecret: string } | null> {
  const kv = getKv(env);
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  // Issue #1759: dual-read. Request secrets are 15-minute handshake
  // state, so they are NOT dual-written (no long-lived key to
  // migrate); the alias fallback is what makes a secret issued
  // under a pre-rename login reachable at all.
  const aliasLogin = await resolveAliasLogin(env, identity?.internalUserId);
  return readFirstParsable(
    kv,
    tokenCandidateKeys(
      KV_REQUEST_TOKEN_KEY,
      userLogin,
      envConfig.name,
      identity,
      aliasLogin,
    ),
    (raw) => {
      try {
        return JSON.parse(raw) as { requestToken: string; requestTokenSecret: string };
      } catch {
        return null;
      }
    },
  );
}

/**
 * Retrieves stored access tokens for a user from the SessionStore DO
 */
export async function getStoredTokens(
  env: Env,
  userLogin: string,
  overrideEnv?: string,
  identity?: ETradeTokenIdentity
): Promise<ETradeTokenSet | null> {
  const kv = getKv(env);
  const envConfig = resolveEnvironmentConfig(env, overrideEnv);
  // Issue #1759: dual-read. Without an identity this is exactly
  // the pre-#1759 read (scoped login, then unscoped login). With
  // one, the internal-id key is primary and the alias login is
  // the fallback that keeps pre-rename tokens reachable.
  const aliasLogin = await resolveAliasLogin(env, identity?.internalUserId);
  return readFirstParsable(
    kv,
    tokenCandidateKeys(
      KV_ACCESS_TOKEN_KEY,
      userLogin,
      envConfig.name,
      identity,
      aliasLogin,
    ),
    (raw) => {
      try {
        return JSON.parse(raw) as ETradeTokenSet;
      } catch {
        return null;
      }
    },
  );
}

/**
 * Revokes and deletes stored tokens from the SessionStore DO across all environments
 */
export async function revokeStoredTokens(env: Env, userLogin: string, overrideEnv?: string, identity?: ETradeTokenIdentity): Promise<void> {
  const kv = getKv(env);
  const logins = Array.from(new Set([userLogin, userLogin.toLowerCase(), userLogin.toUpperCase()]));
  // Issue #1759: with an identity, the internal-id key and the
  // alias-login key are revoked too — otherwise a revoke would
  // leave a live token reachable through the dual-read fallback.
  // (overrideEnv is accepted for signature compatibility and, as
  // before, does not narrow the delete set: revocation spans
  // environments by design.)
  const aliasLogin = await resolveAliasLogin(env, identity?.internalUserId);
  const extraLogins = [
    ...(identity?.internalUserId ? [identity.internalUserId] : []),
    ...(aliasLogin ? [aliasLogin] : []),
  ];
  const deletes: Promise<any>[] = [];
  for (const login of [...logins, ...extraLogins]) {
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
  // Issue #329 follow-up: revoked tokens must not survive in any isolate cache.
  invalidateTokenCacheFor(userLogin);
  for (const login of extraLogins) invalidateTokenCacheFor(login);
}

/**
 * Step 5: Revoke Access Token Upstream & Purge Stored Tokens
 * Calls GET /oauth/revoke_access_token on E*TRADE servers and removes the
 * stored tokens from the SessionStore DO
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

  // Issue #1245 (#1209 F4b): renewal single-flight per user+env. The
  // 23:00 cron, the manual renew trigger, the preflight, and on-auth
  // renewal all enter here; two overlapping renewals would present
  // the same stored pair upstream and race their writes. The claim
  // rides the SessionStore DO's atomic consume op (120s TTL).
  const lockKey = `etrade:renew-lock:${envConfig.name}:${userLogin.toLowerCase()}`;
  const claim = await consumeStoreKey({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "etrade",
    key: lockKey,
    value: "1",
    ttlSeconds: 120,
  });
  if (claim === "duplicate") {
    // Another renewal is in flight. The tokens already read stay
    // valid until midnight ET — serve this caller with them instead
    // of a second upstream renewal.
    return tokens;
  }
  if (claim === "unavailable") {
    // Lock service unreachable: fail OPEN to the pre-#1245 behavior
    // (renewal availability beats strict single-flight).
    console.warn(`[renewETradeAccessToken] renewal lock unavailable for ${userLogin}; proceeding without single-flight`);
  }

  const baseUrl = envConfig.etrade.baseUrl.replace(/\/v1\/?$/, "");
  const renewUrl = `${baseUrl}/oauth/renew_access_token`;

  try {
    return await withAspects(
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
  } finally {
    if (claim === "consumed") {
      try {
        await getKv(env).delete(lockKey);
      } catch {
        // Best-effort release; the claim expires on its TTL regardless.
      }
    }
  }
}

/** Renew every active account token from the Durable Object store. */
export async function renewAllStoredETradeTokens(env: Env): Promise<{ renewed: number; skipped: number; failed: number }> {
  const entries = await listStoreEntries({
    namespace: env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
    namespaceName: "etrade",
    prefix: "etrade:token:",
  });
  if (!entries) throw new Error("SessionStore token listing is unavailable.");

  let renewed = 0;
  let skipped = 0;
  let failed = 0;
  for (const entry of entries) {
    const match = entry.key.match(/^etrade:token:(TEST|PROD):(.+)$/);
    if (!match) continue;
    try {
      const token = JSON.parse(entry.value) as ETradeTokenSet;
      if (!token.userLogin || isTokenExpiredEt(token.storedAt)) {
        skipped++;
        continue;
      }
      const result = await renewETradeAccessToken(env, token.userLogin, match[1]);
      if (result) renewed++;
      else failed++;
    } catch {
      failed++;
    }
  }
  return { renewed, skipped, failed };
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
  // The stored per-user token is the ONLY source (#1185 Phase B, #1066):
  // the legacy process-wide static pair was deleted, so a login with no
  // valid stored token resolves to null and callers fail closed.

  const kv = getKv(env);
  const scopedKey = KV_ACCESS_TOKEN_KEY(userLogin, envConfig.name);

  // Issue #329 follow-up: this function runs once per E*TRADE request, so the
  // token-store read (or two, on the legacy-key fallback) is the hottest remaining read
  // path. Serve repeats from the isolate cache; every write path invalidates.
  const cacheKey = tokenCacheKey(envConfig.name, userLogin);
  const cached = readTokenCache(cacheKey);
  if (cached !== undefined) return cached;
  // Issue #1218: the store read below is async — a concurrent write
  // path (connect/renew/revoke) may invalidate while it is in flight.
  // Capture the epoch now; the cache writes below no-op if it moved,
  // so a stale result never resurrects after the invalidation.
  const readEpoch = tokenCacheEpoch(cacheKey);

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
          // Adopt active token for current environment in the token store so future reads are instantaneous
          await kv.put(scopedKey, JSON.stringify({ ...parsed, environment: envConfig.name }), { expirationTtl: 86400 });
        }
      } catch {}
    }
  }

  if (!tokens) {
    writeTokenCache(cacheKey, null, readEpoch);
    return null;
  }

  if (isTokenExpiredEt(tokens.storedAt)) {
    console.warn(`E*TRADE tokens for ${userLogin} expired at midnight ET.`);
    await revokeStoredTokens(env, userLogin, overrideEnv);
    writeTokenCache(cacheKey, null, readEpoch);
    return null;
  }

  writeTokenCache(cacheKey, tokens, readEpoch);
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
    return {
      authenticated: false,
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
