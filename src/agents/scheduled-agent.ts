import { callable } from "agents";
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
//   1. Pulls enabled goals from its own SQL
//   2. Checks each goal's cron schedule (isDue)
//   3. Budget-checks via PaymentsAgent before creating work
//   4. Creates an Orchestrator job for due goals within budget
//
// The agent never spends directly — all budget decisions go through
// PaymentsAgent, and all work goes through OrchestratorAgent.

interface ScheduledAgentState {
  goals: ScheduledGoal[];
}

export class ScheduledAgent extends callable<ScheduledAgentState>() {
  initialState: ScheduledAgentState = {
    goals: DEFAULT_SCHEDULES,
  };

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

    for (const goal of this.state.goals) {
      if (!goal.enabled) continue;
      tick.goalsEvaluated++;

      if (!isDue(goal.cron, goal.lastRun, now)) continue;

      try {
        // Budget check via PaymentsAgent — never spend without approval
        const paymentsId = env.PAYMENTS_AGENT.idFromName("default");
        const payments = env.PAYMENTS_AGENT.get(paymentsId);
        const budgetOk = await payments.budgetCheck({
          operation: goal.operation,
          amountCents: goal.budgetCents,
        });

        if (!budgetOk.allowed) {
          tick.jobsSkipped++;
          continue;
        }

        // Create Orchestrator job for this goal
        const orchId = env.ORCHESTRATOR_AGENT.idFromName("default");
        const orchestrator = env.ORCHESTRATOR_AGENT.get(orchId);
        await orchestrator.createJob({
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

    this.setState({ goals: this.state.goals });
    return tick;
  }

  /** List all scheduled goals. */
  async listGoals(): Promise<ScheduledGoal[]> {
    return this.state.goals;
  }

  /** Enable or disable a goal by ID. */
  async setGoalEnabled(id: string, enabled: boolean): Promise<boolean> {
    const goal = this.state.goals.find((g) => g.id === id);
    if (!goal) return false;
    goal.enabled = enabled;
    this.setState({ goals: this.state.goals });
    return true;
  }

  /** Add a new scheduled goal. */
  async addGoal(goal: ScheduledGoal): Promise<void> {
    this.setState({ goals: [...this.state.goals, goal] });
  }
}
