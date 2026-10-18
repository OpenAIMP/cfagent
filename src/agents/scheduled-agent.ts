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
    return tick;
  }

  /** List all scheduled goals. */
  async listGoals(): Promise<ScheduledGoal[]> {
    return this.getGoals();
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
