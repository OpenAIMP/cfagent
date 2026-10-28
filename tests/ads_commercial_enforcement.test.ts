/**
 * Issue #2022 — ads suppression resolved from the commercial account
 * store: Subscribed tier or a tenant with ads off is served nothing
 * and counted nothing; everything else serves; any store failure
 * fails open to serve (never blank Free users' ads on a blip).
 */
import { describe, expect, it, vi } from "vitest";
import {
  handleAdsRevenueReferralsRoutes,
  handleReferralsAdsRoutes,
  type AdsRevenueReferralsRouteContext,
} from "../src/agents/routes/adsRevenueReferrals";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";
import type {
  CommercialAccountRecord,
  CreditRedemptionRecord,
  TenantSettingsRecord,
  TransactionRecord,
} from "../src/types";

function makeRepo<T extends Record<string, unknown>>(key: keyof T) {
  const map = new Map<string, T>();
  return {
    map,
    findOne: (where: Record<string, unknown>) => {
      for (const row of map.values()) {
        if (Object.entries(where).every(([k, v]) => row[k] === v)) return row;
      }
      return null;
    },
    findById: (id: string) => map.get(id) ?? null,
    findMany: (opts: { where?: Record<string, unknown> } = {}) => {
      const rows = [...map.values()];
      if (!opts.where) return rows;
      return rows.filter((row) =>
        Object.entries(opts.where as Record<string, unknown>).every(([k, v]) => row[k] === v),
      );
    },
    create: (record: T) => {
      map.set(String(record[key]), record);
      return record;
    },
    update: (id: string, patch: Partial<T>) => {
      const row = map.get(id);
      if (!row) return null;
      const next = { ...row, ...patch };
      map.set(id, next);
      return next;
    },
    upsert: (record: T) => {
      map.set(String(record[key]), record);
      return record;
    },
  };
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

function setup(account: CommercialAccountRecord | null, tenantAdsEnabled: boolean | null) {
  const storeOrm = {
    commercialAccounts: makeRepo<CommercialAccountRecord>("id"),
    tenantSettings: makeRepo<TenantSettingsRecord>("tenantId"),
    creditRedemptions: makeRepo<CreditRedemptionRecord>("creditRunId"),
    transactions: makeRepo<TransactionRecord>("id"),
    events: makeRepo<Record<string, unknown>>("id"),
  };
  if (account) (storeOrm.commercialAccounts as unknown as { map: Map<string, CommercialAccountRecord> }).map.set(account.id, account);
  if (tenantAdsEnabled !== null && account) {
    (storeOrm.tenantSettings as unknown as { map: Map<string, TenantSettingsRecord> }).map.set(account.tenantId, {
      tenantId: account.tenantId,
      adsEnabled: tenantAdsEnabled,
      updatedAt: "2026-10-28T00:00:00Z",
    });
  }
  const canonicalEnv = { SERVICE_USER_LOGIN: "svc", COMMERCIAL_STORE_OPERATORS: "op1" };
  const canonicalCtx = {
    env: canonicalEnv,
    getOrm: () => storeOrm,
    audit: vi.fn(),
  } as unknown as AgenticPaymentsRouteContext;
  const canonicalFetch = async (req: Request) => {
    const url = new URL(req.url);
    return handleAgenticPaymentsRoutes(req, url, url.pathname, "sess-canonical", canonicalCtx);
  };
  const adsEnv = {
    SERVICE_USER_LOGIN: "svc",
    SEARCH_AGENT: { idFromName: () => "canonical", get: () => ({ fetch: canonicalFetch }) },
  };
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
    env: adsEnv,
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

const freeAccount = (tier: "Free" | "Subscribed"): CommercialAccountRecord => ({
  id: "u1",
  tenantId: "t1",
  tier,
  creditsUSD: 0,
  includedRuns: 0,
  updatedAt: "2026-10-28T00:00:00Z",
});

describe("ads suppression from the store (#2022)", () => {
  it("serves Free users with the impression increment", async () => {
    const { adsCtx, adsSql } = setup(freeAccount("Free"), true);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    const body = (await res?.json()) as { count: number; ads: Array<{ id: string }> };
    expect(body.count).toBe(1);
    expect(body.ads[0].id).toBe("ad_workers_ai");
    expect(adsSql.exec.mock.calls.some(([q]: [string]) => q.startsWith("UPDATE mas_ads SET impressions"))).toBe(true);
  });

  it("suppresses Subscribed users with no write and no read", async () => {
    const { adsCtx, adsSql, adsOrm } = setup(freeAccount("Subscribed"), true);
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
    const { adsCtx, adsSql } = setup(freeAccount("Free"), false);
    const res = await callB(adsCtx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
    expect(adsSql.exec).not.toHaveBeenCalled();
  });

  it("fails open to serve when the store is unreachable or the caller is anonymous", async () => {
    const { adsCtx, adsSql } = setup(freeAccount("Subscribed"), true);
    const noStoreCtx = {
      ...adsCtx,
      env: { SERVICE_USER_LOGIN: "svc" },
    } as unknown as AdsRevenueReferralsRouteContext;
    const res = await callB(noStoreCtx, "GET", "/ads", "u1");
    expect(((await res?.json()) as { count: number }).count).toBe(1);
    const anon = await callB(adsCtx, "GET", "/ads", null);
    expect(((await anon?.json()) as { count: number }).count).toBe(1);
    expect(adsSql.exec.mock.calls.some(([q]: [string]) => q.startsWith("UPDATE mas_ads SET impressions"))).toBe(true);
  });

  it("a populated Subscribed ctx tier still suppresses on store failure", async () => {
    const { adsCtx } = setup(null, null);
    const ctx = { ...adsCtx, viewerTier: "Subscribed" } as AdsRevenueReferralsRouteContext;
    const res = await callB(ctx, "GET", "/ads", "u1");
    expect(await res?.json()).toEqual({ count: 0, ads: [] });
  });
});
