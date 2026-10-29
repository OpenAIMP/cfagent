/**
 * Issue #2022 — ads suppression resolved from the D1 commercial
 * store: Subscribed tier or a tenant with ads off is served nothing
 * and counted nothing; everything else serves; any store failure
 * fails open to serve (never blank Free users' ads on a blip).
 *
 * The handler builds the store adapter straight from
 * ctx.env.AGENT_DB; tests supply a MockD1Database (node:sqlite,
 * the slice0 pattern) seeded through the real Drizzle adapter.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  handleAdsRevenueReferralsRoutes,
  handleReferralsAdsRoutes,
  type AdsRevenueReferralsRouteContext,
} from "../src/agents/routes/adsRevenueReferrals";
import {
  createD1CommercialDb,
  D1CommercialAdapter,
  ensureCommercialSchema,
} from "../src/data/d1CommercialAdapter";
import {
  createD1SubscriptionDb,
  D1SubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../src/data/d1SubscriptionAdapter";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

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

async function setup(
  tier: "Free" | "Subscribed" | null,
  tenantAdsEnabled: boolean | null,
  subsSeed?: Array<{ periodStartMs: number; periodEndMs: number }>,
  tierSource?: "operator" | "subscription",
) {
  const mock = new MockD1Database();
  const db = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(db);
  // Migration 0008 alters the accounts table (tier_source), so
  // the commercial mapping requires 0008 applied after 0007 —
  // the same order the money routes ensure at runtime.
  const subsDb0 = createD1SubscriptionDb(mock as unknown as D1Database);
  await ensureSubscriptionSchema(subsDb0);
  const store = new D1CommercialAdapter(db);
  if (tier !== null) {
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier, tierSource, creditsUSD: 0, includedRuns: 0 });
    if (tenantAdsEnabled !== null) await store.setTenantAdsEnabled("t1", tenantAdsEnabled);
  }
  if (subsSeed) {
    const subsDb = createD1SubscriptionDb(mock as unknown as D1Database);
    await ensureSubscriptionSchema(subsDb);
    const subs = new D1SubscriptionAdapter(subsDb);
    for (let i = 0; i < subsSeed.length; i++) {
      await subs.createSubscription({
        id: `s-seed-${i}`,
        userId: "u1",
        tenantId: "t1",
        planId: "pro",
        provider: "cfpay",
        providerPaymentRef: `sub-seed-${i}`,
        periodStartMs: subsSeed[i].periodStartMs,
        periodEndMs: subsSeed[i].periodEndMs,
      });
    }
  }
  const adsSql = {
    exec: vi.fn((query: string) => {
      if (query.startsWith("SELECT COUNT")) return [{ count: 1 }];
      if (query.startsWith("SELECT id, title")) return [seedRow];
      return [];
    }),
  } as never;
  // #2345 adaptation: the handlers serve the marketplace
  // tables through the ports (orm.marketplacePorts); the stub
  // repositories double as the ports and the /ads serving row
  // comes from the ads port stub. The impression-increment
  // assertions moved from the retired UPDATE statement to the
  // port's incrementAllImpressions call.
  const adsPort = {
    findMany: vi.fn(async () => [{
      id: "ad_workers_ai",
      title: "Cloudflare Workers AI",
      tagline: "Run models on serverless GPUs.",
      sponsor: "Cloudflare",
      badge: "FLAGSHIP PARTNER",
      url: "https://developers.cloudflare.com/workers-ai/",
      ctaText: "Deploy in 60s →",
      accentColor: "#f38020",
      impressions: 5,
      clicks: 2,
      createdAt: "2026-10-28T00:00:00Z",
    }]),
    findById: vi.fn(async () => null),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
    create: vi.fn(async (rec: any) => rec),
    delete: vi.fn(async () => true),
    count: vi.fn(async () => 1),
    incrementCounter: vi.fn(async () => null),
    incrementAllImpressions: vi.fn(async () => undefined),
  };
  const adsOrm = {
    externalAds: {
      findMany: vi.fn(() => [{ id: "e1", title: "Ext", impressions: 3, clicks: 1 }]),
      findById: vi.fn(() => ({ id: "e1", impressions: 3, clicks: 1, earnings: 0, cpmRate: 1, cpcRate: 1 })),
      update: vi.fn((id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
    },
    ads: adsPort,
    marketplacePorts: vi.fn(async () => ({
      categories: { findMany: vi.fn(async () => []) },
      externalAds: (adsOrmRef as any).externalAds,
      ads: adsPort,
      referrals: { findMany: vi.fn(async () => []) },
    })),
  };
  const adsOrmRef = adsOrm;
  const adsCtx = {
    getOrm: () => adsOrm,
    ensureTables: () => adsSql,
    audit: vi.fn(),
    env: { AGENT_DB: mock },
  } as unknown as AdsRevenueReferralsRouteContext;
  return { adsCtx, adsSql, adsOrm };
}

const req = (method: string, path: string, login: string | null, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const callA = (ctx: AdsRevenueReferralsRouteContext, method: string, path: string, login: string | null, body?: unknown) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleAdsRevenueReferralsRoutes(req(method, path, login, body), url, path, "sess-1", ctx);
};

const callB = (ctx: AdsRevenueReferralsRouteContext, method: string, path: string, login: string | null, body?: unknown) => {
  const url = new URL(`https://agent.internal${path}`);
  return handleReferralsAdsRoutes(req(method, path, login, body), url, path, "sess-1", ctx);
};

describe("ads suppression from the store (#2022)", () => {
  it("serves Free users with the impression increment", async () => {
    const { adsCtx, adsSql, adsOrm } = await setup("Free", true);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    const body = (await res?.json()) as { count: number; ads: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.ads[0].id).toBe("ad_workers_ai");
    expect(adsOrm.ads.incrementAllImpressions).toHaveBeenCalledWith(1);
  });

  it("suppresses Subscribed users with no write and no read", async () => {
    const { adsCtx, adsSql, adsOrm } = await setup("Subscribed", true);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
    expect(adsSql.exec).not.toHaveBeenCalled();
    const ext = await callA(adsCtx, "GET", "/external-ads", "u1");
    expect(await ext?.json()).toEqual({ count: 0, ads: [] });
    expect(adsOrm.externalAds.findMany).not.toHaveBeenCalled();
    const click = await callB(adsCtx, "POST", "/ads/click", "u1", { id: "ad_workers_ai" });
    expect(await click?.json()).toEqual({ success: false });
    expect(adsSql.exec).not.toHaveBeenCalled();
  });

  it("suppresses every user of a tenant with ads off, regardless of tier", async () => {
    const { adsCtx, adsSql } = await setup("Free", false);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
    expect(adsSql.exec).not.toHaveBeenCalled();
  });

  it("banner-config follows the store tier and tenant flag", async () => {
    const sub = await setup("Subscribed", true);
    const subCfg = (await (await callB(sub.adsCtx, "GET", "/ads/banner-config", "u1"))?.json()) as Record<string, unknown>;
    expect(subCfg.tier).toBe("Subscribed");
    expect(subCfg.adsAllowed).toBe(false);
    expect(subCfg.googleUnitsAllowed).toBe(false);
    const off = await setup("Free", false);
    const offCfg = (await (await callB(off.adsCtx, "GET", "/ads/banner-config", "u1"))?.json()) as Record<string, unknown>;
    expect(offCfg.tier).toBe("Free");
    expect(offCfg.adsAllowed).toBe(false);
    expect(offCfg.googleUnitsAllowed).toBe(false);
    const free = await setup("Free", true);
    const freeCfg = (await (await callB(free.adsCtx, "GET", "/ads/banner-config", "u1"))?.json()) as Record<string, unknown>;
    expect(freeCfg.tier).toBe("Free");
    expect(freeCfg.adsAllowed).toBe(true);
    expect(freeCfg.googleUnitsAllowed).toBe(true);
  });

  it("fails open to serve when the store is unreachable or the caller is anonymous", async () => {
    const { adsCtx, adsSql, adsOrm } = await setup("Subscribed", true);
    const noStoreCtx = {
      ...adsCtx,
      env: {},
    } as unknown as AdsRevenueReferralsRouteContext;
    const res = await callB(noStoreCtx, "GET", "/ads", "u1");
    expect(((await res?.json()) as { count: number }).count).toBe(1);
    const anon = await callB(adsCtx, "GET", "/ads", null);
    expect(((await anon?.json()) as { count: number }).count).toBe(1);
    expect(adsOrm.ads.incrementAllImpressions).toHaveBeenCalledWith(1);
  });

  it("a populated Subscribed ctx tier still suppresses on store failure", async () => {
    const { adsCtx } = await setup(null, null);
    const ctx = { ...adsCtx, viewerTier: "Subscribed" } as AdsRevenueReferralsRouteContext;
    const res = await callB(ctx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
  });
});

describe("ads effective tier from subscriptions (#2020/#2127)", () => {
  const NOW = Date.now();
  it("an unexpired subscription suppresses ads even when the stored tier is Free", async () => {
    const { adsCtx, adsSql } = await setup("Free", true, [{ periodStartMs: NOW - 1000, periodEndMs: NOW + 30 * 86_400_000 }]);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
    expect(adsSql.exec).not.toHaveBeenCalled();
    const cfg = (await (await callB(adsCtx, "GET", "/ads/banner-config", "u1"))?.json()) as Record<string, unknown>;
    expect(cfg.tier).toBe("Subscribed");
    expect(cfg.adsAllowed).toBe(false);
  });

  it("an expired subscription stops suppressing ads for a subscription-granted tier", async () => {
    const { adsCtx, adsSql, adsOrm } = await setup("Subscribed", true, [{ periodStartMs: NOW - 60 * 86_400_000, periodEndMs: NOW - 1000 }], "subscription");
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    expect(((await res?.json()) as { count: number }).count).toBe(1);
    expect(adsOrm.ads.incrementAllImpressions).toHaveBeenCalledWith(1);
    const cfg = (await (await callB(adsCtx, "GET", "/ads/banner-config", "u1"))?.json()) as Record<string, unknown>;
    expect(cfg.tier).toBe("Free");
    expect(cfg.adsAllowed).toBe(true);
  });

  it("an operator grant survives an expired subscription", async () => {
    const { adsCtx, adsSql } = await setup("Subscribed", true, [{ periodStartMs: NOW - 60 * 86_400_000, periodEndMs: NOW - 1000 }], "operator");
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
    expect(adsSql.exec).not.toHaveBeenCalled();
  });

  it("a subscription without any account row still suppresses while unexpired", async () => {
    const { adsCtx, adsSql } = await setup(null, null, [{ periodStartMs: NOW - 1000, periodEndMs: NOW + 30 * 86_400_000 }]);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
    expect(adsSql.exec).not.toHaveBeenCalled();
  });
});
