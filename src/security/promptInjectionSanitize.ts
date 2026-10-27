/**
 * Issue #1763 (parent #1717, scan row F-36 partial) — SEC-005 inbound
 * text sanitization at the entrypoint.
 *
 * Why this layer exists: the LLM Judge is only one consumer of
 * inbound text. Webhook and Slack text reaches NLQ planning,
 * validation, and other prompt assemblies before any judge runs, so
 * judge-only defense leaves the indirect prompt-injection path open
 * for every other consumer. This module is the entrypoint layer:
 * webhook queries (src/server.ts handleNlqWebhookRequest) and Slack
 * event/command text (src/trading/slack/agent.ts processSlackEvent /
 * processSlackCommand) pass through it BEFORE forwarding.
 *
 * What it does — and deliberately does NOT do:
 * - Defuses every delimiter marker the prompt registry uses, so an
 *   inbound payload can never break out of a delimited region
 *   downstream (the delimited gate in src/mlsecops/evalGate.ts is
 *   the second layer; this is the first). A defused marker is
 *   replaced with "[marker removed]", never silently deleted, so
 *   the tampering stays visible in the text.
 * - Strips NUL and other C0/C1 control characters (except newline,
 *   carriage return, and tab), which have no legitimate meaning in
 *   a query and can smuggle content past naive parsers.
 * - Preserves everything else VERBATIM, including prose that merely
 *   resembles an instruction ("ignore previous instructions" as
 *   words). Keyword censorship would break legitimate messages
 *   ("explain what 'ignore previous instructions' means") and is
 *   brittle; the defense is structural (delimiters + the
 *   untrustedContent gate), not a denylist of phrases.
 *
 * The marker list is literal here on purpose: this module must stay
 * dependency-light (it is imported by the worker entrypoint), so it
 * does not import the builder modules that own the constants.
 * Drift is pinned by test (tests/prompt_injection_sanitize_1763):
 * every begin/end in src/mlsecops/modelPromptRegistry.ts PROMPT_PINS
 * plus the NLQ and judge markers must appear in this list.
 *
 * This is enforcement-adjacent, not enforcement-configurable: no
 * config switch can disable it, and no caller (webhook, Slack, or
 * otherwise) can opt its own text out of it — the #1717 security
 * guard (behavior variants configurable, enforcement never
 * opt-out).
 */

/**
 * Every delimiter marker a production prompt assembly uses to fence
 * untrusted data. Keep in sync with the registry pins and the NLQ /
 * judge builders; the sanitizer test fails on drift.
 */
export const INBOUND_SANITIZER_MARKERS: readonly string[] = [
  // #769 gated pins (src/mlsecops/modelPromptRegistry.ts)
  "<<<UNTRUSTED_NEWS_CONTENT>>>",
  "<<<END_UNTRUSTED_NEWS_CONTENT>>>",
  "<<<UNTRUSTED_GROUP_ANALYSES>>>",
  "<<<END_UNTRUSTED_GROUP_ANALYSES>>>",
  "<<<UNTRUSTED_RETRIEVED_CONTENT>>>",
  "<<<END_UNTRUSTED_RETRIEVED_CONTENT>>>",
  // #1763 gated pins
  "<<<UNTRUSTED_OPTION_DATA>>>",
  "<<<END_UNTRUSTED_OPTION_DATA>>>",
  "<<<UNTRUSTED_COMPARISON_DATA>>>",
  "<<<END_UNTRUSTED_COMPARISON_DATA>>>",
  "<<<UNTRUSTED_COMPARISON_CONTRACTS>>>",
  "<<<END_UNTRUSTED_COMPARISON_CONTRACTS>>>",
  // NLQ untrusted channel (src/agents/nlq/llmPlanning.ts)
  "<<<UNTRUSTED_EMAIL_CONTENT>>>",
  "<<<END_UNTRUSTED_EMAIL_CONTENT>>>",
  // Judge (src/agents/judge.ts)
  "<<<UNTRUSTED_USER_TEXT>>>",
  "<<<END_UNTRUSTED_USER_TEXT>>>",
];

export const MARKER_REMOVED = "[marker removed]";

/** Sanitize inbound text at the entrypoint. See the header. */
export function sanitizeInboundText(text: unknown): string {
  if (typeof text !== "string") return "";
  let cleaned = text;
  for (const marker of INBOUND_SANITIZER_MARKERS) {
    if (cleaned.includes(marker)) cleaned = cleaned.split(marker).join(MARKER_REMOVED);
  }
  // Strip C0 controls except \n \r \t, plus C1 controls and NUL.
  cleaned = cleaned.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  return cleaned;
}
