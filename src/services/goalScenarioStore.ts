/**
 * Issue #1098 (Phase 0 of epic #1096): durable store for the epic's core
 * model — goals, scenarios, and recommendation outcomes.
 *
 * @deprecated Superseded by src/data/goalScenarioPorts.ts (port),
 * src/data/doSqliteGoalScenarioAdapter.ts (production adapter) and
 * src/data/createEvidenceSatellitePorts.ts (composition root) —
 * #1976 step 4c (#2356, ADR 0022 D-I step 4). This module is a
 * re-export shim: every function delegates to the DO adapter over
 * the caller's sql handle, statement-for-statement identical to
 * the pre-port implementation. New code should compose the port
 * through createEvidenceSatellitePorts.
 *
 * Tenant scoping follows the #584 (EP-003) precedent in
 * scheduledReports.ts: every row carries `user_login` (default "default")
 * and every read/write is filtered by it, always as a bound parameter.
 * A goal, scenario, or outcome belonging to another tenant is invisible:
 * reads return null/[], status updates return false, and attaching a
 * scenario or outcome to another tenant's parent returns null instead of
 * writing an orphan (or cross-tenant) row.
 */

import { DoSqliteGoalScenarioStore } from "../data/doSqliteGoalScenarioAdapter";
import type {
  CreateGoalInput,
  CreateScenarioInput,
  GoalScenarioSqlExecutor,
  RecordOutcomeInput,
} from "../data/goalScenarioPorts";
import type {
  GoalRecord,
  GoalStatus,
  OutcomeRecord,
  ScenarioRecord,
} from "../data/goalScenarioPorts";

export {
  GOAL_SCENARIO_TABLES,
  type CreateGoalInput,
  type CreateScenarioInput,
  type GoalKind,
  type GoalRecord,
  type GoalSource,
  type GoalStatus,
  type OutcomeKind,
  type OutcomeRecord,
  type RecordOutcomeInput,
  type ScenarioRecord,
} from "../data/goalScenarioPorts";

function store(sql: GoalScenarioSqlExecutor): DoSqliteGoalScenarioStore {
  return new DoSqliteGoalScenarioStore(sql);
}

export function ensureGoalScenarioTables(sql: any): void {
  store(sql).ensureTables();
}

export function createGoal(
  sql: any,
  input: CreateGoalInput,
): GoalRecord {
  return store(sql).createGoal(input);
}

export function getGoal(sql: any, userLogin: string, id: string): GoalRecord | null {
  return store(sql).getGoal(userLogin, id);
}

export function listGoals(sql: any, userLogin: string, status?: GoalStatus): GoalRecord[] {
  return store(sql).listGoals(userLogin, status);
}

export function updateGoalStatus(sql: any, userLogin: string, id: string, status: GoalStatus): boolean {
  return store(sql).updateGoalStatus(userLogin, id, status);
}

export function createScenario(
  sql: any,
  input: CreateScenarioInput,
): ScenarioRecord | null {
  return store(sql).createScenario(input);
}

export function getScenario(sql: any, userLogin: string, id: string): ScenarioRecord | null {
  return store(sql).getScenario(userLogin, id);
}

export function listScenarios(sql: any, userLogin: string, goalId: string): ScenarioRecord[] {
  return store(sql).listScenarios(userLogin, goalId);
}

export function recordOutcome(
  sql: any,
  input: RecordOutcomeInput,
): OutcomeRecord | null {
  return store(sql).recordOutcome(input);
}

export function listOutcomes(
  sql: any,
  userLogin: string,
  filter?: { scenarioId?: string; goalId?: string },
): OutcomeRecord[] {
  return store(sql).listOutcomes(userLogin, filter);
}
