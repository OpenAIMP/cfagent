/**
 * Issue #1806: Cloudflare Feature Flags Registry & Evaluator.
 *
 * Provides a single unified feature registry and evaluation pipeline:
 * 1. Primary: Cloudflare Flagship native binding (`env.FLAGS`), conforming to OpenFeature.
 * 2. Fallback: Environment variables (`FEATURE_<FLAG>` or `FEATURE_FLAGS` JSON blob)
 *    and documented legacy switches (`SOCIAL_POSTING_ENABLED`).
 * 3. Fail-Closed: Unknown flags, missing configs, or flag-service errors evaluate to `false`.
 */

import type { Env } from "../types";

export type FeatureFlag =
  | "screener"
  | "options_research"
  | "autopilot"
  | "trading_orders"
  | "voice_trading"
  | "social_publishing"
  | "nlq"
  | "payments"
  | "schedules";

export const ALL_FEATURE_FLAGS: readonly FeatureFlag[] = [
  "screener",
  "options_research",
  "autopilot",
  "trading_orders",
  "voice_trading",
  "social_publishing",
  "nlq",
  "payments",
  "schedules",
] as const;

const KNOWN_FLAGS = new Set<string>(ALL_FEATURE_FLAGS);

export function isKnownFeatureFlag(flag: string): flag is FeatureFlag {
  return KNOWN_FLAGS.has(flag);
}

export interface FeatureEvaluationContext {
  userId?: string;
  userLogin?: string;
  environment?: string;
  [key: string]: unknown;
}

/**
 * Evaluates whether a feature flag is enabled.
 *
 * Order of evaluation:
 * 1. Validate flag name (unknown flags fail closed -> false).
 * 2. If Cloudflare Flagship binding `env.FLAGS` is present, query it via getBooleanValue.
 *    Any Flagship error fails closed -> false.
 * 3. If Flagship is absent, check `env.FEATURE_FLAGS` (JSON map).
 * 4. Check specific named env var `env.FEATURE_<FLAG>`.
 * 5. Check documented legacy fallback (e.g. SOCIAL_POSTING_ENABLED for social_publishing).
 * 6. Default closed -> false.
 */
export async function isFeatureEnabled(
  env: Env | Partial<Env> | Record<string, unknown> | undefined | null,
  flag: string,
  context?: FeatureEvaluationContext
): Promise<boolean> {
  if (!isKnownFeatureFlag(flag)) {
    return false;
  }

  // 1. Cloudflare Flagship native binding
  const flagsBinding = (env as any)?.FLAGS;
  if (flagsBinding && typeof flagsBinding.getBooleanValue === "function") {
    try {
      const result = await flagsBinding.getBooleanValue(flag, false, context);
      if (typeof result === "boolean") {
        return result;
      }
    } catch (flagshipError) {
      console.warn(`[featureFlags] Flagship evaluation failed for flag '${flag}', failing closed to false:`, flagshipError);
      return false;
    }
  }

  // 2. Bulk JSON env var fallback (`FEATURE_FLAGS='{"screener": true}'`)
  const bulkVar = (env as Record<string, unknown> | undefined)?.FEATURE_FLAGS;
  if (bulkVar) {
    try {
      const parsed = typeof bulkVar === "string" ? JSON.parse(bulkVar) : bulkVar;
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)[flag] === "boolean") {
        return (parsed as Record<string, boolean>)[flag];
      }
    } catch {
      // Malformed JSON continues to next fallback
    }
  }

  // 3. Named environment variable fallback (`FEATURE_SCREENER="1"`)
  const envKey = `FEATURE_${flag.toUpperCase()}`;
  const directVar = (env as Record<string, unknown> | undefined)?.[envKey];
  if (typeof directVar === "string") {
    const trimmed = directVar.trim().toLowerCase();
    if (trimmed === "1" || trimmed === "true" || trimmed === "on") return true;
    if (trimmed === "0" || trimmed === "false" || trimmed === "off") return false;
  } else if (typeof directVar === "boolean") {
    return directVar;
  }

  // 4. Documented legacy fallback
  if (flag === "social_publishing") {
    const legacySocial = (env as Record<string, unknown> | undefined)?.SOCIAL_POSTING_ENABLED;
    if (typeof legacySocial === "string") {
      const trimmed = legacySocial.trim().toLowerCase();
      return trimmed === "1" || trimmed === "true" || trimmed === "on";
    }
  }

  // 5. Default closed
  return false;
}

/**
 * Returns a dictionary of all known feature flags and their current evaluated states.
 */
export async function getAllFeatureFlags(
  env: Env | Partial<Env> | Record<string, unknown> | undefined | null,
  context?: FeatureEvaluationContext
): Promise<Record<FeatureFlag, boolean>> {
  const entries = await Promise.all(
    ALL_FEATURE_FLAGS.map(async (flag) => {
      const enabled = await isFeatureEnabled(env, flag, context);
      return [flag, enabled] as const;
    })
  );
  return Object.fromEntries(entries) as Record<FeatureFlag, boolean>;
}

/**
 * Creates a standard JSON 404 response for a disabled feature route.
 */
export function createFeatureDisabledResponse(
  feature: FeatureFlag | string,
  status = 404
): Response {
  return Response.json(
    {
      error: `Feature '${feature}' is disabled.`,
      code: "FEATURE_DISABLED",
      feature,
    },
    {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * Maps a request URL pathname to its owning FeatureFlag, if any.
 * Returns null if the route is not product-gated (e.g. auth, static, health).
 */
export function matchFeatureForRoute(pathname: string): FeatureFlag | null {
  const p = pathname.toLowerCase();

  // Screener pipeline (E*TRADE & FOSS screeners, presets, and runs)
  if (
    p.startsWith("/api/screener") ||
    p.startsWith("/screener") ||
    p.startsWith("/api/etrade/screen") ||
    p.startsWith("/api/options/screen") ||
    p.startsWith("/api/options/evaluate") ||
    p.startsWith("/api/options/profiles") ||
    p.startsWith("/api/options/runs") ||
    p.startsWith("/api/options/export") ||
    p.startsWith("/api/foss/screen") ||
    p.startsWith("/api/foss/compare")
  ) {
    return "screener";
  }

  // Options research & flows
  if (
    p.startsWith("/api/options/flows") ||
    p.startsWith("/api/trading/options") ||
    p.startsWith("/trading/options") ||
    p.startsWith("/api/research") ||
    p.startsWith("/research")
  ) {
    return "options_research";
  }

  // Trading orders (tickets, preview, execution)
  if (
    p.startsWith("/api/trading/orders") ||
    p.startsWith("/api/etrade/orders") ||
    p.startsWith("/api/trading/preview") ||
    p.startsWith("/api/trading/execute")
  ) {
    return "trading_orders";
  }

  // Voice trading desk
  if (p.startsWith("/api/trading/voice") || p.startsWith("/api/voice")) {
    return "voice_trading";
  }

  // Autopilot control
  if (p.startsWith("/api/autopilot") || p.startsWith("/api/trading/autopilot")) {
    return "autopilot";
  }

  // Social publishing
  if (p.startsWith("/api/social") || p.startsWith("/social")) {
    return "social_publishing";
  }

  // Natural Language Queries (NLQ)
  if (
    p.startsWith("/api/trading/nlq") ||
    p.startsWith("/api/nlq") ||
    p.startsWith("/nlq")
  ) {
    return "nlq";
  }

  // Payments & billing
  if (
    p.startsWith("/api/premium") ||
    p.startsWith("/api/payments") ||
    p.startsWith("/checkout/sandbox")
  ) {
    return "payments";
  }

  // Schedules
  if (p.startsWith("/api/schedule") || p.startsWith("/api/schedules")) {
    return "schedules";
  }

  return null;
}
