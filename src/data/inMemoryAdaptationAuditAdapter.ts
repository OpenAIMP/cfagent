/**
 * Issue #2357 (#1976 step 4b) — the in-memory implementation
 * of the adaptation audit port, with semantics identical to
 * the DO-SQLite adapter (append-only, newest-first lists,
 * the 1..500 limit clamp).
 */
import type {
  AdaptationAuditRow,
  AdaptationAuditStore,
  AdaptationRecord,
} from "./adaptationAuditPorts";

export class InMemoryAdaptationAuditStore implements AdaptationAuditStore {
  private rows: AdaptationAuditRow[] = [];

  ensureTable(): void {
    // In-memory: nothing to ensure.
  }

  insert(
    rec: AdaptationRecord,
    status: "applied" | "blocked",
    blockReason: string | null,
    now: Date,
  ): string {
    const id = `adapt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.rows.push({
      id,
      actor: rec.actor,
      subject: rec.subject,
      parameter: rec.parameter,
      before: rec.before,
      after: rec.after,
      delta: rec.delta,
      rationale: rec.rationale,
      dataWindow: rec.dataWindow,
      status,
      blockReason,
      createdAt: rec.createdAt ?? now.toISOString(),
    });
    return id;
  }

  list(subject?: string, limit = 100): AdaptationAuditRow[] {
    const lim = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.rows
      .filter((r) => !subject || r.subject === subject)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, lim)
      .map((r) => ({ ...r }));
  }
}
