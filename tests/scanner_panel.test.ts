/** @vitest-environment jsdom */
/**
 * Issue #84 slice 1: Opportunity Scanner panel (mode switch #23 +
 * strategy profiles #28) and its API client.
 *
 * Harness follows the established panel tests: the REAL apiFetch is
 * driven against a stubbed global fetch, and — per the #71 lesson —
 * the transport contract is mocked, not just the payload: one test
 * runs the scan through the worker's actual 202 async-job stub →
 * poll statusUrl → completed flow. Component tests render with
 * react-dom/client in jsdom (the repo's render harness) and drive the
 * real form controls.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ScannerPanel,
  ScanResultsView,
  MODE_LABELS,
  buildScanRequest,
  buildProfileSpec,
  profileSummary,
  profileToForm,
  emptyProfileForm,
  bestFitCell,
  noFitMessage,
  type ProfileFormState,
} from "../src/client/ScannerPanel";
import {
  runOpportunityScan,
  listProfiles,
  coerceScanResponse,
  type OpportunityScanResponse,
} from "../src/client/scannerApi";
import type { StrategyProfile } from "../src/trading/options/strategyProfile";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures -----------------------------------------------------------------

const incomeProfile: StrategyProfile = {
  id: "prof-1",
  userLogin: "trader1",
  name: "Income",
  version: 2,
  createdAt: "2026-10-10T12:00:00.000Z",
  updatedAt: "2026-10-15T12:00:00.000Z",
  thesis: "range_bound",
  maxPlannedLoss: 500,
  allowedStrategies: ["put_credit_spread", "iron_condor"],
  fitGate: { minCompositeScore: 55, minProbabilityOfProfit: 0.35, requireFresh: true, minConfidence: "MEDIUM" },
};

const growthProfile: StrategyProfile = {
  id: "prof-2",
  userLogin: "trader1",
  name: "Growth",
  version: 1,
  createdAt: "2026-10-12T12:00:00.000Z",
  updatedAt: "2026-10-12T12:00:00.000Z",
  thesis: "bullish",
};

const perNameEnvelope = {
  action: "opportunities",
  success: true,
  scanned: 2,
  withTrades: 1,
  opportunities: [
    {
      symbol: "AAPL",
      underlyingPrice: 250,
      targetPrice: 262.5,
      targetSource: "thesis",
      targetEmUnits: 0.6,
      score: 71.2,
      gateBucket: "fit",
      gateReasons: [],
      pick: {
        status: "recommended",
        riskProfile: "balanced",
        confidence: "HIGH",
        alternatives: [],
        rationale: [],
        blockers: [],
        humanApprovalRequired: true,
        disclaimer: "",
        best: {
          rank: 1,
          compositeScore: 71.2,
          components: {},
          candidate: {
            label: "Bull Call Spread",
            type: "call_debit_spread",
            netDebit: 3.25,
            maxLoss: 325,
            maxProfit: 675,
            modelImpliedProbabilityOfProfit: 0.42,
          },
        },
      },
    },
  ],
  skipped: [{ symbol: "ZZZ", reason: "no chain data" }],
  truncatedSymbols: 0,
  assumptions: [
    "Stated target $500 applies to SPY only.",
    'Strategy profile "Income" (v2) applied — thesis range_bound, max planned loss $500.',
  ],
  matrix: [],
  typeRollup: [],
  mode: "per_name_best",
  fits: [],
  fitsTotal: 0,
  gate: { fit: 1, borderline: 1, noFit: 0 },
  borderline: [],
  gateParams: { minCompositeScore: 55, minProbabilityOfProfit: 0.35, requireFresh: true, minConfidence: "MEDIUM" },
  profileRef: { id: "prof-1", name: "Income", version: 2 },
  generatedAt: "2026-10-16T14:00:00.000Z",
  modelVersion: "1.1.2",
  requestSnapshot: {},
  configSnapshot: {},
  coverage: { considered: 3, scanned: 2, truncated: 0, evaluated: 2, errors: 1, withTrades: 1 },
} as any;

const fitRow = {
  symbol: "MSFT",
  verdict: "pass",
  targetPrice: 420,
  targetSource: "thesis",
  targetEmUnits: 0.55,
  gateBucket: "fit",
  gateReasons: [],
  cells: [
    {
      strategyType: "iron_condor",
      best: {
        candidateId: "c1", label: "Iron Condor", compositeScore: 66.4, score: 60,
        expirationDate: "2026-11-20", legs: [], netDebit: -2.1, maxLoss: 290,
        maxProfit: 210, maxProfitUnbounded: false, targetRewardRisk: 0.72,
        probabilityOfProfit: 0.61,
      },
      evaluatedCount: 5, passedCount: 2, rejectedCount: 3, rejectionReasons: {},
    },
  ],
} as any;

const fitEnvelope = {
  ...perNameEnvelope,
  mode: "strategy_fit",
  opportunities: [],
  fits: [fitRow],
  fitsTotal: 1,
  gate: { fit: 1, borderline: 1, noFit: 0 },
  borderline: [{ ...fitRow, symbol: "NVDA", gateBucket: "borderline", cells: [] }],
  profileRef: null,
  assumptions: [],
  coverage: { considered: 3, scanned: 3, truncated: 0, evaluated: 2, errors: 1, withTrades: 1 },
} as any;

const noFitEnvelope = {
  ...perNameEnvelope,
  mode: "strategy_fit",
  opportunities: [],
  fits: [],
  fitsTotal: 0,
  gate: { fit: 0, borderline: 2, noFit: 1 },
  borderline: [],
  profileRef: null,
  assumptions: [],
  coverage: { considered: 4, scanned: 4, truncated: 0, evaluated: 3, errors: 1, withTrades: 0 },
} as any;

// Fetch stub ---------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  body?: any;
  headers?: Record<string, string>;
}

interface StubState {
  profiles: StrategyProfile[];
  unifiedEnvelope: any;
  unifiedViaJob: boolean;
  createError?: string;
  nextId: number;
}

function installFetch(state: StubState) {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, headers: init.headers });

    if (url.includes("/api/jobs/")) {
      return Response.json({
        jobId: "job-scan",
        capability: "http.request",
        status: "completed",
        statusUrl: "/api/jobs/job-scan",
        responseStatus: 200,
        result: { body: JSON.stringify(state.unifiedEnvelope), headers: { "content-type": "application/json" } },
      });
    }
    if (url.endsWith("/api/trading/options/unified")) {
      if (state.unifiedViaJob) {
        return Response.json({ jobId: "job-scan", status: "queued", statusUrl: "/api/jobs/job-scan" }, { status: 202 });
      }
      return Response.json(state.unifiedEnvelope);
    }
    if (url.endsWith("/api/etrade/options/profiles")) {
      if (method === "GET") return Response.json({ count: state.profiles.length, profiles: state.profiles });
      if (method === "POST") {
        if (state.createError) return Response.json({ error: state.createError }, { status: 400 });
        const { name, ...spec } = body;
        const created: StrategyProfile = {
          id: `prof-new-${state.nextId++}`,
          userLogin: "trader1",
          name,
          version: 1,
          createdAt: "2026-10-16T15:00:00.000Z",
          updatedAt: "2026-10-16T15:00:00.000Z",
          ...spec,
        };
        state.profiles = [...state.profiles, created];
        return Response.json(created, { status: 201 });
      }
    }
    const profileMatch = url.match(/\/api\/etrade\/options\/profiles\/([^/]+)$/);
    if (profileMatch) {
      const id = decodeURIComponent(profileMatch[1]);
      const existing = state.profiles.find((p) => p.id === id);
      if (!existing) return Response.json({ error: "profile not found" }, { status: 404 });
      if (method === "GET") return Response.json(existing);
      if (method === "PUT") {
        const { name, ...spec } = body;
        const updated: StrategyProfile = {
          ...existing, ...spec, name: name ?? existing.name,
          version: existing.version + 1, updatedAt: "2026-10-16T15:05:00.000Z",
        };
        state.profiles = state.profiles.map((p) => (p.id === id ? updated : p));
        return Response.json(updated);
      }
      if (method === "DELETE") {
        state.profiles = state.profiles.filter((p) => p.id !== id);
        return Response.json({ deleted: true });
      }
    }
    return Response.json({ error: `unstubbed ${method} ${url}` }, { status: 500 });
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

function freshState(overrides: Partial<StubState> = {}): StubState {
  return {
    profiles: [incomeProfile, growthProfile],
    unifiedEnvelope: perNameEnvelope,
    unifiedViaJob: false,
    nextId: 1,
    ...overrides,
  };
}

// DOM helpers ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 500)}`);
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(ScannerPanel, { activeEnv: "TEST", userLogin: "trader1" }));
  });
  await flush(60);
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush(40);
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush(60);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.unstubAllGlobals();
});

// API client + transport contract -------------------------------------------

describe("scannerApi vs the async-job transport (issue #71 contract)", () => {
  it("runOpportunityScan polls the 202 job stub and resolves the real scan envelope", async () => {
    const calls = installFetch(freshState({ unifiedViaJob: true }));
    const result = await runOpportunityScan("TEST", "trader1", {
      action: "opportunities", symbols: ["AAPL"], mode: "per_name_best",
    });
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0].symbol).toBe("AAPL");
    expect(result.profileRef).toEqual({ id: "prof-1", name: "Income", version: 2 });
    // The transport really was job-polled, not direct JSON.
    expect(calls.some((c) => c.url.includes("/api/jobs/"))).toBe(true);
    const post = calls.find((c) => c.url.endsWith("/api/trading/options/unified"));
    expect(post?.method).toBe("POST");
    expect(post?.headers?.["x-environment"]).toBe("TEST");
    expect(post?.headers?.["x-user-login"]).toBe("trader1");
  });

  it("surfaces the unified service's error field (failed profile resolution) as a throw", async () => {
    installFetch(freshState({
      unifiedEnvelope: { action: "opportunities", success: false, error: 'No saved profile named "Nope".' },
    }));
    await expect(
      runOpportunityScan("TEST", "trader1", { action: "opportunities", profileName: "Nope" }),
    ).rejects.toThrow('No saved profile named "Nope".');
  });

  it("listProfiles reads the { count, profiles } envelope and sends the user header", async () => {
    const calls = installFetch(freshState());
    const profiles = await listProfiles("PROD", "trader1");
    expect(profiles.map((p) => p.name)).toEqual(["Income", "Growth"]);
    expect(calls[0].headers?.["x-user-login"]).toBe("trader1");
    expect(calls[0].headers?.["x-environment"]).toBe("PROD");
  });

  it("coerceScanResponse fills missing arrays and rejects a non-object body", () => {
    const coerced = coerceScanResponse({ action: "opportunities", success: true });
    expect(coerced.opportunities).toEqual([]);
    expect(coerced.fits).toEqual([]);
    expect(coerced.assumptions).toEqual([]);
    expect(() => coerceScanResponse("nope")).toThrow(/response shape/);
  });
});

// Pure view-model helpers ------------------------------------------------------

describe("buildScanRequest (mode is explicit on every run)", () => {
  it("per_name_best sends mode, normalized symbols, thesis and risk profile — no limit, no profile", () => {
    const body = buildScanRequest({
      symbolsText: "aapl, msft AAPL", thesis: "bullish", riskProfile: "balanced",
      mode: "per_name_best", profileId: "", fitLimit: 25,
    });
    expect(body.action).toBe("opportunities");
    expect(body.mode).toBe("per_name_best");
    expect(body.symbols).toEqual(["AAPL", "MSFT"]);
    expect(body.thesis).toBe("bullish");
    expect(body.riskProfile).toBe("balanced");
    expect(body.profileId).toBeUndefined();
    expect(body.limit).toBeUndefined();
  });

  it("strategy_fit sends the fit limit and the chosen profileId", () => {
    const body = buildScanRequest({
      symbolsText: "MSFT", thesis: "range_bound", riskProfile: "conservative",
      mode: "strategy_fit", profileId: "prof-1", fitLimit: 50,
    });
    expect(body.mode).toBe("strategy_fit");
    expect(body.limit).toBe(50);
    expect(body.profileId).toBe("prof-1");
  });
});

describe("buildProfileSpec (empty optionals are omitted, never null/'')", () => {
  it("a name-only form produces an empty spec", () => {
    const { spec, problems } = buildProfileSpec({ ...emptyProfileForm(), name: "Bare" });
    expect(spec).toEqual({});
    expect(problems).toEqual([]);
  });

  it("parses numbers, splits strategy types, and includes the gate only when enabled", () => {
    const form: ProfileFormState = {
      ...emptyProfileForm(),
      name: "Income",
      thesis: "range_bound",
      allowedStrategies: "put_credit_spread, iron_condor",
      maxPlannedLoss: "500",
      minDte: "20",
      maxDte: "45",
      gateEnabled: true,
      gateMinCompositeScore: "55",
      gateMinProbabilityOfProfit: "0.35",
      gateRequireFresh: true,
      gateMinConfidence: "MEDIUM",
    };
    const { spec, problems } = buildProfileSpec(form);
    expect(problems).toEqual([]);
    expect(spec.thesis).toBe("range_bound");
    expect(spec.allowedStrategies).toEqual(["put_credit_spread", "iron_condor"]);
    expect(spec.maxPlannedLoss).toBe(500);
    expect(spec.minDte).toBe(20);
    expect(spec.maxDte).toBe(45);
    expect(spec.minRewardRisk).toBeUndefined();
    expect(spec.fitGate).toEqual({
      requireFresh: true, minCompositeScore: 55, minProbabilityOfProfit: 0.35, minConfidence: "MEDIUM",
    });
  });

  it("reports non-numeric numeric fields as problems instead of sending NaN", () => {
    const { spec, problems } = buildProfileSpec({ ...emptyProfileForm(), maxPlannedLoss: "abc" });
    expect(spec.maxPlannedLoss).toBeUndefined();
    expect(problems).toEqual(["Max planned loss must be a number."]);
  });

  it("profileToForm round-trips a stored profile into the editor", () => {
    const form = profileToForm(incomeProfile);
    expect(form.name).toBe("Income");
    expect(form.maxPlannedLoss).toBe("500");
    expect(form.allowedStrategies).toBe("put_credit_spread, iron_condor");
    expect(form.gateEnabled).toBe(true);
    expect(form.gateMinProbabilityOfProfit).toBe("0.35");
    const { spec } = buildProfileSpec(form);
    expect(spec.maxPlannedLoss).toBe(500);
    expect(spec.fitGate?.minCompositeScore).toBe(55);
  });
});

describe("profileSummary + bestFitCell + noFitMessage", () => {
  it("summarizes only the constraints a profile sets", () => {
    expect(profileSummary(incomeProfile)).toContain("thesis range_bound");
    expect(profileSummary(incomeProfile)).toContain("max loss $500");
    expect(profileSummary(incomeProfile)).toContain("gate: score ≥55, POP ≥35%, fresh only, ≥MEDIUM");
    expect(profileSummary({ ...growthProfile, thesis: undefined })).toBe("No constraints set");
  });

  it("bestFitCell picks the highest-composite passing cell, null when none passed", () => {
    expect(bestFitCell(fitRow)?.label).toBe("Iron Condor");
    expect(bestFitCell({ ...fitRow, cells: [{ ...fitRow.cells[0], best: null }] })).toBeNull();
  });

  it("noFitMessage carries the gate accounting verbatim", () => {
    expect(noFitMessage(noFitEnvelope as OpportunityScanResponse)).toBe(
      "No names fit under the current gate — 3 evaluated, 2 borderline, 1 skipped.",
    );
  });
});

// Component behavior (jsdom) ---------------------------------------------------

describe("ScannerPanel — mode switch + scan run", () => {
  it("runs per_name_best by default: body carries the mode, header names it, rows + badge + assumptions render", async () => {
    const calls = installFetch(freshState());
    await renderPanel();
    await waitForText("Income (v2)"); // profile picker populated from listProfiles

    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("Bull Call Spread");

    const post = calls.filter((c) => c.url.endsWith("/api/trading/options/unified")).at(-1);
    expect(post?.body.mode).toBe("per_name_best");
    expect(post?.body.symbols).toEqual(["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"]);
    expect(container.textContent).toContain(`Mode: ${MODE_LABELS.per_name_best}`);
    expect(container.textContent).toContain("AAPL");
    expect(container.textContent).toContain("71.2");
    expect(container.textContent).toContain("42.0%"); // POP rendered from the 0.42 fraction
    expect(container.textContent).toContain("Profile: Income v2"); // server profileRef badge
    expect(container.textContent).toContain("Stated target $500 applies to SPY only.");
    expect(container.textContent).toContain('Strategy profile "Income" (v2) applied');
    expect(container.textContent).toContain("2 scanned · 2 evaluated · 1 skipped");
  });

  it("switching to strategy_fit sends that mode + limit and renders ALL fits with the borderline accounted", async () => {
    const calls = installFetch(freshState({ unifiedEnvelope: fitEnvelope }));
    await renderPanel();
    await waitForText("Income (v2)");

    await click(buttonByText(container, "Names that fit my strategy"));
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("Iron Condor");

    const post = calls.filter((c) => c.url.endsWith("/api/trading/options/unified")).at(-1);
    expect(post?.body.mode).toBe("strategy_fit");
    expect(post?.body.limit).toBe(25);
    expect(container.textContent).toContain(`Mode: ${MODE_LABELS.strategy_fit}`);
    expect(container.textContent).toContain("1 fits");
    expect(container.textContent).toContain("MSFT");
    expect(container.textContent).toContain("66.4");
    expect(container.textContent).toContain("Borderline (evaluated, below the gate): NVDA");
  });

  it("selecting a profile in the picker sends its profileId on the run", async () => {
    const calls = installFetch(freshState());
    await renderPanel();
    await waitForText("Income (v2)");

    const picker = container.querySelector<HTMLSelectElement>("#scp-profile")!;
    await act(async () => {
      setValue(picker, "prof-1");
    });
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("Bull Call Spread");

    const post = calls.filter((c) => c.url.endsWith("/api/trading/options/unified")).at(-1);
    expect(post?.body.profileId).toBe("prof-1");
    expect(post?.body.profileName).toBeUndefined();
  });

  it("strategy_fit with zero fits renders the explicit no-fit state, not a table", async () => {
    installFetch(freshState({ unifiedEnvelope: noFitEnvelope }));
    await renderPanel();

    await click(buttonByText(container, "Names that fit my strategy"));
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("No names fit under the current gate");

    expect(container.textContent).toContain("No names fit under the current gate — 3 evaluated, 2 borderline, 1 skipped.");
    const results = container.querySelector(".scp-results");
    expect(results?.querySelector("table")).toBeNull();
  });

  it("a malformed scan payload (all arrays missing) renders without throwing", async () => {
    installFetch(freshState({ unifiedEnvelope: { action: "opportunities", success: true } }));
    await renderPanel();
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText("No qualifying trades were returned for this scan.");
    expect(container.textContent).toContain(`Mode: ${MODE_LABELS.per_name_best}`);
    expect(container.querySelector(".scp-error")).toBeNull();
  });

  it("a server error message from the scan renders in the error box", async () => {
    installFetch(freshState({
      unifiedEnvelope: { action: "opportunities", success: false, error: 'No saved profile named "Ghost".' },
    }));
    await renderPanel();
    await submitForm(container.querySelector("form.scp-form")!);
    await waitForText('No saved profile named "Ghost".');
    expect(container.querySelector(".scp-error")?.textContent).toContain('No saved profile named "Ghost".');
  });
});

describe("ScannerPanel — strategy profiles manager (surface 4)", () => {
  it("create POSTs { name, ...spec } with empty optionals omitted, refreshes list + picker, shows the new version", async () => {
    const calls = installFetch(freshState({ profiles: [] }));
    await renderPanel();
    await waitForText("No saved profiles yet.");

    await click(buttonByText(container, "New profile"));
    const form = container.querySelector<HTMLFormElement>("#scp-profile-form")!;
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>("#scp-pf-name")!, "Income");
      setValue(form.querySelector<HTMLSelectElement>("#scp-pf-thesis")!, "range_bound");
      setValue(form.querySelector<HTMLInputElement>("#scp-pf-maxloss")!, "500");
    });
    // Enable the fit gate and set its min score.
    await click(form.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>("#scp-pf-gate-score")!, "55");
    });
    await submitForm(form);
    await waitForText('Saved profile "Income" — now v1.');

    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/etrade/options/profiles"));
    expect(post?.body).toEqual({
      name: "Income",
      thesis: "range_bound",
      maxPlannedLoss: 500,
      fitGate: { requireFresh: true, minCompositeScore: 55 },
    });
    // List refreshed and the picker now offers the new profile.
    const picker = container.querySelector<HTMLSelectElement>("#scp-profile")!;
    expect([...picker.options].map((o) => o.textContent)).toContain("Income (v1)");
    expect(container.textContent).toContain("max loss $500");
  });

  it("edit PUTs the full spec to /profiles/:id and shows the bumped version", async () => {
    const calls = installFetch(freshState({ profiles: [incomeProfile] }));
    await renderPanel();
    await waitForText("Income");

    await click(buttonByText(container, "Edit"));
    const form = container.querySelector<HTMLFormElement>("#scp-profile-form")!;
    expect(form.querySelector<HTMLInputElement>("#scp-pf-name")!.value).toBe("Income");
    expect(form.querySelector<HTMLInputElement>("#scp-pf-maxloss")!.value).toBe("500");
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>("#scp-pf-maxloss")!, "750");
    });
    await submitForm(form);
    await waitForText('Saved profile "Income" — now v3.');

    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/api/etrade/options/profiles/prof-1");
    expect(put?.body.name).toBe("Income");
    expect(put?.body.maxPlannedLoss).toBe(750);
    expect(put?.body.fitGate).toEqual({
      requireFresh: true, minCompositeScore: 55, minProbabilityOfProfit: 0.35, minConfidence: "MEDIUM",
    });
  });

  it("delete is a two-step inline confirm: first click arms, second click DELETEs", async () => {
    const calls = installFetch(freshState({ profiles: [incomeProfile] }));
    await renderPanel();
    await waitForText("Income");

    await click(buttonByText(container, "Delete"));
    expect(container.textContent).toContain("Confirm delete?");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await click(buttonByText(container, "Confirm delete?"));
    await waitForText('Deleted profile "Income".');
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/api/etrade/options/profiles/prof-1");
    expect(container.textContent).toContain("No saved profiles yet.");
  });

  it("a 400 from create renders the server's message verbatim in the form", async () => {
    installFetch(freshState({ profiles: [], createError: 'A profile named "Income" already exists' }));
    await renderPanel();
    await waitForText("No saved profiles yet.");

    await click(buttonByText(container, "New profile"));
    const form = container.querySelector<HTMLFormElement>("#scp-profile-form")!;
    await act(async () => {
      setValue(form.querySelector<HTMLInputElement>("#scp-pf-name")!, "Income");
    });
    await submitForm(form);
    await waitForText('A profile named "Income" already exists');
    expect(form.querySelector(".scp-error")?.textContent).toBe('A profile named "Income" already exists');
    // The form stays open so the user can fix the name.
    expect(container.querySelector("#scp-profile-form")).not.toBeNull();
  });
});

describe("ScanResultsView (pure render)", () => {
  it("fit mode names the mode, the profile badge, and every fit row", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(
      React.createElement(ScanResultsView, {
        result: fitEnvelope as OpportunityScanResponse,
        runContext: { mode: "strategy_fit" as const, profileLabel: null },
      }),
    ).replace(/<!-- -->/g, ""); // SSR inserts comment markers between text nodes
    expect(html).toContain("Mode: Names that fit my strategy");
    expect(html).toContain("Iron Condor");
    expect(html).toContain("MSFT");
  });

  it("does not throw on a payload with every array missing", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(
      React.createElement(ScanResultsView, {
        result: coerceScanResponse({ action: "opportunities", success: true }),
        runContext: { mode: "strategy_fit" as const, profileLabel: null },
      }),
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("No names fit under the current gate — 0 evaluated, 0 borderline, 0 skipped.");
  });
});
