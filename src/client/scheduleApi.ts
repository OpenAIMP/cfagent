/**
 * Issue #159: client API for the ScheduledAgent dashboard.
 */

export interface ScheduledGoal {
  id: string;
  name: string;
  cron: string;
  operation: string;
  budgetCents: number;
  enabled: boolean;
  lastRun?: string;
}

export interface ScheduleTick {
  timestamp: string;
  goalsEvaluated: number;
  jobsCreated: number;
  jobsSkipped: number;
  errors: string[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await globalThis.fetch(path, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed: ${path}`);
  return data;
}

export function listGoals() {
  return api<{ ok: boolean; goals: ScheduledGoal[] }>("/api/schedule/goals");
}

export function getTickHistory(limit = 20) {
  return api<{ ok: boolean; ticks: ScheduleTick[] }>(
    `/api/schedule/ticks?limit=${limit}`
  );
}

export function addGoal(goal: {
  id: string;
  name: string;
  cron: string;
  operation: string;
  budgetCents: number;
  enabled?: boolean;
}) {
  return api<{ ok: boolean; goal: ScheduledGoal }>("/api/schedule/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(goal),
  });
}

export function setGoalEnabled(id: string, enabled: boolean) {
  return api<{ ok: boolean }>(`/api/schedule/goals/${encodeURIComponent(id)}/enabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export function triggerGoal(id: string) {
  return api<{ ok: boolean; tick: ScheduleTick }>(
    `/api/schedule/goals/${encodeURIComponent(id)}/trigger`,
    { method: "POST" }
  );
}

export function removeGoal(id: string) {
  return api<{ ok: boolean }>(`/api/schedule/goals/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
