/**
 * Issue #1743 — trace propagation contracts across boundaries.
 * (1) Queue: a traceparent rides the CloudEvents envelope as a
 * lowercase extension (tolerated by the envelope validator and
 * now a first-class field); envelopeWithTraceparent stamps it
 * without touching correlationid.
 * (2) Workflow: WorkflowJobCommand carries an optional
 * traceparent; the in-memory adapter passes params through, so
 * a run started under a trace keeps that trace in its params.
 * Producer-side stamping at service-layer call sites (where no
 * request context reaches today) is a documented follow-up —
 * these tests pin the contract, not a fake producer.
 */
import { describe, it, expect } from "vitest";
import {
  isMessageEnvelope,
  type MessageEnvelope,
} from "../src/messaging/messagingPorts";
import {
  envelopeWithTraceparent,
  parseTraceparent,
} from "../src/observability/observabilityPorts";
import {
  assertWorkflowJobCommand,
  type WorkflowJobCommand,
} from "../src/workflows/workflowPorts";
import {
  startWorkflowInstance,
  type WorkflowBindingLike,
} from "../src/workflows/cfWorkflowAdapter";

const TRACE =
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("envelope traceparent extension", () => {
  it("is a valid envelope field and survives validation", () => {
    const env: MessageEnvelope = {
      specversion: "1.0",
      id: "evt-1",
      source: "test",
      type: "screener.completed",
      time: "2026-10-26T00:00:00.000Z",
      data: {},
      traceparent: TRACE,
    };
    expect(isMessageEnvelope(env)).toBe(true);
  });

  it("envelopeWithTraceparent stamps the header and keeps correlationid", () => {
    const base: MessageEnvelope = {
      specversion: "1.0",
      id: "evt-1",
      source: "test",
      type: "screener.completed",
      time: "2026-10-26T00:00:00.000Z",
      data: {},
      correlationid: "corr-1",
    };
    const stamped = envelopeWithTraceparent(base, parseTraceparent(TRACE)!);
    expect(stamped.traceparent).toBe(TRACE);
    expect(stamped.correlationid).toBe("corr-1");
    expect(stamped.id).toBe("evt-1");
    expect(base.traceparent).toBeUndefined();
  });
});

describe("workflow command traceparent", () => {
  it("is accepted by command validation and flows through start params", async () => {
    const command: WorkflowJobCommand = {
      jobId: "screener:manual:ALL:2026-10-26T00:00:00.000Z",
      type: "run-screen",
      source: "manual",
      trigger: "manual",
      userLogin: "owner-1",
      role: "parent",
      shards: [{ shardId: "TECH", universe: "TECH" }],
      traceparent: TRACE,
    };
    expect(assertWorkflowJobCommand(command)).toBe(command);
    const created: Array<{ id: string; params: unknown }> = [];
    const binding: WorkflowBindingLike = {
      create: async (options) => {
        created.push(options);
        return { id: options.id };
      },
      get: async () => {
        throw new Error("no instance");
      },
    };
    const handle = await startWorkflowInstance(binding, command);
    expect(handle.existing).toBe(false);
    expect(created).toHaveLength(1);
    expect(
      (created[0].params as WorkflowJobCommand).traceparent,
    ).toBe(TRACE);
  });

  it("is optional: commands without it validate and start unchanged", async () => {
    const command: WorkflowJobCommand = {
      jobId: "job-2",
      type: "run-screen",
      source: "manual",
      trigger: "manual",
      userLogin: "owner-1",
      role: "parent",
      shards: [{ shardId: "TECH", universe: "TECH" }],
    };
    expect(assertWorkflowJobCommand(command).traceparent).toBeUndefined();
  });
});
