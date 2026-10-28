/**
 * Issue #2022 (Goal 4) — the ads tier rule, enforced server-side.
 *
 * Rule (decided in #2022, recommended in #1076): ad-free follows
 * ACTIVE Subscribed status only. A pay-per-use purchase buys calls,
 * not a tier, so it never confers ad-free — one cent-scale purchase
 * permanently removing the free tier's revenue would be a hole.
 *
 * Tier is a user attribute, never a header claim and never a pooled
 * gateway identity (#1076 enforcement sketch). The route handlers
 * therefore resolve tier ONLY from the context's verified tier
 * attribute (`viewerTier`), which the account store (#2020/#2015)
 * will populate. Today no tier attribute exists on any user, so
 * every caller resolves to Free and serving is unchanged — the
 * enforcement point is installed and tested, and the tier source is
 * the only thing #2020 has to plug in. Nothing here reads a header
 * for tier, and nothing here invents a tier for a caller.
 *
 * Fail direction: any value other than exactly "Subscribed" —
 * including undefined, "Free", "PayPerUse", and garbage — resolves to
 * Free (serve). Suppression is opt-in by a real Subscribed record,
 * never by an ambiguous value.
 */
export type AdsTier = "Free" | "Subscribed";

/** Resolve a tier attribute to the ads tier. Unknown → Free (serve). */
export function resolveAdsTier(tierAttribute: string | undefined | null): AdsTier {
  return tierAttribute === "Subscribed" ? "Subscribed" : "Free";
}

/** True only for an active Subscribed tier. */
export function isAdFreeTier(tier: AdsTier): boolean {
  return tier === "Subscribed";
}

/** Server-resolved ad allowance: what the client ANDs with local preference. */
export interface ServerAdsConfig {
  tier: AdsTier;
  /** Master allowance: false suppresses every ad surface. */
  adsAllowed: boolean;
  googleUnitsAllowed: boolean;
  sponsorSpotlightAllowed: boolean;
  adNetworkStripAllowed: boolean;
}

/**
 * Resolve the server ad config for a tier attribute. Free allows
 * everything (local preference governs); Subscribed allows nothing.
 * The per-surface flags are equal today but distinct in shape so a
 * future surface rule does not need a new endpoint.
 */
export function resolveServerAdsConfig(
  tierAttribute: string | undefined | null,
): ServerAdsConfig {
  const tier = resolveAdsTier(tierAttribute);
  const allowed = !isAdFreeTier(tier);
  return {
    tier,
    adsAllowed: allowed,
    googleUnitsAllowed: allowed,
    sponsorSpotlightAllowed: allowed,
    adNetworkStripAllowed: allowed,
  };
}
