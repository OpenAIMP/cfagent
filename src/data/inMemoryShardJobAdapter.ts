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
import type {
  RetentionPurgeStore,
  ShardJobKey,
} from "./retentionPorts";

/** Issue #1701 (slice 6): same purge semantics as the D1 adapter. */
export class InMemoryShardJobAdapter
  implements ShardJobStore, RetentionPurgeStore
{
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

  async listAgedShardJobKeys(
    tenantId: string,
    cutoffMs: number,
    limit: number,
  ): Promise<ShardJobKey[]> {
    return byAge(
      this.rows.filter(
        (r) => r.tenantId === tenantId && r.createdAtMs < cutoffMs,
      ),
    ).slice(0, limit);
  }

  async listOldestShardJobKeys(
    tenantId: string,
    limit: number,
  ): Promise<ShardJobKey[]> {
    return byAge(this.rows.filter((r) => r.tenantId === tenantId)).slice(
      0,
      limit,
    );
  }

  async countShardJobs(tenantId: string): Promise<number> {
    return this.rows.filter((r) => r.tenantId === tenantId).length;
  }

  async deleteShardJobs(
    tenantId: string,
    keys: ShardJobKey[],
  ): Promise<void> {
    for (const key of keys) {
      const idx = this.rows.findIndex(
        (r) =>
          r.tenantId === tenantId &&
          r.chainId === key.chainId &&
          r.jobKey === key.jobKey &&
          r.version === key.version,
      );
      if (idx >= 0) this.rows.splice(idx, 1);
    }
  }
}

function byAge(rows: ShardJobRow[]): ShardJobKey[] {
  return [...rows]
    .sort(
      (a, b) =>
        a.createdAtMs - b.createdAtMs ||
        a.chainId.localeCompare(b.chainId) ||
        a.jobKey.localeCompare(b.jobKey) ||
        a.version - b.version,
    )
    .map((r) => ({ chainId: r.chainId, jobKey: r.jobKey, version: r.version }));
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
