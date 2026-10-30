/**
 * Issue #2362 (#1976 step 4f) — in-memory
 * ResourceRollupStorePort adapter: the conformance suite's
 * second implementation of the contract. Mirrors the D1
 * adapter's semantics: replace-writes per key, the pinned
 * read ordering, null before the first row. (Error direction
 * differs by construction — an in-memory store has no
 * missing-table state; the throw contract is D1-shaped and
 * pinned against the D1 adapter + characterization.)
 */
import type { AlertState, ResourceRollupStorePort } from "./resourceRollupPorts";
import type { DailyRollupRow } from "../telemetry/resourceRollup";

export class InMemoryResourceRollupStore implements ResourceRollupStorePort {
  private readonly rollups = new Map<string, DailyRollupRow>();
  private readonly alerts = new Map<string, AlertState>();
  private readonly reports = new Map<string, string>();

  async ensureSchema(): Promise<void> {
    // Nothing to create: presence is the maps above.
  }

  async writeDailyRollup(_day: string, rows: readonly DailyRollupRow[]): Promise<void> {
    for (const row of rows) {
      this.rollups.set([row.day, row.ns, row.op, row.caller, row.trigger].join("\0"), { ...row });
    }
  }

  async readDailyRollup(day: string): Promise<DailyRollupRow[]> {
    return [...this.rollups.values()]
      .filter((r) => r.day === day)
      .sort(
        (a, b) =>
          a.ns.localeCompare(b.ns) ||
          a.op.localeCompare(b.op) ||
          a.caller.localeCompare(b.caller) ||
          a.trigger.localeCompare(b.trigger),
      )
      .map((r) => ({ ...r }));
  }

  async latestCompletedRollupDay(): Promise<string | null> {
    const days = [...this.rollups.values()].map((r) => r.day).sort();
    return days.length ? days[days.length - 1] : null;
  }

  async getAlertState(budget: string, day: string): Promise<AlertState | null> {
    return this.alerts.get([budget, day].join("\0")) ?? null;
  }

  async markAlerted(
    budget: string,
    day: string,
    delivered: boolean,
    note: string | null,
  ): Promise<void> {
    this.alerts.set([budget, day].join("\0"), {
      budget,
      day,
      alerted_at: Date.now(),
      delivered: delivered ? 1 : 0,
      note,
    });
  }

  async writeComparisonReport(day: string, report: unknown): Promise<void> {
    this.reports.set(day, JSON.stringify(report));
  }

  async readComparisonReport(day: string): Promise<unknown | null> {
    const json = this.reports.get(day);
    return json === undefined ? null : (JSON.parse(json) as unknown);
  }
}
