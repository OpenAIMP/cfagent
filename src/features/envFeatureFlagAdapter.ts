/**
 * Issue #1815: Environment Variable Adapter for FeatureFlagPort.
 *
 * Implements FeatureFlagPort against environment variables:
 * 1. Bulk JSON map (`env.FEATURE_FLAGS`)
 * 2. Named direct variables (`env.FEATURE_<FLAG>`)
 * 3. Documented legacy variables (e.g. `SOCIAL_POSTING_ENABLED` for `social_publishing`)
 * 4. Screener-first rollout defaults:
 *    - `screener` is strictly default-closed (OFF)
 *    - In configured environments, unconfigured flags default to closed (OFF)
 *    - In bare unit test environments with zero feature variables, baseline routes
 *      do not fail closed prematurely.
 */

import {
  ALL_FEATURE_FLAGS,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  isKnownFeatureFlag,
} from "./featureFlagPorts";

export class EnvFeatureFlagAdapter implements FeatureFlagPort {
  constructor(private readonly env?: Record<string, unknown> | null) {}

  async isEnabled(flag: string, _context?: FeatureEvaluationContext): Promise<boolean> {
    if (!isKnownFeatureFlag(flag)) {
      return false;
    }

    if (!this.env) {
      return false;
    }

    // 1. Bulk JSON env var fallback (`FEATURE_FLAGS='{"screener": true}'`)
    const bulkVar = this.env.FEATURE_FLAGS;
    if (bulkVar) {
      try {
        const parsed = typeof bulkVar === "string" ? JSON.parse(bulkVar) : bulkVar;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as Record<string, unknown>)[flag] === "boolean"
        ) {
          return (parsed as Record<string, boolean>)[flag];
        }
      } catch {
        // Malformed JSON continues to next fallback
      }
    }

    // 2. Named environment variable fallback (`FEATURE_SCREENER="1"`, `FEATURE_VOICE_TRADING="0"`)
    const envKey = `FEATURE_${flag.toUpperCase()}`;
    const directVar = this.env[envKey];
    if (typeof directVar === "string") {
      const trimmed = directVar.trim().toLowerCase();
      if (trimmed === "1" || trimmed === "true" || trimmed === "on") return true;
      if (trimmed === "0" || trimmed === "false" || trimmed === "off") return false;
    } else if (typeof directVar === "boolean") {
      return directVar;
    }

    // 3. Documented legacy fallback
    if (flag === "social_publishing") {
      const legacySocial = this.env.SOCIAL_POSTING_ENABLED;
      if (typeof legacySocial === "string") {
        const trimmed = legacySocial.trim().toLowerCase();
        if (trimmed === "1" || trimmed === "true" || trimmed === "on") return true;
        if (trimmed === "0" || trimmed === "false" || trimmed === "off") return false;
      }
    }

    // 4. Screener is ALWAYS default-closed (OFF)
    if (flag === "screener") {
      return false;
    }

    // Issue #1997: goal_workflow is ALWAYS default-closed (OFF),
    // like screener. It gates a new execution path (staged goal
    // runs on the workflow); the bare-env default-TRUE below
    // ("baseline routes do not fail closed prematurely") would
    // otherwise silently enable it in any environment with zero
    // feature configuration — violating its default-OFF rollout.
    // Explicit enablement only: FEATURE_FLAGS bulk JSON or
    // FEATURE_GOAL_WORKFLOW above.
    if (flag === "goal_workflow") {
      return false;
    }

    // 5. For other registered features:
    // When feature configuration is present in the environment (bulk flags set,
    // or direct FEATURE_<FLAG> configured), non-enabled features default to OFF (closed).
    // In bare unit test environments with zero feature flags, baseline routes do not fail closed.
    const hasFeatureConfig = Boolean(
      bulkVar ||
      directVar !== undefined ||
      this.env.FEATURE_SCREENER !== undefined
    );

    return !hasFeatureConfig;
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
