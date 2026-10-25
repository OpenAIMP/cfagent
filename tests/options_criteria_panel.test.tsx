/**
 * Issue #1498 (#940-D): options criteria UI for the manual options
 * contract screen.
 *
 * - optionsCriteriaToFilter emits enabled rows only, IV as the engine's
 *   decimal, and omits BOTH/ALL selects; its output validates with the
 *   run path's own strict parser (parseOptionScreenerFilter).
 * - optionsFilterToCriteria maps a stored preset fully onto panel state
 *   (IV back to percent; BOTH/ALL map to off, never to a constraint).
 * - The panel renders toggle rows + an honest last-run view, and the
 *   preset manager's options Load path applies the options mapper.
 * - RawContractsScreener source pin: the panel + options manager own the
 *   criteria now; the old raw filter state is gone.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import {
  defaultOptionsCriteria,
  optionsCriteriaToFilter,
  optionsFilterToCriteria,
  OptionsCriteriaPanel,
  type OptionsCriteriaState,
} from "../src/client/OptionsCriteriaPanel";
import {
  ScreenerPresetManager,
  type ScreenerPreset,
} from "../src/client/ScreenerPresetManager";
import { parseOptionScreenerFilter } from "../src/trading/screeningSchemas";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderPanel(
  criteria: OptionsCriteriaState,
  lastSentFilters: Record<string, unknown> | null = null
): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <OptionsCriteriaPanel criteria={criteria} onChange={() => {}} lastSentFilters={lastSentFilters} />
    );
  });
  return container;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const presetOptions: ScreenerPreset = {
  id: "p9",
  name: "Near-dated calls",
  assetClass: "options",
  criteria: { contractType: "CALL", minDelta: 0.2, maxSpreadPct: 5 },
  createdAt: "2026-10-25T10:00:00Z",
  updatedAt: "2026-10-25T10:00:00Z",
};

beforeEach(() => {
  (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/screener/presets" && method === "GET") {
      return jsonResponse(200, {
        presets: [
          {
            id: presetOptions.id,
            name: presetOptions.name,
            assetClass: presetOptions.assetClass,
            criteria: presetOptions.criteria,
            createdAt: presetOptions.createdAt,
            updatedAt: presetOptions.updatedAt,
          },
        ],
      });
    }
    return jsonResponse(404, { error: "Preset not found." });
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Issue #1498 — optionsCriteriaToFilter", () => {
  it("emits enabled rows only, IV as a decimal, BOTH/ALL omitted", () => {
    const criteria: OptionsCriteriaState = {
      ...defaultOptionsCriteria,
      contractType: { enabled: true, value: "CALL" },
      moneyness: { enabled: true, value: "OTM" },
      minDelta: { enabled: true, value: "0.2" },
      maxSpreadPct: { enabled: true, value: "5" },
      minIvPct: { enabled: true, value: "25" },
      maxDelta: { enabled: true, value: "" },
      minVolume: { enabled: false, value: "100" },
    };
    expect(optionsCriteriaToFilter(criteria)).toEqual({
      contractType: "CALL",
      moneyness: "OTM",
      minDelta: 0.2,
      maxSpreadPct: 5,
      minImpliedVolatility: 0.25,
    });
  });

  it("an enabled BOTH type or ALL moneyness is omitted, not sent as a constraint", () => {
    const criteria: OptionsCriteriaState = {
      ...defaultOptionsCriteria,
      contractType: { enabled: true, value: "BOTH" },
      moneyness: { enabled: true, value: "ALL" },
    };
    expect(optionsCriteriaToFilter(criteria)).toEqual({});
  });

  it("all-off maps to an empty filter (never a substituted preset)", () => {
    expect(optionsCriteriaToFilter(defaultOptionsCriteria)).toEqual({});
  });

  it("the emitted filter validates with the run path's own strict parser", () => {
    const criteria: OptionsCriteriaState = {
      ...defaultOptionsCriteria,
      minVolume: { enabled: true, value: "100" },
      minOpenInterest: { enabled: true, value: "500" },
      maxSpreadPct: { enabled: true, value: "10" },
      minDte: { enabled: true, value: "7" },
      maxDte: { enabled: true, value: "45" },
      minDelta: { enabled: true, value: "0.2" },
      maxIvPct: { enabled: true, value: "60" },
      moneyness: { enabled: true, value: "OTM" },
    };
    const parsed = parseOptionScreenerFilter(optionsCriteriaToFilter(criteria));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        minVolume: 100,
        minOpenInterest: 500,
        maxSpreadPct: 10,
        minDte: 7,
        maxDte: 45,
        minDelta: 0.2,
        maxImpliedVolatility: 0.6,
        moneyness: "OTM",
      });
    }
  });
});

describe("Issue #1498 — optionsFilterToCriteria", () => {
  it("a full filter maps to enabled panel rows, IV back to percent", () => {
    expect(
      optionsFilterToCriteria({
        contractType: "PUT",
        moneyness: "ITM",
        minVolume: 100,
        minOpenInterest: 500,
        maxSpreadPct: 10,
        maxStrikeDistancePct: 15,
        minDte: 7,
        maxDte: 45,
        minPrice: 0.5,
        maxPrice: 5,
        minDelta: 0.2,
        maxDelta: 0.8,
        minGamma: 0.01,
        maxGamma: 0.1,
        minTheta: -0.05,
        maxTheta: 0,
        minVega: 0.05,
        maxVega: 0.3,
        minRho: 0.01,
        maxRho: 0.1,
        minImpliedVolatility: 0.25,
        maxImpliedVolatility: 0.6,
      })
    ).toEqual({
      contractType: { enabled: true, value: "PUT" },
      moneyness: { enabled: true, value: "ITM" },
      minVolume: { enabled: true, value: "100" },
      minOpenInterest: { enabled: true, value: "500" },
      maxSpreadPct: { enabled: true, value: "10" },
      maxStrikeDistancePct: { enabled: true, value: "15" },
      minDte: { enabled: true, value: "7" },
      maxDte: { enabled: true, value: "45" },
      minPrice: { enabled: true, value: "0.5" },
      maxPrice: { enabled: true, value: "5" },
      minDelta: { enabled: true, value: "0.2" },
      maxDelta: { enabled: true, value: "0.8" },
      minGamma: { enabled: true, value: "0.01" },
      maxGamma: { enabled: true, value: "0.1" },
      minTheta: { enabled: true, value: "-0.05" },
      maxTheta: { enabled: true, value: "0" },
      minVega: { enabled: true, value: "0.05" },
      maxVega: { enabled: true, value: "0.3" },
      minRho: { enabled: true, value: "0.01" },
      maxRho: { enabled: true, value: "0.1" },
      minIvPct: { enabled: true, value: "25" },
      maxIvPct: { enabled: true, value: "60" },
    });
  });

  it("an empty filter maps to all-off, and BOTH/ALL map to off", () => {
    expect(optionsFilterToCriteria({})).toEqual(defaultOptionsCriteria);
    const mapped = optionsFilterToCriteria({ contractType: "BOTH", moneyness: "ALL" });
    expect(mapped.contractType).toEqual({ enabled: false, value: "BOTH" });
    expect(mapped.moneyness).toEqual({ enabled: false, value: "ALL" });
  });
});

describe("Issue #1498 — OptionsCriteriaPanel", () => {
  it("renders the criterion rows, toggled-off inputs disabled", () => {
    const el = renderPanel(defaultOptionsCriteria);
    for (const label of [
      "Contract type",
      "Moneyness",
      "Min volume",
      "Min open interest",
      "Max spread",
      "Min DTE",
      "Max DTE",
      "Min premium",
      "Min delta",
      "Min IV",
    ]) {
      expect(el.textContent).toContain(label);
    }
    const minDelta = el.querySelector("#options-criteria-minDelta") as HTMLInputElement;
    expect(minDelta.disabled).toBe(true);
  });

  it("toggling a criterion on enables its input", () => {
    const onChange = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <OptionsCriteriaPanel criteria={defaultOptionsCriteria} onChange={onChange} lastSentFilters={null} />
      );
    });
    const toggle = container.querySelector('button[aria-label="Toggle Min delta"]');
    expect(toggle).toBeDefined();
    act(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].minDelta.enabled).toBe(true);
  });

  it("last-run view shows sent values (IV as percent) and 'Not set' for unset fields", () => {
    const el = renderPanel(defaultOptionsCriteria, {
      minDelta: 0.2,
      minImpliedVolatility: 0.3,
      moneyness: "OTM",
    });
    expect(el.textContent).toContain("0.2");
    expect(el.textContent).toContain("30%");
    expect(el.textContent).toContain("Out of the money");
    expect(el.textContent).toContain("Not set");
  });

  it("with no run yet the view says so instead of inventing criteria", () => {
    const el = renderPanel(defaultOptionsCriteria);
    expect(el.textContent).toContain("No run yet");
  });
});

describe("Issue #1498 — ScreenerPresetManager (options)", () => {
  it("Load with the options mapper applies the mapped criteria", async () => {
    const onApplyPreset = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ScreenerPresetManager
          assetClass="options"
          userLogin="alice"
          currentFilter={{ minDelta: 0.3 }}
          filterToCriteria={optionsFilterToCriteria}
          onApplyPreset={onApplyPreset}
        />
      );
    });
    await act(async () => {});
    expect(container.textContent).toContain("Near-dated calls");
    const load = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Load"
    );
    expect(load).toBeDefined();
    await act(async () => {
      load!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(onApplyPreset).toHaveBeenCalledTimes(1);
    const applied = onApplyPreset.mock.calls[0][0] as OptionsCriteriaState;
    expect(applied.contractType).toEqual({ enabled: true, value: "CALL" });
    expect(applied.minDelta).toEqual({ enabled: true, value: "0.2" });
    expect(applied.maxSpreadPct).toEqual({ enabled: true, value: "5" });
    expect(applied.moneyness).toEqual({ enabled: false, value: "ALL" });
    expect(applied.minVolume).toEqual({ enabled: false, value: "" });
  });
});

describe("Issue #1498 — RawContractsScreener source pin", () => {
  it("the panel + options manager own the criteria; the old raw filter state is gone", () => {
    const source = readFileSync("src/client/options/RawContractsScreener.tsx", "utf8");
    expect(source).toContain("OptionsCriteriaPanel");
    expect(source).toContain('assetClass="options"');
    expect(source).toContain("optionsCriteriaToFilter");
    expect(source).toContain("optionsFilterToCriteria");
    expect(source).toContain("setLastSentOptionsFilters");
    expect(source).not.toContain("setContractType");
    expect(source).not.toContain("setMinDte");
    expect(source).not.toContain("setMaxSpreadPct");
  });
});
