/** @vitest-environment jsdom */
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AdminQueueWipePanel } from "../src/client/AdminQueueWipePanel";

let container: HTMLDivElement;
let root: Root;

const FULL_DUMP = {
  count: 1,
  schedules: [
    { id: "a1", callback: "autonomousMarketScreen", type: "cron", cron: "30 12 * * 1-5", payload: { universe: "NASDAQ100" } },
  ],
  timestamp: "2026-10-30T12:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AdminQueueWipePanel />);
  });
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

function clickButton(label: string) {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const target = buttons.find((b) => (b.textContent ?? "").trim() === label);
  if (!target) throw new Error(`No button labelled "${label}" (found: ${buttons.map((b) => b.textContent).join(" | ")}`);
  return target;
}

function checkboxes(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll('input[type="checkbox"]'));
}

function checkboxFor(labelPart: string): HTMLInputElement {
  // Match on the label's leading text: several rows mention other rows
  // in their notes (e.g. memberships mentions the genesis marker).
  const found = checkboxes().find((c) => {
    const text = c.parentElement?.textContent ?? "";
    const label = text.split(" — ")[0];
    return label.includes(labelPart);
  });
  if (!found) throw new Error(`No checkbox for "${labelPart}"`);
  return found;
}

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(calls: Call[]) {
  return vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, body });
    if (url === "/api/schedules") return jsonResponse(FULL_DUMP);
    if (url === "/api/schedules/cancel-all" && body.confirm !== true) {
      return jsonResponse({ confirmRequired: true, wouldCancel: [{ id: "a1", callback: "autonomousMarketScreen" }], wouldCancelCount: 1, pausedPreserved: 0 });
    }
    if (url === "/api/schedules/cancel-all" && body.confirm === true) {
      return jsonResponse({ cancelled: 1, cancelledIds: ["a1"], failed: [], pausedPreserved: 0 });
    }
    if (url === "/api/maintenance/clear-table" && body.confirm !== true) {
      return jsonResponse({ table: body.table, scope: "instance", confirmed: false, confirmRequired: true, wouldDelete: 3 });
    }
    if (url === "/api/maintenance/clear-table" && body.confirm === true) {
      return jsonResponse({ table: body.table, scope: "instance", confirmed: true, deleted: 3 });
    }
    if (url === "/api/maintenance/kv-wipe" && body.confirm !== true) {
      return jsonResponse({ confirmed: false, confirmRequired: true, rows: (body.rows as string[]).map((row) => ({ row, count: 2 })) });
    }
    if (url === "/api/maintenance/kv-wipe" && body.confirm === true) {
      return jsonResponse({ confirmed: true, rows: (body.rows as string[]).map((row) => ({ row, count: 2 })) });
    }
    if (url === "/api/maintenance/events-export") {
      return jsonResponse({ count: 2, truncated: false, events: [] });
    }
    if (url.startsWith("/api/clear")) return jsonResponse({ ok: true });
    return jsonResponse({ error: "unexpected call" }, 500);
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  vi.unstubAllGlobals();
});

describe("AdminQueueWipePanel selective wipe (#2489)", () => {
  it("checks every row by default", async () => {
    vi.stubGlobal("fetch", stubFetch([]));
    await renderPanel();
    const boxes = checkboxes();
    expect(boxes.length).toBe(12);
    expect(boxes.every((c) => c.checked)).toBe(true);
  });

  it("locks the marker checkbox while memberships is checked, unlocks when unchecked", async () => {
    vi.stubGlobal("fetch", stubFetch([]));
    await renderPanel();
    const marker = checkboxFor("genesis marker");
    expect(marker.disabled).toBe(true);
    const memberships = checkboxFor("Memberships");
    await act(async () => {
      memberships.click();
    });
    expect(memberships.checked).toBe(false);
    expect(checkboxFor("genesis marker").disabled).toBe(false);
  });

  it("unchecking a row skips it entirely: no preview call for that row", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", stubFetch(calls));
    await renderPanel();
    await act(async () => {
      checkboxFor("Audit history").click();
    });
    expect(checkboxFor("Audit history").checked).toBe(false);
    await act(async () => {
      clickButton("Preview selective wipe").click();
    });
    expect(bodyText()).toContain("Confirm selective wipe");
    const clearPreviews = calls.filter(
      (c) => c.url === "/api/maintenance/clear-table" && c.body.confirm !== true,
    );
    expect(clearPreviews.some((c) => c.body.table === "mas_events")).toBe(false);
    expect(clearPreviews.some((c) => c.body.table === "mas_async_jobs")).toBe(true);
  });

  it("runs the aggregate confirm, the audit second confirmation with export, and per-row results", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", stubFetch(calls));
    await renderPanel();
    await act(async () => {
      clickButton("Preview selective wipe").click();
    });
    expect(bodyText()).toContain("Confirm selective wipe");
    await act(async () => {
      clickButton("Wipe selected").click();
    });
    // mas_events is selected, so the second confirmation opens instead.
    expect(bodyText()).toContain("Audit history needs a second confirmation");
    await act(async () => {
      clickButton("Export audit history first").click();
    });
    expect(calls.some((c) => c.url === "/api/maintenance/events-export")).toBe(true);
    await act(async () => {
      clickButton("Wipe including audit history").click();
    });
    expect(bodyText()).toContain("Selective wipe result");
    expect(bodyText()).toContain("framework: Cancelled 1 schedule(s)");
    expect(bodyText()).toContain("mas_events: Deleted 3 row(s)");
    expect(bodyText()).toContain("kv:sessions: Deleted 2 key(s)");
    // KV wipe went through ONE aggregate confirm call (gate once).
    const kvConfirms = calls.filter(
      (c) => c.url === "/api/maintenance/kv-wipe" && c.body.confirm === true,
    );
    expect(kvConfirms).toHaveLength(1);
    expect(kvConfirms[0].body.rows).toEqual(["memberships", "tokens", "bindings", "marker", "sessions"]);
    // Sessions wiped: the signed-out notice shows, no dump re-fetch.
    expect(bodyText()).toContain("Sessions wiped");
  });
});
