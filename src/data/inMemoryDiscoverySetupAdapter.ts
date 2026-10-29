/**
 * Issue #2337 (#1976 step 2) — the in-memory implementation of
 * the discovery setup-run port, with semantics identical to the
 * DO-SQLite adapter (including the pre-write count
 * reconciliation). Moved from
 * src/trading/options/discoverySetupStore.ts (now a shim).
 */
import {
  DISCOVERY_MODEL_VERSION,
  DISCOVERY_SETUP_RUN_MAX_ROWS,
  DISCOVERY_SETUP_RUN_RETENTION_DAYS,
  discoverySetupRunVisibleToCaller,
  validateDiscoveryRunCounts,
  type DiscoverySetupRunInput,
  type DiscoverySetupStore,
  type DiscoverySetupStoreOptions,
  type StoredDiscoverySetupRun,
} from "./discoverySetupPorts";

function retentionCutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

function byNewestFirst(a: StoredDiscoverySetupRun, b: StoredDiscoverySetupRun): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function assertReconciled(input: DiscoverySetupRunInput): void {
  const error = validateDiscoveryRunCounts(input.counts, input.items);
  if (error) throw new Error(`discovery run rejected: ${error}`);
}

export class InMemoryDiscoverySetupStore implements DiscoverySetupStore {
  private runs: StoredDiscoverySetupRun[] = [];
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(options: DiscoverySetupStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? DISCOVERY_SETUP_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? DISCOVERY_SETUP_RUN_MAX_ROWS;
  }

  async save(input: DiscoverySetupRunInput): Promise<StoredDiscoverySetupRun> {
    assertReconciled(input);
    const run: StoredDiscoverySetupRun = {
      ...input,
      id: this.idFactory(),
      modelVersion: DISCOVERY_MODEL_VERSION,
    };
    this.runs.push(run);
    await this.prune(new Date(input.createdAt));
    return run;
  }

  async list(
    options: { limit?: number; offset?: number; scopeKey?: string; userLogin?: string } = {},
  ): Promise<StoredDiscoverySetupRun[]> {
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    return this.runs
      .filter((r) => discoverySetupRunVisibleToCaller(r, options.userLogin))
      .filter((r) => options.scopeKey === undefined || r.scopeKey === options.scopeKey)
      .sort(byNewestFirst)
      .slice(offset, offset + limit);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredDiscoverySetupRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    return discoverySetupRunVisibleToCaller(run, options.userLogin) ? run : null;
  }

  async latestForScope(
    scopeKey: string,
    options: { userLogin?: string } = {},
  ): Promise<StoredDiscoverySetupRun | null> {
    const [latest] = await this.list({ scopeKey, limit: 1, userLogin: options.userLogin });
    return latest ?? null;
  }

  async prune(now: Date): Promise<number> {
    const cutoff = retentionCutoff(now, this.retentionDays);
    const before = this.runs.length;
    const fresh = this.runs.filter((r) => r.createdAt >= cutoff).sort(byNewestFirst);
    this.runs = fresh.slice(0, this.maxRows);
    return before - this.runs.length;
  }
}
