/**
 * Schedule definitions for autonomous agent triggers.
 *
 * The ScheduledAgent Durable Object (src/agents/scheduled-agent.ts)
 * consumes these on each cron tick: it pulls active goals from SQL,
 * budget-checks via PaymentsAgent, and creates Orchestrator jobs.
 */

export interface ScheduledGoal {
  id: string;
  name: string;
  /** Cron expression for when this goal should be evaluated */
  cron: string;
  /** Agent operation to invoke (from the orchestrate.ts catalog) */
  operation: string;
  /** Max spend per evaluation, in cents */
  budgetCents: number;
  /** Whether this goal is currently active */
  enabled: boolean;
  /** Last time this goal was evaluated (ISO timestamp) */
  lastRun?: string;
}

export interface ScheduleTick {
  timestamp: string;
  goalsEvaluated: number;
  jobsCreated: number;
  jobsSkipped: number;
  errors: string[];
}

/**
 * Default schedules. Goals themselves live in the ScheduledAgent's
 * SQL; these are the built-in evaluations that ship with the system.
 */
export const DEFAULT_SCHEDULES: ScheduledGoal[] = [
  {
    id: "daily-qa-sweep",
    name: "Daily QA sweep",
    cron: "0 6 * * *",
    operation: "qa.run_sweep",
    budgetCents: 500,
    enabled: true,
  },
  {
    id: "opportunity-hunt",
    name: "Opportunity hunt",
    cron: "0 */6 * * *",
    operation: "search.opportunity_hunt",
    budgetCents: 1000,
    enabled: true,
  },
];

/**
 * Check whether a cron expression is due given the last run time.
 * Minimal parser supporting the schedules above (minute hour * * *).
 */
export function isDue(cron: string, lastRun: string | undefined, now: Date): boolean {
  const [minute, hour] = cron.split(" ").map(Number);
  if (Number.isNaN(minute) || Number.isNaN(hour)) return false;

  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();

  // Due if we're in the target hour/minute window
  if (currentHour !== hour || currentMinute < minute) return false;

  // And we haven't run in the last 23 hours (avoid double-fire)
  if (lastRun) {
    const last = new Date(lastRun).getTime();
    if (now.getTime() - last < 23 * 60 * 60 * 1000) return false;
  }
  return true;
}
