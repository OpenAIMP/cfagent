import { Agent } from "agents";
import type { Env } from "../types";
import {
  DEFAULT_SCHEDULES,
  isDue,
  type ScheduledGoal,
  type ScheduleTick,
} from "../schedule";

// ScheduledAgent: autonomous trigger for goal-driven agent work.
//
// Wired to Cloudflare Cron Triggers (wrangler.jsonc triggers.crons).
// On each tick it:
//   1. Pulls enabled goals from DO storage
//   2. Checks each goal's cron schedule (isDue)
//   3. Budget-checks via PaymentsAgent before creating work
//   4. Creates an Orchestrator job for due goals within budget
//
// The agent never spends directly — all budget decisions go through
// PaymentsAgent, and all work goes through the orchestrator module.

export class ScheduledAgent extends Agent<Env> {
  private async getGoals(): Promise<ScheduledGoal[]> {
    const stored = await this.ctx.storage.get<ScheduledGoal[]>("goals");
    if (!stored) {
      await this.ctx.storage.put("goals", DEFAULT_SCHEDULES);
      return DEFAULT_SCHEDULES;
    }
    return stored;
  }

  private async saveGoals(goals: ScheduledGoal[]): Promise<void> {
    await this.ctx.storage.put("goals", goals);
  }

  /** Recent cron ticks, newest first (capped). */
  private async getTicks(): Promise<ScheduleTick[]> {
    const stored = await this.ctx.storage.get<ScheduleTick[]>("tickHistory");
    return stored ?? [];
  }

  private async recordTick(tick: ScheduleTick): Promise<void> {
    const history = await this.getTicks();
    history.unshift(tick);
    await this.ctx.storage.put("tickHistory", history.slice(0, 50));
  }

  /**
   * Cron entrypoint, invoked by the Workers runtime on each
   * triggers.crons tick. Evaluates due goals and dispatches work.
   */
  async onCron(env: Env): Promise<ScheduleTick> {
    const now = new Date();
    const tick: ScheduleTick = {
      timestamp: now.toISOString(),
      goalsEvaluated: 0,
      jobsCreated: 0,
      jobsSkipped: 0,
      errors: [],
    };

    const goals = await this.getGoals();

    for (const goal of goals) {
      if (!goal.enabled) continue;
      tick.goalsEvaluated++;

      if (!isDue(goal.cron, goal.lastRun, now)) continue;

      try {
        const paymentsId = env.PAYMENTS_AGENT.idFromName("default");
        const payments = env.PAYMENTS_AGENT.get(paymentsId) as unknown as {
          budgetCheck(req: {
            operation: string;
            amountCents: number;
            agentId?: string;
          }): Promise<{ allowed: boolean; reason?: string }>;
        };
        const budgetOk = await payments.budgetCheck({
          operation: goal.operation,
          amountCents: goal.budgetCents,
        });

        if (!budgetOk.allowed) {
          tick.jobsSkipped++;
          continue;
        }

        const { createJob } = await import("../orchestrate");
        await createJob(env, {
          goalId: goal.id,
          goalName: goal.name,
          operation: goal.operation,
          budgetCents: goal.budgetCents,
        });

        goal.lastRun = now.toISOString();
        tick.jobsCreated++;
      } catch (err) {
        tick.errors.push(
          `${goal.id}: ${err instanceof Error ? err.message : String(err)}`
        );
        tick.jobsSkipped++;
      }
    }

    await this.saveGoals(goals);
    await this.recordTick(tick);
    return tick;
  }

  /** List all scheduled goals. */
  async listGoals(): Promise<ScheduledGoal[]> {
    return this.getGoals();
  }

  /** Recent cron tick history, newest first. */
  async getTickHistory(limit: number = 20): Promise<ScheduleTick[]> {
    const history = await this.getTicks();
    return history.slice(0, Math.max(1, Math.min(50, limit)));
  }

  /**
   * Add a new scheduled goal. The operation must exist in the
   * orchestrate.ts catalog; the cron expression uses the same minimal
   * syntax as the built-in schedules ("minute hour * * *").
   */
  async addGoal(goal: {
    id: string;
    name: string;
    cron: string;
    operation: string;
    budgetCents: number;
    enabled?: boolean;
  }): Promise<ScheduledGoal> {
    const id = goal.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!id) throw new Error("Goal id is required.");
    if (!goal.name.trim()) throw new Error("Goal name is required.");
    if (!/^(\*|\*\/\d+|\d+)\s+(\*|\*\/\d+|\d+)\s+(\*|\d+)\s+(\*|\d+)\s+(\*|\d+)$/.test(goal.cron.trim())) {
      throw new Error("Cron must look like 'minute hour * * *' (e.g. '0 6 * * *').");
    }
    if (!Number.isFinite(goal.budgetCents) || goal.budgetCents <= 0) {
      throw new Error("budgetCents must be a positive number.");
    }
    const goals = await this.getGoals();
    if (goals.some((g) => g.id === id)) throw new Error(`Goal already exists: ${id}`);
    const { OPERATION_CATALOG } = await import("../orchestrate");
    const known = OPERATION_CATALOG.some((e) => e.operations.includes(goal.operation));
    if (!known) throw new Error(`Unknown operation: ${goal.operation}`);
    const created: ScheduledGoal = {
      id,
      name: goal.name.trim(),
      cron: goal.cron.trim(),
      operation: goal.operation,
      budgetCents: Math.floor(goal.budgetCents),
      enabled: goal.enabled !== false,
    };
    goals.push(created);
    await this.saveGoals(goals);
    return created;
  }

  /** Remove a scheduled goal by ID. */
  async removeGoal(id: string): Promise<boolean> {
    const goals = await this.getGoals();
    const idx = goals.findIndex((g: ScheduledGoal) => g.id === id);
    if (idx < 0) return false;
    goals.splice(idx, 1);
    await this.saveGoals(goals);
    return true;
  }

  /** Enable or disable a goal by ID. */
  async setGoalEnabled(id: string, enabled: boolean): Promise<boolean> {
    const goals = await this.getGoals();
    const goal = goals.find((g: ScheduledGoal) => g.id === id);
    if (!goal) return false;
    goal.enabled = enabled;
    await this.saveGoals(goals);
    return true;
  }

  /** Manually trigger evaluation of a single goal. */
  async triggerGoal(id: string, env: Env): Promise<ScheduleTick> {
    const goals = await this.getGoals();
    const goal = goals.find((g: ScheduledGoal) => g.id === id);
    if (!goal) {
      return {
        timestamp: new Date().toISOString(),
        goalsEvaluated: 0,
        jobsCreated: 0,
        jobsSkipped: 1,
        errors: [`Goal not found: ${id}`],
      };
    }
    const origLastRun = goal.lastRun;
    goal.lastRun = undefined;
    await this.saveGoals(goals);
    const tick = await this.onCron(env);
    if (tick.jobsCreated === 0 && tick.errors.length === 0) {
      goal.lastRun = origLastRun;
      await this.saveGoals(goals);
    }
    return tick;
  }
}
