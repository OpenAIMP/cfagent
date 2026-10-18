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
// A complete Agent (not just callable) with:
//   1. SDK SCHEDULING — uses this.schedule()/this.scheduleEvery() from the
//      Agents SDK (DO alarms, persisted to SQLite, survives restarts).
//      Goals are registered as cron schedules in onStart().
//   2. A2A — exposes an agent card at /.well-known/agent.json and handles
//      JSON-RPC dispatch for cross-agent invocation.
//   3. AGENT-AS-A-TOOL — other agents can call listGoals, setGoalEnabled,
//      triggerGoal, and getSchedules as tools.
//
// Budget discipline: the agent never spends directly. Every goal evaluation
// budget-checks via PaymentsAgent before creating Orchestrator work.

interface ScheduledAgentState {
  goals: ScheduledGoal[];
}

export class ScheduledAgent extends Agent<Env, ScheduledAgentState> {
  initialState: ScheduledAgentState = {
    goals: DEFAULT_SCHEDULES,
  };

  /**
   * Runs on every DO wake. Registers each enabled goal as an SDK cron
   * schedule (idempotent — same cron + callback + payload returns the
   * existing schedule instead of duplicating).
   */
  async onStart(): Promise<void> {
    for (const goal of this.state.goals) {
      if (!goal.enabled) continue;
      // Each goal gets its own cron schedule invoking evaluateGoal
      await this.schedule(goal.cron, "evaluateGoal", { goalId: goal.id });
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

    const goal = this.state.goals.find((g) => g.id === payload.goalId);
    if (!goal || !goal.enabled) {
      tick.jobsSkipped++;
      return tick;
    }

    try {
      // Budget check via PaymentsAgent — never spend without approval
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

      // Create Orchestrator job (orchestrator is a plain module)
      const { createJob } = await import("../orchestrate");
      await createJob(this.env, {
        goalId: goal.id,
        goalName: goal.name,
        operation: goal.operation,
        budgetCents: goal.budgetCents,
      });

      goal.lastRun = now.toISOString();
      this.setState({ goals: this.state.goals });
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

    for (const goal of this.state.goals) {
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

  // ── Agent-as-a-tool: methods other agents can invoke ──

  /** List all scheduled goals with their cron, status, and last run. */
  async listGoals(): Promise<ScheduledGoal[]> {
    return this.state.goals;
  }

  /** Enable or disable a goal. Re-registers SDK schedules on enable. */
  async setGoalEnabled(id: string, enabled: boolean): Promise<boolean> {
    const goal = this.state.goals.find((g) => g.id === id);
    if (!goal) return false;
    goal.enabled = enabled;
    this.setState({ goals: this.state.goals });
    if (enabled) {
      await this.schedule(goal.cron, "evaluateGoal", { goalId: goal.id });
    }
    return true;
  }

  /** Manually trigger a goal evaluation outside its schedule. */
  async triggerGoal(id: string): Promise<ScheduleTick> {
    return this.evaluateGoal({ goalId: id });
  }

  /** List all SDK-registered schedules (cron, delayed, interval). */
  async getSchedules() {
    return this.listSchedules();
  }

  /** Schedule a one-off delayed task. */
  async scheduleOnce(
    delaySeconds: number,
    callback: string,
    payload: Record<string, unknown>
  ): Promise<string> {
    const s = await this.schedule(delaySeconds, callback, payload);
    return s.id;
  }

  // ── A2A: agent card + JSON-RPC ──

  /** Agent card for A2A discovery. */
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
        "scheduleOnce",
        "evaluateGoal",
      ],
    };
  }

  /**
   * Handle A2A JSON-RPC requests. Routes method calls to agent methods.
   */
  async onA2ARequest(body: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<unknown> {
    const { method, params = {} } = body;
    switch (method) {
      case "listGoals":
        return this.listGoals();
      case "setGoalEnabled":
        return this.setGoalEnabled(
          params.id as string,
          params.enabled as boolean
        );
      case "triggerGoal":
        return this.triggerGoal(params.id as string);
      case "getSchedules":
        return this.getSchedules();
      case "scheduleOnce":
        return this.scheduleOnce(
          params.delaySeconds as number,
          params.callback as string,
          (params.payload as Record<string, unknown>) ?? {}
        );
      default:
        throw new Error(`Unknown A2A method: ${method}`);
    }
  }
}
