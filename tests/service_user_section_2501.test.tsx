/** @vitest-environment jsdom */
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ServiceUserSection } from "../src/client/ServiceUserSection";
import {
  fetchServiceUserStatus,
  provisionPlatformTier,
} from "../src/client/serviceUserApi";

vi.mock("../src/client/serviceUserApi", () => ({
  fetchServiceUserStatus: vi.fn(),
  provisionPlatformTier: vi.fn(),
  ServiceUserApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const mockedFetch = vi.mocked(fetchServiceUserStatus);
const mockedProvision = vi.mocked(provisionPlatformTier);

let container: HTMLDivElement;
let root: Root;

const STATUS_PROVISIONED = {
  serviceUser: "svc-background",
  serviceInternalUserId: "service:svc-background",
  platform: { membershipId: "m-1", roles: ["member"] },
  tenants: ["primary"],
};

const STATUS_UNPROVISIONED = {
  ...STATUS_PROVISIONED,
  platform: null,
  tenants: [],
};

function bodyText(): string {
  return document.body.textContent ?? "";
}

function clickButton(label: string) {
  const buttons = Array.from(document.body.querySelectorAll("button"));
  const target = buttons.find((b) => (b.textContent ?? "").trim() === label);
  if (!target) {
    throw new Error(
      `No button labelled "${label}" (found: ${buttons.map((b) => b.textContent).join(" | ")})`,
    );
  }
  return target;
}

async function renderSection() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ServiceUserSection />);
  });
}

async function click(label: string) {
  await act(async () => {
    (clickButton(label) as HTMLElement).click();
  });
}

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  vi.unstubAllGlobals();
});

describe("ServiceUserSection", () => {
  it("shows provisioned platform state with the service user and tenant tiers", async () => {
    mockedFetch.mockResolvedValue(STATUS_PROVISIONED);
    await renderSection();
    expect(bodyText()).toContain("svc-background");
    expect(bodyText()).toContain("Provisioned (member)");
    expect(bodyText()).toContain("primary");
  });

  it("shows not-provisioned state with a Provision button", async () => {
    mockedFetch.mockResolvedValue(STATUS_UNPROVISIONED);
    await renderSection();
    expect(bodyText()).toContain("Not provisioned");
    expect(bodyText()).toContain("None");
    expect(() => clickButton("Provision platform tier")).not.toThrow();
  });

  it("reports success and re-reads status after a provision", async () => {
    mockedFetch.mockResolvedValue(STATUS_UNPROVISIONED);
    mockedProvision.mockResolvedValue({ kind: "provisioned", membershipId: "m-9" });
    await renderSection();
    await click("Provision platform tier");
    expect(bodyText()).toContain("Platform tier provisioned.");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("reports already-provisioned as information, not an error", async () => {
    mockedFetch.mockResolvedValue(STATUS_PROVISIONED);
    mockedProvision.mockResolvedValue({ kind: "alreadyProvisioned", membershipId: "m-1" });
    await renderSection();
    await click("Provision platform tier");
    expect(bodyText()).toContain("Platform tier was already provisioned.");
    expect(bodyText()).not.toContain("Failed to provision");
  });

  it("renders queued-not-done on 202, never success, and does not claim proof", async () => {
    mockedFetch.mockResolvedValue(STATUS_UNPROVISIONED);
    mockedProvision.mockResolvedValue({ kind: "queued", jobId: "job-1" });
    await renderSection();
    await click("Provision platform tier");
    expect(bodyText()).toContain("queued as a background job, not completed");
    expect(bodyText()).toContain("only a status read showing the platform tier provisioned counts as done");
    expect(bodyText()).not.toContain("Platform tier provisioned.");
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("renders a denied state with no Provision button on status 403", async () => {
    mockedFetch.mockRejectedValue(statusError(403, "Forbidden"));
    await renderSection();
    expect(bodyText()).toContain("not a platform admin");
    expect(document.body.querySelectorAll("button").length).toBe(1);
    expect(bodyText()).toContain("Refresh status");
  });

  it("renders a sign-in state on status 401", async () => {
    mockedFetch.mockRejectedValue(statusError(401, "Unauthorized"));
    await renderSection();
    expect(bodyText()).toContain("Not signed in");
  });

  it("renders the platform-admin denial on provision 403", async () => {
    mockedFetch.mockResolvedValue(STATUS_UNPROVISIONED);
    mockedProvision.mockRejectedValue(statusError(403, "Forbidden"));
    await renderSection();
    await click("Provision platform tier");
    expect(bodyText()).toContain("not a platform admin");
  });
});
