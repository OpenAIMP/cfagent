/** @vitest-environment jsdom */

/**
 * Issue #2471 (program #2468, Phase 1) — first-run screen + preferences
 * panel, rendered for real (react-dom, not source-text assertions).
 *
 * The firstRunApi module is mocked at the network boundary only (the
 * checkout-panel precedent): the screen's own logic — steps, read-only
 * identity display, preferences save, completion — runs for real, and
 * the completion store functions are the real ones (importActual).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const apiState = vi.hoisted(() => ({
  identity: null as null | {
    userLogin: string;
    tenantId: string | null;
    hasAccount: boolean;
    tier: string;
    creditsUSD: number;
    includedRunsRemaining: number;
  },
  identityError: null as null | Error,
  preferences: { userId: "second-user", tenantId: "tenant-1", digestEnabled: false, welcomeEnabled: true, updatedAtMs: 1 },
  savedBody: null as null | Record<string, unknown>,
}));

vi.mock("../src/client/firstRunApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/firstRunApi")>();
  return {
    ...actual,
    fetchPlatformIdentity: vi.fn(async () => {
      if (apiState.identityError) throw apiState.identityError;
      if (!apiState.identity) throw new Error("no mocked identity");
      return apiState.identity;
    }),
    fetchNotificationPreferences: vi.fn(async () => apiState.preferences),
    saveNotificationPreferences: vi.fn(async (input: Record<string, unknown>) => {
      apiState.savedBody = input;
      return { ...apiState.preferences, digestEnabled: input.digestEnabled as boolean, welcomeEnabled: input.welcomeEnabled as boolean };
    }),
  };
});

import { FirstRunScreen } from "../src/client/FirstRunScreen";
import { NotificationPreferencesPanel } from "../src/client/NotificationPreferencesPanel";
import { isFirstRunComplete } from "../src/client/firstRunApi";

const flush = async (times = 5) => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

async function renderScreen(props: { userLogin: string; onComplete?: () => void }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let completed = 0;
  await act(async () => {
    root.render(
      <FirstRunScreen
        userLogin={props.userLogin}
        onComplete={() => {
          completed += 1;
          props.onComplete?.();
        }}
      />,
    );
  });
  await flush();
  return { container, root, completed: () => completed };
}

function click(container: HTMLElement, text: string) {
  const el = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
  if (!el) throw new Error(`no button containing ${JSON.stringify(text)}; buttons: ${[...container.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`);
  act(() => {
    el.click();
  });
}

function clickLabel(container: HTMLElement, text: string) {
  const label = [...container.querySelectorAll("label")].find((l) => (l.textContent ?? "").includes(text));
  if (!label) throw new Error(`no label containing ${JSON.stringify(text)}`);
  // Wrapper label (input inside) or FieldShell label (htmlFor sibling).
  const input =
    label.querySelector("input") ??
    (label.htmlFor ? container.querySelector(`#${label.htmlFor}`) : null);
  if (!(input instanceof HTMLInputElement)) throw new Error(`label ${JSON.stringify(text)} has no input`);
  act(() => {
    input.click();
  });
}

beforeEach(() => {
  apiState.identity = {
    userLogin: "second-user",
    tenantId: "tenant-1",
    hasAccount: true,
    tier: "Free",
    creditsUSD: 0,
    includedRunsRemaining: 3,
  };
  apiState.identityError = null;
  apiState.preferences = { userId: "second-user", tenantId: "tenant-1", digestEnabled: false, welcomeEnabled: true, updatedAtMs: 1 };
  apiState.savedBody = null;
});

afterEach(async () => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("FirstRunScreen (#2471)", () => {
  it("shows identity + tier read-only on step 1, with no tier/tenant input", async () => {
    const { container, root } = await renderScreen({ userLogin: "screen-user-1" });
    try {
      const text = container.textContent ?? "";
      expect(text).toContain("second-user");
      expect(text).toContain("Free");
      // Read-only means read-only: step 1 renders no form inputs at all.
      expect(container.querySelectorAll("input").length).toBe(0);
      expect(container.querySelectorAll("select").length).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("walks account -> E*TRADE guidance -> preferences -> completion, saves, and marks complete", async () => {
    const { container, root, completed } = await renderScreen({ userLogin: "screen-user-2" });
    try {
      // Step 1 -> step 2.
      click(container, "Continue");
      await flush();
      expect(container.textContent ?? "").toContain("Settings");
      expect(container.textContent ?? "").toContain("E*TRADE");

      // Step 2's guidance button reuses the existing Settings menu event.
      const opened: Event[] = [];
      const listener = (e: Event) => opened.push(e);
      window.addEventListener("open-settings-menu", listener);
      try {
        click(container, "Open Settings");
      } finally {
        window.removeEventListener("open-settings-menu", listener);
      }
      expect(opened.length).toBe(1);

      // Step 2 -> step 3: preferences reflect the existing route's values.
      click(container, "Continue");
      await flush();
      const digest = container.querySelector('input[name="digestEnabled"]') as HTMLInputElement | null;
      const welcome = container.querySelector('input[name="welcomeEnabled"]') as HTMLInputElement | null;
      expect(digest).not.toBeNull();
      expect(welcome).not.toBeNull();
      expect(digest!.checked).toBe(false);
      expect(welcome!.checked).toBe(true);

      // Toggle digest on, save, and finish.
      clickLabel(container, "Digest");
      click(container, "Save");
      await flush();
      expect(apiState.savedBody).toEqual({
        userId: "second-user",
        tenantId: "tenant-1",
        digestEnabled: true,
        welcomeEnabled: true,
      });
      expect(container.textContent ?? "").toContain("You are all set");
      click(container, "Finish");
      expect(completed()).toBe(1);
      expect(isFirstRunComplete("screen-user-2")).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("shows an error, not a silent skip, when identity cannot load", async () => {
    apiState.identityError = new Error("identity unavailable");
    const { container, root } = await renderScreen({ userLogin: "screen-user-3" });
    try {
      expect(container.textContent ?? "").toContain("couldn");
      expect(container.querySelectorAll("input").length).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("with no account tenant, explains preferences are unavailable and still allows completion", async () => {
    apiState.identity = {
      userLogin: "second-user",
      tenantId: null,
      hasAccount: false,
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 0,
    };
    const { container, root, completed } = await renderScreen({ userLogin: "screen-user-4" });
    try {
      click(container, "Continue");
      await flush();
      click(container, "Continue");
      await flush();
      expect(container.textContent ?? "").toContain("account");
      expect(apiState.savedBody).toBeNull();
      click(container, "Continue");
      await flush();
      click(container, "Finish");
      expect(completed()).toBe(1);
      expect(isFirstRunComplete("screen-user-4")).toBe(true);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});

describe("NotificationPreferencesPanel (#2471)", () => {
  it("loads toggles from the existing route and saves through it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <NotificationPreferencesPanel
            identity={{
              userLogin: "second-user",
              tenantId: "tenant-1",
              hasAccount: true,
              tier: "Free",
              creditsUSD: 0,
              includedRunsRemaining: 3,
            }}
          />,
        );
      });
      await flush();
      const digest = container.querySelector('input[name="digestEnabled"]') as HTMLInputElement | null;
      expect(digest).not.toBeNull();
      expect(digest!.checked).toBe(false);
      clickLabel(container, "Digest");
      click(container, "Save");
      await flush();
      expect(apiState.savedBody).toEqual({
        userId: "second-user",
        tenantId: "tenant-1",
        digestEnabled: true,
        welcomeEnabled: true,
      });
      expect(container.textContent ?? "").toContain("Saved");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });
});
