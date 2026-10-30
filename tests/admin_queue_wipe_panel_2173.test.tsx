/** @vitest-environment jsdom */
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AdminQueueWipePanel } from "../src/client/AdminQueueWipePanel";

let container: HTMLDivElement;
let root: Root;

const FULL_DUMP = {
  count: 3,
  schedules: [
    { id: "a1", callback: "autonomousMarketScreen", type: "cron", cron: "30 12 * * 1-5", payload: { universe: "NASDAQ100" } },
    { id: "b2", callback: "autonomousOptionsAnalysis", type: "interval", intervalSeconds: 3600, payload: { universe: "SP100" } },
    { id: "p3", callback: "autonomousMarketScreen", paused: true, payload: {} },
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
  if (!target) throw new Error(`No button labelled "${label}" (found: ${buttons.map((b) => b.textContent).join(" | ")})`);
  return target;
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

describe("AdminQueueWipePanel", () => {
  it("renders the dump table with callback, cadence, universe, and paused state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(FULL_DUMP)));
    await renderPanel();
    expect(bodyText()).toContain("autonomousMarketScreen");
    expect(bodyText()).toContain("30 12 * * 1-5");
    expect(bodyText()).toContain("NASDAQ100");
    expect(bodyText()).toContain("SP100");
    expect(bodyText()).toContain("Paused");
    // Scope honesty: own-instance only, no platform-wide wipe promised.
    expect(bodyText()).toContain("own instance");
  });

  it("cancel-all runs preview, modal confirm, then verify-empty on re-fetch", async () => {
    let wiped = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url === "/api/schedules" && !init?.method) {
          // After a wipe the paused row survives by design; only the
          // active schedules are gone, which is what "verified empty" means.
          return jsonResponse(
            wiped
              ? { count: 1, schedules: [FULL_DUMP.schedules[2]] }
              : FULL_DUMP,
          );
        }
        if (url === "/api/schedules/cancel-all" && body.confirm !== true) {
          return jsonResponse({
            cancelled: 0,
            confirmRequired: true,
            wouldCancel: [
              { id: "a1", callback: "autonomousMarketScreen" },
              { id: "b2", callback: "autonomousOptionsAnalysis" },
            ],
            wouldCancelCount: 2,
            pausedPreserved: 1,
          });
        }
        if (url === "/api/schedules/cancel-all" && body.confirm === true) {
          wiped = true;
          return jsonResponse({ cancelled: 2, cancelledIds: ["a1", "b2"], failed: [], pausedPreserved: 1 });
        }
        return jsonResponse({ error: "unexpected call" }, 500);
      }),
    );
    await renderPanel();
    await act(async () => {
      clickButton("Preview queue wipe").click();
    });
    expect(bodyText()).toContain("2 schedule(s) would be cancelled");
    expect(bodyText()).toContain("1 paused record(s) preserved");
    await act(async () => {
      clickButton("Cancel schedules").click();
    });
    expect(bodyText()).toContain("Cancelled 2 schedule(s)");
    // Verify-empty: the re-fetched dump shows zero active schedules.
    expect(bodyText()).toContain("Queue verified empty");
  });

  it("clear-table preview and confirm render per-table results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url === "/api/schedules") return jsonResponse(FULL_DUMP);
        if (url === "/api/maintenance/clear-table" && body.confirm !== true) {
          return jsonResponse({
            table: "mas_async_jobs",
            scope: "session",
            confirmed: false,
            confirmRequired: true,
            wouldDelete: 4,
            breakdown: { queued: 3, failed: 1 },
            skippedRunning: 1,
          });
        }
        if (url === "/api/maintenance/clear-table" && body.confirm === true) {
          return jsonResponse({ table: "mas_async_jobs", scope: "session", confirmed: true, deleted: 4, skippedRunning: 1 });
        }
        return jsonResponse({ error: "unexpected call" }, 500);
      }),
    );
    await renderPanel();
    await act(async () => {
      clickButton("Preview mas_async_jobs").click();
    });
    expect(bodyText()).toContain("4 row(s) would be deleted");
    await act(async () => {
      clickButton("Clear mas_async_jobs").click();
    });
    expect(bodyText()).toContain("Deleted 4 row(s)");
    // Refused tables are named, not offered as actions.
    expect(bodyText()).toContain("mas_events");
    expect(bodyText()).not.toContain("Preview mas_events");
  });

  it("Track 1 recreation shows the four-schedule review before any create", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(FULL_DUMP)));
    await renderPanel();
    expect(bodyText()).toContain("Stock pre-market");
    expect(bodyText()).toContain("Stock intra-day");
    expect(bodyText()).toContain("Options NASDAQ100");
    expect(bodyText()).toContain("Options SP100");
    expect(bodyText()).toContain("30 16 * * 1-5");
    // Review only: no create call has been made yet.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a dump failure renders an error, never an empty table", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Forbidden" }, 403)));
    await renderPanel();
    expect(bodyText()).toContain("Queue dump failed");
    expect(bodyText()).toContain("Forbidden");
    // No dump row rendered: the ids below exist only in the dump table,
    // not in the Track 1 review table (which legitimately shows callbacks).
    expect(bodyText()).not.toContain("a1");
    expect(bodyText()).not.toContain("b2");
  });
});
