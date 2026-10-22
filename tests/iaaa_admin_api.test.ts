import { describe, it, expect } from "vitest";
import {
  formatEventTime,
  isAdminOverview,
} from "../src/client/iaaaAdminApi";

/**
 * #945 IAAA-UI v1 — client-side data-shape helpers (no browser needed).
 * The panel renders only payloads that pass isAdminOverview; a 403
 * body or garbage must never reach the table.
 */
const valid = {
  tenantId: "primary",
  callerInternalUserId: "11111111-1111-4111-8111-111111111111",
  memberships: [
    {
      membershipId: "m-1",
      internalUserId: "11111111-1111-4111-8111-111111111111",
      tenantId: "primary",
      roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" }],
      createdBy: "system:bootstrap-genesis",
      createdAtMs: 1792660000000,
    },
  ],
  genesis: { platformGenesisOccurred: true },
  recentAuditEvents: [
    {
      id: "evt-1",
      timestamp: 1792660000000,
      type: "auth.login.success",
      action: "auth.login",
      decision: "allow",
      outcome: "success",
      correlationId: "corr-1",
    },
  ],
};

describe("isAdminOverview", () => {
  it("accepts a well-formed overview", () => {
    expect(isAdminOverview(valid)).toBe(true);
  });

  it("rejects a 403 body, null, and malformed payloads", () => {
    expect(isAdminOverview({ error: "Forbidden" })).toBe(false);
    expect(isAdminOverview(null)).toBe(false);
    expect(isAdminOverview({ ...valid, recentAuditEvents: "nope" })).toBe(false);
    expect(isAdminOverview({ ...valid, memberships: null })).toBe(false);
    expect(isAdminOverview({ ...valid, genesis: {} })).toBe(false);
  });
});

describe("formatEventTime", () => {
  it("formats a valid timestamp and degrades gracefully", () => {
    expect(formatEventTime(1792660000000)).toContain("2026");
    expect(formatEventTime(Number.NaN)).toBe("—");
  });
});
