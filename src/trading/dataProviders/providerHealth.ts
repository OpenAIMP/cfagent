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
 * E7 (issue #1248): the write model now also records fetch outcomes
 * (fetch_failed rows — the fetch itself threw, with a classified
 * kind), so this projection gains the fetch dimension ADDITIVELY:
 * fetchAttempts / fetchFailures / fetchFailureRate count fetch
 * truth, captureFailures keeps the capture-write count separate
 * (a provider that is down is a different incident from our
 * storage being broken), lastFailureAt / consecutiveFailures now
 * count BOTH failure row kinds (on a pre-E7 log — no fetch_failed
 * rows — every v1 number is byte-identical), and the latest fetch
 * failure's kind is surfaced for the panel. fetchAttempts equals
 * totalCaptures by construction: every row in the log evidences
 * exactly one fetch attempt.
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
import type { ProviderCaptureStore } from "../../data/providerCapturePorts";
import type { FetchFailureKind } from "./fetchOutcome";

export type ProviderHealthStatus = "healthy" | "degraded" | "down" | "no-data";

/**
 * The stated health thresholds — ONE named block, pinned by tests:
 *  - down: the latest records are a run of at least
 *    `downConsecutiveFailures` failures (capture-write or fetch
 *    failures — the streak counts both row kinds since E7);
 *  - degraded: the capture failure rate reaches
 *    `degradedFailureRate`, the fetch failure rate reaches
 *    `degradedFetchFailureRate` (E7), or the latest record failed
 *    (a streak of 1–2, below the down threshold);
 *  - the metering window is the trailing `windowMs` (24h).
 */
export const PROVIDER_HEALTH_THRESHOLDS = {
  downConsecutiveFailures: 3,
  degradedFailureRate: 0.2,
  degradedFetchFailureRate: 0.2,
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
  /**
   * fetched_at of the most recent FAILURE record — capture_failed
   * or (since E7) fetch_failed; null when none. On pre-E7 logs
   * this is exactly the most recent capture_failed, as in E6.
   */
  lastFailureAt: string | null;
  /**
   * Failure records (capture_failed or fetch_failed) counting back
   * from the most recent record until the first non-failure; 0 when
   * the latest record is not a failure (or there are no records).
   * >= 1 ⟺ latest failed. On pre-E7 logs this counts capture_failed
   * rows only, exactly as in E6.
   */
  consecutiveFailures: number;
  /** Sum of raw_byte_size over `captured` records (see header). */
  totalRawBytes: number;
  /** Records with fetched_at inside the trailing window. */
  capturesLast24h: number;
  /** capture_failed records inside the trailing window. */
  failuresLast24h: number;
  /**
   * E7: fetch attempts evidenced by the log — every record is one
   * attempt, so this equals totalCaptures; named separately
   * because API consumers reason in fetch terms.
   */
  fetchAttempts: number;
  /** E7: records whose fetch itself failed (status fetch_failed). */
  fetchFailures: number;
  /** E7: fetchFailures / fetchAttempts; 0 when there are no attempts. */
  fetchFailureRate: number;
  /**
   * E7: capture-write failures (status capture_failed) — the same
   * count failedCount carries under its E6 name, reported under
   * this explicit name so "provider down" and "our storage broke"
   * stay distinguishable at the API surface.
   */
  captureFailures: number;
  /** E7: fetched_at of the most recent fetch_failed record; null when none. */
  lastFetchFailureAt: string | null;
  /** E7: fetch_failed records counting back from the latest record. */
  fetchConsecutiveFailures: number;
  /** E7: the kind of the most recent fetch failure; null when none. */
  latestFetchFailureKind: FetchFailureKind | null;
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
    fetchAttempts: 0,
    fetchFailures: 0,
    fetchFailureRate: 0,
    captureFailures: 0,
    lastFetchFailureAt: null,
    fetchConsecutiveFailures: 0,
    latestFetchFailureKind: null,
  };
}

function isFailureRecord(record: DataCaptureRecord): boolean {
  return record.status === "capture_failed" || record.status === "fetch_failed";
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
    out.fetchAttempts += 1;
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
      out.captureFailures += 1;
      out.lastFailureAt = record.fetchedAt;
    } else if (record.status === "fetch_failed") {
      out.fetchFailures += 1;
      out.lastFailureAt = record.fetchedAt;
      out.lastFetchFailureAt = record.fetchedAt;
      out.latestFetchFailureKind = record.failureKind;
    }
  }
  out.failureRate =
    out.totalCaptures > 0 ? out.failedCount / out.totalCaptures : 0;
  out.fetchFailureRate =
    out.fetchAttempts > 0 ? out.fetchFailures / out.fetchAttempts : 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!isFailureRecord(sorted[i])) break;
    out.consecutiveFailures += 1;
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].status !== "fetch_failed") break;
    out.fetchConsecutiveFailures += 1;
  }
  return out;
}

/**
 * The health status as a PURE function of the aggregates — the same
 * aggregates always yield the same status. Thresholds:
 * PROVIDER_HEALTH_THRESHOLDS. E7: the fetch failure rate degrades
 * alongside the capture failure rate (read defensively so a
 * v1-shaped aggregates object — no fetch fields — derives exactly
 * the E6 status).
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
    (aggregates.fetchFailureRate ?? 0) >=
      PROVIDER_HEALTH_THRESHOLDS.degradedFetchFailureRate ||
    aggregates.consecutiveFailures >= 1
  ) {
    return "degraded";
  }
  return "healthy";
}

/**
 * The derivation as a PURE function of a record set — the same
 * records always yield the same health block, whichever store
 * supplied them (#2303: the sync store and the capture port run
 * this identical derivation over their reads).
 */
export function aggregateProviderHealthFromRecords(
  records: readonly DataCaptureRecord[],
  now: number = Date.now()
): ProviderHealth {
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
  return aggregateProviderHealthFromRecords(
    listCapturesByProvider(sql, tenantId, providerId),
    now
  );
}

/**
 * The same aggregation over the ProviderCaptureStore port
 * (#2303) — production wiring reads the D1 capture log through
 * the port; the derivation is the shared pure function above.
 */
export async function aggregateProviderHealthViaPort(
  port: ProviderCaptureStore,
  tenantId: string,
  providerId: DataProviderId,
  now: number = Date.now()
): Promise<ProviderHealth> {
  return aggregateProviderHealthFromRecords(
    await port.listCapturesByProvider(tenantId, providerId),
    now
  );
}
