/**
 * src/data/d1MarketplaceAdapter.ts — #2345 (#1976 step 3a,
 * ADR 0022 D-A/D-B): the D1 implementation of the marketplace
 * ports — Drizzle over agent_categories / agent_referrals /
 * agent_ads / agent_external_ads (migration 0021).
 *
 * Semantics identical to the DO-SQLite adapters (the ports'
 * contract): create = insert-or-throw; update returns the
 * re-read row or null with the D-E.2 verification; delete
 * returns true only when a row was removed; counters step
 * atomically in SQL. Statements are built with Drizzle's sql
 * template — identifiers come only from the static column
 * maps (validated against the map before use), values are
 * always bound. Boolean record fields map to 0/1 is_*
 * columns exactly as the DO core maps them.
 *
 * ensureD1Marketplace applies pending migrations and seeds
 * each table iff empty with the canonical seed data (the
 * same marketplaceSeedData the DO facade seeds from), so a
 * fresh D1 starts with the same fleet reference data every
 * instance used to seed privately.
 *
 * #CDO-mha7
 */
import { sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import {
  AD_COLUMN_MAP,
  CATEGORY_COLUMN_MAP,
  EXTERNAL_AD_COLUMN_MAP,
  REFERRAL_COLUMN_MAP,
} from "./doSqliteOrmAdapters";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type {
  AdRecord,
  CategoryRecord,
  ExternalAdRecord,
  ReferralRecord,
} from "../types";
import {
  marketplaceSeedData,
  type AdPort,
  type AsyncRepositoryPort,
  type ExternalAdPort,
  type MarketplacePorts,
} from "./marketplacePorts";
import type { RepositoryQueryOptions } from "./repositoryPorts";

/** Drizzle D1 database object for the marketplace tables. */
export type MarketplaceDb = DrizzleD1Database<Record<string, never>>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1MarketplaceDb(d1: D1Database): MarketplaceDb {
  return drizzle(d1) as unknown as MarketplaceDb;
}

interface D1TableConfig {
  table: string;
  idField: string;
  columnMap: Record<string, string>;
}

const IDENT = /^[a-z][a-z0-9_]*$/;

class D1MarketplaceRepository<T extends Record<string, any>>
  implements AsyncRepositoryPort<T>
{
  readonly tableName: string;

  constructor(
    protected readonly db: MarketplaceDb,
    protected readonly config: D1TableConfig,
  ) {
    this.tableName = config.table;
  }

  private col(prop: string): string {
    const col = this.config.columnMap[prop] || prop;
    if (!IDENT.test(col)) throw new Error(`Invalid column for ${this.tableName}: ${prop}`);
    return col;
  }

  private allowedColumns(): Set<string> {
    return new Set([
      ...Object.values(this.config.columnMap),
      ...Object.keys(this.config.columnMap),
    ]);
  }

  private fromRow(row: Record<string, unknown>): T {
    const obj: Record<string, unknown> = {};
    const reverse: Record<string, string> = {};
    for (const [prop, col] of Object.entries(this.config.columnMap)) {
      reverse[col] = prop;
    }
    for (const [key, val] of Object.entries(row)) {
      const prop = reverse[key] || key;
      if (typeof val === "number" && (key.startsWith("is_") || key === "is_active")) {
        obj[prop] = Boolean(val);
      } else {
        obj[prop] = val;
      }
    }
    return obj as T;
  }

  private toParams(record: Record<string, unknown>): {
    cols: string[];
    values: unknown[];
  } {
    const cols: string[] = [];
    const values: unknown[] = [];
    for (const [prop, val] of Object.entries(record)) {
      cols.push(this.col(prop));
      values.push(typeof val === "boolean" ? (val ? 1 : 0) : val);
    }
    return { cols, values };
  }

  private whereSql(where?: Record<string, unknown>): SQL | null {
    if (!where) return null;
    const clauses: SQL[] = [];
    for (const [key, val] of Object.entries(where)) {
      if (val === undefined || val === null) continue;
      const bound = typeof val === "boolean" ? (val ? 1 : 0) : val;
      clauses.push(sql`${sql.identifier(this.col(key))} = ${bound}`);
    }
    return clauses.length > 0 ? sql.join(clauses, sql` AND `) : null;
  }

  private orderSql(orderBy?: string): SQL | null {
    if (!orderBy) return null;
    const allowed = this.allowedColumns();
    const terms: SQL[] = [];
    for (const part of orderBy.split(",")) {
      const m = part.trim().match(/^([a-z][a-z0-9_]*)(?:\s+(ASC|DESC))?$/i);
      if (!m || !allowed.has(m[1])) {
        throw new Error(`Invalid orderBy for ${this.tableName}: ${orderBy}`);
      }
      terms.push(sql`${sql.identifier(m[1])} ${sql.raw((m[2] || "ASC").toUpperCase())}`);
    }
    return sql.join(terms, sql`, `);
  }

  async findMany(options: RepositoryQueryOptions = {}): Promise<T[]> {
    let query = sql`SELECT * FROM ${sql.identifier(this.tableName)}`;
    const where = this.whereSql(options.where);
    if (where) query = sql`${query} WHERE ${where}`;
    const order = this.orderSql(options.orderBy);
    if (order) query = sql`${query} ORDER BY ${order}`;
    if (options.limit) query = sql`${query} LIMIT ${options.limit}`;
    if (options.offset) query = sql`${query} OFFSET ${options.offset}`;
    const rows = await this.db.all<Record<string, unknown>>(query);
    return rows.map((r) => this.fromRow(r));
  }

  async findById(id: string): Promise<T | null> {
    const rows = await this.db.all<Record<string, unknown>>(
      sql`SELECT * FROM ${sql.identifier(this.tableName)} WHERE ${sql.identifier(this.col(this.config.idField))} = ${id} LIMIT 1`,
    );
    return rows.length > 0 ? this.fromRow(rows[0]) : null;
  }

  async findOne(where: Record<string, unknown>): Promise<T | null> {
    const results = await this.findMany({ where, limit: 1 });
    return results.length > 0 ? results[0] : null;
  }

  async create(record: T): Promise<T> {
    const { cols, values } = this.toParams(record);
    const placeholders = sql.join(
      values.map((v) => sql`${v}`),
      sql`, `,
    );
    await this.db.run(
      sql`INSERT INTO ${sql.identifier(this.tableName)} (${sql.raw(cols.join(", "))}) VALUES (${placeholders})`,
    );
    return record;
  }

  async update(id: string, updates: Partial<T>): Promise<T | null> {
    const sets: SQL[] = [];
    for (const [prop, val] of Object.entries(updates)) {
      if (prop === this.config.idField || val === undefined) continue;
      const bound = typeof val === "boolean" ? (val ? 1 : 0) : val;
      sets.push(sql`${sql.identifier(this.col(prop))} = ${bound}`);
    }
    if (sets.length === 0) return this.findById(id);
    await this.db.run(
      sql`UPDATE ${sql.identifier(this.tableName)} SET ${sql.join(sets, sql`, `)} WHERE ${sql.identifier(this.col(this.config.idField))} = ${id}`,
    );
    const after = await this.findById(id);
    if (!after) return null;
    // D-E.2 verification, same rule as the DO core (#2345).
    for (const [prop, val] of Object.entries(updates)) {
      if (prop === this.config.idField || val === undefined) continue;
      if ((after as Record<string, unknown>)[prop] !== val) {
        throw new Error(
          `Repository.update verification failed on ${this.tableName}: field ${prop} did not read back as written`,
        );
      }
    }
    return after;
  }

  async upsert(record: T): Promise<T> {
    const id = record[this.config.idField];
    if (id && (await this.findById(id))) {
      await this.update(id, record);
      return record;
    }
    return this.create(record);
  }

  async delete(id: string): Promise<boolean> {
    // D-E.2: report the change count when the store gives one;
    // otherwise verify by existence probe + post-delete re-read
    // (the DO core's fallback rule).
    const existed = (await this.findById(id)) !== null;
    const result = await this.db.run(
      sql`DELETE FROM ${sql.identifier(this.tableName)} WHERE ${sql.identifier(this.col(this.config.idField))} = ${id}`,
    );
    const changes = (result as { meta?: { changes?: number } }).meta?.changes;
    if (typeof changes === "number") return changes > 0;
    if (!existed) return false;
    return (await this.findById(id)) === null;
  }

  async count(where?: Record<string, unknown>): Promise<number> {
    let query = sql`SELECT COUNT(*) AS count FROM ${sql.identifier(this.tableName)}`;
    const w = this.whereSql(where);
    if (w) query = sql`${query} WHERE ${w}`;
    const rows = await this.db.all<{ count: number }>(query);
    return Number(rows[0]?.count || 0);
  }

  async incrementCounter(
    id: string,
    counter: string,
    delta: number,
  ): Promise<number | null> {
    const col = this.col(counter);
    await this.db.run(
      sql`UPDATE ${sql.identifier(this.tableName)} SET ${sql.identifier(col)} = ${sql.identifier(col)} + ${delta} WHERE ${sql.identifier(this.col(this.config.idField))} = ${id}`,
    );
    const row = await this.findById(id);
    return row ? Number((row as Record<string, unknown>)[counter] ?? 0) : null;
  }
}

class D1ExternalAdRepository
  extends D1MarketplaceRepository<ExternalAdRecord>
  implements ExternalAdPort
{
  async incrementEarnings(id: string, delta: number): Promise<number | null> {
    return this.incrementCounter(id, "earnings", delta);
  }
}

class D1AdRepository
  extends D1MarketplaceRepository<AdRecord>
  implements AdPort
{
  async incrementAllImpressions(delta: number): Promise<void> {
    await this.db.run(
      sql`UPDATE ${sql.identifier(this.tableName)} SET impressions = impressions + ${delta}`,
    );
  }
}

/** The four D1 marketplace adapters over one Drizzle handle. */
export function createD1MarketplacePorts(db: MarketplaceDb): MarketplacePorts {
  return {
    categories: new D1MarketplaceRepository<CategoryRecord>(db, {
      table: "agent_categories",
      idField: "id",
      columnMap: CATEGORY_COLUMN_MAP,
    }),
    externalAds: new D1ExternalAdRepository(db, {
      table: "agent_external_ads",
      idField: "id",
      columnMap: EXTERNAL_AD_COLUMN_MAP,
    }),
    ads: new D1AdRepository(db, {
      table: "agent_ads",
      idField: "id",
      columnMap: AD_COLUMN_MAP,
    }),
    referrals: new D1MarketplaceRepository<ReferralRecord>(db, {
      table: "agent_referrals",
      idField: "id",
      columnMap: REFERRAL_COLUMN_MAP,
    }),
  };
}

/**
 * Idempotent schema-ensure + seed: applies pending migrations
 * (0021 creates the tables), then seeds each marketplace
 * table iff it is empty, from the canonical seed data.
 */
export async function ensureD1Marketplace(db: MarketplaceDb): Promise<void> {
  await applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
  const ports = createD1MarketplacePorts(db);
  const seeds = marketplaceSeedData(new Date().toISOString());
  if ((await ports.categories.count()) === 0) {
    for (const cat of seeds.categories) await ports.categories.create(cat);
  }
  if ((await ports.externalAds.count()) === 0) {
    for (const ad of seeds.externalAds) await ports.externalAds.create(ad);
  }
  if ((await ports.ads.count()) === 0) {
    for (const ad of seeds.ads) await ports.ads.create(ad);
  }
}
