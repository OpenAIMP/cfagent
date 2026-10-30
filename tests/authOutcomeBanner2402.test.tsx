/** @vitest-environment jsdom */
/**
 * Issue #2402: the app boot shows a one-time success confirmation via
 * the shared Toast primitive (the one global place for transient
 * success/failure feedback). BootToast fires exactly once per mount
 * (a ref guard, so StrictMode's double effect in dev never double
 * toasts) and renders no visible content of its own.
 *
 * Harness follows tests/etradeDisconnect2386.test.tsx: react-dom in
 * jsdom, toast observed in the document body.
 */
import { describe, expect, it, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { BootToast } from "../src/client/BootToast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 40) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ToastProvider>{node}</ToastProvider>);
  });
  await flush();
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
});

function countOccurrences(text: string): number {
  return document.body.textContent?.split(text).length ?? 0;
}

describe("BootToast", () => {
  it("shows the success message once and renders nothing itself", async () => {
    await render(<BootToast message="Signed in as Ada" />);
    expect(document.body.textContent).toContain("Signed in as Ada");
    expect(container.textContent ?? "").not.toContain("Signed in as Ada");
  });

  it("fires exactly once under StrictMode double effects", async () => {
    await render(
      <React.StrictMode>
        <BootToast message="Signed in as Ada" />
      </React.StrictMode>
    );
    expect(countOccurrences("Signed in as Ada") - 1).toBe(1);
  });

  it("shows nothing when there is no message", async () => {
    await render(<BootToast message={null} />);
    expect(document.body.textContent ?? "").not.toContain("Signed in");
  });
});
