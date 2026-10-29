/**
 * Issue #2288 (#1976 step 0) — in-memory trace-record store.
 *
 * A test double with the same port semantics as the D1 adapter:
 * the conformance suite runs unchanged against both. It is NOT a
 * production store and NOT a second source of truth — it exists
 * so the port contract is testable without any store at all.
 */
import type { TraceRecord, TraceRecordStore } from "./traceRecordPorts";

export class InMemoryTraceRecordAdapter implements TraceRecordStore {
  private records: TraceRecord[] = [];

  async appendTrace(record: TraceRecord): Promise<void> {
    if (this.records.some((r) => r.id === record.id)) return;
    this.records.push({ ...record });
  }

  async listByCorrelation(correlationId: string): Promise<TraceRecord[]> {
    return this.records
      .filter((r) => r.correlationId === correlationId)
      .sort((a, b) => {
        if (a.occurredAtMs !== b.occurredAtMs)
          return a.occurredAtMs - b.occurredAtMs;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map((r) => ({ ...r }));
  }

  async listByAgent(
    actingAgent: string,
    limit: number = 100,
  ): Promise<TraceRecord[]> {
    return this.records
      .filter((r) => r.actingAgent === actingAgent)
      .sort((a, b) => {
        if (a.occurredAtMs !== b.occurredAtMs)
          return b.occurredAtMs - a.occurredAtMs;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      })
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
