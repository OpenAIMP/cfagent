/**
 * Issue #2065 — the goal workflow start must surface a diagnosable
 * failure instead of swallowing it into null + a generic 500.
 *
 * `startGoalScreenWorkflow` throws a WorkflowError with a stable
 * code, and the start attempt is wrapped in the withObservability
 * aspect: exactly one sink event per attempt (completion with
 * duration, or error with the code — never the raw message), and
 * a failing sink never fails the call.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildGoalScreenCommand,
  startGoalScreenWorkflow,
} from "../src/services/goalScreenWorkflowSubmission";
import { WorkflowError } from "../src/workflows/workflowPorts";

function fakeSink() {
  return { write: vi.fn().mockResolvedValue(undefined) } as never;
}

function cmd() {
  return buildGoalScreenCommand({
    jobId: "goal-screen:manual:alice:income:2026-10-27T12:00:00.000Z",
    source: "manual",
    trigger: "manual",
    userLogin: "alice",
    scenario: { goalKind: "income" } as never,
    scenarioSource: "built",
  });
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    create: async ({ id }: { id: string }) => ({ id }),
    get: async (id: string) => ({ id, status: async () => ({ status: "queued" }) }),
    ...overrides,
  };
}

describe("startGoalScreenWorkflow diagnostics (#2065)", () => {
  it("throws workflow_binding_absent + error event when the binding is missing", async () => {
    const sink = fakeSink();
    await expect(startGoalScreenWorkflow({}, cmd(), sink)).rejects.toMatchObject({
      code: "workflow_binding_absent",
    });
    expect(sink.write).toHaveBeenCalledTimes(1);
    const event = sink.write.mock.calls[0][0];
    expect(event.type).toBe("goal.workflow.start");
    expect(event.level).toBe("error");
    expect(event.errorCode).toBe("workflow_binding_absent");
    expect(event.fields.workflowBinding).toBe("absent");
    expect(event.runId).toBe(cmd().jobId);
  });

  it("throws workflow_binding_malformed when the binding lacks create/get", async () => {
    const sink = fakeSink();
    const env = { SCREENER_WORKFLOW: { create: async () => ({}) } };
    await expect(startGoalScreenWorkflow(env, cmd(), sink)).rejects.toMatchObject({
      code: "workflow_binding_malformed",
    });
    const event = sink.write.mock.calls[0][0];
    expect(event.errorCode).toBe("workflow_binding_malformed");
    expect(event.fields.workflowBinding).toBe("malformed");
  });

  it("throws projection_store_unbound when AGENT_DB is missing", async () => {
    const sink = fakeSink();
    const env = { SCREENER_WORKFLOW: binding() };
    await expect(startGoalScreenWorkflow(env, cmd(), sink)).rejects.toMatchObject({
      code: "projection_store_unbound",
    });
    const event = sink.write.mock.calls[0][0];
    expect(event.errorCode).toBe("projection_store_unbound");
    expect(event.fields.projectionStore).toBe("unbound");
  });

  it("throws invalid_command when the command fails shape validation", async () => {
    const sink = fakeSink();
    const env = { SCREENER_WORKFLOW: binding(), AGENT_DB: {} };
    const bad = { ...cmd(), type: "bogus" } as never;
    await expect(startGoalScreenWorkflow(env, bad, sink)).rejects.toMatchObject({
      code: "invalid_command",
    });
    const event = sink.write.mock.calls[0][0];
    expect(event.errorCode).toBe("invalid_command");
  });

  it("throws start_failed when create throws and no instance can be adopted", async () => {
    const sink = fakeSink();
    const env = {
      SCREENER_WORKFLOW: binding({
        create: async () => {
          throw new Error("binding boom");
        },
        get: async () => {
          throw new Error("no instance");
        },
      }),
      AGENT_DB: {},
    };
    await expect(startGoalScreenWorkflow(env, cmd(), sink)).rejects.toMatchObject({
      code: "start_failed",
    });
    const event = sink.write.mock.calls[0][0];
    expect(event.errorCode).toBe("start_failed");
  });

  it("resolves the handle + info event with duration on success", async () => {
    const sink = fakeSink();
    const env = { SCREENER_WORKFLOW: binding(), AGENT_DB: {} };
    const handle = await startGoalScreenWorkflow(env, cmd(), sink);
    expect(handle.jobId).toBe(cmd().jobId);
    expect(handle.status).toBe("queued");
    expect(handle.existing).toBe(false);
    expect(sink.write).toHaveBeenCalledTimes(1);
    const event = sink.write.mock.calls[0][0];
    expect(event.level).toBe("info");
    expect(typeof event.durationMs).toBe("number");
    expect(event.fields.workflowBinding).toBe("present");
    expect(event.fields.projectionStore).toBe("bound");
  });

  it("a failing sink never fails the call (aspect guarantee)", async () => {
    const sink = { write: vi.fn().mockRejectedValue(new Error("sink down")) } as never;
    const env = { SCREENER_WORKFLOW: binding(), AGENT_DB: {} };
    const handle = await startGoalScreenWorkflow(env, cmd(), sink);
    expect(handle.jobId).toBe(cmd().jobId);
  });

  it("the thrown error is a WorkflowError (callers map code, never message)", async () => {
    const sink = fakeSink();
    let caught: unknown;
    try {
      await startGoalScreenWorkflow({}, cmd(), sink);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkflowError);
  });
});
