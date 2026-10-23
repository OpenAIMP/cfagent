import type { DiscoveryRequestDraft } from "./types";

/** Server cap: MAX_SAVED_REQUESTS_PER_RUN (src/trading/options/discoveryRunStore.ts). */
export const DISCOVERY_REQUEST_LIMIT = 25;

const DISCOVERY_THESES = ["bullish", "bearish", "range_bound", "large_move"] as const;
const DISCOVERY_IV_DIRECTIONS = ["rise", "unchanged", "fall"] as const;

export function blankDiscoveryRequestDraft(): DiscoveryRequestDraft {
  return {
    symbol: "",
    thesis: "bullish",
    targetPrice: "",
    targetDate: "",
    expectedIvDirection: "unchanged",
    maxPlannedLoss: "",
    minRewardRisk: "",
    optimizationBias: "",
    dataMode: "live",
    allowedStrategies: "all",
    maxDte: "",
  };
}

/** Map a stored StrategyRequest (a schedule's payload) back into a form draft. */
export function discoveryDraftFromRequest(req: any): DiscoveryRequestDraft {
  const base = blankDiscoveryRequestDraft();
  if (!req || typeof req !== "object") return base;
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  return {
    symbol: typeof req.symbol === "string" ? req.symbol : "",
    thesis: DISCOVERY_THESES.includes(req.thesis) ? req.thesis : "bullish",
    targetPrice: num(req.targetPrice),
    targetDate: typeof req.targetDate === "string" ? req.targetDate : "",
    expectedIvDirection: DISCOVERY_IV_DIRECTIONS.includes(req.expectedIvDirection)
      ? req.expectedIvDirection
      : "unchanged",
    maxPlannedLoss: num(req.maxPlannedLoss),
    minRewardRisk: num(req.minRewardRisk),
    optimizationBias: num(req.optimizationBias),
    dataMode: req.dataMode === "calibrated-demo" ? "calibrated-demo" : "live",
    allowedStrategies:
      Array.isArray(req.allowedStrategies) && req.allowedStrategies.length > 0
        ? req.allowedStrategies.join(", ")
        : "all",
    maxDte: num(req.maxDte),
  };
}

/**
 * Convert form drafts into the payload.requests array, mirroring the
 * required-field checks of the server's validateStrategyRequest
 * (src/trading/options/strategyRiskAgent.ts). That validator is
 * server-only — it resolves strategy ids against the server registry —
 * so an unknown strategy id passes here and is rejected by the create
 * route's 400, whose message the form surfaces verbatim. Returns
 * { error } with a user-facing message for the first problem found.
 */
export function buildDiscoveryRequests(
  drafts: DiscoveryRequestDraft[]
): { requests: Array<Record<string, any>> } | { error: string } {
  if (!Array.isArray(drafts) || drafts.length === 0) {
    return { error: "Add at least one saved discovery view." };
  }
  if (drafts.length > DISCOVERY_REQUEST_LIMIT) {
    return { error: `Discovery schedules are capped at ${DISCOVERY_REQUEST_LIMIT} saved views per schedule.` };
  }
  const requests: Array<Record<string, any>> = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const label = `Saved view ${i + 1}${d.symbol.trim() ? ` (${d.symbol.trim().toUpperCase()})` : ""}`;
    const symbol = d.symbol.trim().toUpperCase();
    if (!symbol) return { error: `${label}: a symbol is required.` };
    const targetPrice = Number(d.targetPrice);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      return { error: `${label}: target price must be a positive number.` };
    }
    if (!d.targetDate.trim()) return { error: `${label}: a target date is required.` };
    const maxPlannedLoss = Number(d.maxPlannedLoss);
    if (!Number.isFinite(maxPlannedLoss) || maxPlannedLoss <= 0) {
      return { error: `${label}: max planned loss must be a positive number.` };
    }
    const minRewardRisk = Number(d.minRewardRisk);
    if (!Number.isFinite(minRewardRisk) || minRewardRisk < 0) {
      return { error: `${label}: minimum reward/risk must be zero or more.` };
    }
    const allowedStrategies = d.allowedStrategies
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowedStrategies.length === 0) {
      return { error: `${label}: name at least one allowed strategy (or "all").` };
    }
    const request: Record<string, any> = {
      symbol,
      thesis: d.thesis,
      targetPrice,
      targetDate: d.targetDate.trim(),
      expectedIvDirection: d.expectedIvDirection,
      maxPlannedLoss,
      minRewardRisk,
      allowedStrategies,
      dataMode: d.dataMode,
    };
    if (d.optimizationBias.trim() !== "") {
      const bias = Number(d.optimizationBias);
      if (!Number.isInteger(bias) || bias < 0 || bias > 100) {
        return { error: `${label}: optimization bias must be a whole number from 0 to 100.` };
      }
      request.optimizationBias = bias;
    }
    if (d.maxDte.trim() !== "") {
      const maxDte = Number(d.maxDte);
      if (!Number.isInteger(maxDte) || maxDte < 1) {
        return { error: `${label}: max DTE must be a whole number of at least 1.` };
      }
      request.maxDte = maxDte;
    }
    requests.push(request);
  }
  return { requests };
}
