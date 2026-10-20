/** @vitest-environment jsdom */
/**
 * Issue #110: ScheduledOptionsManager completeness & safety.
 *
 * The manager is the UI for the Agents scheduling API. The #106 audit
 * found it partial and, in places, misleading:
 *  - no UI control called the screen / renewal / IV trigger routes;
 *  - every card's "Trigger Now" ran options analysis, whatever the
 *    card's own job was;
 *  - the baseline system schedules (token renewal, market screen, IV
 *    collection) rendered as generic cards with analysis-default
 *    payload labels, and Edit/Cancel acted on them unguarded — an edit
 *    could silently replace the IV cron with an analysis schedule;
 *  - the create form hard-coded the analysis callback and offered
 *    only cron + interval, though the API supports delayed and
 *    one-shot (date) modes too, and IV collection was not creatable;
 *  - nothing called GET /api/schedules/:id.
 *
 * Harness follows tests/scanner_panel.test.ts: the REAL apiFetch is
 * driven against a stubbed global fetch (the #71 lesson — mock the
 * transport contract, not just payloads), including one test through
 * the worker's 202 async-job stub → poll → completed flow. The
 * component renders with react-dom/client in jsdom.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ScheduledOptionsManager,
  SYSTEM_JOBS,
  triggerRouteFor,
} from "../src/client/options/ScheduledOptionsManager";
import { etToUtcCron } from "../src/client/options/cronTime";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures -----------------------------------------------------------------

const NEXT_RUN_S = Math.floor(Date.UTC(2026, 9, 19, 14, 30, 0) / 1000);

const screenSystem = {
  id: "sys-market-screen",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 14 * * 1-5",
  payload: { userLogin: "trader1", environment: "TEST", universe: "LEV_ETF", maxItems: 29, sector: "Technology", trigger: "scheduled" },
  time: NEXT_RUN_S,
};

const userAnalysis = {
  id: "user-analysis-1",
  type: "interval",
  callback: "autonomousOptionsAnalysis",
  intervalSeconds: 3600,
  payload: {
    symbols: ["NVDA", "AAPL"],
    thesis: "bullish",
    riskProfile: "balanced",
    userLogin: "trader1",
    environment: "TEST",
    universe: "NASDAQ100",
    maxItems: 100,
    trigger: "scheduled",
    pushToSlack: true,
    slackChannel: "#options-alerts",
  },
  time: NEXT_RUN_S,
};

const ALL_SCHEDULES = [screenSystem, userAnalysis];

interface StubState {
  schedules: any[];
  cancelledIds: Set<string>;
  listViaJob: boolean;
}

interface RecordedCall {
  url: string;
  method: string;
  body: any;
}

function installFetch(state: StubState) {
  const calls: RecordedCall[] = [];
  const visibleSchedules = () => state.schedules.filter((s) => !state.cancelledIds.has(s?.id));
  const mock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.includes("/api/jobs/")) {
      return Response.json({
        jobId: "job-list",
        capability: "http.request",
        status: "completed",
        statusUrl: "/api/jobs/job-list",
        responseStatus: 200,
        result: {
          body: JSON.stringify({ count: visibleSchedules().length, schedules: visibleSchedules() }),
          headers: { "content-type": "application/json" },
        },
      });
    }
    if (url.startsWith("/api/audit")) {
      return Response.json({ events: [] });
    }
    if (url === "/api/schedules" && method === "GET") {
      if (state.listViaJob) {
        return Response.json(
          { jobId: "job-list", status: "queued", statusUrl: "/api/jobs/job-list" },
          { status: 202 }
        );
      }
      return Response.json({ count: visibleSchedules().length, schedules: visibleSchedules() });
    }
    if (url === "/api/schedules/cancel" && method === "POST") {
      state.cancelledIds.add(body?.id);
      return Response.json({ scheduleId: body?.id, cancelled: true });
    }
    if (url === "/api/schedules/create" && method === "POST") {
      return Response.json({ success: true, schedule: { id: "sched-new-1", ...body } });
    }
    if (url === "/api/schedules/trigger-options-analysis" && method === "POST") {
      return Response.json({
        success: true,
        taskType: "options_analysis",
        data: {
          totalScanned: 4,
          withTrades: 2,
          symbols: ["NVDA", "AAPL"],
          summary: "stub analysis complete",
          notifications: { slack: true },
        },
      });
    }
    if (url === "/api/schedules/trigger-screen" && method === "POST") {
      return Response.json({ success: true, message: "Autonomous market screen triggered" });
    }
    if (url === "/api/schedules/trigger-renew" && method === "POST") {
      return Response.json({ success: true, message: "E*TRADE token renewal triggered" });
    }
    if (url === "/api/schedules/trigger-iv-collection" && method === "POST") {
      return Response.json({
        success: true,
        taskType: "options.iv_collection",
        data: {
          date: "2026-10-16",
          outcomes: [],
          recorded: 3,
          alreadyRecorded: 40,
          failed: 0,
          trackedCount: 43,
        },
      });
    }
    const byId = url.match(/^\/api\/schedules\/([^/?]+)$/);
    if (byId && method === "GET") {
      const found = state.schedules.find((s) => s?.id === decodeURIComponent(byId[1]));
      if (!found) return Response.json({ error: "schedule not found" }, { status: 404 });
      return Response.json(found);
    }
    return Response.json({ error: `unstubbed ${method} ${url}` }, { status: 500 });
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

function freshState(overrides: Partial<StubState> = {}): StubState {
  return {
    schedules: [...ALL_SCHEDULES],
    cancelledIds: new Set<string>(),
    listViaJob: false,
    ...overrides,
  };
}

function callsTo(calls: RecordedCall[], urlPart: string, method?: string) {
  return calls.filter(
    (c) => c.url.includes(urlPart) && (method === undefined || c.method === method)
  );
}

// DOM helpers ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 600)}`);
}

async function waitForNoText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}" to disappear.`);
}

async function renderManager() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ScheduledOptionsManager, { activeEnv: "TEST", userLogin: "trader1" })
    );
  });
  await flush(60);
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
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

function cardByTitle(titlePart: string): HTMLElement {
  const card = [...container.querySelectorAll(".schedule-item-card")].find((c) =>
    c.textContent?.includes(titlePart)
  );
  if (!card) throw new Error(`schedule card "${titlePart}" not found`);
  return card as HTMLElement;
}

function selectByOptionText(scope: ParentNode, optionText: string): HTMLSelectElement {
  const sel = [...scope.querySelectorAll("select")].find((s) =>
    [...s.options].some((o) => o.textContent?.includes(optionText))
  );
  if (!sel) throw new Error(`select with option "${optionText}" not found`);
  return sel as HTMLSelectElement;
}

function optionValueByText(sel: HTMLSelectElement, optionText: string): string {
  const opt = [...sel.options].find((o) => o.textContent?.includes(optionText));
  if (!opt) throw new Error(`option "${optionText}" not found`);
  return opt.value;
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush(60);
}

async function openCreateModal() {
  await click(buttonByText(container, "New Schedule"));
  const modal = container.querySelector(".sched-modal-card");
  if (!modal) throw new Error("create modal did not open");
  return modal as HTMLElement;
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

// Only account-owned stock and options screens are surfaced.
describe("ScheduledOptionsManager — stock/options schedules", () => {
  it("renders identical account and run metadata for both screen types", async () => {
    installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");
    const stockCard = cardByTitle("Stock Market Screen");
    const optionsCard = cardByTitle("Options Market Screen");
    for (const field of ["userLogin", "trader1", "environment", "TEST", "universe", "maxItems", "trigger", "scheduled"]) {
      expect(stockCard.textContent).toContain(field);
      expect(optionsCard.textContent).toContain(field);
    }
    expect(stockCard.textContent).toContain("LEV_ETF");
    expect(stockCard.textContent).toContain("29");
    expect(optionsCard.textContent).toContain("NASDAQ100");
    expect(Object.keys(SYSTEM_JOBS).sort()).toEqual(["autonomousMarketScreen", "autonomousOptionsAnalysis"].sort());
    expect(container.textContent).not.toContain("Token Renewal");
    expect(container.textContent).not.toContain("IV History Collection");
  });

  it("keeps edit and cancel controls on account-owned screening jobs", async () => {
    installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");
    for (const title of ["Stock Market Screen", "Options Market Screen"]) {
      const card = cardByTitle(title);
      expect([...card.querySelectorAll("button")].some((b) => b.textContent?.includes("Edit"))).toBe(true);
      expect([...card.querySelectorAll("button")].some((b) => b.textContent?.includes("Cancel"))).toBe(true);
    }
  });

  it("ignores legacy and malformed schedule rows", async () => {
    installFetch(freshState({ schedules: [screenSystem, userAnalysis, null, { id: 42 }, { callback: "autoRenewETradeTokens" }, { callback: "collectIvHistory" }] as any }));
    await renderManager();
    await waitForText("Stock Market Screen");
    expect(container.textContent).toContain("Options Market Screen");
    expect(container.textContent).not.toContain("Token Renewal");
    expect(container.textContent).toContain("2 Active");
  });
});

// Per-card triggers -----------------------------------------------------------

describe("ScheduledOptionsManager — per-card triggers", () => {
  it("maps every triggerable callback to its own route and no further", () => {
    expect(triggerRouteFor("autonomousOptionsAnalysis")).toBe("/api/schedules/trigger-options-analysis");
    expect(triggerRouteFor("autonomousMarketScreen")).toBe("/api/schedules/trigger-screen");
    expect(triggerRouteFor("autoRenewETradeTokens")).toBeUndefined();
    expect(triggerRouteFor("collectIvHistory")).toBeUndefined();
    expect(triggerRouteFor("sendScheduledReminder")).toBeUndefined();
    expect(triggerRouteFor("expireStaleOrderDraft")).toBeUndefined();
    expect(triggerRouteFor("executeAsyncJob")).toBeUndefined();
  });

  it("Trigger Now on the screen card calls trigger-screen with the card's payload", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    await click(buttonByText(cardByTitle("Stock Market Screen"), "Trigger Now"));

    const screenCalls = callsTo(calls, "/api/schedules/trigger-screen", "POST");
    expect(screenCalls).toHaveLength(1);
    expect(screenCalls[0].body).toMatchObject({ sector: "Technology", universe: "LEV_ETF", maxItems: 29 });
    expect(callsTo(calls, "/api/schedules/trigger-options-analysis", "POST")).toHaveLength(0);
  });

  it("Trigger Now on a user analysis card still runs options analysis with that card's payload", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Options Market Screen");

    await click(buttonByText(cardByTitle("Options Market Screen"), "Trigger Now"));

    const analysisCalls = callsTo(calls, "/api/schedules/trigger-options-analysis", "POST");
    expect(analysisCalls).toHaveLength(1);
    expect(analysisCalls[0].body.symbols).toEqual(["NVDA", "AAPL"]);
    await waitForText("Found 2 actionable setups");
  });

  it("shows no Trigger or Edit control on callbacks without a trigger route", async () => {
    installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");
    expect(container.textContent).not.toContain("sendScheduledReminder");
    expect(triggerRouteFor("sendScheduledReminder")).toBeUndefined();
  });
});

// Create form -----------------------------------------------------------------

describe("ScheduledOptionsManager — create form", () => {
  it("creates a stock screen schedule with the selected universe, maxItems, and scheduled trigger", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    const jobSelect = selectByOptionText(modal, "Autonomous Market Screen (Stocks)");
    setValue(jobSelect, optionValueByText(jobSelect, "Autonomous Market Screen (Stocks)"));
    const universe = selectByOptionText(modal, "Leveraged ETFs");
    setValue(universe, optionValueByText(universe, "Leveraged ETFs"));
    const maxItems = modal.querySelector('input[type="number"]') as HTMLInputElement;
    setValue(maxItems, "29");

    await submitForm(modal.querySelector("form")!);

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.callback).toBe("autonomousMarketScreen");
    expect(createCalls[0].body.payload).toMatchObject({ universe: "LEV_ETF", maxItems: 29, trigger: "scheduled", sector: "Technology" });
    expect(createCalls[0].body.scheduleType).toBe("interval");
    expect(createCalls[0].body.payload.userLogin).toBeUndefined(); // trusted identity is stamped server-side
  });

  it("posts a delayed create body with delayInSeconds and no cron/interval fields", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Options Market Screen");

    const modal = await openCreateModal();
    const cadence = selectByOptionText(modal, "Delayed (Once, After a Delay)");
    setValue(cadence, optionValueByText(cadence, "Delayed (Once, After a Delay)"));
    await flush(40);

    const delayInput = [...modal.querySelectorAll('input[type="number"]')].at(-1) as HTMLInputElement;
    expect(delayInput).not.toBeNull();
    setValue(delayInput, "7200");
    await flush(20);

    await submitForm(modal.querySelector("form")!);

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.callback).toBe("autonomousOptionsAnalysis");
    expect(createCalls[0].body.scheduleType).toBe("delayed");
    expect(createCalls[0].body.delayInSeconds).toBe(7200);
    expect(createCalls[0].body).not.toHaveProperty("cron");
    expect(createCalls[0].body).not.toHaveProperty("intervalSeconds");
  });

  it("posts a one-shot create body with an ISO date", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Options Market Screen");

    const modal = await openCreateModal();
    const cadence = selectByOptionText(modal, "One-Shot (Specific Date & Time)");
    setValue(cadence, optionValueByText(cadence, "One-Shot (Specific Date & Time)"));
    await flush(40);

    const dateInput = modal.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    expect(dateInput).not.toBeNull();
    setValue(dateInput, "2026-10-20T09:30");
    await flush(20);

    await submitForm(modal.querySelector("form")!);

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.scheduleType).toBe("scheduled");
    expect(createCalls[0].body.date).toBe(new Date("2026-10-20T09:30").toISOString());
    expect(createCalls[0].body).not.toHaveProperty("cron");
    expect(createCalls[0].body).not.toHaveProperty("intervalSeconds");
    expect(createCalls[0].body).not.toHaveProperty("delayInSeconds");
  });

  it("keeps the #107 cron presets: ET intents converted to UTC at pick time, with the DST disclosure", async () => {
    installFetch(freshState());
    await renderManager();
    await waitForText("Options Market Screen");

    const modal = await openCreateModal();
    const cadence = selectByOptionText(modal, "Cron Expression (Specific Time/Days)");
    setValue(cadence, optionValueByText(cadence, "Cron Expression (Specific Time/Days)"));
    await flush(40);

    await click(buttonByText(modal, "Market Open (9:30 AM ET M-F)"));
    const cronInput = modal.querySelector('input[placeholder*="30 9"]') as HTMLInputElement;
    expect(cronInput).not.toBeNull();
    expect(cronInput.value).toBe(etToUtcCron({ hour: 9, minute: 30, daysOfWeek: "1-5" }));
    expect(modal.textContent).toContain("converted to UTC when picked");
  });
});

// Detail view -----------------------------------------------------------------

describe("ScheduledOptionsManager — detail view", () => {
  it("fetches GET /api/schedules/:id on demand and renders type, next run, cron and payload", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const screenCard = cardByTitle("Stock Market Screen");
    // No by-id fetch happens until the user asks for details.
    expect(callsTo(calls, "/api/schedules/sys-market-screen", "GET")).toHaveLength(0);

    await click(buttonByText(screenCard, "Details"));
    await waitForText("Next run:");

    const detailCalls = callsTo(calls, "/api/schedules/sys-market-screen", "GET");
    expect(detailCalls).toHaveLength(1);
    expect(screenCard.textContent).toContain(new Date(NEXT_RUN_S * 1000).toLocaleString());
    expect(screenCard.textContent).toContain("0 14 * * 1-5");
    expect(screenCard.textContent).toContain("autonomousMarketScreen");
    expect(screenCard.textContent).toContain('"userLogin"');
    expect(screenCard.textContent).toContain("sys-market-screen");

    // Toggling again collapses the panel without another fetch.
    await click(buttonByText(screenCard, "Hide Details"));
    expect(screenCard.textContent).not.toContain("Next run:");
    expect(callsTo(calls, "/api/schedules/sys-market-screen", "GET")).toHaveLength(1);
  });
});

// Transport contract ----------------------------------------------------------

describe("ScheduledOptionsManager — transport (issue #71 contract)", () => {
  it("renders the schedule list delivered through the worker's 202 async-job stub", async () => {
    installFetch(freshState({ listViaJob: true }));
    await renderManager();
    await waitForText("Stock Market Screen");
    expect(container.textContent).toContain("Options Market Screen");
    expect(container.textContent).toContain("2 Active");
  });
});
