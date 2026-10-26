/**
 * Issue #1651 ([AGENTIC] Slice 1) — in-memory chain/schedule
 * store.
 *
 * A test double with the same port semantics as the D1 adapter:
 * the port/dialect suite runs unchanged against both. It is NOT
 * a production store and NOT a second source of truth — it
 * exists so the port contract is testable without any store at
 * all, and so the dialect suite can prove a behavior is
 * adapter-independent. No migration concept applies here (there
 * is no SQL to migrate).
 */
import type {
  ChainRow,
  ChainScheduleStore,
  ScheduleRow,
} from "./chainSchedulePorts";

export class InMemoryChainScheduleAdapter implements ChainScheduleStore {
  private chains: ChainRow[] = [];
  private schedules: ScheduleRow[] = [];

  async recordChain(row: ChainRow): Promise<void> {
    if (
      this.chains.some(
        (r) =>
          r.tenantId === row.tenantId &&
          r.chainId === row.chainId &&
          r.version === row.version,
      )
    ) {
      return;
    }
    this.chains.push({ ...row });
  }

  async recordSchedule(row: ScheduleRow): Promise<void> {
    if (
      this.schedules.some(
        (r) =>
          r.tenantId === row.tenantId &&
          r.scheduleId === row.scheduleId &&
          r.version === row.version,
      )
    ) {
      return;
    }
    this.schedules.push({ ...row });
  }

  async latestChain(
    tenantId: string,
    chainId: string,
  ): Promise<ChainRow | null> {
    const matches = this.chains.filter(
      (r) => r.tenantId === tenantId && r.chainId === chainId,
    );
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.version - a.version);
    return { ...matches[0] };
  }

  async latestSchedule(
    tenantId: string,
    scheduleId: string,
  ): Promise<ScheduleRow | null> {
    const matches = this.schedules.filter(
      (r) => r.tenantId === tenantId && r.scheduleId === scheduleId,
    );
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.version - a.version);
    return { ...matches[0] };
  }
}
