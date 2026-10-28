/**
 * Issue #1815: In-Memory Adapter for FeatureFlagPort.
 *
 * Implements FeatureFlagPort using an in-memory Map.
 * Used for deterministic unit testing, sandbox shadow runs, and local mocks
 * without requiring Cloudflare Workers bindings or environment variables.
 */

import {
  ALL_FEATURE_FLAGS,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  isKnownFeatureFlag,
} from "./featureFlagPorts";

export class InMemoryFeatureFlagAdapter implements FeatureFlagPort {
  private readonly flags = new Map<FeatureFlag, boolean>();

  constructor(initialFlags?: Partial<Record<FeatureFlag, boolean>>) {
    // Default-closed for all known flags, except payment_assurance
    // (issue #2054: default ON, overridable via initialFlags).
    for (const flag of ALL_FEATURE_FLAGS) {
      this.flags.set(flag, flag === "payment_assurance");
    }

    if (initialFlags) {
      for (const [flag, enabled] of Object.entries(initialFlags)) {
        if (isKnownFeatureFlag(flag) && typeof enabled === "boolean") {
          this.flags.set(flag, enabled);
        }
      }
    }
  }

  setFlag(flag: FeatureFlag, enabled: boolean): void {
    if (isKnownFeatureFlag(flag)) {
      this.flags.set(flag, enabled);
    }
  }

  async isEnabled(flag: string, _context?: FeatureEvaluationContext): Promise<boolean> {
    if (!isKnownFeatureFlag(flag)) {
      return false;
    }
    return this.flags.get(flag) ?? false;
  }

  async getAllFlags(_context?: FeatureEvaluationContext): Promise<Record<FeatureFlag, boolean>> {
    const result: Partial<Record<FeatureFlag, boolean>> = {};
    for (const flag of ALL_FEATURE_FLAGS) {
      result[flag] = this.flags.get(flag) ?? false;
    }
    return result as Record<FeatureFlag, boolean>;
  }
}
