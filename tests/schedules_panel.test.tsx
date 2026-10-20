/**
 * Issue #273 — SchedulesPanel management UI: paused status + resume,
 * the inline frequency editor presets, and the create form fed by the
 * server's callback allow-list.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { SchedulesPanel } from "../src/client/SchedulesPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const LIST_RESPONSE = {
  count: 2,
  creatableCallbacks: ["autonomousMarketScreen", "autonomousOptionsAnalysis", "autonomousStrategyDiscovery"],
  schedules: [
    {
      id: "job-interval-1",
      type: "interval",
      callback: "autonomousOptionsAnalysis",
      payload: { symbols: ["AAPL"], userLogin: "venus", environment: "PROD" },
      intervalSeconds: 3600,
      time: 1999999999,
    },
    {
      id: "job-cron-2",
      type: "cron",
      callback: "autonomousMarketScreen",
      payload: { universe: "SP500", userLogin: "venus" },
      cron: "5 * * * *",
      paused: true,
    },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => {
    root.render(<SchedulesPanel userLogin="venus" activeEnv="PROD" />);
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
    expect(text).toContain("autonomousOptionsAnalysis");
    expect(text).toContain("autonomousMarketScreen");
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
    const options = [...container.querySelectorAll("option")].map((o) => o.getAttribute("value"));
    expect(options).toContain("autonomousMarketScreen");
    expect(options).toContain("autonomousStrategyDiscovery");
  });
});
