/**
 * Issue #1737 — the in-memory workflow adapter. The second
 * adapter behind the port: it runs the parent and shard
 * flows eagerly with a fake step (do executes immediately,
 * sleep advances a virtual clock) and an in-memory instance
 * registry. It is the standing proof that a second
 * implementation plugs in cleanly, and the execution engine
 * for port-level tests.
 *
 * Explicit construction only (tests, local development). It
 * is NEVER a silent production fallback: an in-memory
 * registry in a worker isolate cannot survive a restart, so
 * substituting it for durable execution would lie about the
 * run guarantees. The composition root never builds it.
 *
 * Virtual clock: the adapter owns elapsed time — sleep
 * advances it — and the flows read time through the wrapped
 * clock, so poll loops and deadlines behave deterministically
 * in tests (a hanging child times out after its deadline in
 * virtual time, without any real waiting).
 */

import {
  assertWorkflowJobCommand,
  workflowIdForJob,
  workflowStatusUrl,
  type WorkflowHandle,
  type WorkflowInstanceStatus,
  type WorkflowJobCommand,
  type WorkflowPort,
  type WorkflowStatus,
} from "./workflowPorts";
import {
  runParentFlow,
  runShardFlow,
  type ChildWorkflowOps,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
} from "./screenerWorkflowFlow";

interface InstanceRecord {
  workflowId: string;
  jobId: string;
  command: WorkflowJobCommand;
  status: WorkflowInstanceStatus;
  output?: unknown;
  error?: { message: string };
}

export class InMemoryWorkflowAdapter implements WorkflowPort {
  private readonly instances = new Map<string, InstanceRecord>();
  private elapsedMs = 0;
  private readonly baseNowMs: number;

  private readonly clockedDeps: ScreenerWorkflowDeps;

  constructor(private readonly deps: ScreenerWorkflowDeps) {
    this.baseNowMs = deps.nowMs();
    // Assigned here (not as a field initializer): field
    // initializers run before parameter properties are set.
    this.clockedDeps = {
      ...deps,
      nowMs: () => this.baseNowMs + this.elapsedMs,
    };
  }

  /** Fake step: do executes immediately; sleep advances the virtual clock. */
  private readonly fakeStep: ScreenerWorkflowStep = {
    do: async (_name, fn) => fn(),
    sleep: async (_name, durationMs) => {
      this.elapsedMs += durationMs;
    },
  };

  /** Flows read time through the virtual clock (see constructor). */

  private childOps(): ChildWorkflowOps {
    return {
      createChild: async (command) => {
        const handle = await this.start(command);
        return { workflowId: handle.workflowId };
      },
      getChildStatus: async (workflowId) => {
        const record = this.instances.get(workflowId);
        if (!record) return null;
        return {
          status: record.status,
          ...(record.output !== undefined ? { output: record.output } : {}),
          ...(record.error ? { error: record.error } : {}),
        };
      },
    };
  }

  async start(command: WorkflowJobCommand): Promise<WorkflowHandle> {
    assertWorkflowJobCommand(command);
    const workflowId = workflowIdForJob(command.jobId);
    const existing = this.instances.get(workflowId);
    if (existing) {
      return {
        workflowId,
        jobId: command.jobId,
        status: existing.status,
        existing: true,
        statusUrl: workflowStatusUrl(command.jobId),
      };
    }
    const record: InstanceRecord = {
      workflowId,
      jobId: command.jobId,
      command,
      status: "running",
    };
    this.instances.set(workflowId, record);
    try {
      // Execution is synchronous here (unlike the provider
      // adapter, where start only creates): an execution
      // failure is recorded on the instance, never thrown
      // from start — callers poll status for the outcome,
      // exactly as they do on the provider path.
      const output =
        command.role === "shard"
          ? await runShardFlow(command, this.fakeStep, this.clockedDeps)
          : await runParentFlow(
              command,
              this.fakeStep,
              this.clockedDeps,
              this.childOps(),
            );
      record.status = "complete";
      record.output = output;
    } catch (err) {
      record.status = "errored";
      record.error = { message: err instanceof Error ? err.message : String(err) };
    }
    return {
      workflowId,
      jobId: command.jobId,
      status: record.status,
      existing: false,
      statusUrl: workflowStatusUrl(command.jobId),
    };
  }

  async status(workflowId: string): Promise<WorkflowStatus | null> {
    const record = this.instances.get(workflowId);
    if (!record) return null;
    return { workflowId, jobId: record.jobId, status: record.status };
  }
}
