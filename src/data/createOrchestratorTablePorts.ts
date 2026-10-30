/**
 * Issue #2359 (#1976 step 4d) — composition root for the
 * orchestrator-owned table family. This is the ONLY module
 * that maps a host's storage handle to the family's
 * production implementations: domain code imports this helper
 * and the port types, never a store client.
 *
 * The four tables live in the orchestrator instance's own
 * storage; each port is served by its own DO adapter over
 * the shared handle (one owner per table, ADR 0022 D-A).
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapters); client-reachable modules must import the port
 * TYPES from orchestratorTablePorts.ts (type-only, erased at
 * compile time), never this root.
 */
import { DoSqliteAutopilotStateStore } from "./doSqliteAutopilotStateAdapter";
import { DoSqlitePolicyVerdictStore } from "./doSqlitePolicyVerdictAdapter";
import { DoSqliteReportConfirmationStore } from "./doSqliteReportConfirmationAdapter";
import { DoSqliteScreenerPresetStore } from "./doSqliteScreenerPresetAdapter";
import {
  InMemoryAutopilotStateStore,
  InMemoryPolicyVerdictStore,
  InMemoryReportConfirmationStore,
  InMemoryScreenerPresetStore,
} from "./inMemoryOrchestratorTableAdapters";
import type {
  AutopilotStatePort,
  OrchestratorTableSqlExecutor,
  PolicyVerdictPort,
  ReportConfirmationPort,
  ScreenerPresetPort,
} from "./orchestratorTablePorts";

export interface OrchestratorTablePorts {
  autopilot: AutopilotStatePort;
  verdicts: PolicyVerdictPort;
  confirmations: ReportConfirmationPort;
  presets: ScreenerPresetPort;
}

/** Compose the family's ports over a host's DO storage. */
export function createOrchestratorTablePorts(
  sql: OrchestratorTableSqlExecutor
): OrchestratorTablePorts {
  return {
    autopilot: new DoSqliteAutopilotStateStore(sql),
    verdicts: new DoSqlitePolicyVerdictStore(sql),
    confirmations: new DoSqliteReportConfirmationStore(sql),
    presets: new DoSqliteScreenerPresetStore(sql),
  };
}

/** Compose the family's ports over the in-memory adapters (tests). */
export function createInMemoryOrchestratorTablePorts(): OrchestratorTablePorts {
  return {
    autopilot: new InMemoryAutopilotStateStore(),
    verdicts: new InMemoryPolicyVerdictStore(),
    confirmations: new InMemoryReportConfirmationStore(),
    presets: new InMemoryScreenerPresetStore(),
  };
}
