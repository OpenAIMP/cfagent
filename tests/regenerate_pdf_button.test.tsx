/** @vitest-environment jsdom */
/**
 * Issue #1325: a Regenerate action on failed-PDF runs in Reports (and
 * ScreenersHub, which embeds ReportsPanel) calls the shipped R5
 * endpoint POST /screener/report/regenerate and refreshes the run in
 * place. The endpoint heals LATEST + its HISTORY entry; the parent
 * list refresh (onRegenerated) is what surfaces the healed PDF and
 * clears pdfError.
 *
 * Pins:
 *  - clicking Regenerate POSTs to the regenerate endpoint, and on
 *    success the parent refresh callback fires (healed run surfaces)
 *  - a failed regeneration surfaces the new coded error, and the
 *    refresh callback does NOT fire
 *  - 404 (no stored run) surfaces a business message, not a crash
 *  - the button is disabled while the regeneration is in flight
 *  - ReportsPanel wires the button into the failed-PDF row (source pin)
 *
 * Harness follows tests/pdf_report_link_honesty.test.tsx: react-dom/client
 * in jsdom, direct component renders.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { RegeneratePdfButton } from "../src/client/RegeneratePdfButton";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await flush();
}

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockRegenerate(status: number, body: unknown) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    calls.push({ url: String(input), method: init?.method || "GET" });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function regenerateButton(): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Regenerate"
  ) as HTMLButtonElement | null;
}

describe("Issue #1325 — RegeneratePdfButton", () => {
  it("success calls the endpoint and fires the parent refresh", async () => {
    const { calls } = mockRegenerate(200, {
      pdfStatus: "generated",
      pdfKey: "screener:pdf:abc",
      timestamp: "2026-10-25T12:00:00.000Z",
      reportUrl: "/api/screener/report.pdf?key=screener%3Apdf%3Aabc",
    });
    const onRegenerated = vi.fn();
    await render(<RegeneratePdfButton onRegenerated={onRegenerated} />);
    const button = regenerateButton();
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/screener/report/regenerate");
    expect(calls[0].method).toBe("POST");
    expect(onRegenerated).toHaveBeenCalledTimes(1);
    expect(container.textContent || "").not.toContain("No stored run");
  });

  it("failed regeneration surfaces the coded error and does not refresh", async () => {
    mockRegenerate(502, {
      pdfStatus: "failed",
      pdfError: "FAILURE_REPORT_XLSX_GENERATION: PDF generation failed for the stored run",
      timestamp: "2026-10-25T12:00:00.000Z",
    });
    const onRegenerated = vi.fn();
    await render(<RegeneratePdfButton onRegenerated={onRegenerated} />);
    await act(async () => {
      regenerateButton()!.click();
    });
    await flush();
    expect(container.textContent || "").toContain("FAILURE_REPORT_XLSX_GENERATION");
    expect(onRegenerated).not.toHaveBeenCalled();
  });

  it("404 surfaces a business message, not a crash", async () => {
    mockRegenerate(404, { error: "FAILURE_REPORT_ARTIFACT_MISSING: no stored screener run to regenerate" });
    const onRegenerated = vi.fn();
    await render(<RegeneratePdfButton onRegenerated={onRegenerated} />);
    await act(async () => {
      regenerateButton()!.click();
    });
    await flush();
    expect(container.textContent || "").toContain("No stored run to regenerate.");
    expect(onRegenerated).not.toHaveBeenCalled();
  });

  it("the button is disabled while regeneration is in flight", async () => {
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending as any)
    );
    const onRegenerated = vi.fn();
    await render(<RegeneratePdfButton onRegenerated={onRegenerated} />);
    await act(async () => {
      regenerateButton()!.click();
    });
    expect(regenerateButton()!.disabled).toBe(true);
    await act(async () => {
      resolveFetch({ ok: true, status: 200, json: async () => ({ pdfStatus: "generated" }) });
    });
    await flush();
    expect(onRegenerated).toHaveBeenCalledTimes(1);
  });

  it("ReportsPanel wires the button into the failed-PDF row (source pin)", () => {
    const panel = readFileSync("src/client/ReportsPanel.tsx", "utf8");
    expect(panel).toContain("RegeneratePdfButton");
    expect(panel).toContain("pdfStatus");
  });
});
