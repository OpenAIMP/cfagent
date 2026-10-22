import type { StrategyProfile } from "../../../trading";
import { DISCOVERY_REQUEST_LIMIT } from "./discoveryRequests";

/** Parse the profile-derived symbols field: comma- or
 *  newline-separated, trimmed, uppercased, blanks dropped (order
 *  preserved). */
export function parseDerivedSymbols(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

// Mirrors the create route's ticker check (src/agents/routes/
// schedules.ts) so an invalid ticker fails in the form, not at the
// route; the route remains the backstop.
export const DERIVED_SYMBOL_RE = /^[A-Z0-9./-]{1,16}$/;

/**
 * Build the profile-derived schedule payload (issue #533, spec R1)
 * from the form state, with the route's arm-time rules mirrored
 * client-side: a profile is required, and exactly ONE symbol source
 * is emitted — explicit symbols XOR a watchlist name — so the payload
 * can never carry both (the route 400s on both/neither). Returns
 * { error } with a user-facing message for the first problem found.
 */
export function buildProfileDerivedPayload(input: {
  source: "symbols" | "watchlist";
  symbolsText: string;
  watchlistName: string;
  profileId: string;
}): { payload: Record<string, any> } | { error: string } {
  const profileId = input.profileId.trim();
  if (!profileId) {
    return { error: "Choose a Strategy Profile to derive targets under." };
  }
  if (input.source === "watchlist") {
    const watchlistName = input.watchlistName.trim();
    if (!watchlistName) {
      return { error: "Enter the name of a watchlist to derive targets for." };
    }
    return { payload: { inputModel: "profile-derived", watchlistName, profileId } };
  }
  const symbols = parseDerivedSymbols(input.symbolsText);
  if (symbols.length === 0) {
    return { error: "Enter at least one symbol to derive targets for." };
  }
  if (symbols.length > DISCOVERY_REQUEST_LIMIT) {
    return {
      error: `Profile-derived discovery schedules are capped at ${DISCOVERY_REQUEST_LIMIT} symbols per schedule.`,
    };
  }
  const bad = symbols.find((s) => !DERIVED_SYMBOL_RE.test(s));
  if (bad) return { error: `"${bad}" is not a valid ticker symbol.` };
  return { payload: { inputModel: "profile-derived", symbols, profileId } };
}

/**
 * Why a Strategy Profile cannot support target derivation, or null
 * when it can (issue #533 decisions D1/D3, mirrored client-side so
 * the picker can disable the profile with the reason shown): no
 * thesis → no direction to derive toward; missing risk caps → no
 * honest values exist to construct the request with.
 */
export function profileDerivationBlockReason(
  profile: Pick<StrategyProfile, "thesis" | "maxPlannedLoss" | "minRewardRisk">
): string | null {
  if (!profile.thesis) return "no thesis — cannot derive direction";
  if (profile.maxPlannedLoss === undefined || profile.minRewardRisk === undefined) {
    return "missing max planned loss or min reward/risk — cannot derive targets";
  }
  return null;
}
