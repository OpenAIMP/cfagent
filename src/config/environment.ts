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

export interface EnvironmentPaymentsConfig {
  mode: "test" | "live";
  paypalEnvironment: "sandbox" | "live";
  stripeMode: "test" | "live";
  lemonsqueezyMode: "test" | "live";
}

export interface ResolvedEnvironment {
  name: "TEST" | "PROD" | string;
  label: string;
  isLive: boolean;
  etrade: EnvironmentETradeConfig;
  payments: EnvironmentPaymentsConfig;
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
export function resolveEnvironmentConfig(env?: Partial<Env>, overrideEnv?: string): ResolvedEnvironment {
  const processEnv = typeof process !== "undefined" && process?.env ? process.env : {};

  // Active environment name priority:
  // 1. Explicit overrideEnv (from request header x-environment or UI toggle)
  // 2. Explicit runtime override on env (e.g. in targeted tests or specific workers)
  // 3. environment.config.json default (developer's repository choice)
  // 4. Cloudflare Worker or process env bindings
  const envNameCandidate =
    overrideEnv ||
    (env?.ETRADE_ENVIRONMENT === "sandbox" ? "TEST" : env?.ETRADE_ENVIRONMENT === "live" ? "PROD" : undefined) ||
    (env?.APP_ENV && env.APP_ENV !== defaultConfig.environment ? env.APP_ENV : undefined) ||
    defaultConfig.environment ||
    env?.APP_ENV ||
    env?.ENVIRONMENT ||
    processEnv.APP_ENV ||
    processEnv.ENVIRONMENT ||
    "PROD";

  const activeName = envNameCandidate.toUpperCase();

  const envsMap = defaultConfig.environments as Record<string, any>;
  const baseDef = envsMap[activeName] || envsMap["PROD"] || envsMap["TEST"];

  // ET_BASE_URL from secret takes priority if matching the active environment
  let rawUrl = baseDef.etrade.baseUrl;
  const envUrl = env?.ET_BASE_URL || processEnv.ET_BASE_URL;
  if (envUrl) {
    if (activeName === "PROD" && !envUrl.includes("apisb.etrade.com")) {
      rawUrl = envUrl;
    } else if (activeName === "TEST" && envUrl.includes("apisb.etrade.com")) {
      rawUrl = envUrl;
    }
  }

  const baseUrl = resolveETradeBaseUrl(rawUrl);
  const isLive = activeName === "PROD" || (baseUrl.startsWith("https://api.etrade.com") && !baseUrl.startsWith("https://apisb.etrade.com"));

  // OAuth credentials — strictly segregated by environment:
  const isProd = activeName === "PROD";

  // In PROD: prefer ET_PROD_API_KEY, falling back to ET_API_KEY if dedicated prod secret is not yet set
  const apiKey = isProd
    ? (env?.ET_PROD_API_KEY ||
       (env as any)?.ETRADE_PROD_CONSUMER_KEY ||
       processEnv.ET_PROD_API_KEY ||
       processEnv.ETRADE_PROD_CONSUMER_KEY ||
       env?.ET_API_KEY ||
       env?.ETRADE_CONSUMER_KEY ||
       processEnv.ET_API_KEY ||
       processEnv.ETRADE_CONSUMER_KEY)
    : (env?.ET_SANDBOX_API_KEY ||
       (env as any)?.ETRADE_SANDBOX_CONSUMER_KEY ||
       processEnv.ET_SANDBOX_API_KEY ||
       processEnv.ETRADE_SANDBOX_CONSUMER_KEY ||
       env?.ET_API_KEY ||
       env?.ETRADE_CONSUMER_KEY ||
       processEnv.ET_API_KEY ||
       processEnv.ETRADE_CONSUMER_KEY);

  const apiSecret = isProd
    ? (env?.ET_PROD_API_SECRET ||
       (env as any)?.ETRADE_PROD_CONSUMER_SECRET ||
       processEnv.ET_PROD_API_SECRET ||
       processEnv.ETRADE_PROD_CONSUMER_SECRET ||
       env?.ET_API_SECRET ||
       env?.ETRADE_CONSUMER_SECRET ||
       processEnv.ET_API_SECRET ||
       processEnv.ETRADE_CONSUMER_SECRET)
    : (env?.ET_SANDBOX_API_SECRET ||
       (env as any)?.ETRADE_SANDBOX_CONSUMER_SECRET ||
       processEnv.ET_SANDBOX_API_SECRET ||
       processEnv.ETRADE_SANDBOX_CONSUMER_SECRET ||
       env?.ET_API_SECRET ||
       env?.ETRADE_CONSUMER_SECRET ||
       processEnv.ET_API_SECRET ||
       processEnv.ETRADE_CONSUMER_SECRET);

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

  const paypalEnv = env?.PAYPAL_ENVIRONMENT || (isLive ? "live" : "sandbox");

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
    payments: {
      mode: isLive ? "live" : "test",
      paypalEnvironment: paypalEnv,
      stripeMode: isLive ? "live" : "test",
      lemonsqueezyMode: isLive ? "live" : "test",
    },
  };
}
