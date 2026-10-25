/**
 * #1256 remainder — NLQ fit rewire: KernelDiscoveryResult back to
 * DiscoveryModeResult, honestly.
 *
 * The kernel candidate contract allows economics null; the discovery
 * contract now does too (DiscoveryCandidate.economics and
 * NameFit.economics are nullable). This mapper is the bridge the C4
 * deferral was waiting for, and its rules are absolute:
 *
 *  - A kernel candidate WITH a source discovery candidate (today's
 *    kernel research entries are all source-backed: CatalogFitBuilder
 *    wraps DiscoveryCandidates, the name-fit builder wraps NameFits)
 *    round-trips through that source. The kernel's status wins (the
 *    kernel gate chain is the tier decision now); economics comes
 *    from the kernel run and stays null when null — never zero-filled,
 *    never replaced with a placeholder figure.
 *  - A kernel candidate WITHOUT a source cannot be represented in
 *    the discovery contract without inventing provenance, a source
 *    label, or (for a scenario-less candidate) scenario figures.
 *    The mapper THROWS an explicit error for it: the run fails
 *    loudly instead of silently dropping a candidate or fabricating
 *    one. Future builders that emit source-less candidates must
 *    extend the discovery contract first — that is the documented
 *    extension point, not a case to paper over here.
 *  - Rejections are merged, never lost: the name direction combines
 *    the source discovery's rejections with the kernel's re-gate
 *    rejections (exact structure+reason duplicates merged — the same
 *    verdict recorded twice is one entry). The strategy direction's
 *    kernel result already merges source rejections upstream
 *    (discoverNamesForStrategy maps them to symbol ids), so its ids
 *    ARE symbols by construction — if gate handlers are ever added
 *    to that entry, this mapping must be revisited (a gate rejection
 *    id would be a fit id, not a symbol).
 */
import type { KernelCandidate, KernelDiscoveryResult } from "./recommendationKernel";
import type {
  DiscoveryCandidate,
  NameDiscoveryResult,
  NameFit,
  StrategyDiscoveryResult,
} from "./researchDiscovery";

function isDiscoveryCandidateSource(source: unknown): source is DiscoveryCandidate {
  if (!source || typeof source !== "object") return false;
  const s = source as Record<string, unknown>;
  return (
    typeof s["symbol"] === "string" &&
    typeof s["structure"] === "string" &&
    Array.isArray(s["legs"]) &&
    typeof s["scenario"] === "object" &&
    s["scenario"] !== null &&
    "economics" in s
  );
}

function isNameFitSource(source: unknown): source is NameFit {
  if (!source || typeof source !== "object") return false;
  const s = source as Record<string, unknown>;
  return (
    typeof s["symbol"] === "string" &&
    typeof s["structure"] === "string" &&
    typeof s["fitScore"] === "number" &&
    Array.isArray(s["missingComponents"]) &&
    "economics" in s
  );
}

/** Map one kernel candidate back to its source discovery candidate, carrying the kernel's tier and economics (null stays null). */
export function mapKernelCandidateToDiscovery(kc: KernelCandidate): DiscoveryCandidate {
  if (!isDiscoveryCandidateSource(kc.source)) {
    throw new Error(
      `Kernel discovery mapping: candidate ${kc.id} has no source discovery candidate — cannot represent it in DiscoveryModeResult without inventing provenance or figures.`,
    );
  }
  const source = kc.source;
  return {
    ...source,
    status: kc.status,
    gateReasons: [...kc.gateReasons],
    limitations: [...kc.limitations],
    // The kernel's economics is authoritative; null passes through as
    // null (Unverified at most, per the kernel falsify invariant) —
    // never replaced with a zero-filled placeholder.
    economics: kc.economics,
  };
}

/** Map one kernel fit candidate back to its source name fit, carrying the kernel's tier. Economics keeps the source's NameFit shape. */
export function mapKernelCandidateToNameFit(kc: KernelCandidate): NameFit {
  if (!isNameFitSource(kc.source)) {
    throw new Error(
      `Kernel discovery mapping: candidate ${kc.id} has no source name fit — cannot represent it in DiscoveryModeResult without inventing fit evidence.`,
    );
  }
  return { ...kc.source, status: kc.status };
}

/** Map a kernel name-direction result back to a NameDiscoveryResult. Source supplies identity + admission lists; kernel supplies tiers, rejections, limitations. */
export function mapKernelNameDiscovery(
  kernel: KernelDiscoveryResult,
  source: NameDiscoveryResult,
): NameDiscoveryResult {
  const candidates = kernel.candidates.map(mapKernelCandidateToDiscovery);
  const seen = new Set<string>();
  const rejected: NameDiscoveryResult["rejected"] = [];
  for (const r of [
    ...source.rejected,
    ...kernel.rejected.map((k) => ({ structure: k.structure, reason: k.reason })),
  ]) {
    const key = `${r.structure}\n${r.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rejected.push(r);
  }
  return {
    symbol: source.symbol,
    outlook: source.outlook,
    provenance: source.provenance,
    candidates,
    rejected,
    notConstructible: [...source.notConstructible],
    inadmissibleCatalogIds: [...source.inadmissibleCatalogIds],
    // The kernel's limitations already include the builder's (source)
    // limitations — CatalogFitBuilder carries them into the run.
    limitations: [...kernel.limitations],
  };
}

/** Map a kernel strategy-direction result back to a StrategyDiscoveryResult. Rejected ids are symbols by construction (see module doc). */
export function mapKernelStrategyDiscovery(
  kernel: KernelDiscoveryResult,
  source: StrategyDiscoveryResult,
): StrategyDiscoveryResult {
  return {
    structure: source.structure,
    ranked: kernel.candidates.map(mapKernelCandidateToNameFit),
    rejected: kernel.rejected.map((k) => ({ symbol: k.id, reason: k.reason })),
    limitations: [...kernel.limitations],
  };
}
