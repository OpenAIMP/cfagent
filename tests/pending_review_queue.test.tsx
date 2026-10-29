/** @vitest-environment jsdom */
/**
 * Issue #1324: the Reports panel's pending-review queue lists every
 * #277-held delivery with its artifacts, a countdown to expiry, and
 * approve / let-expire actions. Approve dispatches the held delivery;
 * let-expire rejects it (discarded unsent); both refresh the queue.
 *
 * Pins:
 *  - held items render with detail, artifact file names, and a countdown
 *  - Approve posts decision "approved" for that confirmation, then the
 *    queue refreshes (dispatched items leave it)
 *  - Let expire posts decision "rejected" for that confirmation
 *  - an empty queue renders the empty state, not a blank panel
 *  - a failed list fetch renders a business error notice, not a crash
 *  - formatCountdown is exact at fixed timestamps (no wall-clock drift)
 *
 * Harness follows tests/pdf_report_link_honesty.test.tsx: react-dom/client
 * in jsdom, direct component renders.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PendingReviewQueue, formatCountdown } from "../src/client/PendingReviewQueue";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = Date.now();
const isoIn = (ms: number) => new Date(NOW + ms).toISOString();

const SCREENER_ITEM = {
  confirmationId: "rc_screener1",
  kind: "screener",
  createdAt: isoIn(-60 * 60 * 1000),
  expiresAt: isoIn(2 * 60 * 60 * 1000 + 30 * 60 * 1000),
  detail: "SP100 screen · slack",
  artifacts: ["screener-report.pdf", "screener-report.xlsx"],
  channel: "slack",
  displayName: "SP100 screen",
  reportUrl: "https://agent.openaimp.com/api/screener/report.pdf?key=abc",
};

const EMAIL_ITEM = {
  confirmationId: "rc_email1",
  kind: "email",
  createdAt: isoIn(-30 * 60 * 1000),
  expiresAt: isoIn(45 * 60 * 1000),
  detail: "analyst@example.com · report.xlsx",
  artifacts: ["report.xlsx"],
};

function mockFetchSequence() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let pendingCalls = 0;
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method || "GET";
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url, method, body });
    if (url.endsWith("/trading/reports/pending")) {
      pendingCalls += 1;
      const pending = pendingCalls === 1 ? [SCREENER_ITEM, EMAIL_ITEM] : [];
      return { ok: true, status: 200, json: async () => ({ pending }) } as any;
    }
    if (url.endsWith("/trading/reports/confirm")) {
      return { ok: true, status: 200, json: async () => ({ success: true }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({ error: "Not found." }) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button")).filter(
    (b) => b.textContent?.trim() === name
  ) as HTMLButtonElement[];
}

describe("Issue #1324 — PendingReviewQueue", () => {
  it("renders held items with detail, artifacts, and a countdown", async () => {
    mockFetchSequence();
    await render(<PendingReviewQueue />);
    const text = container.textContent || "";
    expect(text).toContain("SP100 screen · slack");
    expect(text).toContain("screener-report.pdf");
    expect(text).toContain("screener-report.xlsx");
    expect(text).toContain("analyst@example.com · report.xlsx");
    expect(text).toContain("report.xlsx");
    expect(text).toMatch(/expires in 2h \d+m/);
    expect(text).toMatch(/expires in 4\d+m/);
  });

  it("Approve posts decision approved, then the queue refreshes to empty", async () => {
    const { calls } = mockFetchSequence();
    await render(<PendingReviewQueue />);
    const approve = buttonsNamed("Approve");
    expect(approve.length).toBe(2);
    await act(async () => {
      approve[0].click();
    });
    // #2283 stream 1: Approve now opens the shared confirm Modal
    // (portaled to document.body) instead of dispatching immediately.
    const modal = document.querySelector(".modal-backdrop") as HTMLElement;
    const send = Array.from(modal.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Approve and send"
    ) as HTMLButtonElement;
    await act(async () => {
      send.click();
    });
    await flush();
    const confirm = calls.find(
      (c) => c.url.endsWith("/trading/reports/confirm") && c.method === "POST"
    );
    expect(confirm?.body).toEqual({ confirmationId: "rc_screener1", decision: "approved" });
    expect(container.textContent || "").toContain("No deliveries awaiting review");
  });

  it("Let expire posts decision rejected for that confirmation", async () => {
    const { calls } = mockFetchSequence();
    await render(<PendingReviewQueue />);
    const letExpire = buttonsNamed("Let expire");
    expect(letExpire.length).toBe(2);
    await act(async () => {
      letExpire[1].click();
    });
    // #2283 stream 1: Let expire now opens the shared confirm Modal.
    const modal = document.querySelector(".modal-backdrop") as HTMLElement;
    const expire = Array.from(modal.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Let expire"
    ) as HTMLButtonElement;
    await act(async () => {
      expire.click();
    });
    await flush();
    const confirm = calls.find(
      (c) => c.url.endsWith("/trading/reports/confirm") && c.method === "POST"
    );
    expect(confirm?.body).toEqual({ confirmationId: "rc_email1", decision: "rejected" });
  });

  it("empty queue renders the empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ pending: [] }) }) as any)
    );
    await render(<PendingReviewQueue />);
    expect(container.textContent || "").toContain("No deliveries awaiting review");
  });

  it("failed list fetch renders a business error notice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "Failed to list pending confirmations." }),
      }) as any)
    );
    await render(<PendingReviewQueue />);
    expect(container.textContent || "").toContain("Could not load the pending-review queue.");
  });

  it("formatCountdown is exact at fixed timestamps", () => {
    const now = Date.parse("2026-10-25T12:00:00.000Z");
    expect(formatCountdown("2026-10-25T14:30:00.000Z", now)).toBe("expires in 2h 30m");
    expect(formatCountdown("2026-10-25T12:45:00.000Z", now)).toBe("expires in 45m");
    expect(formatCountdown("2026-10-25T12:00:00.000Z", now)).toBe("Expired");
    expect(formatCountdown("2026-10-25T11:00:00.000Z", now)).toBe("Expired");
    expect(formatCountdown(null, now)).toBe("Expiry unknown");
    expect(formatCountdown("not-a-date", now)).toBe("Expiry unknown");
  });
});
