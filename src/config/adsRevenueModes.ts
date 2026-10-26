/**
 * #1721 (parent #1717, slice (a)): ONE runtime config switch per
 * categories / referrals / external-ads pair — the PAYMENTS_FLOW_MODE
 * (#1711) pattern applied to this domain.
 *
 * Switches (Worker env vars, non-secret, owner-set; this slice sets NO
 * production value — production values are an owner action):
 *   CATEGORIES_MODE, REFERRALS_MODE, EXTERNAL_ADS_MODE
 * Values: "route" | "mcp" (case-insensitive, surrounding whitespace
 * ignored). Built-in default for all three: "route" — current PUBLIC
 * ROUTE behavior, recorded so the owner can overturn it later
 * (notably ads money defaults: route cpm 15.0 / cpc 1.25).
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in ("route").
 * Carriers: run = the per-request / per-call `mode` field (REST body
 * `mode`, GET `?mode=`, MCP input `mode`); session / user = the
 * optional `scopedModes` carrier on the execution context
 * (McpToolContext.scopedModes / route ctx scopedModes), populated by
 * the execution-context owner; global env = the Worker env var.
 * A blank/unset level falls through to the next level. The FIRST
 * non-blank level wins; if that value is unrecognized, the resolution
 * FAILS CLOSED to "route" (invalid=true, level = the winning level)
 * and does NOT fall through to a lower level that might say "mcp".
 * Callers must log + audit `<domain>.config_error` on invalid.
 *
 * What the switch governs (VALUE contract only): id schemes, slug
 * rules, description/category/reward/network/placement/tagline/cta
 * defaults, sortOrder defaults, isActive handling, list order/limit,
 * money defaults, initial ledger state, rounding, update field sets,
 * and missing-id semantics for click/delete/impression.
 *
 * What the switch does NOT govern:
 * - Audit parity is NOT switched. Both surfaces audit in BOTH modes
 *   with the route event names (category.created/updated/deleted,
 *   referral.created/deleted, external_ad.created/updated/clicked).
 *   The scan's MCP audit silence is closed by this slice, not kept
 *   as a mode.
 * - Transport envelopes stay per surface: REST maps failures to HTTP
 *   statuses; MCP throws. A switched missing-id behavior is mapped,
 *   not erased (e.g. an MCP throw becomes a REST 400/404).
 * - Enforcement: this domain has no enforcement gate, and no switch
 *   value can disable one. Behavior variants are configurable;
 *   enforcement is never opt-out (standing Security Guard).
 * - No persisted settings store is introduced here. Session/user
 *   carriers are honored in resolution order and unit-pinned, but in
 *   production today only run (per-request `mode`) and global env are
 *   settable; an admin-owned persisted settings surface is a
 *   follow-up, not smuggled in via the memory store (whose keys any
 *   MCP caller can write — an unsafe home for money defaults).
 *
 * Both code paths are preserved as branches inside the builders below
 * (never deleted): "route" branches reproduce the pre-#1721 route code
 * verbatim, "mcp" branches reproduce the pre-#1721 command code
 * verbatim, including their quirks (route update slug rules differ
 * from route create slug rules; both layers' `||` rate fallback turns
 * an explicit 0 into the default; MCP category sortOrder `|| 10`
 * turns an explicit 0 into 10).
 */

import type { ExternalAdRecord } from "../types";

/** The two contract variants behind each switch. */
export type AdsRevenueMode = "route" | "mcp";

/** The three switches, keyed by domain. */
export const ADS_REVENUE_SWITCHES = {
  categories: "CATEGORIES_MODE",
  referrals: "REFERRALS_MODE",
  externalAds: "EXTERNAL_ADS_MODE",
} as const;

export type AdsRevenueDomain = keyof typeof ADS_REVENUE_SWITCHES;

/** Audit event emitted when a switch value fails closed. */
export function adsRevenueConfigErrorEvent(domain: AdsRevenueDomain): string {
  return domain === "categories"
    ? "category.config_error"
    : domain === "referrals"
      ? "referral.config_error"
      : "external_ad.config_error";
}

/** One level of the resolution order. Blank/unset falls through. */
export interface ModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

/** Session/user carriers for one domain, as carried by an execution context. */
export interface AdsRevenueScopeCarrier {
  session?: unknown;
  user?: unknown;
}

/** The `scopedModes` carrier shared by route ctx and McpToolContext. */
export interface AdsRevenueScopedModes {
  categories?: AdsRevenueScopeCarrier;
  referrals?: AdsRevenueScopeCarrier;
  externalAds?: AdsRevenueScopeCarrier;
}

export interface ResolvedAdsRevenueMode {
  mode: AdsRevenueMode;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for audit). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

function normalizeModeValue(raw: unknown): AdsRevenueMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "route") return "route";
  if (normalized === "mcp") return "mcp";
  return "invalid";
}

/**
 * Resolves one switch in run > session > user > env > builtin order.
 * First non-blank level wins; an invalid winner fails closed to
 * "route" with invalid=true (no fall-through to a lower level).
 */
export function resolveAdsRevenueMode(levels: ModeScopeLevels): ResolvedAdsRevenueMode {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeModeValue(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      return {
        mode: "route",
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return { mode: normalized, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: "route", invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set for one domain from its carriers + run + env. */
export function levelsForDomain(
  scoped: AdsRevenueScopedModes | undefined,
  domain: AdsRevenueDomain,
  run: unknown,
  envValue: unknown
): ModeScopeLevels {
  const carrier = scoped?.[domain];
  return { run, session: carrier?.session, user: carrier?.user, env: envValue };
}

// ---------------------------------------------------------------------------
// Categories (C-1 / M05)
// ---------------------------------------------------------------------------

/** Route create slug base: lowercased, non-alphanumerics -> "-", trimmed. */
function routeCreateSlugBase(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Create slug, verbatim per mode. Route: supplied slug honored as-is
 * (only truncated to 32); otherwise the trimmed base, truncated to 32.
 * MCP: name only (supplied slug ignored), no trim, no truncation.
 */
export function categoryCreateSlug(name: string, suppliedSlug: string | undefined, mode: AdsRevenueMode): string {
  if (mode === "route") {
    return (suppliedSlug || routeCreateSlugBase(name)).slice(0, 32);
  }
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/**
 * Create id, verbatim per mode. Route: `cat_<slug[0:16]>_<uuid4>` (a
 * caller-supplied id is ignored — on the route, a body id means
 * update, not create). MCP: caller id wins, else deterministic
 * `cat_<name with _ separators>` (no random suffix).
 */
export function categoryCreateId(
  slug: string,
  name: string,
  callerId: string | undefined,
  mode: AdsRevenueMode
): string {
  if (mode === "route") {
    return `cat_${slug.slice(0, 16)}_${crypto.randomUUID().slice(0, 4)}`;
  }
  return callerId || `cat_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
}

export interface CategoryCreateInput {
  description?: string;
  icon?: string;
  sortOrder?: unknown;
  isActive?: unknown;
}

/** Create defaults, verbatim per mode (icon is identical on both). */
export function categoryCreateValues(
  name: string,
  input: CategoryCreateInput,
  mode: AdsRevenueMode,
  existingCount: number
): { description: string; icon: string; sortOrder: number; isActive: boolean } {
  if (mode === "route") {
    return {
      description: input.description || `Category for ${name} partner links`,
      icon: input.icon || "🏷️",
      sortOrder: input.sortOrder !== undefined ? Number(input.sortOrder) : (existingCount || 0) + 1,
      isActive: input.isActive !== undefined ? Boolean(input.isActive) : true,
    };
  }
  return {
    description: input.description || `${name} category tools and services`,
    icon: input.icon || "🏷️",
    sortOrder: Number(input.sortOrder) || 10,
    isActive: true,
  };
}

export interface CategoryRecordLike {
  name: string;
  slug: string;
  description: string;
  icon: string;
  isActive: boolean;
  sortOrder: number;
}

export interface CategoryUpdateInput {
  name?: string;
  slug?: string;
  description?: string;
  icon?: string;
  isActive?: unknown;
  sortOrder?: unknown;
}

/**
 * Update patch, verbatim per mode (updatedAt is added by the caller).
 * Route: full field set; slug recomputed from supplied slug or name
 * with the UPDATE slug rules (no trim, no 32-truncation — deliberately
 * different from route create). MCP: name/icon/description/sortOrder
 * only when supplied; slug and isActive are never touched.
 */
export function categoryUpdatePatch(
  existing: CategoryRecordLike,
  input: CategoryUpdateInput,
  mode: AdsRevenueMode
): Record<string, unknown> {
  if (mode === "route") {
    return {
      name: input.name || existing.name,
      slug: input.slug || (input.name ? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : existing.slug),
      description: input.description ?? existing.description,
      icon: input.icon || existing.icon,
      isActive: input.isActive !== undefined ? Boolean(input.isActive) : existing.isActive,
      sortOrder: input.sortOrder !== undefined ? Number(input.sortOrder) : existing.sortOrder,
    };
  }
  return {
    ...(input.name ? { name: input.name } : {}),
    ...(input.icon ? { icon: input.icon } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.sortOrder !== undefined ? { sortOrder: Number(input.sortOrder) } : {}),
  };
}

/** List ordering is identical on both surfaces: sort_order ASC. */
export function categoryListOptions(): { orderBy: string } {
  return { orderBy: "sort_order ASC" };
}

// ---------------------------------------------------------------------------
// Referrals (C-2 / M06)
// ---------------------------------------------------------------------------

/** Create defaults, verbatim per mode (route trims; MCP does not). */
export function referralCreateValues(
  input: { category?: string; rewardText?: string },
  mode: AdsRevenueMode
): { category: string; rewardText: string } {
  if (mode === "route") {
    return {
      category: (input.category || "AI & Dev Tools").trim(),
      rewardText: (input.rewardText || "Community referral reward").trim(),
    };
  }
  return {
    category: input.category || "AI Tools",
    rewardText: input.rewardText || "$10 Free Credits",
  };
}

/** List order/limit, verbatim per mode (shape stays per surface). */
export function referralListOptions(mode: AdsRevenueMode): { orderBy: string; limit?: number } {
  if (mode === "route") {
    return { orderBy: "created_at DESC", limit: 100 };
  }
  return { orderBy: "clicks DESC" };
}

// ---------------------------------------------------------------------------
// External ads (C-3 / M07)
// ---------------------------------------------------------------------------

/** Create id, verbatim per mode. Route embeds the raw network segment. */
export function externalAdCreateId(network: string | undefined, mode: AdsRevenueMode): string {
  if (mode === "route") {
    return `ext_${network || "net"}_${crypto.randomUUID().slice(0, 6)}`;
  }
  return `ext_ad_${crypto.randomUUID().slice(0, 8)}`;
}

export interface ExternalAdCreateInput {
  name?: string;
  network?: ExternalAdRecord["network"];
  placement?: ExternalAdRecord["placement"];
  tagline?: string;
  ctaText?: string;
  bannerImageUrl?: string;
  cpmRate?: unknown;
  cpcRate?: unknown;
}

/**
 * Create field values, verbatim per mode. Both use the `||` fallback,
 * so an explicit 0 rate collapses to the default on both layers.
 * Route creation counts as one paid impression; MCP starts at 0/0.
 * Route sets bannerImageUrl "" and no updatedAt; MCP has no
 * bannerImageUrl field (omitted, not "").
 */
export function externalAdCreateValues(
  title: string,
  input: ExternalAdCreateInput,
  mode: AdsRevenueMode
): {
  name: string;
  network: ExternalAdRecord["network"];
  placement: ExternalAdRecord["placement"];
  tagline: string;
  ctaText: string;
  bannerImageUrl?: string;
  cpmRate: number;
  cpcRate: number;
  impressions: number;
  clicks: number;
  earnings: number;
  isActive: boolean;
} {
  if (mode === "route") {
    const cpmRate = Number(input.cpmRate) || 15.0;
    return {
      name: input.name || title,
      network: input.network || "direct",
      placement: input.placement || "header_leaderboard",
      tagline: input.tagline || "",
      ctaText: input.ctaText || "Learn More →",
      bannerImageUrl: input.bannerImageUrl || "",
      cpmRate,
      cpcRate: Number(input.cpcRate) || 1.25,
      impressions: 1,
      clicks: 0,
      earnings: cpmRate / 1000,
      isActive: true,
    };
  }
  return {
    name: title,
    network: input.network || "ethicalads",
    placement: input.placement || "in_stream",
    tagline: input.tagline || `Verified developer partner: ${title}`,
    ctaText: input.ctaText || "Learn More",
    cpmRate: Number(input.cpmRate) || 2.5,
    cpcRate: Number(input.cpcRate) || 0.45,
    impressions: 0,
    clicks: 0,
    earnings: 0,
    isActive: true,
  };
}

/** List order, verbatim per mode. */
export function externalAdListOptions(mode: AdsRevenueMode): { orderBy: string } {
  return mode === "route" ? { orderBy: "earnings DESC" } : { orderBy: "created_at DESC" };
}

export interface ExternalAdUpdateInput {
  title?: string;
  name?: string;
  network?: string;
  placement?: string;
  tagline?: string;
  ctaText?: string;
  targetUrl?: string;
  cpmRate?: unknown;
  cpcRate?: unknown;
  isActive?: unknown;
}

/**
 * Route update patch (keep-existing for missing fields, no updatedAt
 * written — verbatim route behavior). There is intentionally NO mcp
 * branch: legacy MCP has no update action, and the command throws
 * `Unsupported action: update` in mcp mode instead of using a patch.
 */
export function externalAdUpdatePatch(
  existing: {
    title: string;
    name: string;
    network: string;
    placement: string;
    tagline: string;
    ctaText: string;
    targetUrl: string;
    cpmRate: number;
    cpcRate: number;
    isActive: boolean;
  },
  input: ExternalAdUpdateInput
): Record<string, unknown> {
  return {
    title: input.title || existing.title,
    name: input.name || existing.name,
    network: input.network || existing.network,
    placement: input.placement || existing.placement,
    tagline: input.tagline || existing.tagline,
    ctaText: input.ctaText || existing.ctaText,
    targetUrl: input.targetUrl || existing.targetUrl,
    cpmRate: input.cpmRate !== undefined ? Number(input.cpmRate) : existing.cpmRate,
    cpcRate: input.cpcRate !== undefined ? Number(input.cpcRate) : existing.cpcRate,
    isActive: input.isActive !== undefined ? Boolean(input.isActive) : existing.isActive,
  };
}

/** Impression earnings, verbatim per mode (fallback rate + rounding). */
export function externalAdImpressionEarnings(current: number, storedCpmRate: number, mode: AdsRevenueMode): number {
  if (mode === "route") {
    const incremental = (storedCpmRate || 15.0) / 1000;
    return Math.round((current + incremental) * 1000) / 1000;
  }
  const incremental = (storedCpmRate || 2.5) / 1000;
  return Number((current + incremental).toFixed(4));
}

/** Click earnings, verbatim per mode (fallback rate + rounding). */
export function externalAdClickEarnings(current: number, storedCpcRate: number, mode: AdsRevenueMode): number {
  if (mode === "route") {
    const incremental = storedCpcRate || 1.25;
    return Math.round((current + incremental) * 100) / 100;
  }
  const incremental = storedCpcRate || 0.45;
  return Number((current + incremental).toFixed(4));
}
