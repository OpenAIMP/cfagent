/**
 * Issue #1737 — the provider adapter for the workflow port.
 * This module (plus the workflow class and the composition
 * root) is the ONLY place that touches the workflow binding.
 * Domain code imports the port and the composition root,
 * never this module and never a binding.
 *
 * Idempotent start: creating an instance with an id that
 * already exists is an error, not a second run — so a create
 * failure is followed by a get, and an existing instance is
 * adopted (existing:true) instead of failing. This is what
 * makes retried starts (and retried fan-out steps) safe: a
 * create that already landed adopts its own instance.
 */

import {
  assertWorkflowJobCommand,
  workflowIdForJob,
  workflowStatusUrl,
  WorkflowError,
  type WorkflowHandle,
  type WorkflowInstanceStatus,
  type WorkflowJobCommand,
  type WorkflowPort,
  type WorkflowStatus,
} from "./workflowPorts";

/** Minimal structural surface the adapter needs from a binding (no provider types). */
export interface WorkflowBindingInstance {
  id: string;
  status(): Promise<{
    status: string;
    output?: unknown;
    error?: { message: string };
  }>;
}

/** Minimal structural surface of a workflow binding. */
export interface WorkflowBindingLike {
  create(options: { id: string; params: unknown }): Promise<{ id: string }>;
  get(id: string): Promise<WorkflowBindingInstance>;
}

/** Map a raw instance status onto the port's vocabulary (unknown strings → "unknown"). */
export function mapInstanceStatus(raw: string): WorkflowInstanceStatus {
  switch (raw) {
    case "queued":
    case "running":
    case "paused":
    case "waiting":
    case "waitingForPause":
    case "complete":
    case "errored":
    case "terminated":
      return raw;
    default:
      return "unknown";
  }
}

/**
 * Deterministic short instance id for a job whose derived id the
 * provider would reject (Issue #2065: a 122-char goal job id).
 *
 * Hashing keeps retries idempotent: the same job id always maps to the
 * same fallback instance, so a retried start adopts instead of creating
 * a second run. 40 hex chars + the prefix stay far under the provider's
 * 100-character ceiling.
 */
async function fallbackWorkflowId(jobId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jobId));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `screen-${hex.slice(0, 40)}`;
}

/** Provider error text, safe to log (never returned to a client). */
function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Start one instance idempotently: create, or adopt the
 * existing instance when create reports the id is taken
 * (any create error falls through to the get — the error
 * shape for a duplicate id is provider detail, and a get
 * that succeeds proves the instance exists).
 *
 * Issue #2065: when the derived id is unusable (over the provider's
 * 100-character ceiling, rejected characters) or the collision has no
 * adoptable instance, the job is not lost — one retry uses a short
 * provider-safe id (`screen-<uuid>`). The job id still rides in params,
 * so the run stays traceable, and a genuine provider outage still fails
 * loudly with the original error preserved for the logs.
 */
export async function startWorkflowInstance(
  binding: WorkflowBindingLike,
  command: WorkflowJobCommand,
): Promise<{ workflowId: string; existing: boolean; adoptedFallbackId?: boolean }> {
  let firstError: unknown = null;
  let derivedId: string | null = null;
  try {
    derivedId = workflowIdForJob(command.jobId);
    const instance = await binding.create({ id: derivedId, params: command });
    return { workflowId: instance.id, existing: false };
  } catch (err) {
    firstError = err;
  }
  if (derivedId) {
    try {
      const instance = await binding.get(derivedId);
      await instance.status();
      return { workflowId: derivedId, existing: true };
    } catch {
      // No adoptable instance: fall through to the fallback-id retry.
    }
  }
  const fallbackId = await fallbackWorkflowId(command.jobId);
  try {
    const instance = await binding.create({ id: fallbackId, params: command });
    console.warn(
      `[workflows] start used fallback instance id ${fallbackId} for job ${command.jobId} after the derived id failed: ${errorText(firstError)}`,
    );
    return { workflowId: instance.id, existing: false, adoptedFallbackId: true };
  } catch (retryErr) {
    throw new WorkflowError(
      "start_failed",
      `Workflow start failed for job ${command.jobId} (derived id: ${errorText(firstError)}; fallback id: ${errorText(retryErr)}).`,
    );
  }
}

/** Provider adapter: the workflow port over a workflow binding. */
export class CfWorkflowAdapter implements WorkflowPort {
  constructor(private readonly binding: WorkflowBindingLike) {}

  async start(command: WorkflowJobCommand): Promise<WorkflowHandle> {
    assertWorkflowJobCommand(command);
    const { workflowId, existing } = await startWorkflowInstance(
      this.binding,
      command,
    );
    return {
      workflowId,
      jobId: command.jobId,
      status: existing ? "running" : "queued",
      existing,
      statusUrl: workflowStatusUrl(command.jobId),
    };
  }

  async status(workflowId: string): Promise<WorkflowStatus | null> {
    try {
      const instance = await this.binding.get(workflowId);
      const s = await instance.status();
      return { workflowId, status: mapInstanceStatus(s.status) };
    } catch {
      return null;
    }
  }
}
