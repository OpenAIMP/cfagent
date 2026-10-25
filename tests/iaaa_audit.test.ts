import { describe, it, expect } from "vitest";
import {
  createMemoryAuditStore,
  recordAuditEvent,
  recordAuditAccess,
  createAuditAccessEvent,
  classifyAuditFailure,
  shouldBlockAction,
  isAuditedSuccess,
  verifyChain,
} from "../src/security/iaaaAudit";
import type {
  AuditStore,
  CreateIaaaAuditEventInput,
  IaaaAuditEvent,
} from "../src/security/iaaaAudit";

/**
 * Issue #945, Slice 5 — IAAA accountability (pure policy/evidence model).
 *
 * Spec §6 acceptance cases: "A consequential action traces to
 * initiator, workload, delegation, policy, approval, outcome" and
 * "Audit failures are detected and handled per policy". This module
 * is NOT live enforcement and does NOT replace the existing audit
 * route (src/agents/routes/audit.ts, mas_events): no route, API,
 * job, tool, storage backend, or consequential action flow is
 * touched, and no production audit data is changed. A later slice
 * wires these pure rules into live call sites; until then they are
 * a testable evidence model. Retention and the tamper mechanism
 * remain open decisions in spec §8; the hash chain here is the
 * proposed mechanism, not a settled retention policy.
 */

const NOW = 1_800_000_000_000;

function consequentialEvent(
  overrides: Partial<CreateIaaaAuditEventInput> = {},
): CreateIaaaAuditEventInput {
  return {
    timestamp: NOW,
    type: "action:execute",
    actorPrincipalId: "agent-1",
    actorType: "agent",
    initiatingPrincipalId: "user-1",
    tenantId: "tenant-a",
    workspaceId: "workspace-1",
    taskId: "task-1",
    agentInstanceId: "agent-1",
    delegationId: "delegation-1",
    correlationId: "corr-1",
    action: "task:execute",
    resourceId: "resource-1",
    decision: "allow",
    policyVersion: "iaaa-authorization-1",
    approvalId: "approval-1",
    outcome: "succeeded",
    ...overrides,
  };
}

describe("iaaa audit (#945 slice 5)", () => {
  it("records a complete consequential action with all attribution fields", async () => {
    const store = createMemoryAuditStore();
    const result = await recordAuditEvent(store, consequentialEvent());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const event = result.event;
    expect(event.actorPrincipalId).toBe("agent-1");
    expect(event.initiatingPrincipalId).toBe("user-1");
    expect(event.tenantId).toBe("tenant-a");
    expect(event.taskId).toBe("task-1");
    expect(event.agentInstanceId).toBe("agent-1");
    expect(event.delegationId).toBe("delegation-1");
    expect(event.correlationId).toBe("corr-1");
    expect(event.action).toBe("task:execute");
    expect(event.resourceId).toBe("resource-1");
    expect(event.decision).toBe("allow");
    expect(event.policyVersion).toBe("iaaa-authorization-1");
    expect(event.approvalId).toBe("approval-1");
    expect(event.outcome).toBe("succeeded");
    expect(event.previousEventHash).toBeNull();
    expect(event.eventHash.length).toBe(64);
    expect((await store.list()).length).toBe(1);
  });

  it("chains events so each event carries the previous event's hash", async () => {
    const store = createMemoryAuditStore();
    const first = await recordAuditEvent(store, consequentialEvent());
    const second = await recordAuditEvent(
      store,
      consequentialEvent({ correlationId: "corr-2", action: "artifact:export" }),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(second.event.previousEventHash).toBe(first.event.eventHash);
    expect(await verifyChain(await store.list())).toBe(true);
  });

  it("verifies a multi-event chain end to end", async () => {
    const store = createMemoryAuditStore();
    for (let i = 0; i < 3; i++) {
      const result = await recordAuditEvent(
        store,
        consequentialEvent({ correlationId: `corr-${i}` }),
      );
      expect(result.ok).toBe(true);
    }
    expect(await verifyChain(await store.list())).toBe(true);
  });

  it("rejects an event missing the actor principal and writes nothing", async () => {
    const store = createMemoryAuditStore();
    const result = await recordAuditEvent(
      store,
      consequentialEvent({ actorPrincipalId: "" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("MISSING_ACTOR");
    expect((await store.list()).length).toBe(0);
  });

  it("rejects an event missing the initiating principal and writes nothing", async () => {
    const store = createMemoryAuditStore();
    const result = await recordAuditEvent(
      store,
      consequentialEvent({ initiatingPrincipalId: "   " }),
    );
    expect(result.ok).toBe(false);
    expect((await store.list()).length).toBe(0);
  });

  it("rejects an event missing the tenant scope and writes nothing", async () => {
    const store = createMemoryAuditStore();
    const result = await recordAuditEvent(
      store,
      consequentialEvent({ tenantId: "" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe("MISSING_TENANT");
    expect((await store.list()).length).toBe(0);
  });

  it("rejects an event missing the action and writes nothing", async () => {
    const store = createMemoryAuditStore();
    const result = await recordAuditEvent(
      store,
      consequentialEvent({ action: "" }),
    );
    expect(result.ok).toBe(false);
    expect((await store.list()).length).toBe(0);
  });

  it("rejects an event with an invalid decision", async () => {
    const store = createMemoryAuditStore();
    const result = await recordAuditEvent(
      store,
      consequentialEvent({ decision: "maybe" as never }),
    );
    expect(result.ok).toBe(false);
    expect((await store.list()).length).toBe(0);
  });

  it("rejects an event with an invalid outcome", async () => {
    const store = createMemoryAuditStore();
    const result = await recordAuditEvent(
      store,
      consequentialEvent({ outcome: "done" as never }),
    );
    expect(result.ok).toBe(false);
    expect((await store.list()).length).toBe(0);
  });

  it("blocks a consequential action when its audit write fails", async () => {
    const failing: AuditStore = {
      async append(): Promise<void> {
        throw new Error("audit store unavailable");
      },
      async list(): Promise<IaaaAuditEvent[]> {
        return [];
      },
    };
    const result = await recordAuditEvent(failing, consequentialEvent());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("AUDIT_WRITE_FAILED");
    const classification = classifyAuditFailure("consequential", true);
    expect(classification.action).toBe("block");
    expect(shouldBlockAction("consequential", true)).toBe(true);
  });

  it("allows a non-consequential read with a warning when audit write fails", async () => {
    const classification = classifyAuditFailure("non-consequential", true);
    expect(classification.action).toBe("allow-with-warning");
    expect(shouldBlockAction("non-consequential", true)).toBe(false);
    expect(shouldBlockAction("consequential", false)).toBe(false);
    expect(shouldBlockAction("non-consequential", false)).toBe(false);
  });

  it("does not report an action as audited-success when its audit write failed", async () => {
    // Authorization passed, but the audit record never landed: this
    // must never be reported as a successful audited action.
    expect(
      isAuditedSuccess({ decision: "allow", outcome: "succeeded", auditRecorded: false }),
    ).toBe(false);
    expect(
      isAuditedSuccess({ decision: "allow", outcome: "succeeded", auditRecorded: true }),
    ).toBe(true);
    expect(
      isAuditedSuccess({ decision: "deny", outcome: "succeeded", auditRecorded: true }),
    ).toBe(false);
    expect(
      isAuditedSuccess({ decision: "allow", outcome: "failed", auditRecorded: true }),
    ).toBe(false);
  });

  it("detects tampering with an earlier event in the chain", async () => {
    const store = createMemoryAuditStore();
    await recordAuditEvent(store, consequentialEvent());
    await recordAuditEvent(store, consequentialEvent({ correlationId: "corr-2" }));
    const events = await store.list();
    const tampered = events.map((event, i) =>
      i === 0 ? { ...event, action: "task:cancel" } : event,
    );
    expect(await verifyChain(tampered)).toBe(false);
    expect(await verifyChain(events)).toBe(true);
  });

  it("detects a broken link when a previous hash is altered", async () => {
    const store = createMemoryAuditStore();
    await recordAuditEvent(store, consequentialEvent());
    await recordAuditEvent(store, consequentialEvent({ correlationId: "corr-2" }));
    const events = await store.list();
    const relinked = events.map((event, i) =>
      i === 1 ? { ...event, previousEventHash: "0".repeat(64) } : event,
    );
    expect(await verifyChain(relinked)).toBe(false);
  });

  it("exposes an append-only store with no update or delete operation", () => {
    const store = createMemoryAuditStore();
    expect(typeof store.append).toBe("function");
    expect(typeof store.list).toBe("function");
    expect("update" in store).toBe(false);
    expect("delete" in store).toBe(false);
    expect("remove" in store).toBe(false);
  });

  it("records an audit:read access as an audit event itself", async () => {
    const store = createMemoryAuditStore();
    const result = await recordAuditAccess(store, {
      readerPrincipalId: "auditor-1",
      actorType: "human",
      initiatingPrincipalId: "auditor-1",
      tenantId: "tenant-a",
      access: "audit:read",
      correlationId: "corr-read-1",
      timestamp: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.event.type).toBe("audit:read");
    expect(result.event.action).toBe("audit:read");
    expect(result.event.actorPrincipalId).toBe("auditor-1");
    expect(result.event.tenantId).toBe("tenant-a");
    expect((await store.list()).length).toBe(1);
  });

  it("records an audit:export access as an audit event itself", async () => {
    const store = createMemoryAuditStore();
    const access = createAuditAccessEvent({
      readerPrincipalId: "auditor-1",
      actorType: "human",
      initiatingPrincipalId: "auditor-1",
      tenantId: "tenant-a",
      access: "audit:export",
      correlationId: "corr-export-1",
      timestamp: NOW,
    });
    const result = await recordAuditEvent(store, access);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.event.type).toBe("audit:export");
    expect(result.event.action).toBe("audit:export");
  });

  it("rejects an audit-access event missing its reader attribution", async () => {
    const store = createMemoryAuditStore();
    const result = await recordAuditAccess(store, {
      readerPrincipalId: "",
      actorType: "human",
      initiatingPrincipalId: "auditor-1",
      tenantId: "tenant-a",
      access: "audit:read",
      correlationId: "corr-read-2",
      timestamp: NOW,
    });
    expect(result.ok).toBe(false);
    expect((await store.list()).length).toBe(0);
  });

  it("lets a legitimate non-consequential workflow succeed with audit intact", async () => {
    const store = createMemoryAuditStore();
    const result = await recordAuditEvent(
      store,
      consequentialEvent({
        type: "task:read",
        action: "task:read",
        actorType: "human",
        actorPrincipalId: "user-1",
        outcome: "succeeded",
      }),
    );
    expect(result.ok).toBe(true);
    expect(await verifyChain(await store.list())).toBe(true);
  });
});
