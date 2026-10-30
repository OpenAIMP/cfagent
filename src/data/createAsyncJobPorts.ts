/**
 * Issue #2358 (#1976 step 4a) — composition root for the
 * async-job queue family. This is the ONLY module that maps a
 * host's storage handle to the family's production
 * implementations: domain code imports this helper and the
 * port types, never a store client.
 *
 * The family's hosts hold one handle: the DO sql executor
 * (ctx.storage.sql-shaped). All three roles (queue / read /
 * maintenance) are served by the one DO adapter over that
 * handle — they are roles over a single table in a single
 * instance, so the root hands the same store out three times.
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapters); client-reachable modules must import the port
 * TYPES from asyncJobPorts.ts (type-only, erased at compile
 * time), never this root.
 */
import { DoSqliteAsyncJobStore } from "./doSqliteAsyncJobAdapter";
import { InMemoryAsyncJobStore } from "./inMemoryAsyncJobAdapter";
import type {
  AsyncJobMaintenancePort,
  AsyncJobQueuePort,
  AsyncJobReadPort,
  AsyncJobSqlExecutor,
} from "./asyncJobPorts";

export interface AsyncJobPorts {
  queue: AsyncJobQueuePort;
  read: AsyncJobReadPort;
  maintenance: AsyncJobMaintenancePort;
}

/** Compose the family's ports over a host's DO storage. */
export function createAsyncJobPorts(sql: AsyncJobSqlExecutor): AsyncJobPorts {
  const store = new DoSqliteAsyncJobStore(sql);
  return { queue: store, read: store, maintenance: store };
}

/** Compose the family's ports over the in-memory adapter (tests). */
export function createInMemoryAsyncJobPorts(): AsyncJobPorts {
  const store = new InMemoryAsyncJobStore();
  return { queue: store, read: store, maintenance: store };
}
