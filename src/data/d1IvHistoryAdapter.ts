/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-I step 2) — the D1
 * implementation of the IV-history port: Drizzle over
 * `agent_iv_history` (migration 0020).
 *
 * CUTOVER GATE (issue #2337, R-2): this adapter is
 * conformance-proven but NOT selected in production — the
 * composition root defaults to the DO adapter and selects this
 * one only when config says so (IV_HISTORY_D1_ENABLED). The
 * read/write cutover waits on the owner ruling recorded on the
 * issue: existing history is stranded per collecting DO
 * instance, so switching writers first would restart the
 * series from empty (a warming-up restart under the 2026-10-13
 * 365-day retention decision is an explicit call, never a
 * default).
 *
 * Semantics identical to the DO adapter (the port's contract):
 *  - record() is first-write-wins per (symbol, date) and
 *    REPORTS the outcome: true when the row was written, false
 *    when the day already had its record. A pre-check read
 *    makes the outcome reportable; the (symbol, date) primary
 *    key + ON CONFLICT DO NOTHING keeps the guarantee even if
 *    a writer races the check. One statement unit per record,
 *    never batched (step-2 audit §4): a provider-failed day is
 *    an absent observation, never a rolled-back batch.
 *  - Symbols are normalized (trim + upper-case) on every path.
 *  - listSeries is newest-first; coverage reports the count
 *    and the MIN/MAX date span; listSymbols ascending.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { agentIvHistory } from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type {
  IvHistoryCoverage,
  IvHistoryRecord,
  IvHistoryStore,
} from "./ivHistoryPorts";

/** Drizzle D1 database object carrying the IV-history schema. */
export type IvHistoryDb = DrizzleD1Database<{
  agentIvHistory: typeof agentIvHistory;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1IvHistoryDb(d1: D1Database): IvHistoryDb {
  return drizzle(d1, { schema: { agentIvHistory } });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureIvHistorySchema(
  db: IvHistoryDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

type IvRow = typeof agentIvHistory.$inferSelect;

function rowToRecord(row: IvRow): IvHistoryRecord {
  return {
    symbol: row.symbol,
    date: row.date,
    atmIv: row.atmIv,
    spot: row.spot,
    expiryDate: row.expiryDate,
    dte: row.dte,
    collectedAt: row.collectedAt,
  };
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/** The D1 implementation of the IV-history port. */
export class D1IvHistoryStore implements IvHistoryStore {
  constructor(readonly db: IvHistoryDb) {}

  async record(record: IvHistoryRecord): Promise<boolean> {
    const symbol = normalizeSymbol(record.symbol);
    if (await this.get(symbol, record.date)) return false;
    await this.db
      .insert(agentIvHistory)
      .values({
        symbol,
        date: record.date,
        atmIv: record.atmIv,
        spot: record.spot,
        expiryDate: record.expiryDate,
        dte: record.dte,
        collectedAt: record.collectedAt,
      })
      .onConflictDoNothing();
    return true;
  }

  async get(symbol: string, date: string): Promise<IvHistoryRecord | null> {
    const rows = await this.db
      .select()
      .from(agentIvHistory)
      .where(
        and(
          eq(agentIvHistory.symbol, normalizeSymbol(symbol)),
          eq(agentIvHistory.date, date),
        ),
      )
      .limit(1);
    return rows.length ? rowToRecord(rows[0]) : null;
  }

  async listSeries(
    symbol: string,
    options: { limit?: number } = {},
  ): Promise<IvHistoryRecord[]> {
    const query = this.db
      .select()
      .from(agentIvHistory)
      .where(eq(agentIvHistory.symbol, normalizeSymbol(symbol)))
      .orderBy(desc(agentIvHistory.date));
    const rows = options.limit !== undefined ? await query.limit(options.limit) : await query;
    return rows.map(rowToRecord);
  }

  async coverage(symbol: string): Promise<IvHistoryCoverage> {
    const [row] = await this.db
      .select({
        count: sql<number>`COUNT(*)`,
        firstDate: sql<string | null>`MIN(${agentIvHistory.date})`,
        lastDate: sql<string | null>`MAX(${agentIvHistory.date})`,
      })
      .from(agentIvHistory)
      .where(eq(agentIvHistory.symbol, normalizeSymbol(symbol)));
    return {
      observations: Number(row?.count ?? 0),
      firstDate: row?.firstDate ?? null,
      lastDate: row?.lastDate ?? null,
    };
  }

  async listSymbols(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ symbol: agentIvHistory.symbol })
      .from(agentIvHistory)
      .orderBy(asc(agentIvHistory.symbol));
    return rows.map((r) => r.symbol);
  }
}
