/** @vitest-environment jsdom */
/**
 * Issue #2219 (program #2218, slice 1) — CheckoutPanel renders the
 * resolved identity read-only: tenant, user, and account tier
 * from the self-only identity endpoint, with no tenant input in
 * either tab. While identity loads the panel shows a neutral
 * loading line; on resolution failure it shows the failure
 * message — never an input fallback.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CheckoutPanel } from "../src/client/CheckoutPanel";

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
  vi.unstubAllGlobals();
});

function stubApi(opts: { identityOk: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const okJson = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
      if (url.endsWith("/api/features")) return okJson({ features: { monetization: false } });
      if (url.includes("/commercial/pricing")) {
        return okJson({
          monetizationEnabled: false,
          prices: { stock: 1, goal: 2, options: 3, strategy: 4 },
          // #2198/#2233 pricing shape: the panel reads the network marker.
          network: { stripeMode: "sandbox", x402Network: null, acceptsMainnet: false },
          browserPaymentScope: "card-only",
          failurePolicy: "Failure policy.",
        });
      }
      if (url.includes("/commercial/identity")) {
        return opts.identityOk
          ? okJson({
              userLogin: "u1",
              tenantId: "t9",
              hasAccount: true,
              tier: "PayPerUse",
              creditsUSD: 5,
              includedRunsRemaining: 2,
            })
          : { ok: false, status: 503, json: async () => ({ error: "store down" }) };
      }
      if (url.includes("/commercial/subscription")) {
        return okJson({ userId: "u1", effectiveTier: "PayPerUse", current: null, subscriptions: [] });
      }
      if (url.includes("/commercial/plans")) return okJson({ plans: [] });
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<CheckoutPanel userLogin="u1" />);
  });
  await flush();
}

describe("CheckoutPanel read-only identity (#2219)", () => {
  it("displays tenant, user, and tier with no tenant input", async () => {
    stubApi({ identityOk: true });
    await renderPanel();
    expect(container.textContent).toContain("u1");
    expect(container.textContent).toContain("t9");
    expect(container.textContent).toContain("PayPerUse");
    expect(container.textContent).not.toContain("Tenant id");
    expect(container.textContent).not.toContain("Enter your tenant id");
    // Pay tab inputs are symbols + checkout email only; no tenant field exists to fill.
    const textInputs = Array.from(container.querySelectorAll("input")).filter(
      (el) => (el as HTMLInputElement).type === "text",
    );
    expect(textInputs).toHaveLength(2);
    expect(textInputs.some((el) => (el as HTMLInputElement).value === "t9")).toBe(false);
    expect(container.textContent).toContain("Run for free");
  });

  it("on identity resolution failure shows the failure message, never an input fallback", async () => {
    stubApi({ identityOk: false });
    await renderPanel();
    expect(container.textContent).toContain("temporarily unavailable");
    expect(container.textContent).not.toContain("Tenant id");
    const textInputs = Array.from(container.querySelectorAll("input")).filter(
      (el) => (el as HTMLInputElement).type === "text",
    );
    expect(textInputs).toHaveLength(2);
  });
});
