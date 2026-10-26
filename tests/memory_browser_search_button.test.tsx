/** @vitest-environment jsdom */
/**
 * MemoryBrowser Search button is a primitive Button (#1578, A2;
 * WCAG 2.2 AA 2.5.8 target size).
 *
 * Assessment-01 found MemoryBrowser's interactive controls measuring
 * under 24px. Its Search button was a bare <button> with no sizing
 * class; converting it to the Button primitive puts it on the
 * primitive's 38px medium floor (pinned in ux_target_size.test.ts).
 * This test pins the conversion itself.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryBrowser } from "../src/client/MemoryBrowser";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

describe("MemoryBrowser Search button (#1578, A2)", () => {
  it("renders Search as a primitive Button", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<MemoryBrowser />);
    });
    const buttons = [...document.querySelectorAll("button")];
    const search = buttons.find((b) => b.textContent === "Search");
    expect(search, "Search button must render").toBeDefined();
    expect(search!.className).toContain("ui-btn");
  });
});
