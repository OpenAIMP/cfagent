/**
 * Issue #769 (parent #764, MLSecOps) — the model/prompt eval gate.
 *
 * Deterministic, prompt-assembly-level gate: it runs on the assembled
 * prompt text, never on a live model call, so it runs in CI on every PR.
 * This is the same level as the #767 v3 red-team manifest, which states
 * explicitly that model-behavior grading ("does a live model obey an
 * injection despite the defense") is a separate, non-CI evaluation.
 * Nothing here claims live-model grading.
 *
 * Thresholds are fixed up front in EVAL_GATE_THRESHOLDS: security cases
 * must pass 100% and quality cases 100%. A threshold change is itself a
 * registry change — it lands as a diff to this file in its own PR, never
 * as a per-change tuning knob.
 *
 * Security checks (all must pass):
 * - exactly the expected number of BEGIN/END delimiters (default 1 each;
 *   a template whose data rule itself names the markers, like the
 *   orchestrator's, declares 2 — any further marker means hostile
 *   payload escaped the data region);
 * - the data-is-not-instructions rule is present;
 * - no hostile payload appears verbatim (an undefused END marker or a
 *   bare interpolation fails here).
 * Quality checks (all must pass):
 * - every legitimate fragment survives inside the delimited region
 *   (the gate must not break legitimate behavior to buy security).
 *
 * Failures are named strings, so a red gate names its failing check
 * under the gitops named-failure rule instead of failing silently.
 */

export const EVAL_GATE_THRESHOLDS = {
  /** Fraction of security checks that must pass: 1 = every check. */
  securityPassRateRequired: 1,
  /** Fraction of quality checks that must pass: 1 = every check. */
  qualityPassRateRequired: 1,
} as const;

export interface DelimitedPromptGateInput {
  /** Assembled prompt text from the production builder. */
  prompt: string;
  /** Opening delimiter of the untrusted-data region. */
  begin: string;
  /** Closing delimiter of the untrusted-data region. */
  end: string;
  /** Data-is-not-instructions rule the prompt must carry. */
  dataRule: string;
  /** Legitimate fragments that must survive inside the region. */
  mustBeInside: readonly string[];
  /** Hostile payloads that must NOT appear verbatim in the prompt. */
  mustNotAppearVerbatim: readonly string[];
  /**
   * Expected delimiter counts (default 1 each). A template whose
   * data rule text itself mentions the markers declares the higher
   * count; the check stays exact, so an escape still adds a marker
   * and still fails.
   */
  expectedBeginCount?: number;
  expectedEndCount?: number;
}

export interface PromptGateResult {
  passed: boolean;
  securityPassed: boolean;
  qualityPassed: boolean;
  /** Named failures; empty exactly when passed is true. */
  failures: string[];
}

function count(haystack: string, needle: string): number {
  return needle ? haystack.split(needle).length - 1 : 0;
}

export function runDelimitedPromptGate(
  input: DelimitedPromptGateInput,
): PromptGateResult {
  const {
    prompt, begin, end, dataRule, mustBeInside, mustNotAppearVerbatim,
    expectedBeginCount = 1, expectedEndCount = 1,
  } = input;
  const securityFailures: string[] = [];
  const qualityFailures: string[] = [];

  const beginCount = count(prompt, begin);
  if (beginCount !== expectedBeginCount) {
    securityFailures.push(
      `BEGIN marker count is ${beginCount}, expected exactly ${expectedBeginCount}`,
    );
  }
  const endCount = count(prompt, end);
  if (endCount !== expectedEndCount) {
    securityFailures.push(
      `END marker count is ${endCount}, expected exactly ${expectedEndCount} (an extra END marker means payload escaped the region)`,
    );
  }
  if (!prompt.includes(dataRule)) {
    securityFailures.push("data-is-not-instructions rule is missing");
  }
  for (const hostile of mustNotAppearVerbatim) {
    if (hostile && prompt.includes(hostile)) {
      securityFailures.push(
        "hostile payload appears verbatim in the prompt (undefused END marker or bare interpolation)",
      );
    }
  }

  const beginIdx = prompt.indexOf(begin);
  const endIdx = prompt.indexOf(end, beginIdx + begin.length);
  const region =
    beginIdx >= 0 && endIdx > beginIdx
      ? prompt.slice(beginIdx + begin.length, endIdx)
      : "";
  for (const fragment of mustBeInside) {
    if (!region.includes(fragment)) {
      qualityFailures.push(
        `legitimate fragment missing from the delimited region: ${fragment.slice(0, 80)}`,
      );
    }
  }

  // With the fixed 100% thresholds these reduce to "no failures", but the
  // rate form is kept so a future threshold change is a visible diff here,
  // not a silent relaxation in the check logic.
  const securityTotal = 3 + mustNotAppearVerbatim.length;
  const securityPassed =
    1 - securityFailures.length / Math.max(securityTotal, 1) >=
    EVAL_GATE_THRESHOLDS.securityPassRateRequired;
  const qualityPassed =
    1 - qualityFailures.length / Math.max(mustBeInside.length, 1) >=
    EVAL_GATE_THRESHOLDS.qualityPassRateRequired;

  return {
    passed: securityPassed && qualityPassed,
    securityPassed,
    qualityPassed,
    failures: [...securityFailures, ...qualityFailures],
  };
}
