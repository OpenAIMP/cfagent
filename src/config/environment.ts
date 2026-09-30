import defaultConfig from "../../environment.config.json";
import type { Env } from "../types";

export interface EnvironmentETradeConfig {
  baseUrl: string;
  type: "sandbox" | "live";
  apiKey?: string;
  apiSecret?: string;
  oauthToken?: string;
  oauthTokenSecret?: string;
}

export interface ResolvedEnvironment {
  name: "TEST" | "PROD" | string;
  label: string;
  isLive: boolean;
  etrade: EnvironmentETradeConfig;
}

/**
 * Derives the E*TRADE /v1 base URL from either:
 *  - a base URL like "https://apisb.etrade.com"
 *  - a full endpoint like "https://apisb.etrade.com/v1/accounts/..."
 * Always returns "https://<host>/v1"
 */
export function resolveETradeBaseUrl(rawUrl: string): string {
  if (!rawUrl) return "https://apisb.etrade.com/v1";
  const clean = rawUrl.trim().replace(/\/$/, "");
  try {
    const parsed = new URL(clean);
    const origin = parsed.origin; // e.g. "https://apisb.etrade.com"
    return `${origin}/v1`;
  } catch {
    if (clean.includes("api.etrade.com")) return "https://api.etrade.com/v1";
    return "https://apisb.etrade.com/v1";
  }
}

/**
 * Resolves the active environment and E*TRADE credentials.
 *
 * Priority cascade:
 *   1. Cloudflare Worker env bindings (runtime secrets: ET_API_KEY, ET_API_SECRET, ET_BASE_URL)
 *   2. process.env (Node / local .dev.vars)
 *   3. environment.config.json default
 *
 * ET_BASE_URL is expected to be a base URL ("https://apisb.etrade.com") — NOT a path template.
 * accountIdKey must be resolved at runtime via GET /v1/accounts/list (see ETradeService.fetchAccountsRemote).
 */
export function resolveEnvironmentConfig(env?: Partial<Env>): ResolvedEnvironment {
  const processEnv = typeof process !== "undefined" && process?.env ? process.env : {};

  // Active environment name — matches a GitHub environment name
  const activeName = (
    env?.APP_ENV ||
    env?.ENVIRONMENT ||
    processEnv.APP_ENV ||
    processEnv.ENVIRONMENT ||
    defaultConfig.environment ||
    "TEST"
  ).toUpperCase();

  const envsMap = defaultConfig.environments as Record<string, any>;
  const baseDef = envsMap[activeName] || envsMap["TEST"];

  // ET_BASE_URL from secret takes priority; fall back to config-defined baseUrl
  const rawUrl =
    env?.ET_BASE_URL ||
    processEnv.ET_BASE_URL ||
    baseDef.etrade.baseUrl;

  const baseUrl = resolveETradeBaseUrl(rawUrl);
  const isLive = baseUrl.startsWith("https://api.etrade.com") && !baseUrl.startsWith("https://apisb.etrade.com");

  // OAuth credentials — ET_API_KEY / ET_API_SECRET (plus legacy aliases)
  const apiKey =
    env?.ET_API_KEY ||
    env?.ETRADE_CONSUMER_KEY ||
    processEnv.ET_API_KEY ||
    processEnv.ETRADE_CONSUMER_KEY;

  const apiSecret =
    env?.ET_API_SECRET ||
    env?.ETRADE_CONSUMER_SECRET ||
    processEnv.ET_API_SECRET ||
    processEnv.ETRADE_CONSUMER_SECRET;

  // OAuth 1.0a access token pair (obtained after user authorizes via E*TRADE OAuth flow)
  const oauthToken =
    env?.ETRADE_OAUTH_TOKEN ||
    (env as any)?.ETRADE_ACCESS_TOKEN ||
    processEnv.ETRADE_OAUTH_TOKEN ||
    processEnv.ETRADE_ACCESS_TOKEN;

  const oauthTokenSecret =
    env?.ETRADE_OAUTH_TOKEN_SECRET ||
    (env as any)?.ETRADE_ACCESS_TOKEN_SECRET ||
    processEnv.ETRADE_OAUTH_TOKEN_SECRET ||
    processEnv.ETRADE_ACCESS_TOKEN_SECRET;

  return {
    name: activeName,
    label: baseDef.label || (isLive ? "Live" : "Sandbox"),
    isLive,
    etrade: {
      baseUrl,
      type: isLive ? "live" : "sandbox",
      apiKey,
      apiSecret,
      oauthToken,
      oauthTokenSecret,
    },
  };
}
