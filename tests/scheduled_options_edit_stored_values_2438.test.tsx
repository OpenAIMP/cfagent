/** @vitest-environment jsdom */
/**
 * Issue #2438 (ScreenersHub redesign), conflicting-state rule: a form
 * field shows the stored value or an explicit "Not set" — never a
 * default presented as stored. Defaults apply on create only, never
 * on edit.
 *
 * The proven mechanism (ScheduledOptionsManager edit-load): an absent
 * stored value kept the create defaults — pushToSlack true and
 * slackChannel "#options-alerts" — while Details (scheduleDetail.ts)
 * showed Slack "Not configured" for the same record.
 *
 * Pins:
 *  - editing a schedule with no stored Slack config shows Slack OFF
 *    (no checked box, no channel value smuggled in);
 *  - editing a schedule WITH stored Slack config shows it verbatim;
 *  - opening create after an edit restores the create defaults
 *    (Slack on, #options-alerts) instead of inheriting edit leftovers.
 *
 * Harness follows tests/scheduled_options_manager.test.ts: the REAL
 * apiFetch is driven against a stubbed global fetch; the edit modal
 * portals to document.body (.sched-modal-card).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScheduledOptionsManager } from "../src/client/ScheduledOptionsManager";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NEXT_RUN_S = Math.floor(Date.UTC(2026, 9, 19, 14, 30, 0) / 1000);

const noSlackSchedule = {
  id: "sched-no-slack",
  type: "interval",
  callback: "autonomousOptionsAnalysis",
  intervalSeconds: 3600,
  payload: {
    symbols: ["NVDA"],
    thesis: "bullish",
    riskProfile: "balanced",
    userLogin: "trader1",
    environment: "TEST",
    universe: "NASDAQ100",
    maxItems: 100,
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

const slackSchedule = {
  id: "sched-with-slack",
  type: "interval",
  callback: "autonomousOptionsAnalysis",
  intervalSeconds: 3600,
  payload: {
    symbols: ["AAPL"],
    thesis: "bullish",
    riskProfile: "balanced",
    userLogin: "trader1",
    environment: "TEST",
    universe: "NASDAQ100",
    maxItems: 100,
    trigger: "scheduled",
    pushToSlack: true,
    slackChannel: "#desk-alerts",
  },
  time: NEXT_RUN_S,
};

let container: HTMLDivElement;
let root: Root;

function installFetch(schedules: any[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init: any = {}) => {
      const url = String(input);
      const method = String(init.method || "GET").toUpperCase();
      if (url === "/api/schedules" && method === "GET") {
        return Response.json({ count: schedules.length, schedules });
      }
      if (url.includes("/api/etrade/options/profiles")) {
        return Response.json({ count: 0, profiles: [] });
      }
      if (url.startsWith("/api/audit")) {
        return Response.json({ events: [] });
      }
      return Response.json({ error: "unstubbed" }, { status: 500 });
    }),
  );
}

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderManager() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ScheduledOptionsManager, { activeEnv: "TEST", userLogin: "trader1" }));
  });
  await flush(60);
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush(40);
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}

function cardById(id: string): HTMLElement {
  const card = [...container.querySelectorAll(".schedule-item-card")].find((c) =>
    (c.textContent || "").includes(id),
  );
  if (!card) throw new Error(`schedule card "${id}" not found`);
  return card as HTMLElement;
}

function editModal(): HTMLElement {
  const modal = document.querySelector(".sched-modal-card");
  if (!modal) throw new Error("edit modal did not open");
  return modal as HTMLElement;
}

function slackCheckbox(modal: HTMLElement): HTMLInputElement {
  const box = [...modal.querySelectorAll('input[type="checkbox"]')].find((cb) => {
    const card = cb.closest(".channel-check-card");
    return (card?.textContent || "").includes("Slack Block Kit");
  });
  if (!box) throw new Error("Slack checkbox not found");
  return box as HTMLInputElement;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.unstubAllGlobals();
});

describe("Schedule edit shows stored values, never defaults (#2438)", () => {
  it("editing a schedule with no stored Slack config shows Slack OFF", async () => {
    installFetch([noSlackSchedule, slackSchedule]);
    await renderManager();
    await click(buttonByText(cardById("sched-no-slack"), "Edit"));
    const modal = editModal();
    expect(slackCheckbox(modal).checked).toBe(false);
    const channelInput = modal.querySelector('input[type="text"]') as HTMLInputElement | null;
    const channelValues = [...modal.querySelectorAll("input")].map((i) => (i as HTMLInputElement).value);
    expect(channelValues).not.toContain("#options-alerts");
    expect(channelInput).toBeDefined();
  });

  it("editing a schedule with stored Slack config shows it verbatim", async () => {
    installFetch([noSlackSchedule, slackSchedule]);
    await renderManager();
    await click(buttonByText(cardById("sched-with-slack"), "Edit"));
    const modal = editModal();
    expect(slackCheckbox(modal).checked).toBe(true);
    const channelValues = [...modal.querySelectorAll("input")].map((i) => (i as HTMLInputElement).value);
    expect(channelValues).toContain("#desk-alerts");
  });

  it("opening create after an edit restores the create defaults", async () => {
    installFetch([noSlackSchedule, slackSchedule]);
    await renderManager();
    await click(buttonByText(cardById("sched-no-slack"), "Edit"));
    const modal = editModal();
    expect(slackCheckbox(modal).checked).toBe(false);
    await click(buttonByText(modal, "Cancel"));
    await click(buttonByText(container, "New Schedule"));
    const createModal = editModal();
    expect(slackCheckbox(createModal).checked).toBe(true);
    const channelValues = [...createModal.querySelectorAll("input")].map((i) => (i as HTMLInputElement).value);
    expect(channelValues).toContain("#options-alerts");
  });
});
