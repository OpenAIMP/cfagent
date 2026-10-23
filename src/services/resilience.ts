/**
 * Shared resilience executor (issue #1181, slice R1 of the #1173
 * screener trust program).
 *
 * One implementation of retry-with-exponential-backoff for the whole
 * pipeline — every provider, every fetch class — driven by the
 * pipeline policy (pipelinePolicy.ts). Before this module, retry
 * behavior was whatever each path happened to hardcode: the E*TRADE
 * acquisition retried 3× with linear delays (liveScreener.withRetries),
 * Yahoo never retried, deliveries and report generation had ad-hoc
 * single attempts. The owner's requirement (#1173, 2026-10-23) is
 * that ALL failures are retried with exponential timeouts under
 * configurable policy — this is the executor that makes that true.
 *
 * Testability: sleep and the jitter source are injected, so tests
 * assert the schedule without waiting.
 */

import type { RetryPolicy } from "./pipelinePolicy";

/**
 * Delay before retry number `retryIndex` (1 = first retry):
 * baseDelayMs × 2^(retryIndex-1), capped at maxDelayMs, with
 * symmetric jitter of ±jitterRatio applied last.
 */
export function computeBackoffDelayMs(
  policy: RetryPolicy,
  retryIndex: number,
  rng: () => number = Math.random
): number {
  const exp = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(2, Math.max(0, retryIndex - 1))
  );
  if (!policy.jitterRatio || policy.jitterRatio <= 0) return Math.round(exp);
  const spread = exp * Math.min(1, policy.jitterRatio);
  const delta = (rng() * 2 - 1) * spread;
  return Math.max(0, Math.round(exp + delta));
}

export interface RetryEvent {
  label?: string;
  /** The attempt that just failed (1-based). */
  attempt: number;
  maxAttempts: number;
  /** Delay before the next attempt. */
  delayMs: number;
  error: string;
}

export interface WithRetryOptions {
  /** Names the operation in retry log lines (e.g. "yahoo:AAPL"). */
  label?: string;
  /** Return false for a permanent failure (auth, validation) that
   *  retrying cannot heal — it is rethrown immediately. */
  shouldRetry?: (err: unknown) => boolean;
  /** Observability hook, fired before each retry sleep. Defaults to
   *  a structured console.warn. */
  onRetry?: (event: RetryEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` until it succeeds or the policy's attempts are exhausted.
 * The LAST error is rethrown unwrapped — callers keep their own
 * error semantics (the catalog mapping is R4's concern).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  opts: WithRetryOptions = {}
): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, Math.trunc(policy.maxAttempts) || 1);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      if (opts.shouldRetry && !opts.shouldRetry(err)) break;
      const delayMs = computeBackoffDelayMs(policy, attempt, opts.rng);
      const event: RetryEvent = {
        label: opts.label,
        attempt,
        maxAttempts,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      };
      if (opts.onRetry) {
        opts.onRetry(event);
      } else {
        console.warn(
          `[resilience] retry ${attempt}/${maxAttempts - 1}${opts.label ? ` ${opts.label}` : ""} in ${delayMs}ms after: ${event.error}`
        );
      }
      await sleep(delayMs);
    }
  }
  throw lastError;
}
