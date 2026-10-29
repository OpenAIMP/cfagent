/**
 * src/data/doSqliteMarketplaceAdapter.ts — #2345 (#1976 step
 * 3a, ADR 0022 D-A): the DO-SQLite adapters behind the
 * marketplace ports — the AGENT_DB-unbound composition (the
 * pre-move behaviour: the instance's own mas_* tables,
 * per-instance counters). Each adapter wraps the generic
 * repository core and adds the atomic counter step over the
 * adapter's own handle (adapter-side SQL is the layer's job).
 *
 * #CDO-mha7
 */
import type {
  AdRecord,
  CategoryRecord,
  ExternalAdRecord,
  ReferralRecord,
} from "../types";
import {
  AD_COLUMN_MAP,
  CATEGORY_COLUMN_MAP,
  createDoAdRepository,
  createDoCategoryRepository,
  createDoExternalAdRepository,
  createDoReferralRepository,
  EXTERNAL_AD_COLUMN_MAP,
  REFERRAL_COLUMN_MAP,
} from "./doSqliteOrmAdapters";
import type {
  AdPort,
  AsyncRepositoryPort,
  ExternalAdPort,
} from "./marketplacePorts";
import type { Repository } from "./ormRepositoryCore";
import type {
  RepositoryQueryOptions,
  SqlStorage,
} from "./repositoryPorts";

class DoMarketplaceRepository<T extends Record<string, any>>
  implements AsyncRepositoryPort<T>
{
  readonly tableName: string;

  constructor(
    protected readonly sql: SqlStorage,
    protected readonly repo: Repository<T>,
    protected readonly columnMap: Record<string, string>,
  ) {
    this.tableName = repo.tableName;
  }

  async findMany(options?: RepositoryQueryOptions): Promise<T[]> {
    return this.repo.findMany(options);
  }
  async findById(id: string): Promise<T | null> {
    return this.repo.findById(id);
  }
  async findOne(where: Record<string, unknown>): Promise<T | null> {
    return this.repo.findOne(where);
  }
  async create(record: T): Promise<T> {
    return this.repo.create(record);
  }
  async update(id: string, updates: Partial<T>): Promise<T | null> {
    return this.repo.update(id, updates);
  }
  async upsert(record: T): Promise<T> {
    return this.repo.upsert(record);
  }
  async delete(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
  async count(where?: Record<string, unknown>): Promise<number> {
    return this.repo.count(where);
  }

  async incrementCounter(
    id: string,
    counter: string,
    delta: number,
  ): Promise<number | null> {
    const col = this.columnMap[counter];
    if (!col) {
      throw new Error(`Unknown counter ${counter} for ${this.tableName}`);
    }
    this.sql.exec(
      `UPDATE ${this.tableName} SET ${col} = ${col} + ? WHERE id = ?`,
      delta,
      id,
    );
    const row = this.repo.findById(id);
    return row ? Number((row as Record<string, unknown>)[counter] ?? 0) : null;
  }
}

class DoExternalAdRepository
  extends DoMarketplaceRepository<ExternalAdRecord>
  implements ExternalAdPort
{
  async incrementEarnings(id: string, delta: number): Promise<number | null> {
    return this.incrementCounter(id, "earnings", delta);
  }
}

class DoAdRepository
  extends DoMarketplaceRepository<AdRecord>
  implements AdPort
{
  async incrementAllImpressions(delta: number): Promise<void> {
    this.sql.exec("UPDATE mas_ads SET impressions = impressions + ?", delta);
  }
}

/** The four DO-SQLite marketplace adapters over one instance handle. */
export function createDoMarketplaceAdapters(sql: SqlStorage): {
  categories: DoMarketplaceRepository<CategoryRecord>;
  externalAds: ExternalAdPort;
  ads: AdPort;
  referrals: DoMarketplaceRepository<ReferralRecord>;
} {
  return {
    categories: new DoMarketplaceRepository<CategoryRecord>(
      sql,
      createDoCategoryRepository(sql),
      CATEGORY_COLUMN_MAP,
    ),
    externalAds: new DoExternalAdRepository(
      sql,
      createDoExternalAdRepository(sql),
      EXTERNAL_AD_COLUMN_MAP,
    ),
    ads: new DoAdRepository(sql, createDoAdRepository(sql), AD_COLUMN_MAP),
    referrals: new DoMarketplaceRepository<ReferralRecord>(
      sql,
      createDoReferralRepository(sql),
      REFERRAL_COLUMN_MAP,
    ),
  };
}
