/** @vitest-environment jsdom */
/**
 * TabPanel retain mode (#1804 S2, issue #2027): a retained panel stays
 * mounted-hidden so in-flight and finished work survives tab switches —
 * the ScreenersHub #1379 pattern, generalized to the Tabs primitive.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TabPanel } from "../src/client/components/ui/Tabs";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("TabPanel retain mode", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    if (container && container.parentNode) container.parentNode.removeChild(container);
    root = null;
    container = null;
  });

  it("renders nothing when inactive without retain", () => {
    act(() => {
      root?.render(
        React.createElement(TabPanel, { idBase: "probe", tabId: "a", active: false }, "kept work"),
      );
    });
    expect(container?.textContent).not.toContain("kept work");
  });

  it("keeps inactive content mounted-hidden with retain", () => {
    act(() => {
      root?.render(
        React.createElement(
          TabPanel,
          { idBase: "probe", tabId: "a", active: false, retain: true },
          "kept work",
        ),
      );
    });
    expect(container?.textContent).toContain("kept work");
    const panel = container?.querySelector('[role="tabpanel"]') as HTMLElement | null;
    expect(panel).not.toBeNull();
    expect(panel?.hidden).toBe(true);
    expect(panel?.style.display).toBe("none");
  });
});
