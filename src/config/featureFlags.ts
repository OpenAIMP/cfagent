/**
 * Issue #1806 & #1815: Feature Flags Facade & Route Matcher.
 *
 * Exposes the feature flag system and route-matching utilities.
 * Evaluation delegates to the domain FeatureFlagPort architecture in `src/features/`.
 */

import type { Env } from "../types";
import {
  ALL_FEATURE_FLAGS,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  isKnownFeatureFlag,
} from "../features/featureFlagPorts";
import { createFeatureFlagPort } from "../features/createFeatureFlagPort";

export {
  ALL_FEATURE_FLAGS,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  isKnownFeatureFlag,
};
export { createFeatureFlagPort } from "../features/createFeatureFlagPort";
export { CfFlagshipAdapter } from "../features/cfFlagshipAdapter";
export { EnvFeatureFlagAdapter } from "../features/envFeatureFlagAdapter";
export { InMemoryFeatureFlagAdapter } from "../features/inMemoryFeatureFlagAdapter";

/**
 * Evaluates whether a feature flag is enabled using the FeatureFlagPort composition root.
 */
export async function isFeatureEnabled(
  env: Env | Partial<Env> | Record<string, unknown> | undefined | null,
  flag: string,
  context?: FeatureEvaluationContext
): Promise<boolean> {
  const port = createFeatureFlagPort(env);
  return port.isEnabled(flag, context);
}

/**
 * Returns a dictionary of all known feature flags and their current evaluated states.
 */
export async function getAllFeatureFlags(
  env: Env | Partial<Env> | Record<string, unknown> | undefined | null,
  context?: FeatureEvaluationContext
): Promise<Record<FeatureFlag, boolean>> {
  const port = createFeatureFlagPort(env);
  return port.getAllFlags(context);
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

  // Screener pipeline (E*TRADE & market-data screeners, presets, and runs)
  if (
    p.startsWith("/api/screener") ||
    p.startsWith("/screener") ||
    p.startsWith("/api/etrade/screen") ||
    p.startsWith("/api/options/screen") ||
    p.startsWith("/api/options/evaluate") ||
    p.startsWith("/api/options/profiles") ||
    p.startsWith("/api/options/runs") ||
    p.startsWith("/api/options/export") ||
    p.startsWith("/api/market-data/screen") ||
    p.startsWith("/api/market-data/compare") ||
    // #1906: deprecated aliases still route to the same handlers, so they
    // stay feature-gated identically; use canonical prefixes instead.
    // Alias removal is a follow-up.
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
