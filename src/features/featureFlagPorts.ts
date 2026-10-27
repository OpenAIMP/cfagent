/**
 * Issue #1815: Feature Flag Port (ADR 0006).
 *
 * Domain code depends ONLY on these interfaces. This module is
 * deliberately free of any Cloudflare runtime types, any provider
 * binding references, and any environment variable inspection.
 *
 * The composition root (src/features/createFeatureFlagPort.ts) wires
 * provider adapters (cloud native, environment variables, or
 * in-memory mocks) to this port; domain code never touches the adapter.
 */

export type FeatureFlag =
  | "screener"
  | "options_research"
  | "autopilot"
  | "trading_orders"
  | "voice_trading"
  | "social_publishing"
  | "nlq"
  | "payments"
  | "schedules"
  | "enrichment_alpaca";

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
  // Issue #1888: Alpaca enrichment selector. Default off (fail-closed)
  // means Yahoo enrichment is active; flipping this flag on selects
  // Alpaca-primary-with-Yahoo-fallback with no code change.
  "enrichment_alpaca",
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
 * Port interface for feature flag evaluation.
 * Conforms to OpenFeature provider evaluation semantics.
 */
export interface FeatureFlagPort {
  /**
   * Returns whether a named feature flag is enabled for the given context.
   * Must fail closed (return false) on unknown flags, missing config, or provider errors.
   */
  isEnabled(flag: string, context?: FeatureEvaluationContext): Promise<boolean>;

  /**
   * Evaluates all known feature flags and returns a map of flag name to boolean status.
   */
  getAllFlags(context?: FeatureEvaluationContext): Promise<Record<FeatureFlag, boolean>>;
}
