/**
 * Issue #2361 (#1976 step 4e) — composition root for the
 * screener's run-lock family. This is the ONLY module that
 * maps a host's storage handle to the family's production
 * implementation: the screener imports this helper and the
 * port type, never a store client. It replaces the agent's
 * hand-rolled lockSql() executor callback.
 *
 * The lock table lives in the screener instance's own storage;
 * construction executes NOTHING — the table's DDL runs only
 * through the port's ensureSchema (called by acquire and the
 * probe, exactly as the legacy functions ensured it).
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapter); client-reachable modules must import the port
 * TYPES from screenRunLockPorts.ts (type-only, erased at
 * compile time), never this root.
 */
import { DoSqliteScreenRunLock } from "./doSqliteScreenRunLockAdapter";
import { InMemoryScreenRunLock } from "./inMemoryScreenRunLockAdapter";
import type {
  ScreenRunLockPort,
  ScreenRunLockSqlExecutor,
} from "./screenRunLockPorts";

/** Compose the lock port over a host's DO storage. */
export function createScreenRunLockPort(
  sql: ScreenRunLockSqlExecutor
): ScreenRunLockPort {
  return new DoSqliteScreenRunLock(sql);
}

/** Compose the in-memory lock port (test doubles). */
export function createInMemoryScreenRunLockPort(): ScreenRunLockPort {
  return new InMemoryScreenRunLock();
}
