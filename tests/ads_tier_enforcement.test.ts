/**
 * Issue #2022 (Goal 4) — ads tier rule, enforced server-side.
 *
 * Pure tier resolution + server config + the route-handler
 * suppression contract, tested with the same fake-ORM pattern as
 * tests/ads_revenue_referrals_routes_extraction.test.ts.
 *
 * What is pinned here:
 * - only the exact value "Subscribed" suppresses; Free, PayPerUse,
 *   undefined, null, and garbage all serve (pay-per-use buys calls,
 *   not a tier);
 * - a suppressed caller gets empty lists and NO writes: no sponsored
 *   fetch impression increment, no external list read, no
 *   impression/click increments;
 * - the banner-config endpoint resolves Free to all-allowed (local
 *   preference governs) and Subscribed to all-denied;
 * - applyServerAdsConfig ANDs server allowance with local preference
 *   per surface, and leaves local preference untouched when the
 *   server config is unavailable (fail-open on fetch failure).
 */
import { describe, expect, it, vi } from "vitest";
import {
  handleAdsRevenueReferralsRoutes,
  handleReferralsAdsRoutes,
  type AdsRevenueReferralsRouteContext,
} from "../src/agents/routes/adsRevenueReferrals";
import {
  isAdFreeTier,
  resolveAdsTier,
  resolveServerAdsConfig,
} from "../src/services/adsTier";
import {
  applyServerAdsConfig,
  DEFAULT_AD_BANNER_CONFIG,
  type AdBannerConfig,
} from "../src/client/adBannerConfig";

const makeSql = (execImpl: (query: string, ...params: unknown[]) => unknown[] = () => []) =>
  ({ exec: vi.fn(execImpl) }) as any;

const seedRow = {
  id: "ad_workers_ai",
  title: "Cloudflare Workers AI",
  tagline: "Run models on serverless GPUs.",
  sponsor: "Cloudflare",
  badge: "FLAGSHIP PARTNER",
  url: "https://developers.cloudflare.com/workers-ai/",
  cta_text: "Deploy in 60s →",
  accent_color: "#f38020",
  impressions: 5,
  clicks: 2,
  created_at: "2026-10-28T00:00:00Z",
};

const servingSql = () =>
  makeSql((query: string) => {
    if (query.startsWith("SELECT COUNT")) return [{ count: 1 }];
    if (query.startsWith("SELECT id, title")) return [seedRow];
    return [];
  });

const makeOrm = (overrides: Record<string, any> = {}) => ({
  externalAds: {
    findMany: vi.fn(() => [{ id: "e1", title: "Ext", impressions: 3, clicks: 1 }]),
    findById: vi.fn(() => ({ id: "e1", impressions: 3, clicks: 1, earnings: 0, cpmRate: 1, cpcRate: 1 })),
    update: vi.fn((id: string, patch: any) => ({ id, ...patch })),
    create: vi.fn((rec: any) => rec),
    ...overrides.externalAds,
  },
  getRevenueSummary: vi.fn(() => ({ total: 0, currency: "USD" })),
  ...overrides.rest,
});

const baseCtx = (
  overrides: Partial<AdsRevenueReferralsRouteContext> = {},
): AdsRevenueReferralsRouteContext =>
  ({
    getOrm: () => makeOrm() as any,
    ensureTables: () => servingSql(),
    audit: vi.fn(),
    ...overrides,
  }) as AdsRevenueReferralsRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });

const callA = (method: string, path: string, body?: unknown, ctx?: AdsRevenueReferralsRouteContext) => {
  const c = ctx ?? baseCtx();
  const url = new URL(`https://agent.internal${path}`);
  return handleAdsRevenueReferralsRoutes(req(method, path, body), url, path, "sess-1", c).then(
    (res) => ({ res, ctx: c }),
  );
};

const callB = (method: string, path: string, body?: unknown, ctx?: AdsRevenueReferralsRouteContext) => {
  const c = ctx ?? baseCtx();
  const url = new URL(`https://agent.internal${path}`);
  return handleReferralsAdsRoutes(req(method, path, body), url, path, "sess-1", c).then(
    (res) => ({ res, ctx: c }),
  );
};

describe("ads tier resolution (#2022)", () => {
  it("only exactly Subscribed is ad-free", () => {
    expect(resolveAdsTier("Subscribed")).toBe("Subscribed");
    expect(isAdFreeTier(resolveAdsTier("Subscribed"))).toBe(true);
    for (const tier of ["Free", "PayPerUse", "subscribed", "", undefined, null]) {
      expect(resolveAdsTier(tier as string)).toBe("Free");
      expect(isAdFreeTier(resolveAdsTier(tier as string))).toBe(false);
    }
  });

  it("server config allows everything for Free and nothing for Subscribed", () => {
    const free = resolveServerAdsConfig(undefined);
    expect(free.tier).toBe("Free");
    expect(free.adsAllowed).toBe(true);
    expect(free.googleUnitsAllowed).toBe(true);
    expect(free.sponsorSpotlightAllowed).toBe(true);
    expect(free.adNetworkStripAllowed).toBe(true);
    const sub = resolveServerAdsConfig("Subscribed");
    expect(sub.tier).toBe("Subscribed");
    expect(sub.adsAllowed).toBe(false);
    expect(sub.googleUnitsAllowed).toBe(false);
    expect(sub.sponsorSpotlightAllowed).toBe(false);
    expect(sub.adNetworkStripAllowed).toBe(false);
  });
});

describe("applyServerAdsConfig (#2022)", () => {
  const local: AdBannerConfig = {
    ...DEFAULT_AD_BANNER_CONFIG,
    enabled: true,
    showSponsorSpotlight: true,
    showAdNetworkStrip: true,
    showGoogleAdUnits: true,
    tabVisibility: { chat: true, referrals: true },
  };

  it("leaves local preference untouched without a server config", () => {
    expect(applyServerAdsConfig(local, null)).toBe(local);
  });

  it("leaves local preference untouched when the server allows", () => {
    expect(applyServerAdsConfig(local, resolveServerAdsConfig("Free"))).toEqual(local);
  });

  it("forces every surface off when the server denies", () => {
    const applied = applyServerAdsConfig(local, resolveServerAdsConfig("Subscribed"));
    expect(applied.enabled).toBe(false);
    expect(applied.showSponsorSpotlight).toBe(false);
    expect(applied.showAdNetworkStrip).toBe(false);
    expect(applied.showGoogleAdUnits).toBe(false);
    expect(applied.tabVisibility).toEqual({ chat: false, referrals: false });
  });

  it("ANDs per surface, so one denied surface does not kill the others", () => {
    const applied = applyServerAdsConfig(local, {
      tier: "Free",
      adsAllowed: true,
      googleUnitsAllowed: false,
      sponsorSpotlightAllowed: true,
      adNetworkStripAllowed: true,
    });
    expect(applied.showGoogleAdUnits).toBe(false);
    expect(applied.showSponsorSpotlight).toBe(true);
    expect(applied.enabled).toBe(true);
  });
});

describe("ad serving suppression (#2022)", () => {
  it("Subscribed GET /ads returns empty with no impression write", async () => {
    const sql = servingSql();
    const { res } = await callB(
      "GET",
      "/ads",
      undefined,
      baseCtx({ viewerTier: "Subscribed", ensureTables: () => sql }),
    );
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
    expect(sql.exec).not.toHaveBeenCalled();
  });

  it("Free and PayPerUse GET /ads still serve with the impression increment", async () => {
    for (const tier of [undefined, "PayPerUse"]) {
      const sql = servingSql();
      const { res } = await callB(
        "GET",
        "/ads",
        undefined,
        baseCtx({ viewerTier: tier, ensureTables: () => sql }),
      );
      const body = (await res?.json()) as { count: number; ads: Array<{ id: string }> };
      expect(body.count).toBe(1);
      expect(body.ads[0].id).toBe("ad_workers_ai");
      expect(sql.exec.mock.calls.some(([q]: [string]) => q.startsWith("UPDATE mas_ads SET impressions"))).toBe(true);
    }
  });

  it("Subscribed GET /external-ads returns empty without reading the store", async () => {
    const orm = makeOrm();
    const { res } = await callA(
      "GET",
      "/external-ads",
      undefined,
      baseCtx({ viewerTier: "Subscribed", getOrm: () => orm as any }),
    );
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
    expect(orm.externalAds.findMany).not.toHaveBeenCalled();
  });

  it("Subscribed tracking POSTs count nothing", async () => {
    const orm = makeOrm();
    const ctx = baseCtx({ viewerTier: "Subscribed", getOrm: () => orm as any });
    const imp = await callA("POST", "/external-ads/impression", { id: "e1" }, ctx);
    expect(await imp.res?.json()).toEqual({ success: false });
    const click = await callA("POST", "/external-ads/click", { id: "e1" }, ctx);
    expect(await click.res?.json()).toEqual({ success: false });
    const sql = servingSql();
    const adClick = await callB(
      "POST",
      "/ads/click",
      { id: "ad_workers_ai" },
      baseCtx({ viewerTier: "Subscribed", ensureTables: () => sql }),
    );
    expect(await adClick.res?.json()).toEqual({ success: false });
    expect(orm.externalAds.update).not.toHaveBeenCalled();
    expect(sql.exec).not.toHaveBeenCalled();
  });

  it("banner-config endpoint resolves Free and Subscribed", async () => {
    const free = await callB("GET", "/ads/banner-config", undefined, baseCtx());
    expect(await free.res?.json()).toMatchObject({ tier: "Free", adsAllowed: true });
    const sub = await callB(
      "GET",
      "/ads/banner-config",
      undefined,
      baseCtx({ viewerTier: "Subscribed" }),
    );
    expect(await sub.res?.json()).toMatchObject({ tier: "Subscribed", adsAllowed: false });
  });
});
