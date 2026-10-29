/**
 * Issue #2337 (#1976 step 2) — composition root for the
 * options/discovery store family. This is the ONLY module that
 * maps a host's storage handles to the family's production
 * implementations: domain code imports this helper and the port
 * types, never a store client.
 *
 * The family's hosts (OrchestratorAgent and everything it
 * feeds) hold two handles over the same Durable Object SQLite
 * database: the sql executor (ctx.storage.sql-shaped) and —
 * when the host passes it — the transaction-capable storage
 * object (ctx.storage). The adapters' withTransaction wraps
 * (ADR D-C) engage through the registered transaction runner
 * (transactionRunnerProvider.ts; src/server.ts registers the
 * aspect-backed runner once) — this module and the adapters
 * import the aspect's TYPES only, because the options family
 * is reachable from the client bundle through the trading
 * barrel and the aspect (node:async_hooks) is server-only
 * (the step-1 registry lesson, #2303). Hosts that pass only
 * the sql handle get the identical adapters with sequential
 * application, exactly the legacy behaviour.
 *
 * IV HISTORY (cutover gate, R-2 on #2337): the sync root
 * always composes the DO adapter. The D1 adapter is selected
 * ONLY by buildOptionsDiscoveryPorts when the environment sets
 * IV_HISTORY_D1_ENABLED === "true" AND AGENT_DB is bound; the
 * production default is the DO adapter (pinned in the step-2
 * conformance suite). The read/write cutover waits on the
 * owner ruling recorded on the issue.
 *
 * This module imports the transaction aspect (node:async_hooks)
 * through the adapters — it is SERVER-ONLY. Client-reachable
 * modules must import the port TYPES from the individual
 * *Ports.ts files (type-only, erased at compile time), never
 * this root.
 */
import type { DoTransactionStorage } from "../aspects/transactionAspect";
import {
  createD1IvHistoryDb,
  D1IvHistoryStore,
  ensureIvHistorySchema,
} from "./d1IvHistoryAdapter";
import { SqlDiscoveryAlertStore } from "./doSqliteDiscoveryAlertAdapter";
import { SqlDiscoveryRunStore } from "./doSqliteDiscoveryRunAdapter";
import { SqlDiscoverySetupStore } from "./doSqliteDiscoverySetupAdapter";
import { SqlFeedSnapshotStore } from "./doSqliteFeedSnapshotAdapter";
import { SqlIvHistoryStore } from "./doSqliteIvHistoryAdapter";
import {
  DoSqlitePausedScheduleStore,
  SqlPausedScheduleStore,
} from "./doSqlitePausedScheduleAdapter";
import { SqlScanRunStore } from "./doSqliteScanRunAdapter";
import { SqlStrategyProfileStore } from "./doSqliteStrategyProfileAdapter";
import type { DiscoveryAlertStore } from "./discoveryAlertPorts";
import type { DiscoveryRunStore } from "./discoveryRunPorts";
import type { DiscoverySetupStore } from "./discoverySetupPorts";
import type { FeedSnapshotStore } from "./feedSnapshotPorts";
import type { IvHistoryStore } from "./ivHistoryPorts";
import type { PausedScheduleStore } from "./pausedSchedulePorts";
import type { ScanRunStore, ScanSqlExecutor } from "./scanRunPorts";
import type { StrategyProfileStore } from "./strategyProfilePorts";
import type { SqlStorage } from "../orm";

export interface OptionsDiscoveryPorts {
  scanRuns: ScanRunStore;
  discoveryRuns: DiscoveryRunStore;
  discoverySetupRuns: DiscoverySetupStore;
  discoveryAlerts: DiscoveryAlertStore;
  ivHistory: IvHistoryStore;
  strategyProfiles: StrategyProfileStore;
  feedSnapshots: FeedSnapshotStore;
  pausedSchedules: PausedScheduleStore;
  /** The legacy synchronous paused-schedule surface (the same
   *  table through the sync class) for the pre-port call sites
   *  in scheduleManagement's consumers. */
  pausedSchedulesSync: SqlPausedScheduleStore;
}

export interface OptionsDiscoveryPortInputs {
  /** The DO sql executor (ctx.storage.sql-shaped). Every
   *  family adapter except paused schedules executes through
   *  this handle; the family's executor interfaces are all the
   *  same structural shape. */
  sql: ScanSqlExecutor;
  /** The Agents-SDK SqlStorage handle for the paused-schedule
   *  store (ctx.storage.sql IS this handle on the orchestrator
   *  host; typed separately because that store's legacy surface
   *  takes the SqlStorage shape). Defaults to `sql` when the
   *  host's executor is the SqlStorage object itself. */
  scheduleSql?: SqlStorage;
  /** The transaction-capable storage object (ctx.storage) and the process registered the transaction runner (src/server.ts; see transactionRunnerProvider.ts).
   *  When present, the adapters' multi-statement units run
   *  through withTransaction; when absent they apply
   *  sequentially (legacy behaviour). Typed as the workers
   *  DurableObjectStorage (what hosts actually hold) or the
   *  aspect's structural shape; the root coerces at the seam. */
  storage?: DoTransactionStorage | DurableObjectStorage;
}

/**
 * Compose the family's ports over a host's DO storage. IV
 * history is the DO adapter here unconditionally — see the
 * module header for the cutover gate.
 */
export function createOptionsDiscoveryPorts(
  inputs: OptionsDiscoveryPortInputs,
): OptionsDiscoveryPorts {
  const { sql } = inputs;
  const storage = inputs.storage as DoTransactionStorage | undefined;
  const scheduleSql = inputs.scheduleSql ?? (sql as unknown as SqlStorage);
  return {
    scanRuns: new SqlScanRunStore(sql, {}, storage),
    discoveryRuns: new SqlDiscoveryRunStore(sql, {}, storage),
    discoverySetupRuns: new SqlDiscoverySetupStore(sql, {}, storage),
    discoveryAlerts: new SqlDiscoveryAlertStore(sql),
    ivHistory: new SqlIvHistoryStore(sql),
    strategyProfiles: new SqlStrategyProfileStore(sql, {}, storage),
    feedSnapshots: new SqlFeedSnapshotStore(sql, undefined, storage),
    pausedSchedules: new DoSqlitePausedScheduleStore(scheduleSql, storage),
    pausedSchedulesSync: new SqlPausedScheduleStore(scheduleSql),
  };
}

/** Env flag selecting the D1 IV adapter (default: off — the DO
 *  adapter; see the module header's cutover gate). Mirrors the
 *  repo's `=== "true"` env-flag idiom (S2/knowledge flags). */
export function ivHistoryD1Enabled(env: { IV_HISTORY_D1_ENABLED?: string }): boolean {
  return env.IV_HISTORY_D1_ENABLED === "true";
}

/**
 * The env-aware build: identical to createOptionsDiscoveryPorts
 * except IV history resolves through the D1 adapter when the
 * flag is on AND AGENT_DB is bound (schema-ensured here, once
 * per build — hosts memoize). With the flag off or the binding
 * absent, IV history is the DO adapter: today's behaviour.
 */
export async function buildOptionsDiscoveryPorts(
  env: { AGENT_DB?: unknown; IV_HISTORY_D1_ENABLED?: string },
  inputs: OptionsDiscoveryPortInputs,
): Promise<OptionsDiscoveryPorts> {
  const ports = createOptionsDiscoveryPorts(inputs);
  if (ivHistoryD1Enabled(env) && env.AGENT_DB) {
    const db = createD1IvHistoryDb(env.AGENT_DB as D1Database);
    await ensureIvHistorySchema(db);
    ports.ivHistory = new D1IvHistoryStore(db);
  }
  return ports;
}
