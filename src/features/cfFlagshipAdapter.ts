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

    try {
      const result = await this.flags.getBooleanValue(
        flag,
        false,
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
