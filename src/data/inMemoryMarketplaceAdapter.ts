/**
 * src/data/inMemoryMarketplaceAdapter.ts — #2345 (#1976 step
 * 3a, ADR 0022 D-A): the in-memory adapters behind the
 * marketplace ports — the conformance twin for the DO-SQLite
 * and D1 adapters. Each adapter delegates to an
 * InMemoryRepository and returns promises. Counter steps are
 * read-modify-write here (a single-threaded test double has
 * no cross-instance race to lose); atomicity is a property
 * of the real adapters and is pinned there.
 *
 * #CDO-mha7
 */
import type {
  AdRecord,
  CategoryRecord,
  ExternalAdRecord,
  ReferralRecord,
} from "../types";
import { InMemoryRepository } from "./inMemoryOrmAdapters";
import {
  marketplaceSeedData,
  type AdPort,
  type AsyncRepositoryPort,
  type ExternalAdPort,
  type MarketplacePorts,
} from "./marketplacePorts";
import type { RepositoryQueryOptions } from "./repositoryPorts";

class InMemoryMarketplaceRepository<T extends Record<string, any>>
  implements AsyncRepositoryPort<T>
{
  readonly tableName: string;
  protected readonly inner: InMemoryRepository<T>;

  constructor(tableName: string, idField: string = "id") {
    this.inner = new InMemoryRepository<T>(tableName, idField);
    this.tableName = tableName;
  }

  async findMany(options?: RepositoryQueryOptions): Promise<T[]> {
    return this.inner.findMany(options);
  }
  async findById(id: string): Promise<T | null> {
    return this.inner.findById(id);
  }
  async findOne(where: Record<string, unknown>): Promise<T | null> {
    return this.inner.findOne(where);
  }
  async create(record: T): Promise<T> {
    return this.inner.create(record);
  }
  async update(id: string, updates: Partial<T>): Promise<T | null> {
    return this.inner.update(id, updates);
  }
  async upsert(record: T): Promise<T> {
    return this.inner.upsert(record);
  }
  async delete(id: string): Promise<boolean> {
    return this.inner.delete(id);
  }
  async count(where?: Record<string, unknown>): Promise<number> {
    return this.inner.count(where);
  }
  /** Seed rows synchronously (composition seeding; see the factory). */
  seedSync(records: T[]): void {
    for (const record of records) {
      if (!this.inner.findById(record.id)) this.inner.create(record);
    }
  }

  async incrementCounter(
    id: string,
    counter: string,
    delta: number,
  ): Promise<number | null> {
    const row = this.inner.findById(id);
    if (!row) return null;
    const next = Number((row as Record<string, unknown>)[counter] ?? 0) + delta;
    this.inner.update(id, { [counter]: next } as Partial<T>);
    return next;
  }
}

class InMemoryExternalAdRepository
  extends InMemoryMarketplaceRepository<ExternalAdRecord>
  implements ExternalAdPort
{
  async incrementEarnings(id: string, delta: number): Promise<number | null> {
    return this.incrementCounter(id, "earnings", delta);
  }
}

class InMemoryAdRepository
  extends InMemoryMarketplaceRepository<AdRecord>
  implements AdPort
{
  async incrementAllImpressions(delta: number): Promise<void> {
    for (const row of this.inner.findMany()) {
      this.inner.update(row.id, {
        impressions: Number(row.impressions ?? 0) + delta,
      });
    }
  }
}

/** The four in-memory marketplace adapters (conformance use).
 * Seeded with the canonical marketplaceSeedData rows, like
 * every other composition (the facade seeds on
 * initializeSchema; the D1 composition seeds in
 * ensureD1Marketplace) — a conformance double that started
 * empty would pin a composition state production never has. */
export function createInMemoryMarketplacePorts(): MarketplacePorts {
  const seeds = marketplaceSeedData(new Date().toISOString());
  const categories = new InMemoryMarketplaceRepository<CategoryRecord>(
    "mas_categories",
    "id",
  );
  categories.seedSync(seeds.categories);
  const externalAds = new InMemoryExternalAdRepository("mas_external_ads", "id");
  externalAds.seedSync(seeds.externalAds);
  const ads = new InMemoryAdRepository("mas_ads", "id");
  ads.seedSync(seeds.ads);
  return {
    categories,
    externalAds,
    ads,
    referrals: new InMemoryMarketplaceRepository<ReferralRecord>(
      "mas_referrals",
      "id",
    ),
  };
}
