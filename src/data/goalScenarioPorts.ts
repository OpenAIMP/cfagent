/**
 * Issue #2356 (#1976 step 4c, ADR 0022 D-I step 4) — goal /
 * scenario / outcome port for the evidence satellites.
 *
 * ADR D-0 ruled this family DO-resident behind a port (audit
 * §3): per-login instance tenancy (property (e)) with the
 * user_login column discipline preserved by the port exactly
 * as today. This module carries the record types and the port
 * interface ONLY (ADR 0002 R1/R2): no store client, no env
 * binding, no SQL. Adapters: doSqliteGoalScenarioAdapter.ts
 * (production, the legacy goalScenarioStore moved into the
 * layer), inMemoryGoalScenarioAdapter.ts (test double). The
 * types moved here from src/services/goalScenarioStore.ts,
 * which is now a re-export shim over this port and the DO
 * adapter.
 *
 * TRANSACTION SEAM (ADR D-C): every write here is a single
 * statement; the read-check-then-insert pairs (scenario /
 * outcome attaches) are referential-honesty checks, exactly
 * as in the legacy module — no multi-statement unit exists
 * to wrap, and the legacy sql seam carries no transaction-
 * capable storage handle.
 */

export const GOAL_SCENARIO_TABLES = ["mas_goals", "mas_scenarios", "mas_outcomes"] as const;

export type GoalKind =
  | "income"
  | "directional"
  | "volatility_event"
  | "hedge_protect"
  | "repair"
  | "deconcentrate"
  | "iv_harvest"
  | "capital_efficient_leverage"
  | "cash_secured_entry";

export type GoalSource = "user" | "discovered";
export type GoalStatus = "proposed" | "active" | "paused" | "completed" | "archived";

export interface GoalRecord {
  id: string;
  userLogin: string;
  kind: GoalKind;
  title: string;
  status: GoalStatus;
  source: GoalSource;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ScenarioRecord {
  id: string;
  userLogin: string;
  goalId: string;
  portfolioRef: { kind: "real" | "hypothetical"; ref?: string };
  shocks: unknown;
  constraints: unknown;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export type OutcomeKind = "paper" | "realized" | "expired" | "cancelled";

export interface OutcomeRecord {
  id: string;
  userLogin: string;
  goalId: string | null;
  scenarioId: string | null;
  recommendationRef: string | null;
  screenRunRef: string | null;
  kind: OutcomeKind;
  metrics: unknown;
  createdAt: string;
}

export interface CreateGoalInput {
  userLogin?: string;
  kind: GoalKind;
  title: string;
  source?: GoalSource;
  status?: GoalStatus;
  payload?: unknown;
}

export interface CreateScenarioInput {
  userLogin?: string;
  goalId: string;
  portfolioRef: { kind: "real" | "hypothetical"; ref?: string };
  shocks?: unknown;
  constraints?: unknown;
  status?: string;
}

export interface RecordOutcomeInput {
  userLogin?: string;
  goalId?: string;
  scenarioId?: string;
  recommendationRef?: string;
  screenRunRef?: string;
  kind: OutcomeKind;
  metrics?: unknown;
}

/** The goal/scenario/outcome store contract (sync, mirroring
 *  the legacy module's seam exactly). Tenant scoping is part
 *  of the contract: another tenant's row is invisible — reads
 *  return null/[], status updates return false, attaches to
 *  another tenant's parent return null. */
export interface GoalScenarioStore {
  ensureTables(): void;
  createGoal(input: CreateGoalInput): GoalRecord;
  getGoal(userLogin: string, id: string): GoalRecord | null;
  listGoals(userLogin: string, status?: GoalStatus): GoalRecord[];
  updateGoalStatus(userLogin: string, id: string, status: GoalStatus): boolean;
  createScenario(input: CreateScenarioInput): ScenarioRecord | null;
  getScenario(userLogin: string, id: string): ScenarioRecord | null;
  listScenarios(userLogin: string, goalId: string): ScenarioRecord[];
  recordOutcome(input: RecordOutcomeInput): OutcomeRecord | null;
  listOutcomes(
    userLogin: string,
    filter?: { scenarioId?: string; goalId?: string },
  ): OutcomeRecord[];
}

/** Minimal SQL executor matching the Durable Object SqlStorage
 *  `exec` signature (the shape the legacy module's `sql: any`
 *  seam always assumed). */
export interface GoalScenarioSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

/**
 * Multi-tenant SaaS: every goal/scenario/outcome row belongs
 * to exactly one tenant. There is no shared "default" owner —
 * a write without a login is refused instead of collapsing
 * tenants into one bucket. (Moved verbatim from the legacy
 * module; shared by both adapters so the rule cannot drift.)
 */
export function requireGoalScenarioOwner(userLogin: unknown): string {
  const owner = typeof userLogin === "string" ? userLogin.trim() : "";
  if (!owner) {
    throw new Error("goal scenario store requires an owning userLogin (no default identity).");
  }
  return owner;
}
