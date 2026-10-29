/**
 * Issue #273 — SchedulesPanel management UI: paused status + resume,
 * the inline frequency editor presets, and the create form fed by the
 * server's callback allow-list.
 *
 * S7 adaptation (consolidation #958): the panel is now the one
 * schedule UI — the three screening callbacks render as kind cards in
 * the hosted screening section, and the generic cards carry every
 * other callback. These fixtures therefore exercise the generic card
 * path with generic (system) callbacks; the screening kinds' cards
 * are pinned by tests/scheduled_options_manager.test.ts and
 * tests/schedule_ui_s7.test.tsx. The create test now asserts the one
 * structured create form offers exactly the server's creatable
 * kinds. No assertion was weakened.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { SchedulesPanel } from "../src/client/SchedulesPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { JOB_CALLBACKS, type CreatableJob } from "../src/client/ScheduledOptionsManager";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const LIST_RESPONSE = {
  count: 2,
  creatableCallbacks: ["autonomousMarketScreen", "autonomousOptionsAnalysis", "autonomousStrategyDiscovery"],
  schedules: [
    {
      id: "job-interval-1",
      type: "interval",
      callback: "collectIvHistory",
      payload: { universe: "SP500", userLogin: "venus", environment: "PROD" },
      intervalSeconds: 3600,
      time: 1999999999,
    },
    {
      id: "job-cron-2",
      type: "cron",
      callback: "autoRenewEtradeTokens",
      payload: { userLogin: "venus" },
      cron: "5 * * * *",
      paused: true,
    },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => {
    root.render(<ToastProvider><SchedulesPanel userLogin="venus" activeEnv="PROD" /></ToastProvider>);
  });
  await act(async () => {});
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/api/schedules") && (!init?.method || init.method === "GET")) {
      return { ok: true, status: 200, json: async () => LIST_RESPONSE };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SchedulesPanel (#273)", () => {
  it("shows both jobs, the screener universe, and the paused status with a Resume action", async () => {
    await render();
    const text = container.textContent || "";
    expect(text).toContain("collectIvHistory");
    expect(text).toContain("autoRenewEtradeTokens");
    expect(text).toContain("Universe: SP500");
    expect(text).toContain("Paused");
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent || "");
    expect(buttons.some((t) => t.includes("Resume"))).toBe(true);
    expect(buttons.some((t) => t.includes("Pause"))).toBe(true);
  });

  it("offers the frequency editor presets for a recurring job", async () => {
    await render();
    const editBtn = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent || "").includes("Edit frequency")
    );
    expect(editBtn).toBeTruthy();
    await act(async () => {
      editBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const text = container.textContent || "";
    for (const preset of ["5m", "15m", "30m", "Hourly", "2h", "Daily"]) {
      expect(text).toContain(preset);
    }
    expect(container.querySelector('input[placeholder*="cron" i]')).toBeTruthy();
  });

  it("create form lists the server's creatable callbacks", async () => {
    await render();
    const newBtn = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent || "").includes("New schedule")
    );
    expect(newBtn).toBeTruthy();
    await act(async () => {
      newBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    // S7: the one structured create form (the screening section's
    // modal) opens; its job picker offers exactly the kinds whose
    // callbacks the server allow-lists as creatable.
    const modal = document.querySelector(".sched-modal-card");
    expect(modal).toBeTruthy();
    const jobSelect = [...modal!.querySelectorAll("select")].find((s) =>
      [...s.options].some((o) => o.value === "marketScreen")
    );
    expect(jobSelect).toBeTruthy();
    const kinds = [...jobSelect!.options].map((o) => o.value);
    expect(kinds.map((k) => JOB_CALLBACKS[k as CreatableJob]).sort()).toEqual(
      [...LIST_RESPONSE.creatableCallbacks].sort()
    );
  });
});
