import { Agent } from "agents";
import type { Env } from "../types";
import {
  DEFAULT_SCHEDULES,
  isDue,
  type ScheduledGoal,
  type ScheduleTick,
} from "../schedule";

// ScheduledAgent: full think-agent with autonomous scheduling.
//
// Extends Agent (not callable) to enable:
//   1. SDK SCHEDULING — this.schedule()/this.scheduleEvery() (DO alarms,
//      persisted to SQLite, survives restarts). See:
//      https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/
//   2. A2A — agent card + JSON-RPC dispatch for cross-agent invocation.
//   3. AGENT-AS-A-TOOL — listGoals, setGoalEnabled, triggerGoal, getSchedules
//      are invocable by other agents.
//
// Budget discipline: never spends directly. Every goal evaluation
// budget-checks via PaymentsAgent before creating Orchestrator work.

interface ScheduledAgentState {
  goals: ScheduledGoal[];
}

export class ScheduledAgent extends Agent<Env> {
  // Agent state holds the goal list
  initialState: ScheduledAgentState = {
    goals: DEFAULT_SCHEDULES,
  };

  private get goals(): ScheduledGoal[] {
    return (this.state as ScheduledAgentState).goals ?? DEFAULT_SCHEDULES;
  }

  private setGoals(goals: ScheduledGoal[]): void {
    this.setState({ goals } as ScheduledAgentState);
  }

  /**
   * Runs on every DO wake. Registers each enabled goal as an SDK cron
   * schedule (idempotent — same cron + callback + payload returns the
   * existing schedule instead of duplicating).
   */
  async onStart(): Promise<void> {
    const agent = this as unknown as {
      schedule: (cron: string, callback: string, payload: unknown) => Promise<unknown>;
    };
    for (const goal of this.goals) {
      if (!goal.enabled) continue;
      await agent.schedule(goal.cron, "evaluateGoal", { goalId: goal.id });
    }
  }

  /**
   * SDK schedule callback — evaluates a single goal when its cron fires.
   * Budget-checks via PaymentsAgent, then creates an Orchestrator job.
   */
  async evaluateGoal(payload: { goalId: string }): Promise<ScheduleTick> {
    const now = new Date();
    const tick: ScheduleTick = {
      timestamp: now.toISOString(),
      goalsEvaluated: 1,
      jobsCreated: 0,
      jobsSkipped: 0,
      errors: [],
    };

    const goals = this.goals;
    const goal = goals.find((g) => g.id === payload.goalId);
    if (!goal || !goal.enabled) {
      tick.jobsSkipped++;
      return tick;
    }

    try {
      const paymentsId = this.env.PAYMENTS_AGENT.idFromName("default");
      const payments = this.env.PAYMENTS_AGENT.get(paymentsId);
      const budgetOk = await payments.budgetCheck({
        operation: goal.operation,
        amountCents: goal.budgetCents,
      });

      if (!budgetOk.allowed) {
        tick.jobsSkipped++;
        return tick;
      }

      const { createJob } = await import("../orchestrate");
      await createJob(this.env, {
        goalId: goal.id,
        goalName: goal.name,
        operation: goal.operation,
        budgetCents: goal.budgetCents,
      });

      goal.lastRun = now.toISOString();
      this.setGoals(goals);
      tick.jobsCreated++;
    } catch (err) {
      tick.errors.push(
        `${goal.id}: ${err instanceof Error ? err.message : String(err)}`
      );
      tick.jobsSkipped++;
    }

    return tick;
  }

  /**
   * Legacy cron entrypoint — invoked by Workers runtime on triggers.crons
   * tick. Kept for backwards compat; prefer SDK schedules via onStart().
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

    for (const goal of this.goals) {
      if (!goal.enabled) continue;
      tick.goalsEvaluated++;
      if (!isDue(goal.cron, goal.lastRun, now)) continue;
      const result = await this.evaluateGoal({ goalId: goal.id });
      tick.jobsCreated += result.jobsCreated;
      tick.jobsSkipped += result.jobsSkipped;
      tick.errors.push(...result.errors);
    }
    return tick;
  }

  // ── Agent-as-a-tool ──

  async listGoals(): Promise<ScheduledGoal[]> {
    return this.goals;
  }

  async setGoalEnabled(id: string, enabled: boolean): Promise<boolean> {
    const goals = this.goals;
    const goal = goals.find((g) => g.id === id);
    if (!goal) return false;
    goal.enabled = enabled;
    this.setGoals(goals);
    return true;
  }

  async triggerGoal(id: string): Promise<ScheduleTick> {
    return this.evaluateGoal({ goalId: id });
  }

  async getSchedules(): Promise<unknown> {
    const agent = this as unknown as {
      listSchedules: () => Promise<unknown>;
    };
    return agent.listSchedules();
  }

  // ── A2A ──

  static getCard() {
    return {
      name: "ScheduledAgent",
      description:
        "Autonomous goal-driven scheduler. Evaluates cron goals, budget-checks via PaymentsAgent, dispatches Orchestrator jobs.",
      version: "1.0.0",
      capabilities: ["scheduling", "goal-evaluation", "budget-gating"],
      methods: [
        "listGoals",
        "setGoalEnabled",
        "triggerGoal",
        "getSchedules",
        "evaluateGoal",
      ],
    };
  }

  async onA2ARequest(body: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<unknown> {
    const { method, params = {} } = body;
    switch (method) {
      case "listGoals":
        return this.listGoals();
      case "setGoalEnabled":
        return this.setGoalEnabled(params.id as string, params.enabled as boolean);
      case "triggerGoal":
        return this.triggerGoal(params.id as string);
      case "getSchedules":
        return this.getSchedules();
      default:
        throw new Error(`Unknown A2A method: ${method}`);
    }
  }
}
