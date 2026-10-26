/**
 * Issue #1745 — the Decorator over provider calls.
 *
 * withBreaker is the single layering point: budget gate → breaker
 * gate → retry (withRetry reuse, never replaced) → fallback. It is
 * a thin free function over CircuitBreaker.execute so call sites
 * read as decoration, while the state machine stays in the adapter.
 *
 * Budget arithmetic (#1785, named here so the PR states it): the
 * old failure mode spent the whole per-scan budget (35) retrying a
 * dead provider symbol after symbol (~3/100 symbols quoted). With
 * this decorator: (1) an open breaker spends ZERO budget and makes
 * ZERO provider calls — after the trip (3 consecutive failed
 * executes), the remaining symbols resolve as fallbacks/partials
 * inside the same budget instead of burning it; (2) one budget
 * spend per execute(), never per retry attempt, and never per
 * symbol inside a batch call — a batch endpoint call (Yahoo
 * getQuotes, E*TRADE fetchQuotesRemote) is one budgeted execution
 * covering its whole symbol list; (3) budget exhaustion itself
 * serves the fallback (qualified partial with audit status, the
 * #1737 collation vocabulary) instead of throwing mid-scan.
 *
 * fetchBatched is the batching primitive for future chain-request
 * batching (the options scanner's per-symbol snapshot loop is the
 * named follow-up consumer): chunked, order-preserving, sequential
 * — sequential because a burst of parallel chunks would defeat
 * the budget the batching exists to respect.
 */

import type {
  BreakerExecuteOptions,
  BreakerOutcome,
  CircuitBreaker,
} from "./breakerPorts";
export {
  BreakerBudgetExhaustedError,
  BreakerFallbackError,
  BreakerOpenError,
} from "./breakerPorts";

/** Decorate one provider call with budget + breaker + retry + fallback. */
export async function withBreaker<T>(
  breaker: CircuitBreaker,
  fn: () => Promise<T>,
  opts: BreakerExecuteOptions<T> = {}
): Promise<BreakerOutcome<T>> {
  return breaker.execute(fn, opts);
}

/**
 * Run items through a chunked batch endpoint. Each chunk is one
 * call (one budgeted execution when wrapped in withBreaker);
 * results concatenate in input order. chunkSize clamps to >= 1.
 */
export async function fetchBatched<T, R>(
  items: T[],
  chunkSize: number,
  fetchChunk: (chunk: T[]) => Promise<R[]>
): Promise<R[]> {
  const size = Math.max(1, Math.floor(chunkSize) || 1);
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const rows = await fetchChunk(chunk);
    out.push(...rows);
  }
  return out;
}
