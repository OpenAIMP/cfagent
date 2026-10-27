/**
 * Issue #1737 — route-side helpers for starting screener
 * workflows from the synchronous screen routes (Controller
 * pattern: the route builds the command, this module starts
 * it). Route-side only — never imported by the port, the
 * flows, or the adapters.
 *
 * Fallback rule: async start is best-effort. Any failure
 * (unbound workflow, unbound projection store, invalid
 * command, start error) returns null and the caller falls
 * back to the synchronous path — an opt-in async flag must
 * never 500 a screen the sync path can serve. Failures are
 * console.warned so operators see a degraded async path in
 * logs (a repeated-fallback alert is a follow-up).
 */
import type { Env } from "../types";
import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
import { createWorkflowPorts } from "./createWorkflowPorts";
import type { WorkflowHandle, WorkflowJobCommand } from "./workflowPorts";

/** POST body `async: true` (the flag is stripped before schema validation by callers). */
export function asyncRequestedFromBody(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { async?: unknown }).async === true
  );
}

/** GET query `async=1`. */
export function asyncRequestedFromQuery(url: URL): boolean {
  return url.searchParams.get("async") === "1";
}

/**
 * Manual job id, mirroring the task-ledger key scheme
 * (screener:manual:<universe>:<timestamp>). Fresh per
 * start: a failed job is retried by starting a NEW command
 * with a NEW jobId, never by reusing one.
 */
export function manualWorkflowJobId(universe: string): string {
  return `screener:manual:${universe}:${new Date().toISOString()}`;
}

/** Tenant for projection rows: server-resolved, never caller input. */
export function workflowTenantId(env: Partial<Env> | null | undefined): string {
  return resolveIaaaTenant(env);
}

/** Start a workflow when the port is available; null → caller falls back to sync. */
export async function tryStartScreenerWorkflow(
  env: Env,
  command: WorkflowJobCommand,
): Promise<WorkflowHandle | null> {
  try {
    const ports = createWorkflowPorts(env);
    if (!ports) return null;
    return await ports.start(command);
  } catch (err) {
    console.warn(
      "[screener-workflow] Async start failed, falling back to sync:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** 202 response for an accepted async screen. */
export function workflowAcceptedResponse(handle: WorkflowHandle): Response {
  return Response.json(
    {
      jobId: handle.jobId,
      workflowId: handle.workflowId,
      status: "queued",
      ...(handle.existing ? { existing: true } : {}),
      statusUrl: handle.statusUrl,
    },
    { status: 202 },
  );
}
