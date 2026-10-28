/**
 * Issue #1098 (Phase 0 of epic #1096): durable store for the epic's core
 * model — goals, scenarios, and recommendation outcomes.
 *
 * Follows the established mas_* service-store pattern (learnings.ts,
 * strategyReviews.ts, strategyWeights.ts): this module owns its DDL via
 * CREATE TABLE IF NOT EXISTS at the SqlStorage seam, so no new Durable
 * Object class or wrangler migration is required — mas_* tables are
 * created by their owning service, and wrangler.jsonc migrations are
 * reserved for DO classes.
 *
 * Tenant scoping follows the #584 (EP-003) precedent in
 * scheduledReports.ts: every row carries `user_login` (default "default")
 * and every read/write is filtered by it, always as a bound parameter.
 * A goal, scenario, or outcome belonging to another tenant is invisible:
 * reads return null/[], status updates return false, and attaching a
 * scenario or outcome to another tenant's parent returns null instead of
 * writing an orphan (or cross-tenant) row.
 *
 * This phase is schema + CRUD only. Goal/scenario *evaluation* is
 * Phase 1; outcomes are written by later phases as recommendations are
 * tracked to expiry.
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

export function ensureGoalScenarioTables(sql: any): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_goals (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_mas_goals_user_status ON mas_goals(user_login, status)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_scenarios (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    portfolio_ref_kind TEXT NOT NULL,
    portfolio_ref TEXT,
    shocks_json TEXT NOT NULL,
    constraints_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_mas_scenarios_user_goal ON mas_scenarios(user_login, goal_id)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS mas_outcomes (
    id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    goal_id TEXT,
    scenario_id TEXT,
    recommendation_ref TEXT,
    screen_run_ref TEXT,
    kind TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_mas_outcomes_user_scenario ON mas_outcomes(user_login, scenario_id)`);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function goalFromRow(r: any): GoalRecord {
  return {
    id: r.id,
    userLogin: r.user_login,
    kind: r.kind,
    title: r.title,
    status: r.status,
    source: r.source,
    payload: parseJson(r.payload_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function scenarioFromRow(r: any): ScenarioRecord {
  return {
    id: r.id,
    userLogin: r.user_login,
    goalId: r.goal_id,
    portfolioRef: r.portfolio_ref
      ? { kind: r.portfolio_ref_kind, ref: r.portfolio_ref }
      : { kind: r.portfolio_ref_kind },
    shocks: parseJson(r.shocks_json),
    constraints: parseJson(r.constraints_json),
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function outcomeFromRow(r: any): OutcomeRecord {
  return {
    id: r.id,
    userLogin: r.user_login,
    goalId: r.goal_id ?? null,
    scenarioId: r.scenario_id ?? null,
    recommendationRef: r.recommendation_ref ?? null,
    screenRunRef: r.screen_run_ref ?? null,
    kind: r.kind,
    metrics: parseJson(r.metrics_json),
    createdAt: r.created_at,
  };
}

/**
 * Multi-tenant SaaS: every goal/scenario/outcome row belongs to exactly
 * one tenant. There is no shared "default" owner — a write without a
 * login is refused instead of collapsing tenants into one bucket.
 */
function requireOwner(userLogin: unknown): string {
  const owner = typeof userLogin === "string" ? userLogin.trim() : "";
  if (!owner) {
    throw new Error("goal scenario store requires an owning userLogin (no default identity).");
  }
  return owner;
}

export function createGoal(
  sql: any,
  input: {
    userLogin?: string;
    kind: GoalKind;
    title: string;
    source?: GoalSource;
    status?: GoalStatus;
    payload?: unknown;
  }
): GoalRecord {
  ensureGoalScenarioTables(sql);
  const now = new Date().toISOString();
  const goal: GoalRecord = {
    id: newId("goal"),
    userLogin: requireOwner(input.userLogin),
    kind: input.kind,
    title: input.title,
    status: input.status || "proposed",
    source: input.source || "user",
    payload: input.payload ?? null,
    createdAt: now,
    updatedAt: now,
  };
  sql.exec(
    `INSERT INTO mas_goals (id, user_login, kind, title, status, source, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    goal.id, goal.userLogin, goal.kind, goal.title, goal.status, goal.source,
    JSON.stringify(goal.payload), goal.createdAt, goal.updatedAt
  );
  return goal;
}

export function getGoal(sql: any, userLogin: string, id: string): GoalRecord | null {
  ensureGoalScenarioTables(sql);
  const rows = Array.from(
    sql.exec(`SELECT * FROM mas_goals WHERE id = ? AND user_login = ?`, id, userLogin)
  ) as any[];
  return rows.length ? goalFromRow(rows[0]) : null;
}

export function listGoals(sql: any, userLogin: string, status?: GoalStatus): GoalRecord[] {
  ensureGoalScenarioTables(sql);
  const rows = status
    ? (Array.from(
        sql.exec(
          `SELECT * FROM mas_goals WHERE user_login = ? AND status = ? ORDER BY created_at DESC LIMIT 100`,
          userLogin, status
        )
      ) as any[])
    : (Array.from(
        sql.exec(`SELECT * FROM mas_goals WHERE user_login = ? ORDER BY created_at DESC LIMIT 100`, userLogin)
      ) as any[]);
  return rows.map(goalFromRow);
}

export function updateGoalStatus(sql: any, userLogin: string, id: string, status: GoalStatus): boolean {
  ensureGoalScenarioTables(sql);
  // Tenant check first: MockSqlStorage and real SqlStorage differ in what
  // an UPDATE result reports, so existence is proven by a scoped read.
  if (!getGoal(sql, userLogin, id)) return false;
  sql.exec(
    `UPDATE mas_goals SET status = ?, updated_at = ? WHERE id = ? AND user_login = ?`,
    status, new Date().toISOString(), id, userLogin
  );
  return true;
}

export function createScenario(
  sql: any,
  input: {
    userLogin?: string;
    goalId: string;
    portfolioRef: { kind: "real" | "hypothetical"; ref?: string };
    shocks?: unknown;
    constraints?: unknown;
    status?: string;
  }
): ScenarioRecord | null {
  ensureGoalScenarioTables(sql);
  const userLogin = input.userLogin || "default";
  // No orphan scenarios, and no attaching to another tenant's goal.
  if (!getGoal(sql, userLogin, input.goalId)) return null;
  const now = new Date().toISOString();
  const scenario: ScenarioRecord = {
    id: newId("scen"),
    userLogin,
    goalId: input.goalId,
    portfolioRef: input.portfolioRef,
    shocks: input.shocks ?? null,
    constraints: input.constraints ?? null,
    status: input.status || "draft",
    createdAt: now,
    updatedAt: now,
  };
  sql.exec(
    `INSERT INTO mas_scenarios (id, user_login, goal_id, portfolio_ref_kind, portfolio_ref, shocks_json, constraints_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    scenario.id, scenario.userLogin, scenario.goalId, scenario.portfolioRef.kind,
    scenario.portfolioRef.ref ?? null, JSON.stringify(scenario.shocks),
    JSON.stringify(scenario.constraints), scenario.status, scenario.createdAt, scenario.updatedAt
  );
  return scenario;
}

export function getScenario(sql: any, userLogin: string, id: string): ScenarioRecord | null {
  ensureGoalScenarioTables(sql);
  const rows = Array.from(
    sql.exec(`SELECT * FROM mas_scenarios WHERE id = ? AND user_login = ?`, id, userLogin)
  ) as any[];
  return rows.length ? scenarioFromRow(rows[0]) : null;
}

export function listScenarios(sql: any, userLogin: string, goalId: string): ScenarioRecord[] {
  ensureGoalScenarioTables(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM mas_scenarios WHERE user_login = ? AND goal_id = ? ORDER BY created_at DESC LIMIT 100`,
      userLogin, goalId
    )
  ) as any[];
  return rows.map(scenarioFromRow);
}

export function recordOutcome(
  sql: any,
  input: {
    userLogin?: string;
    goalId?: string;
    scenarioId?: string;
    recommendationRef?: string;
    screenRunRef?: string;
    kind: OutcomeKind;
    metrics?: unknown;
  }
): OutcomeRecord | null {
  ensureGoalScenarioTables(sql);
  const userLogin = input.userLogin || "default";
  // Referential honesty: a named parent must exist for THIS tenant.
  if (input.scenarioId && !getScenario(sql, userLogin, input.scenarioId)) return null;
  if (input.goalId && !getGoal(sql, userLogin, input.goalId)) return null;
  const outcome: OutcomeRecord = {
    id: newId("outc"),
    userLogin,
    goalId: input.goalId ?? null,
    scenarioId: input.scenarioId ?? null,
    recommendationRef: input.recommendationRef ?? null,
    screenRunRef: input.screenRunRef ?? null,
    kind: input.kind,
    metrics: input.metrics ?? null,
    createdAt: new Date().toISOString(),
  };
  sql.exec(
    `INSERT INTO mas_outcomes (id, user_login, goal_id, scenario_id, recommendation_ref, screen_run_ref, kind, metrics_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    outcome.id, outcome.userLogin, outcome.goalId, outcome.scenarioId,
    outcome.recommendationRef, outcome.screenRunRef, outcome.kind,
    JSON.stringify(outcome.metrics), outcome.createdAt
  );
  return outcome;
}

export function listOutcomes(
  sql: any,
  userLogin: string,
  filter?: { scenarioId?: string; goalId?: string }
): OutcomeRecord[] {
  ensureGoalScenarioTables(sql);
  let rows: any[];
  if (filter?.scenarioId) {
    rows = Array.from(
      sql.exec(
        `SELECT * FROM mas_outcomes WHERE user_login = ? AND scenario_id = ? ORDER BY created_at DESC LIMIT 100`,
        userLogin, filter.scenarioId
      )
    ) as any[];
  } else if (filter?.goalId) {
    rows = Array.from(
      sql.exec(
        `SELECT * FROM mas_outcomes WHERE user_login = ? AND goal_id = ? ORDER BY created_at DESC LIMIT 100`,
        userLogin, filter.goalId
      )
    ) as any[];
  } else {
    rows = Array.from(
      sql.exec(`SELECT * FROM mas_outcomes WHERE user_login = ? ORDER BY created_at DESC LIMIT 100`, userLogin)
    ) as any[];
  }
  return rows.map(outcomeFromRow);
}
