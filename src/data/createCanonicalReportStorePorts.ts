/**
 * Issue #2359 (#1976 step 4d) — composition root for the
 * canonical-report store family (mas_reports + usage_events).
 * This is the ONLY module that maps a host's storage handle
 * to the family's production implementations: domain code
 * imports this helper and the port types, never a store
 * client.
 *
 * Write and read are roles over one table in one instance,
 * so the root hands the same store out under each role; the
 * usage port is its own store over the same handle.
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapters); client-reachable modules must import the port
 * TYPES from canonicalReportStorePorts.ts (type-only, erased
 * at compile time), never this root.
 */
import { DoSqliteCanonicalReportStore } from "./doSqliteCanonicalReportStoreAdapter";
import { DoSqliteUsageEventStore } from "./doSqliteUsageEventAdapter";
import {
  InMemoryCanonicalReportStore,
  InMemoryUsageEventStore,
} from "./inMemoryCanonicalReportStoreAdapters";
import type {
  CanonicalReportReadPort,
  CanonicalReportStoreSqlExecutor,
  CanonicalReportWritePort,
  UsageEventPort,
} from "./canonicalReportStorePorts";

export interface CanonicalReportStorePorts {
  write: CanonicalReportWritePort;
  read: CanonicalReportReadPort;
  usage: UsageEventPort;
}

/** Compose the family's ports over a host's DO storage. */
export function createCanonicalReportStorePorts(
  sql: CanonicalReportStoreSqlExecutor
): CanonicalReportStorePorts {
  const store = new DoSqliteCanonicalReportStore(sql);
  return { write: store, read: store, usage: new DoSqliteUsageEventStore(sql) };
}

/** Compose the family's ports over the in-memory adapters (tests). */
export function createInMemoryCanonicalReportStorePorts(): CanonicalReportStorePorts {
  const store = new InMemoryCanonicalReportStore();
  return { write: store, read: store, usage: new InMemoryUsageEventStore() };
}
