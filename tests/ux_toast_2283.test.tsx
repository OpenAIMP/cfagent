/** @vitest-environment jsdom */
/**
 * Global Toast primitive (#2283, epic #2150 slice 5): the one familiar
 * place for transient success/failure feedback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastProvider, useToast } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function FireButtons() {
  const toast = useToast();
  return (
    <div>
      <button type="button" onClick={() => toast.success("Saved")}>
        ok
      </button>
      <button type="button" onClick={() => toast.info("Loaded")}>
        info
      </button>
      <button type="button" onClick={() => toast.warning("Heads up")}>
        warn
      </button>
      <button type="button" onClick={() => toast.danger("Failed")}>
        fail
      </button>
      <button type="button" onClick={() => toast.success("Same")}>
        same
      </button>
    </div>
  );
}

function renderToast() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <ToastProvider>
        <FireButtons />
      </ToastProvider>,
    );
  });
}

function click(label: string) {
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === label);
  if (!btn) throw new Error(`button "${label}" not found`);
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function toasts() {
  return Array.from(document.querySelectorAll(".ui-toast"));
}

beforeEach(() => {
  vi.useFakeTimers();
  renderToast();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Toast primitive (#2283)", () => {
  it("announces success as status and danger as alert", () => {
    click("ok");
    click("fail");
    const items = toasts();
    expect(items).toHaveLength(2);
    expect(items.find((t) => t.textContent?.includes("Saved"))?.getAttribute("role")).toBe("status");
    expect(items.find((t) => t.textContent?.includes("Failed"))?.getAttribute("role")).toBe("alert");
  });

  it("auto-dismisses success after 5s", () => {
    click("ok");
    expect(toasts()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(toasts()).toHaveLength(0);
  });

  it("keeps danger visible past the success duration", () => {
    click("fail");
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(toasts()).toHaveLength(1);
  });

  it("dismiss button removes the toast", () => {
    click("ok");
    const dismiss = document.querySelector(".ui-toast-dismiss") as HTMLButtonElement;
    act(() => {
      dismiss.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toasts()).toHaveLength(0);
  });

  it("dedupes identical toasts instead of stacking them", () => {
    click("same");
    click("same");
    expect(toasts()).toHaveLength(1);
  });

  it("caps visible toasts at 4, newest first", () => {
    click("ok");
    click("info");
    click("warn");
    click("fail");
    click("same");
    const items = toasts();
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain("Same");
    expect(document.body.textContent).not.toContain("Saved");
  });

  it("throws when useToast is used outside the provider", () => {
    const NoProvider = () => {
      useToast();
      return null;
    };
    const holder = document.createElement("div");
    document.body.appendChild(holder);
    const r = createRoot(holder);
    expect(() => {
      act(() => {
        r.render(<NoProvider />);
      });
    }).toThrow("useToast must be used within ToastProvider");
    act(() => {
      r.unmount();
    });
    holder.remove();
  });
});
