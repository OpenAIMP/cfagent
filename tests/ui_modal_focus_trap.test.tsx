/** @vitest-environment jsdom */
/**
 * Modal focus behavior (#1578, A2; WAI-ARIA keyboard navigation).
 *
 * The Modal primitive promises: portal to body, Escape to close,
 * initial focus inside the dialog, Tab kept inside (focus trap), and
 * focus restored to the opener on close. Assessment-01's modal gap
 * (PartnerDealsModal's old custom dialogs) was closed by adopting
 * this primitive in E1 — these tests pin the primitive's behavior
 * itself, so the gap cannot silently reopen.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Modal } from "../src/client/components/ui/Modal";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderHarness(onClose: () => void) {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" id="opener" onClick={() => setOpen(true)}>
          Open dialog
        </button>
        <Modal
          open={open}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
          title="Test dialog"
        >
          <button type="button" id="first-action">
            First action
          </button>
          <button type="button" id="second-action">
            Second action
          </button>
        </Modal>
      </>
    );
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness />);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function dialog(): HTMLElement {
  const el = document.querySelector('[role="dialog"]') as HTMLElement | null;
  expect(el, "dialog must be rendered").not.toBeNull();
  return el!;
}

function keyOnDialog(key: string, shift = false) {
  const event = new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true });
  act(() => {
    dialog().dispatchEvent(event);
  });
}

describe("Modal focus trap (#1578, A2)", () => {
  it("moves focus inside the dialog on open and keeps Tab inside", () => {
    const onClose = vi.fn();
    renderHarness(onClose);
    const opener = document.getElementById("opener") as HTMLButtonElement;
    act(() => {
      opener.focus();
      opener.click();
    });
    // Initial focus lands inside the dialog (panel itself in jsdom,
    // where layout-based focusable filtering yields no items).
    expect(dialog().contains(document.activeElement)).toBe(true);
    // Tab must not escape the dialog.
    keyOnDialog("Tab");
    expect(dialog().contains(document.activeElement)).toBe(true);
    keyOnDialog("Tab", true);
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and restores focus to the opener", () => {
    const onClose = vi.fn();
    renderHarness(onClose);
    const opener = document.getElementById("opener") as HTMLButtonElement;
    act(() => {
      opener.focus();
      opener.click();
    });
    expect(dialog().contains(document.activeElement)).toBe(true);
    keyOnDialog("Escape");
    expect(onClose).toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
