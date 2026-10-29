/**
 * Issue #2288 (#1976 step 0) — in-memory work-item event store.
 *
 * A test double with the same port semantics as the D1 adapter:
 * the conformance suite runs unchanged against both, including
 * the redelivery contract (state refreshes, createdAtMs never
 * moves, inserted reports first sighting only). NOT a
 * production store.
 */
import type {
  WorkItemEvent,
  WorkItemEventRow,
  WorkItemEventStore,
  WorkItemKind,
} from "./workItemEventPorts";

export class InMemoryWorkItemEventAdapter implements WorkItemEventStore {
  private rows = new Map<string, WorkItemEventRow>();

  private key(source: string, externalId: string): string {
    return `${source}::${externalId}`;
  }

  async upsertWorkItemEvent(
    event: WorkItemEvent,
    deliveredAtMs: number = Date.now(),
  ): Promise<{ inserted: boolean }> {
    const key = this.key(event.source, event.externalId);
    const existing = this.rows.get(key);
    if (!existing) {
      this.rows.set(key, {
        ...event,
        createdAtMs: deliveredAtMs,
        updatedAtMs: deliveredAtMs,
      });
      return { inserted: true };
    }
    this.rows.set(key, {
      ...existing,
      kind: event.kind,
      state: event.state,
      actor: event.actor,
      occurredAtMs: event.occurredAtMs,
      payloadDigest: event.payloadDigest,
      updatedAtMs: deliveredAtMs,
    });
    return { inserted: false };
  }

  async getWorkItemEvent(
    source: string,
    externalId: string,
  ): Promise<WorkItemEventRow | null> {
    const row = this.rows.get(this.key(source, externalId));
    return row ? { ...row } : null;
  }

  async listWorkItemEvents(
    kind?: WorkItemKind,
  ): Promise<WorkItemEventRow[]> {
    return [...this.rows.values()]
      .filter((r) => (kind ? r.kind === kind : true))
      .sort((a, b) => {
        if (a.occurredAtMs !== b.occurredAtMs)
          return b.occurredAtMs - a.occurredAtMs;
        return a.externalId < b.externalId
          ? 1
          : a.externalId > b.externalId
            ? -1
            : 0;
      })
      .map((r) => ({ ...r }));
  }
}
