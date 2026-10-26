/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — per-isolate retrieval-stats accumulator.
 *
 * Consumes #1740's retrieval.completed CloudEvents envelopes
 * (counts only, never query text) and folds them into the
 * counts the telemetry summary reads. This is the telemetry
 * slice's consumption of the retrieval hook: it does NOT
 * redefine the envelope (it reuses #1740's
 * toRetrievalCompletedEnvelope shape) and does NOT persist
 * retrieval counts — they are ephemeral operational signals
 * with the same documented loss semantics as breaker state
 * (an isolate recycle resets them; fail-open on cold start).
 * The durable home for retrieval streams is #1743's
 * Analytics Engine pipeline (named follow-up, not built
 * here).
 *
 * Validation: only well-formed retrieval.completed envelopes
 * fold (right type, numeric counts, boolean degraded).
 * Malformed or foreign envelopes return false and change
 * nothing; ingestion never throws.
 */
import type { MessageEnvelope } from "../messaging/messagingPorts";

export interface RetrievalStatsSnapshot {
  totalRetrievals: number;
  totalDense: number;
  totalGraph: number;
  degradedCount: number;
  lastCompletedAtMs: number | null;
}

const stats: RetrievalStatsSnapshot = {
  totalRetrievals: 0,
  totalDense: 0,
  totalGraph: 0,
  degradedCount: 0,
  lastCompletedAtMs: null,
};

/** Fold one retrieval.completed envelope into the accumulator. */
export function ingestRetrievalCompleted(envelope: MessageEnvelope): boolean {
  if (envelope.type !== "retrieval.completed") return false;
  const data = envelope.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== "object") return false;
  const { denseCount, graphCount, degraded } = data;
  if (
    typeof denseCount !== "number" ||
    typeof graphCount !== "number" ||
    typeof degraded !== "boolean"
  ) {
    return false;
  }
  stats.totalRetrievals += 1;
  stats.totalDense += denseCount;
  stats.totalGraph += graphCount;
  if (degraded) stats.degradedCount += 1;
  const atMs = Date.parse(envelope.time);
  if (!Number.isNaN(atMs)) stats.lastCompletedAtMs = atMs;
  return true;
}

/** Current accumulator snapshot (a copy — callers cannot mutate state). */
export function retrievalStatsSnapshot(): RetrievalStatsSnapshot {
  return { ...stats };
}

/** Test seam: drop the accumulator (mirrors __resetDefaultBreakerRegistry). */
export function __resetRetrievalStats(): void {
  stats.totalRetrievals = 0;
  stats.totalDense = 0;
  stats.totalGraph = 0;
  stats.degradedCount = 0;
  stats.lastCompletedAtMs = null;
}
