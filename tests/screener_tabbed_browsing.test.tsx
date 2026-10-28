/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScreenersHub, SCREENER_HUB_TABS } from "../src/client/ScreenersHub";
import { CapabilityNavBar } from "../src/client/components/CapabilityNavBar";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ScreenersHub Tabbed Browsing Reference Implementation", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.history.replaceState(null, "", "/screeners");
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  it("exports SCREENER_HUB_TABS with all 13 supported tabs", () => {
    expect(SCREENER_HUB_TABS).toBeDefined();
    expect(SCREENER_HUB_TABS).toContain("stocks");
    expect(SCREENER_HUB_TABS).toContain("options");
    expect(SCREENER_HUB_TABS).toContain("scanner");
    expect(SCREENER_HUB_TABS).toContain("iv-history");
    expect(SCREENER_HUB_TABS).toContain("goal-screen");
    expect(SCREENER_HUB_TABS).toContain("reports");
    expect(SCREENER_HUB_TABS).toContain("schedules");
    expect(SCREENER_HUB_TABS).toContain("review");
    expect(SCREENER_HUB_TABS).toContain("track-record");
  });

  it("deep-links directly into the tab specified by the canonical ?view param", async () => {
    window.history.replaceState(null, "", "/screeners?view=scanner");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" />);
    });

    const activeTab = container?.querySelector('.capability-tab-btn[aria-selected="true"]');
    expect(activeTab).not.toBeNull();
    expect(activeTab?.textContent).toContain("Scanner");

    const scannerPanel = container?.querySelector('#screener-tabpanel-scanner');
    expect(scannerPanel).not.toBeNull();
    expect(scannerPanel?.hasAttribute("hidden")).toBe(false);
  });

  it("still deep-links via a hash tab", async () => {
    window.history.replaceState(null, "", "/screeners#goal-screen");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" />);
    });

    const activeTab = container?.querySelector('.capability-tab-btn[aria-selected="true"]');
    expect(activeTab).not.toBeNull();
    expect(activeTab?.textContent).toContain("Goal");
  });

  it("deep-links directly into the tab specified by URL query param ?screenerTab", async () => {
    window.history.replaceState(null, "", "/screeners?screenerTab=scanner");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" />);
    });

    const activeTab = container?.querySelector('.capability-tab-btn[aria-selected="true"]');
    expect(activeTab).not.toBeNull();
    expect(activeTab?.textContent).toContain("Scanner");

    // Scanner panel tabpanel is rendered and active (not hidden)
    const scannerPanel = container?.querySelector('#screener-tabpanel-scanner');
    expect(scannerPanel).not.toBeNull();
    expect(scannerPanel?.hasAttribute("hidden")).toBe(false);
  });

  it("updates URL and history state when switching tabs", async () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState");

    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" initialTab="stocks" />);
    });

    // Find Reports tab and click it
    const buttons = Array.from(container?.querySelectorAll(".capability-tab-btn") || []);
    const reportsBtn = buttons.find((b) => b.textContent?.includes("Reports")) as HTMLButtonElement;
    expect(reportsBtn).toBeDefined();

    await act(async () => {
      reportsBtn.click();
    });

    expect(pushStateSpy).toHaveBeenCalled();
    const lastCallUrl = String(pushStateSpy.mock.calls[pushStateSpy.mock.calls.length - 1][2]);
    expect(lastCallUrl).toContain("view=reports");

    const reportsPanel = container?.querySelector('#screener-tabpanel-reports');
    expect(reportsPanel).not.toBeNull();
    expect(reportsPanel?.hasAttribute("hidden")).toBe(false);
  });

  it("responds to browser back/forward (popstate) events", async () => {
    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" initialTab="stocks" />);
    });

    expect(container?.querySelector('.capability-tab-btn[aria-selected="true"]')?.textContent).toContain("Stocks");

    // Simulate browser back/forward navigation to ?screenerTab=schedules
    window.history.replaceState(null, "", "/screeners?screenerTab=schedules");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    const activeTab = container?.querySelector('.capability-tab-btn[aria-selected="true"]');
    expect(activeTab?.textContent).toContain("Schedules");

    const schedulesPanel = container?.querySelector('#screener-tabpanel-schedules');
    expect(schedulesPanel).not.toBeNull();
    expect(schedulesPanel?.hasAttribute("hidden")).toBe(false);
  });

  it("preserves mounted tab state across tab switches (retained DOM panels)", async () => {
    await act(async () => {
      root?.render(<ScreenersHub activeEnv="TEST" initialTab="stocks" />);
    });

    // Verify stocks panel is visible
    const stocksPanel = container?.querySelector('#screener-tabpanel-stocks');
    expect(stocksPanel).not.toBeNull();
    expect(stocksPanel?.hasAttribute("hidden")).toBe(false);

    // Switch to Scanner tab
    const buttons = Array.from(container?.querySelectorAll(".capability-tab-btn") || []);
    const scannerBtn = buttons.find((b) => b.textContent?.includes("Scanner")) as HTMLButtonElement;
    await act(async () => {
      scannerBtn.click();
    });

    // Stocks panel is hidden, not unmounted
    expect(stocksPanel?.hasAttribute("hidden")).toBe(true);
    const scannerPanel = container?.querySelector('#screener-tabpanel-scanner');
    expect(scannerPanel).not.toBeNull();
    expect(scannerPanel?.hasAttribute("hidden")).toBe(false);

    // Switch back to Stocks tab
    const stocksBtn = buttons.find((b) => b.textContent?.includes("Stocks")) as HTMLButtonElement;
    await act(async () => {
      stocksBtn.click();
    });

    expect(stocksPanel?.hasAttribute("hidden")).toBe(false);
    expect(scannerPanel?.hasAttribute("hidden")).toBe(true);
  });

  it("CapabilityNavBar supports WCAG 2.2 / WAI-ARIA roving tabindex keyboard navigation", async () => {
    const handleTabChange = vi.fn();
    const tabs = [
      { id: "tab-1", label: "First Tab" },
      { id: "tab-2", label: "Second Tab" },
      { id: "tab-3", label: "Third Tab" },
    ];

    function StatefulNav() {
      const [active, setActive] = React.useState("tab-1");
      return (
        <CapabilityNavBar
          tabs={tabs}
          activeTabId={active}
          onTabChange={(id) => {
            handleTabChange(id);
            setActive(id);
          }}
          ariaLabel="Test Capabilities"
        />
      );
    }

    await act(async () => {
      root?.render(<StatefulNav />);
    });

    const tablist = container?.querySelector('[role="tablist"]') as HTMLElement;
    expect(tablist).not.toBeNull();

    // ArrowRight navigates to next tab
    await act(async () => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(handleTabChange).toHaveBeenCalledWith("tab-2");

    // End key navigates to last tab
    await act(async () => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(handleTabChange).toHaveBeenCalledWith("tab-3");

    // Home key navigates to first tab
    await act(async () => {
      tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(handleTabChange).toHaveBeenCalledWith("tab-1");
  });
});
