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
 * Start one instance idempotently: create, or adopt the
 * existing instance when create reports the id is taken
 * (any create error falls through to the get — the error
 * shape for a duplicate id is provider detail, and a get
 * that succeeds proves the instance exists).
 */
export async function startWorkflowInstance(
  binding: WorkflowBindingLike,
  command: WorkflowJobCommand,
): Promise<{ workflowId: string; existing: boolean }> {
  const id = workflowIdForJob(command.jobId);
  try {
    const instance = await binding.create({ id, params: command });
    return { workflowId: instance.id, existing: false };
  } catch {
    try {
      const instance = await binding.get(id);
      await instance.status();
      return { workflowId: id, existing: true };
    } catch {
      throw new WorkflowError(
        "start_failed",
        `Workflow start failed for job ${command.jobId} (create failed and no instance ${id} could be adopted).`,
      );
    }
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
