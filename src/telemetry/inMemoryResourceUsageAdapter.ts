/**
 * In-memory ResourceUsagePort (issue #1819).
 *
 * Test double and local-dev sink with the same port semantics as the D1
 * adapter: record → totals over the same bucket definition. It is NOT a
 * production store — a per-isolate array loses events on recycle, which is
 * exactly why the production composition root only returns it when no
 * durable sink (Analytics Engine, D1) is bound, and why requireAuth passes
 * no sink at all in that case rather than a sink that silently drops data.
 */
import {
  bucketTotals,
  type ResourceBucketTotal,
  type ResourceUsageEvent,
  type ResourceUsagePort,
} from "./resourceUsagePorts";

export class InMemoryResourceUsageAdapter implements ResourceUsagePort {
  private readonly stored: ResourceUsageEvent[] = [];

  record(event: ResourceUsageEvent): void {
    this.stored.push(event);
  }

  events(): ResourceUsageEvent[] {
    return [...this.stored];
  }

  totals(fromMs: number, toMs: number, bucketMs: number): ResourceBucketTotal[] {
    return bucketTotals(
      this.stored.filter((e) => e.timestampMs >= fromMs && e.timestampMs < toMs),
      bucketMs
    );
  }
}
