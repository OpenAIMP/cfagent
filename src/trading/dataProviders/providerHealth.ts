/**
 * Issue #1235 (E6 of epic #1116): provider health + usage metering —
 * a derived READ model over the capture store (E1, captureStore.ts).
 *
 * The capture table records every provider fetch the platform makes;
 * until this module nothing read those records back for operations,
 * so there was no answer to "is E*TRADE actually serving, when did
 * it last succeed or fail, how much has it served, at what failure
 * rate?" This module computes exactly those numbers — per provider
 * and per capability — from the stored rows, plus an honest health
 * status derived from them by stated thresholds.
 *
 * WHY A SIBLING MODULE (not captureStore.ts): captureStore is the
 * storage layer — it owns the table, the write path, and row reads.
 * Health is a derivation over those rows; keeping it separate leaves
 * the store's surface untouched and keeps the derivation a pure
 * function of record sets (same records ⇒ same aggregates ⇒ same
 * status), which is what the boundary pins exercise.
 *
 * HONESTY RULES (the epic's no-fabrication standard):
 *  - every number is computed from stored capture rows — nothing is
 *    estimated, defaulted, or synthesized;
 *  - a provider with zero captures is "no-data", NEVER an invented
 *    green "healthy";
 *  - totalRawBytes sums raw_byte_size over `captured` rows only —
 *    for a capture_failed row that column holds the size of a
 *    payload that was NOT stored, so counting it would overstate
 *    what the platform actually captured;
 *  - `no_payload` rows count toward totalCaptures (the fetch
 *    happened and the audit trail records it) but are neither
 *    successes nor failures: they move neither capturedCount nor
 *    failedCount, and they break a failure streak like any
 *    non-failure record.
 *
 * STATUS SEMANTICS — what a "failure" is here: a capture_failed row
 * means the fetch succeeded but the capture WRITE failed (E1's
 * failure semantics — the audit trail showing its own gaps). That is
 * the failure signal the stored records honestly carry; this module
 * does not pretend the rows say anything about fetch outcomes they
 * do not record.
 *
 * TENANCY: aggregation is tenant-scoped through the store's own
 * read API (listCapturesByProvider), exactly like every other
 * capture read — a cross-tenant aggregation sees nothing.
 */

import type { SqlStorage } from "../../orm";
import type { DataProviderCapability, DataProviderId } from "./contract";
import {
  listCapturesByProvider,
  type DataCaptureRecord,
} from "./captureStore";

export type ProviderHealthStatus = "healthy" | "degraded" | "down" | "no-data";

/**
 * The stated health thresholds — ONE named block, pinned by tests:
 *  - down: the latest records are a run of at least
 *    `downConsecutiveFailures` capture failures;
 *  - degraded: the overall failure rate reaches
 *    `degradedFailureRate`, or the latest record failed (a streak
 *    of 1–2, below the down threshold);
 *  - the metering window is the trailing `windowMs` (24h).
 */
export const PROVIDER_HEALTH_THRESHOLDS = {
  downConsecutiveFailures: 3,
  degradedFailureRate: 0.2,
  windowMs: 24 * 60 * 60 * 1000,
} as const;

/** Usage + outcome aggregates over a set of capture records. */
export interface CaptureAggregates {
  totalCaptures: number;
  capturedCount: number;
  failedCount: number;
  /** failedCount / totalCaptures; 0 when there are no captures. */
  failureRate: number;
  /** fetched_at of the most recent `captured` record; null when none. */
  lastSuccessAt: string | null;
  /** fetched_at of the most recent `capture_failed` record; null when none. */
  lastFailureAt: string | null;
  /**
   * capture_failed records counting back from the most recent
   * record until the first non-failure; 0 when the latest record is
   * not a failure (or there are no records). >= 1 ⟺ latest failed.
   */
  consecutiveFailures: number;
  /** Sum of raw_byte_size over `captured` records (see header). */
  totalRawBytes: number;
  /** Records with fetched_at inside the trailing window. */
  capturesLast24h: number;
  /** capture_failed records inside the trailing window. */
  failuresLast24h: number;
}

/** A provider's aggregates, its per-capability breakdown, and its status. */
export interface ProviderHealth extends CaptureAggregates {
  status: ProviderHealthStatus;
  byCapability: Partial<Record<DataProviderCapability, CaptureAggregates>>;
}

function emptyAggregates(): CaptureAggregates {
  return {
    totalCaptures: 0,
    capturedCount: 0,
    failedCount: 0,
    failureRate: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    consecutiveFailures: 0,
    totalRawBytes: 0,
    capturesLast24h: 0,
    failuresLast24h: 0,
  };
}

function aggregateRecords(
  records: readonly DataCaptureRecord[],
  nowMs: number
): CaptureAggregates {
  // Chronological order is the derivation's backbone (last times,
  // streak). The store reads fetched_at ASC; re-sort stably here so
  // equal timestamps keep insertion order and the "latest" record
  // is deterministic regardless of the backing store's tie order.
  const sorted = [...records].sort((a, b) =>
    a.fetchedAt < b.fetchedAt ? -1 : a.fetchedAt > b.fetchedAt ? 1 : 0
  );
  const out = emptyAggregates();
  const windowStart = nowMs - PROVIDER_HEALTH_THRESHOLDS.windowMs;
  for (const record of sorted) {
    out.totalCaptures += 1;
    const fetchedMs = Date.parse(record.fetchedAt);
    if (!Number.isNaN(fetchedMs) && fetchedMs >= windowStart) {
      out.capturesLast24h += 1;
      if (record.status === "capture_failed") out.failuresLast24h += 1;
    }
    if (record.status === "captured") {
      out.capturedCount += 1;
      out.lastSuccessAt = record.fetchedAt;
      out.totalRawBytes += record.rawByteSize ?? 0;
    } else if (record.status === "capture_failed") {
      out.failedCount += 1;
      out.lastFailureAt = record.fetchedAt;
    }
  }
  out.failureRate =
    out.totalCaptures > 0 ? out.failedCount / out.totalCaptures : 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].status !== "capture_failed") break;
    out.consecutiveFailures += 1;
  }
  return out;
}

/**
 * The health status as a PURE function of the aggregates — the same
 * aggregates always yield the same status. Thresholds:
 * PROVIDER_HEALTH_THRESHOLDS.
 */
export function deriveProviderHealth(
  aggregates: CaptureAggregates
): ProviderHealthStatus {
  if (aggregates.totalCaptures === 0) return "no-data";
  if (
    aggregates.consecutiveFailures >=
    PROVIDER_HEALTH_THRESHOLDS.downConsecutiveFailures
  ) {
    return "down";
  }
  if (
    aggregates.failureRate >= PROVIDER_HEALTH_THRESHOLDS.degradedFailureRate ||
    aggregates.consecutiveFailures >= 1
  ) {
    return "degraded";
  }
  return "healthy";
}

/**
 * Aggregate one provider's captures (tenant-scoped, through the
 * store's own read API) into its health block. `now` is injectable
 * for tests; production callers take the current time.
 */
export function aggregateProviderHealth(
  sql: SqlStorage,
  tenantId: string,
  providerId: DataProviderId,
  now: number = Date.now()
): ProviderHealth {
  const records = listCapturesByProvider(sql, tenantId, providerId);
  const aggregates = aggregateRecords(records, now);
  const byCapability: Partial<Record<DataProviderCapability, CaptureAggregates>> =
    {};
  const capabilities = [...new Set(records.map((r) => r.capability))].sort();
  for (const capability of capabilities) {
    byCapability[capability] = aggregateRecords(
      records.filter((r) => r.capability === capability),
      now
    );
  }
  return { ...aggregates, status: deriveProviderHealth(aggregates), byCapability };
}
