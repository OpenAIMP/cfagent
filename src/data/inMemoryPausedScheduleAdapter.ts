/**
 * Issue #2337 (#1976 step 2) — the in-memory implementation of
 * the paused-schedule port, with semantics identical to the
 * DO-SQLite adapter (upsert by id, list paused_at ascending).
 * NEW with this port — the legacy module had no in-memory twin.
 */
import type {
  PausedScheduleRecord,
  PausedScheduleStore,
} from "./pausedSchedulePorts";

export class InMemoryPausedScheduleStore implements PausedScheduleStore {
  private records = new Map<string, PausedScheduleRecord>();

  async save(record: PausedScheduleRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<PausedScheduleRecord | undefined> {
    return this.records.get(id);
  }

  async list(): Promise<PausedScheduleRecord[]> {
    return [...this.records.values()].sort((a, b) =>
      a.pausedAt < b.pausedAt ? -1 : a.pausedAt > b.pausedAt ? 1 : 0,
    );
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}
