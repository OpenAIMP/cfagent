/**
 * Rate limiting for outbound Slack webhook calls (issue #411).
 *
 * Why this exists: several delivery paths POST to Slack incoming-webhook
 * URLs (screener/report publishers via the outbound webhook dispatcher, and
 * the browser agent's snapshot deliveries). Nothing bounded their rate, so
 * a busy schedule — or a retry loop upstream — could fire bursts that hit
 * Slack's published per-webhook limit (~1 message/second sustained) and get
 * the webhook throttled or disabled.
 *
 * Policy: token bucket per destination URL — burst of 5, refilling at
 * 1/second (checkRateLimit(key, 5, 5s)). Distinct webhook URLs are
 * independent destinations and never share a bucket.
 *
 * Semantics on limit: the send is SKIPPED and the caller reports it as a
 * failed delivery with a rate-limit error (the same honest-failure shape
 * these paths already use for missing configuration). Nothing is queued or
 * retried inline — the publishers are fire-and-forget by design.
 *
 * The underlying limiter (security/rateLimiter) is per-isolate and
 * best-effort, like the other in-isolate guards in this codebase: it bounds
 * bursts from a single isolate, which is where bursts originate.
 */
import { checkRateLimit, type RateLimitResult } from "../security/rateLimiter";

export const SLACK_WEBHOOK_MAX_REQUESTS = 5;
export const SLACK_WEBHOOK_WINDOW_MS = 5_000;

/** True only for Slack incoming-webhook URLs (exact host match). */
export function isSlackWebhookUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "hooks.slack.com";
  } catch {
    return false;
  }
}

export function checkSlackWebhookRateLimit(
  destination: string,
  now: number = Date.now()
): RateLimitResult {
  return checkRateLimit(
    `slack-webhook:${destination}`,
    SLACK_WEBHOOK_MAX_REQUESTS,
    SLACK_WEBHOOK_WINDOW_MS,
    now
  );
}
