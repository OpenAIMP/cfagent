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

async function setup(tier: "Free" | "Subscribed" | null, tenantAdsEnabled: boolean | null) {
  const mock = new MockD1Database();
  const db = createD1CommercialDb(mock as unknown as D1Database);
  await ensureCommercialSchema(db);
  const store = new D1CommercialAdapter(db);
  if (tier !== null) {
    await store.upsertAccount({ userId: "u1", tenantId: "t1", tier, creditsUSD: 0, includedRuns: 0 });
    if (tenantAdsEnabled !== null) await store.setTenantAdsEnabled("t1", tenantAdsEnabled);
  }
  const adsSql = {
    exec: vi.fn((query: string) => {
      if (query.startsWith("SELECT COUNT")) return [{ count: 1 }];
      if (query.startsWith("SELECT id, title")) return [seedRow];
      return [];
    }),
  } as never;
  const adsOrm = {
    externalAds: {
      findMany: vi.fn(() => [{ id: "e1", title: "Ext", impressions: 3, clicks: 1 }]),
      findById: vi.fn(() => ({ id: "e1", impressions: 3, clicks: 1, earnings: 0, cpmRate: 1, cpcRate: 1 })),
      update: vi.fn((id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
    },
  };
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
    const { adsCtx, adsSql } = await setup("Free", true);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    const body = (await res?.json()) as { count: number; ads: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.ads[0].id).toBe("ad_workers_ai");
    expect(adsSql.exec.mock.calls.some(([q]: [string]) => q.startsWith("UPDATE mas_ads SET impressions"))).toBe(true);
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

  it("fails open to serve when the store is unreachable or the caller is anonymous", async () => {
    const { adsCtx, adsSql } = await setup("Subscribed", true);
    const noStoreCtx = {
      ...adsCtx,
      env: {},
    } as unknown as AdsRevenueReferralsRouteContext;
    const res = await callB(noStoreCtx, "GET", "/ads", "u1");
    expect(((await res?.json()) as { count: number }).count).toBe(1);
    const anon = await callB(adsCtx, "GET", "/ads", null);
    expect(((await anon?.json()) as { count: number }).count).toBe(1);
    expect(adsSql.exec.mock.calls.some(([q]: [string]) => q.startsWith("UPDATE mas_ads SET impressions"))).toBe(true);
  });

  it("a populated Subscribed ctx tier still suppresses on store failure", async () => {
    const { adsCtx } = await setup(null, null);
    const ctx = { ...adsCtx, viewerTier: "Subscribed" } as AdsRevenueReferralsRouteContext;
    const res = await callB(ctx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
  });
});
