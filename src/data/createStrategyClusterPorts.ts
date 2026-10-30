/**
 * Issue #2357 (#1976 step 4b) — composition root for the
 * strategy-state cluster. This is the ONLY module that maps
 * a host's storage handle to the family's production
 * implementations: domain code imports this helper and the
 * port types, never a store client.
 *
 * The family's hosts hold one handle: the DO sql executor
 * (ctx.storage.sql-shaped). Every adapter executes through
 * it — including inside the champion/challenger promotion
 * unit, whose transaction wrap (#2346, re-pointed onto these
 * ports by this slice) opens over the same host storage.
 *
 * settingsRead is the step-3a read-only settings port
 * (settingsReadPorts.ts, gate G-7): the cluster's settings
 * READS (adaptation budget overrides, the kill switch)
 * compose here; no settings write path exists in this family.
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapters); client-reachable modules must import the port
 * TYPES from the individual *Ports.ts files (type-only,
 * erased at compile time), never this root.
 */
import { DoSqliteAdaptationAuditStore } from "./doSqliteAdaptationAuditAdapter";
import { DoSqliteChallengerStore } from "./doSqliteChallengerAdapter";
import { DoSqliteReselectionStore } from "./doSqliteReselectionAdapter";
import { DoSqliteSettingsReadAdapter } from "./doSqliteOrmAdapters";
import { DoSqliteStrategyPolicyStore } from "./doSqliteStrategyPolicyAdapter";
import { DoSqliteStrategyWeightsStore } from "./doSqliteStrategyWeightsAdapter";
import { InMemoryAdaptationAuditStore } from "./inMemoryAdaptationAuditAdapter";
import { InMemoryChallengerStore } from "./inMemoryChallengerAdapter";
import { InMemorySettingsReadAdapter } from "./inMemoryOrmAdapters";
import { InMemoryReselectionStore } from "./inMemoryReselectionAdapter";
import { InMemoryStrategyPolicyStore } from "./inMemoryStrategyPolicyAdapter";
import { InMemoryStrategyWeightsStore } from "./inMemoryStrategyWeightsAdapter";
import type { AdaptationAuditStore } from "./adaptationAuditPorts";
import type { ChallengerSqlExecutor, ChallengerStore } from "./challengerPorts";
import type { ReselectionStore } from "./reselectionPorts";
import type { SettingsReadPort } from "./settingsReadPorts";
import type { StrategyPolicyStore } from "./strategyPolicyPorts";
import type { StrategyWeightsStore } from "./strategyWeightsPorts";

export interface StrategyClusterPorts {
  challengers: ChallengerStore;
  weights: StrategyWeightsStore;
  policy: StrategyPolicyStore;
  reselection: ReselectionStore;
  adaptationAudit: AdaptationAuditStore;
  settingsRead: SettingsReadPort;
}

/** Compose the family's ports over a host's DO storage. */
export function createStrategyClusterPorts(
  sql: ChallengerSqlExecutor,
): StrategyClusterPorts {
  return {
    challengers: new DoSqliteChallengerStore(sql),
    weights: new DoSqliteStrategyWeightsStore(sql as never),
    policy: new DoSqliteStrategyPolicyStore(sql as never),
    reselection: new DoSqliteReselectionStore(sql as never),
    adaptationAudit: new DoSqliteAdaptationAuditStore(sql as never),
    settingsRead: new DoSqliteSettingsReadAdapter(sql as never),
  };
}

/** Compose the family's ports over in-memory adapters (tests). */
export function createInMemoryStrategyClusterPorts(): StrategyClusterPorts {
  return {
    challengers: new InMemoryChallengerStore(),
    weights: new InMemoryStrategyWeightsStore(),
    policy: new InMemoryStrategyPolicyStore(),
    reselection: new InMemoryReselectionStore(),
    adaptationAudit: new InMemoryAdaptationAuditStore(),
    settingsRead: new InMemorySettingsReadAdapter(),
  };
}
