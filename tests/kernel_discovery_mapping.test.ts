/**
 * #1256 remainder — NLQ fit rewire: KernelDiscoveryResult back to
 * DiscoveryModeResult, honestly.
 *
 * The kernel candidate contract allows economics null; the discovery
 * contract did not. Mapping back must therefore NEVER drop a
 * null-economics candidate and NEVER fabricate economics for one:
 * null stays null (status Unverified at most, per the kernel's own
 * falsify invariant) and the NLQ rendering reports it absent.
 * Candidates the kernel cannot represent in the discovery contract
 * (no source discovery candidate to round-trip) fail EXPLICITLY —
 * they are neither dropped nor invented.
 */
import { describe, expect, it } from "vitest";
import {
  mapKernelNameDiscovery,
  mapKernelStrategyDiscovery,
} from "../src/services/kernelDiscoveryMapping";
import type { KernelCandidate, KernelDiscoveryResult } from "../src/services/recommendationKernel";
import type {
  DiscoveryCandidate,
  NameDiscoveryResult,
  NameFit,
  StrategyDiscoveryResult,
} from "../src/services/researchDiscovery";

function economics() {
  return {
    structure: "iron_condor",
    legs: [],
    netDebit: 0,
    netCredit: 1.2,
    maxLoss: 380,
    maxGain: 120,
    breakevens: [],
    derivationNotes: ["fixture"],
  };
}

function discoveryCandidate(overrides: Partial<DiscoveryCandidate> = {}): DiscoveryCandidate {
  return {
    symbol: "AAA",
    structure: "iron_condor",
    label: "Iron Condor",
    source: "catalog",
    legs: [],
    economics: economics(),
    status: "qualified",
    provenance: "live",
    definedRisk: true,
    marginEstimate: 380,
    assignmentRisk: false,
    gateReasons: [],
    limitations: [],
    scenario: { worstPnlTotal: 5, meanPnlTotal: 50, bestPnlTotal: 120, withinConstraints: true },
    ...overrides,
  } as DiscoveryCandidate;
}

function kernelCandidate(dc: DiscoveryCandidate, overrides: Partial<KernelCandidate> = {}): KernelCandidate {
  return {
    id: `research:${dc.symbol}:${dc.source}:${dc.structure}`,
    symbol: dc.symbol,
    structure: dc.structure,
    label: dc.label,
    legs: dc.legs,
    economics: dc.economics,
    status: dc.status,
    provenance: "quant",
    chainProvenance: dc.provenance,
    definedRisk: dc.definedRisk,
    marginEstimate: dc.marginEstimate,
    assignmentRisk: dc.assignmentRisk,
    gateReasons: [...dc.gateReasons],
    limitations: [...dc.limitations],
    rationale: `${dc.label} for ${dc.symbol}.`,
    builderId: "catalog-fit",
    scenario: { ...dc.scenario },
    falsificationEvidence: "researchDiscovery: gateComposedCandidate falsificationPresent",
    source: dc,
    ...overrides,
  } as KernelCandidate;
}

function kernelResult(candidates: KernelCandidate[], rejected: KernelDiscoveryResult["rejected"] = [], limitations: string[] = []): KernelDiscoveryResult {
  return {
    snapshot: { symbol: "AAA", dataSource: "live", chainProvenance: "live" },
    candidates,
    rejected,
    attrition: { generated: candidates.length, gatePassed: candidates.length, priced: candidates.length, falsified: candidates.length, ranked: candidates.length },
    limitations,
  } as KernelDiscoveryResult;
}

function nameSource(candidates: DiscoveryCandidate[], rejected: NameDiscoveryResult["rejected"] = []): NameDiscoveryResult {
  return {
    symbol: "AAA",
    outlook: "range_bound",
    provenance: "live",
    candidates,
    rejected,
    notConstructible: [],
    inadmissibleCatalogIds: [],
    limitations: [],
  };
}

function nameFit(overrides: Partial<NameFit> = {}): NameFit {
  return {
    symbol: "BBB",
    structure: "iron_condor",
    status: "qualified",
    provenance: "live",
    fitScore: 88,
    components: { liquidity: 90, ivFit: null, termStructureFit: 80, earningsDistance: 70, correlation: null, trackRecord: 60 },
    missingComponents: ["ivFit", "correlation"],
    economics: { netDebit: 0, netCredit: 1.2, maxLoss: 380, maxGain: 120 },
    ...overrides,
  } as NameFit;
}

describe("mapKernelNameDiscovery (#1256)", () => {
  it("round-trips a source-backed candidate with the kernel's status and economics", () => {
    const dc = discoveryCandidate();
    const kc = kernelCandidate(dc, { status: "watchlist", gateReasons: ["re-gate note"] });
    const out = mapKernelNameDiscovery(kernelResult([kc]), nameSource([dc]));
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].status).toBe("watchlist");
    expect(out.candidates[0].economics).toEqual(dc.economics);
    expect(out.candidates[0].gateReasons).toContain("re-gate note");
    expect(out.symbol).toBe("AAA");
  });

  it("carries a null-economics candidate through: present, null, unverified — never dropped, never zero-filled", () => {
    const dc = discoveryCandidate({ economics: null as never });
    const kc = kernelCandidate(dc, { economics: null, status: "unverified" });
    const out = mapKernelNameDiscovery(kernelResult([kc]), nameSource([dc]));
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].economics).toBeNull();
    expect(out.candidates[0].status).toBe("unverified");
    // No fabricated figures: no zero-filled economics object.
    expect(out.candidates[0].economics).not.toEqual(expect.objectContaining({ maxLoss: 0 }));
  });

  it("merges kernel rejections with source rejections, deduplicating exact duplicates", () => {
    const dc = discoveryCandidate();
    const kc = kernelCandidate(dc);
    const out = mapKernelNameDiscovery(
      kernelResult([kc], [{ id: "research:AAA:catalog:bull_call_spread", structure: "bull_call_spread", reason: "Re-gated out." }]),
      nameSource([dc], [
        { structure: "bull_call_spread", reason: "Re-gated out." },
        { structure: "straddle", reason: "Thesis mismatch." },
      ]),
    );
    // bull_call_spread appears once (exact duplicate merged); straddle kept.
    expect(out.rejected).toHaveLength(2);
    expect(out.rejected.map((r) => r.structure).sort()).toEqual(["bull_call_spread", "straddle"]);
  });

  it("fails explicitly on a source-less candidate instead of dropping or inventing it", () => {
    const kc = kernelCandidate(discoveryCandidate(), { source: undefined });
    expect(() => mapKernelNameDiscovery(kernelResult([kc]), nameSource([]))).toThrow(/no source discovery candidate/);
  });
});

describe("mapKernelStrategyDiscovery (#1256)", () => {
  it("round-trips a source-backed fit with the kernel's status and the source's economics", () => {
    const fit = nameFit();
    const kc = {
      id: `fit:${fit.symbol}:${fit.structure}`,
      symbol: fit.symbol,
      structure: fit.structure,
      label: `${fit.symbol} fit`,
      legs: [],
      economics: {
        structure: fit.structure,
        legs: [],
        netDebit: fit.economics!.netDebit,
        netCredit: fit.economics!.netCredit,
        maxLoss: fit.economics!.maxLoss,
        maxGain: fit.economics!.maxGain,
        breakevens: [],
        derivationNotes: ["Mapped from NameFit economics summary."],
      },
      status: "watchlist",
      provenance: "quant",
      chainProvenance: fit.provenance,
      definedRisk: false,
      marginEstimate: null,
      assignmentRisk: false,
      gateReasons: [],
      limitations: [],
      rationale: "fit",
      builderId: "name-fit",
      fitScore: fit.fitScore,
      source: fit,
    } as KernelCandidate;
    const out = mapKernelStrategyDiscovery(
      kernelResult([kc]),
      { structure: "iron_condor", ranked: [fit], rejected: [], limitations: [] } as StrategyDiscoveryResult,
    );
    expect(out.ranked).toHaveLength(1);
    expect(out.ranked[0].status).toBe("watchlist");
    expect(out.ranked[0].economics).toEqual(fit.economics);
    expect(out.ranked[0].missingComponents).toEqual(["ivFit", "correlation"]);
  });

  it("maps kernel rejected ids to symbols", () => {
    const fit = nameFit();
    const kc = kernelCandidate(discoveryCandidate(), { source: fit as never });
    const out = mapKernelStrategyDiscovery(
      kernelResult([kc], [{ id: "CCC", structure: "iron_condor", reason: "Not scored." }]),
      { structure: "iron_condor", ranked: [fit], rejected: [], limitations: [] } as StrategyDiscoveryResult,
    );
    expect(out.rejected).toEqual([{ symbol: "CCC", reason: "Not scored." }]);
  });

  it("fails explicitly on a source-less fit candidate", () => {
    const kc = kernelCandidate(discoveryCandidate(), { source: undefined });
    expect(() =>
      mapKernelStrategyDiscovery(kernelResult([kc]), { structure: "iron_condor", ranked: [], rejected: [], limitations: [] } as StrategyDiscoveryResult),
    ).toThrow(/no source name fit/);
  });
});
