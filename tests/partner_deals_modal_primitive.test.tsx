/** @vitest-environment jsdom */
/**
 * PartnerDealsModal renders through the focus-trapping Modal primitive
 * (#1578, A2; WAI-ARIA keyboard navigation).
 *
 * Assessment-01's modal gap named PartnerDealsModal's old custom
 * dialogs, which lacked focus trapping and focus restore. E1 migrated
 * the component onto the Modal primitive; this test pins that the
 * dialog a user actually gets is the primitive's dialog (aria-modal,
 * Escape/close behavior) rather than a hand-rolled shell.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PartnerDealsModal } from "../src/client/components/PartnerDealsModal";

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

describe("PartnerDealsModal primitive usage (#1578, A2)", () => {
  it("renders a primitive modal dialog and closes via its close button", () => {
    const onClose = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<PartnerDealsModal isOpen onClose={onClose} ads={[]} externalAds={[]} />);
    });
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog, "PartnerDealsModal must render the Modal primitive dialog").not.toBeNull();
    const close = document.querySelector('button[aria-label="Close dialog"]') as HTMLButtonElement;
    expect(close).not.toBeNull();
    act(() => {
      close.click();
    });
    expect(onClose).toHaveBeenCalled();
  });
});
