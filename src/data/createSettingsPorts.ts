/**
 * Issue #2390 (#1976 step 4g, gate G-7) — composition root for
 * the settings family: the dedicated port that owns
 * mas_settings. This is the ONLY module that maps a host's
 * storage handle to the family's production implementation:
 * consumers import this helper and the port type, never a
 * store client.
 *
 * The table lives in the orchestrator instance's own storage;
 * construction executes NOTHING — the table's DDL runs only
 * through the port's ensureSchema (called by the orchestrator's
 * ensureTables composition and by delegates whose legacy shape
 * ensured on every call). The ORM composition root
 * (createOrmPorts) and the strategy-cluster root
 * (createStrategyClusterPorts) also expose this port over the
 * same adapters for their families' consumers.
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapter); client-reachable modules must import the port
 * TYPES from settingsReadPorts.ts (type-only, erased at
 * compile time), never this root.
 */
import { DoSqliteSettingsAdapter } from "./doSqliteOrmAdapters";
import { InMemorySettingsAdapter } from "./inMemoryOrmAdapters";
import type {
  SettingsPort,
  SettingsSqlExecutor,
} from "./settingsReadPorts";

/** Compose the settings port over a host's DO storage. */
export function createSettingsPort(sql: SettingsSqlExecutor): SettingsPort {
  return new DoSqliteSettingsAdapter(sql as never);
}

/** Compose the in-memory settings port (test doubles). */
export function createInMemorySettingsPort(): SettingsPort {
  return new InMemorySettingsAdapter();
}
