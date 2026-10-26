/**
 * Issue #1676 ([AGENTIC] Slice 2) — in-memory test double for
 * the shard job store. Same port semantics as the D1 adapter:
 * replay of the same (tenant, chain, job, version) is a
 * no-op; latest-per-job wins for reads; tenant scoping is
 * enforced on every method. Not a production store.
 */
import type {
  ShardJobRow,
  ShardJobStatus,
  ShardJobStore,
} from "./shardJobPorts";

export class InMemoryShardJobAdapter implements ShardJobStore {
  private readonly rows: ShardJobRow[] = [];

  async recordJob(row: ShardJobRow): Promise<void> {
    const exists = this.rows.some(
      (r) =>
        r.tenantId === row.tenantId &&
        r.chainId === row.chainId &&
        r.jobKey === row.jobKey &&
        r.version === row.version,
    );
    if (!exists) this.rows.push({ ...row });
  }

  async latestJob(
    tenantId: string,
    chainId: string,
    jobKey: string,
  ): Promise<ShardJobRow | null> {
    const matches = this.rows.filter(
      (r) =>
        r.tenantId === tenantId && r.chainId === chainId && r.jobKey === jobKey,
    );
    if (matches.length === 0) return null;
    return { ...matches.reduce((a, b) => (b.version > a.version ? b : a)) };
  }

  async listJobsForChain(
    tenantId: string,
    chainId: string,
  ): Promise<ShardJobRow[]> {
    return latestPerJob(
      this.rows.filter((r) => r.tenantId === tenantId && r.chainId === chainId),
    );
  }

  async listJobsByStatus(
    tenantId: string,
    status: ShardJobStatus,
  ): Promise<ShardJobRow[]> {
    return latestPerJob(
      this.rows.filter((r) => r.tenantId === tenantId),
    ).filter((r) => r.status === status);
  }
}

function latestPerJob(rows: ShardJobRow[]): ShardJobRow[] {
  const byKey = new Map<string, ShardJobRow>();
  for (const row of rows) {
    const current = byKey.get(row.jobKey);
    if (!current || row.version > current.version) {
      byKey.set(row.jobKey, row);
    }
  }
  return [...byKey.values()]
    .map((r) => ({ ...r }))
    .sort(
      (a, b) =>
        b.updatedAtMs - a.updatedAtMs || a.jobKey.localeCompare(b.jobKey),
    );
}
