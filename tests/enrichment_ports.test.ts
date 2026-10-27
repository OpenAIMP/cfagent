/**
 * Issue #1888: enrichment domain ports — provider selection, minute
 * timeframes, coverage math, killswitch predicate, quality summary,
 * calibration proposals. Pure functions; no provider, store, or
 * network dependency.
 */
import { describe, expect, it } from "vitest";
import {
  ENRICHMENT_ALPACA_FLAG,
  ENRICHMENT_KILLSWITCH_KEY,
  buildEnrichmentCalibrationProposal,
  computeCoverage,
  enrichmentLoopStopped,
  isEnrichmentKillswitchThrown,
  isMinuteTimeframe,
  resolveEnrichmentSelection,
  resolveMinuteTimeframe,
  summarizeEnrichmentQuality,
  toEnrichmentCompletedEnvelope,
  type EnrichmentRunRecord,
} from "../src/enrichment/enrichmentPorts";

function run(
  overrides: Partial<EnrichmentRunRecord> = {},
): EnrichmentRunRecord {
  return {
    id: "enr-job-1",
    jobId: "job-1",
    stage: "feed",
    provider: "yahoo",
    mode: "yahoo",
    minuteTimeframe: "1Min",
    symbolsRequested: 2,
    symbolsServed: 2,
    barsFetched: 10,
    dailyBars: 4,
    minuteBars: 6,
    fallbacks: 0,
    errors: [],
    partial: false,
    stopped: false,
    breakerState: [],
    killswitchState: "clear",
    createdAt: new Date(0).toISOString(),
    results: [],
    ...overrides,
  };
}

describe("provider selection (existing flag capability)", () => {
  it("flag off selects Yahoo", () => {
    const sel = resolveEnrichmentSelection({
      alpacaFlagOn: false,
      alpacaConfigured: true,
    });
    expect(sel.primary).toBe("yahoo");
    expect(sel.fallback).toBeNull();
    expect(sel.mode).toBe("yahoo");
  });

  it("flag on + Alpaca configured selects Alpaca-primary with Yahoo fallback", () => {
    const sel = resolveEnrichmentSelection({
      alpacaFlagOn: true,
      alpacaConfigured: true,
    });
    expect(sel.primary).toBe("alpaca");
    expect(sel.fallback).toBe("yahoo");
    expect(sel.mode).toBe("alpaca-fallback");
  });

  it("flag on + Alpaca unconfigured fails safe to Yahoo", () => {
    const sel = resolveEnrichmentSelection({
      alpacaFlagOn: true,
      alpacaConfigured: false,
    });
    expect(sel.primary).toBe("yahoo");
    expect(sel.fallback).toBeNull();
    expect(sel.reason).toMatch(/unconfigured/);
  });

  it("the flag name is the existing-port flag", () => {
    expect(ENRICHMENT_ALPACA_FLAG).toBe("enrichment_alpaca");
  });
});

describe("minute timeframes", () => {
  it("detects minute timeframes and not daily/monthly", () => {
    expect(isMinuteTimeframe("1Min")).toBe(true);
    expect(isMinuteTimeframe("15Min")).toBe(true);
    expect(isMinuteTimeframe("1D")).toBe(false);
    expect(isMinuteTimeframe("15M")).toBe(false);
  });

  it("Yahoo supports 1/2/5/15/30/60/90 minutes, 60 aliases to 1h", () => {
    expect(resolveMinuteTimeframe("yahoo", "15Min")).toEqual({
      supported: true,
      minutes: 15,
    });
    expect(resolveMinuteTimeframe("yahoo", "60Min")).toEqual({
      supported: true,
      minutes: 60,
    });
    const bad = resolveMinuteTimeframe("yahoo", "7Min");
    expect(bad.supported).toBe(false);
    if (!bad.supported) expect(bad.error).toMatch(/7Min/);
  });

  it("Alpaca supports 1-59 minutes", () => {
    expect(resolveMinuteTimeframe("alpaca", "59Min")).toEqual({
      supported: true,
      minutes: 59,
    });
    const bad = resolveMinuteTimeframe("alpaca", "90Min");
    expect(bad.supported).toBe(false);
  });

  it("non-minute timeframes are not minute resolutions", () => {
    expect(resolveMinuteTimeframe("yahoo", "1D").supported).toBe(false);
  });
});

describe("coverage math", () => {
  it("computes served/failed/partial/pct", () => {
    expect(computeCoverage(4, 3)).toEqual({
      requested: 4,
      served: 3,
      failed: 1,
      partial: true,
      coveragePct: 75,
    });
    expect(computeCoverage(2, 2).partial).toBe(false);
    expect(computeCoverage(0, 0).coveragePct).toBe(100);
  });
});

describe("killswitch predicate", () => {
  it("key is the dedicated enrichment key", () => {
    expect(ENRICHMENT_KILLSWITCH_KEY).toBe("enrichment.killSwitch");
  });

  it("thrown on on/1/true, clear on off/absent", () => {
    const on = { getValue: () => "on" };
    const off = { getValue: () => "off" };
    const absent = { getValue: () => null };
    expect(isEnrichmentKillswitchThrown(on)).toBe(true);
    expect(isEnrichmentKillswitchThrown(off)).toBe(false);
    expect(isEnrichmentKillswitchThrown(absent)).toBe(false);
  });

  it("fail-closed on unreadable state", () => {
    const broken = {
      getValue: () => {
        throw new Error("read failed");
      },
    };
    expect(isEnrichmentKillswitchThrown(broken)).toBe(true);
  });

  it("either the dedicated switch or the global halt stops the loop", () => {
    expect(
      enrichmentLoopStopped({ killswitchThrown: true, globalHalted: false }),
    ).toBe(true);
    expect(
      enrichmentLoopStopped({ killswitchThrown: false, globalHalted: true }),
    ).toBe(true);
    expect(
      enrichmentLoopStopped({ killswitchThrown: false, globalHalted: false }),
    ).toBe(false);
  });
});

describe("quality summary", () => {
  it("aggregates totals and per-provider rates", () => {
    const summary = summarizeEnrichmentQuality([
      run({ provider: "yahoo", symbolsRequested: 2, symbolsServed: 2, barsFetched: 10 }),
      run({
        id: "enr-job-2",
        jobId: "job-2",
        provider: "alpaca",
        mode: "alpaca-fallback",
        symbolsRequested: 2,
        symbolsServed: 1,
        barsFetched: 3,
        fallbacks: 1,
        partial: true,
        errors: ["alpaca: NVDA unavailable"],
      }),
    ]);
    expect(summary.runs).toBe(2);
    expect(summary.symbolsRequested).toBe(4);
    expect(summary.symbolsServed).toBe(3);
    expect(summary.coveragePct).toBe(75);
    expect(summary.byProvider.yahoo.successes).toBe(1);
    expect(summary.byProvider.alpaca.failures).toBe(1);
    expect(summary.partialRuns).toBe(1);
  });
});

describe("envelopes (counts + ids only)", () => {
  it("completed envelope carries no prices or text", () => {
    const env = toEnrichmentCompletedEnvelope(run());
    expect(env.type).toBe("enrichment.completed");
    expect(env.specversion).toBe("1.0");
    expect(JSON.stringify(env.data)).not.toMatch(/open|close|price/);
    const data = env.data as Record<string, unknown>;
    expect(data.runId).toBe("enr-job-1");
    expect(data.symbolsServed).toBe(2);
  });
});

describe("calibration proposals (governed: propose only)", () => {
  it("proposes a flip when the active provider fails most runs", () => {
    const runs = Array.from({ length: 6 }, (_, i) =>
      run({
        id: `enr-a-${i}`,
        jobId: `a-${i}`,
        provider: "alpaca",
        mode: "alpaca-fallback",
        symbolsRequested: 1,
        symbolsServed: 0,
        partial: true,
      }),
    );
    const proposal = buildEnrichmentCalibrationProposal(
      summarizeEnrichmentQuality(runs),
      { alpacaConfigured: true },
    );
    expect(proposal).not.toBeNull();
    expect(proposal?.action).toBe("consider-provider-flip");
    expect(proposal?.status).toBe("proposed");
  });

  it("no proposal below the sample floor or failure threshold", () => {
    const proposal = buildEnrichmentCalibrationProposal(
      summarizeEnrichmentQuality([run()]),
      { alpacaConfigured: true },
    );
    expect(proposal).toBeNull();
  });
});
