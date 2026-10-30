/**
 * DELEGATE since issue #2362 (#1976 step 4f): the D1 rollup
 * store is superseded by the ResourceRollupStorePort family
 * in the data layer (src/data/resourceRollupPorts.ts +
 * src/data/d1ResourceRollupAdapter.ts, composition in
 * src/data/createResourceRollupPorts.ts; the tables' DDL
 * authority is migration 0022). This module keeps the
 * function-shaped surface its callers import (the
 * ScheduledAgent goal paths) and forwards to the port; the
 * declared error direction — goal-path errors THROW, unlike
 * the per-op record path — lives on the port contract.
 */
import { createResourceRollupStore } from "../data/createResourceRollupPorts";
import type { ResourceD1Db } from "../data/d1ResourceUsageAdapter";
import type { AlertState } from "../data/resourceRollupPorts";
import type { DailyRollupRow } from "./resourceRollup";

export type { ResourceD1Db };
export type { AlertState };

export async function ensureResourceRollupTables(db: ResourceD1Db): Promise<void> {
  await createResourceRollupStore(db).ensureSchema();
}

export async function writeDailyRollup(
  db: ResourceD1Db,
  day: string,
  rows: readonly DailyRollupRow[]
): Promise<void> {
  await createResourceRollupStore(db).writeDailyRollup(day, rows);
}

export async function readDailyRollup(db: ResourceD1Db, day: string): Promise<DailyRollupRow[]> {
  return createResourceRollupStore(db).readDailyRollup(day);
}

/** Latest day with any rollup row, or null before the first rollup lands. */
export async function latestCompletedRollupDay(db: ResourceD1Db): Promise<string | null> {
  return createResourceRollupStore(db).latestCompletedRollupDay();
}

export async function getAlertState(
  db: ResourceD1Db,
  budget: string,
  day: string
): Promise<AlertState | null> {
  return createResourceRollupStore(db).getAlertState(budget, day);
}

export async function markAlerted(
  db: ResourceD1Db,
  budget: string,
  day: string,
  delivered: boolean,
  note: string | null
): Promise<void> {
  await createResourceRollupStore(db).markAlerted(budget, day, delivered, note);
}

export async function writeComparisonReport(
  db: ResourceD1Db,
  day: string,
  report: unknown
): Promise<void> {
  await createResourceRollupStore(db).writeComparisonReport(day, report);
}

export async function readComparisonReport(db: ResourceD1Db, day: string): Promise<unknown | null> {
  return createResourceRollupStore(db).readComparisonReport(day);
}
