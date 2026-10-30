/** @vitest-environment jsdom */
/**
 * Issue #2371 (AOP phase 2, program #1969; renders the #2381 outcome
 * catalog): the records explorer
 * shows the resolved business message first for cataloged codes, with
 * the raw code secondary and category/retryable visible — never a
 * raw-code-only rendering for a cataloged code.
 *
 * Harness follows tests/approvals_panel.test.tsx: react-dom/client
 * in jsdom, direct component renders.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AuditEventCard } from "../src/client/components/AuditEventCard";
import type { AuditLogEvent } from "../src/client/chat/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

const RESOLVED = {
  code: "FAILURE_AUTH_NO_SESSION",
  businessMessage:
    "No E*TRADE session is stored for this account. Please connect your account in Settings.",
  category: "auth",
  retryable: false,
  variant:
    "[FAILURE_AUTH_NO_SESSION] No E*TRADE session is stored for this account. Please connect your account in Settings.",
};

const resolvedEvent: AuditLogEvent = {
  id: "coded-1",
  type: "etrade.auth_blocked",
  agent: "orchestrator",
  payload: { coded_error: "AUTH_003" },
  created_at: "2026-10-27T09:00:00Z",
  resolvedAspects: RESOLVED,
};

const unresolvedEvent: AuditLogEvent = {
  id: "plain-1",
  type: "test.event",
  agent: "orchestrator",
  payload: { job: 1 },
  created_at: "2026-10-27T09:00:00Z",
  resolvedAspects: null,
};

describe("audit event card (#2371)", () => {
  it("shows the resolved business message first, raw code secondary", async () => {
    await render(<AuditEventCard event={resolvedEvent} />);
    const html = container.innerHTML;
    expect(html).toContain(RESOLVED.businessMessage);
    expect(html).toContain("FAILURE_AUTH_NO_SESSION");
    // Business message precedes the raw code in document order.
    expect(html.indexOf(RESOLVED.businessMessage)).toBeLessThan(
      html.indexOf("FAILURE_AUTH_NO_SESSION")
    );
  });

  it("shows category and retryability for a resolved code", async () => {
    await render(<AuditEventCard event={resolvedEvent} />);
    expect(container.textContent).toContain("auth");
    expect(container.textContent).toContain("Not retryable");
  });

  it("keeps the raw payload visible alongside the resolved rendering", async () => {
    await render(<AuditEventCard event={resolvedEvent} />);
    expect(container.textContent).toContain("AUTH_003");
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it("renders unresolved events without a resolved block", async () => {
    await render(<AuditEventCard event={unresolvedEvent} />);
    expect(container.textContent).toContain("test.event");
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.textContent).not.toContain("Not retryable");
  });
});
