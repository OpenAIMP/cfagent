/**
 * Issue #1815: Cloudflare Flagship Adapter for FeatureFlagPort.
 *
 * Implements FeatureFlagPort against the native Cloudflare Flagship binding (`env.FLAGS`),
 * conforming to OpenFeature evaluation semantics.
 *
 * If Flagship fails or throws, it logs a warning and fails closed (returns false)
 * to avoid stale override leaks.
 */

import {
  ALL_FEATURE_FLAGS,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  isKnownFeatureFlag,
} from "./featureFlagPorts";

export interface FlagshipBindingLike {
  getBooleanValue(
    flag: string,
    defaultValue: boolean,
    context?: Record<string, unknown>
  ): Promise<boolean>;
}

export class CfFlagshipAdapter implements FeatureFlagPort {
  constructor(private readonly flags: FlagshipBindingLike) {}

  async isEnabled(flag: string, context?: FeatureEvaluationContext): Promise<boolean> {
    if (!isKnownFeatureFlag(flag)) {
      return false;
    }

    // Issue #2054: per-flag provider defaults. Only payment_assurance
    // defaults ON: the assurance page is visible unless a dashboard
    // flag explicitly turns it off. Every other flag keeps the
    // historic default (false). A provider error still fails closed
    // to false below, including for payment_assurance.
      // Issue #2051: goal_workflow defaults ON — the default covers
      // the missing-flag case (the dashboard flag is still the
      // authoritative control; an explicit Flagship value wins, and
      // an evaluation failure still fails closed below).
    const defaultValue = flag === "payment_assurance" || flag === "goal_workflow";
    try {
      const result = await this.flags.getBooleanValue(
        flag,
        defaultValue,
        context as Record<string, unknown> | undefined
      );
      if (typeof result === "boolean") {
        return result;
      }
    } catch (flagshipError) {
      console.warn(
        `[CfFlagshipAdapter] Evaluation failed for flag '${flag}', failing closed to false:`,
        flagshipError
      );
      return false;
    }

    return false;
  }

  async getAllFlags(context?: FeatureEvaluationContext): Promise<Record<FeatureFlag, boolean>> {
    const entries = await Promise.all(
      ALL_FEATURE_FLAGS.map(async (flag) => {
        const enabled = await this.isEnabled(flag, context);
        return [flag, enabled] as const;
      })
    );

    return Object.fromEntries(entries) as Record<FeatureFlag, boolean>;
  }
}
