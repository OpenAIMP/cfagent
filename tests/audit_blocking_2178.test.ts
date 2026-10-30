/**
 * Issue #2178 (Q7 S2) — blocking audit helper.
 * TDD: written before the implementation.
 *
 * Contract: recordBlockingAudit writes through the chained events
 * repository and lets ANY write failure propagate to the caller. That
 * propagation is what makes a consequential action blocking under Q7:
 * the caller must not report success for an action whose own audit
 * write failed. Contrast the warn-and-swallow paths
 * (OrchestratorAgent.audit, ScheduledTasksService.audit), which stay
 * for non-consequential writes per #1999 D1.
 */
import { describe, expect, it } from "vitest";
import {
  recordBlockingAudit,
  type BlockingAuditEvents,
} from "../src/security/auditChain";
import type { AuditEvent } from "../src/types";

function input(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "e1",
    sessionId: "alice",
    type: "trade.order_executed",
    agent: "trading",
    payload: { orderId: "o1" },
    createdAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  };
}

function fakeRepo(opts: { throws?: Error } = {}): BlockingAuditEvents & {
  created: AuditEvent[];
} {
  const created: AuditEvent[] = [];
  return {
    created,
    create(record: AuditEvent): AuditEvent {
      if (opts.throws) throw opts.throws;
      created.push(record);
      return record;
    },
  };
}

describe("recordBlockingAudit (#2178 S2)", () => {
  it("writes the record through and returns it", () => {
    const repo = fakeRepo();
    const result = recordBlockingAudit(repo, input());
    expect(result.id).toBe("e1");
    expect(repo.created).toHaveLength(1);
    expect(repo.created[0]?.type).toBe("trade.order_executed");
  });

  it("propagates a write failure instead of swallowing it", () => {
    const failure = new Error("audit store unavailable");
    const repo = fakeRepo({ throws: failure });
    expect(() => recordBlockingAudit(repo, input())).toThrowError(
      "audit store unavailable",
    );
    expect(repo.created).toHaveLength(0);
  });
});
