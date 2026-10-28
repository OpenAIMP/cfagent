/** @vitest-environment jsdom */
/**
 * Issue #2049: PaymentWorkflow assurance page renders and its
 * one-click suite passes in the browser (jsdom) — the same 9
 * presets the node runner test pins, exercised through the UI.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PaymentWorkflowAssurance } from "../src/client/PaymentWorkflowAssurance";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 50) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
});

describe("PaymentWorkflow assurance page (jsdom)", () => {
  it("renders the test-only warning and the 9-preset suite passes", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<PaymentWorkflowAssurance />);
    });
    await flush();
    expect(container.textContent).toContain("Test only");
    expect(container.textContent).toContain("Run all 9 preset tests");
    const runAll = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Run all 9 preset tests"),
    );
    expect(runAll).toBeDefined();
    await act(async () => {
      runAll!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("9/9 passing");
    expect(container.textContent).toContain("Tenant mismatch fails closed");
  });
});
