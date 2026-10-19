/**
 * Issue #359-03: characterization for the ads / revenue / referrals route
 * extraction.
 *
 * The domain's blocks are NOT contiguous in routeRequest (inventory group
 * between /schema/query and /audit; community group between /memory and the
 * payments block), so the extraction produced TWO handlers in
 * src/agents/routes/adsRevenueReferrals.ts, each invoked at the exact
 * position its original blocks occupied. This pins (a) the route inventory
 * and relative order inside each handler, (b) the two call-site positions
 * in orchestrator.ts (route matching order is load-bearing), and (c) the
 * extracted handlers' behavior with a mock context: each moved path
 * responds as before, non-matching paths return null (the orchestrator
 * keeps routing).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  handleAdsRevenueReferralsRoutes,
  handleReferralsAdsRoutes,
  type AdsRevenueReferralsRouteContext,
} from "../src/agents/routes/adsRevenueReferrals";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const makeSql = (execImpl: (query: string, ...params: unknown[]) => unknown[] = () => []) =>
  ({ exec: vi.fn(execImpl) }) as any;

const makeOrm = (overrides: Record<string, any> = {}) => ({
  categories: {
    findMany: vi.fn(() => []),
    findById: vi.fn(() => null),
    update: vi.fn((id: string, patch: any) => ({ id, ...patch })),
    create: vi.fn((rec: any) => rec),
    delete: vi.fn(),
    count: vi.fn(() => 0),
    ...overrides.categories,
  },
  externalAds: {
    findMany: vi.fn(() => []),
    findById: vi.fn(() => null),
    update: vi.fn((id: string, patch: any) => ({ id, ...patch })),
    create: vi.fn((rec: any) => rec),
    ...overrides.externalAds,
  },
  getRevenueSummary: vi.fn(() => ({ total: 0, currency: "USD" })),
  ...overrides.rest,
});

const baseCtx = (
  overrides: Partial<AdsRevenueReferralsRouteContext> = {}
): AdsRevenueReferralsRouteContext =>
  ({
    getOrm: () => makeOrm() as any,
    ensureTables: () => makeSql(),
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
  return handleAdsRevenueReferralsRoutes(req(method, path, body), url, path, "sess-1", c).then((res) => ({ res, ctx: c }));
};

const callB = (method: string, path: string, body?: unknown, ctx?: AdsRevenueReferralsRouteContext) => {
  const c = ctx ?? baseCtx();
  const url = new URL(`https://agent.internal${path}`);
  return handleReferralsAdsRoutes(req(method, path, body), url, path, "sess-1", c).then((res) => ({ res, ctx: c }));
};

describe("ads/revenue/referrals route inventory (extraction #366)", () => {
  const moduleSrc = () => src("agents/routes/adsRevenueReferrals.ts");

  it("handler A conditions appear in the module in the original relative order", () => {
    const srcText = moduleSrc();
    const markers = [
      'path.endsWith("/categories")',
      'path.endsWith("/revenue") && request.method === "GET"',
      'path.endsWith("/external-ads")',
      'path.endsWith("/external-ads/impression") && request.method === "POST"',
      'path.endsWith("/external-ads/click") && request.method === "POST"',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = srcText.indexOf(marker);
      expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
    // Handler A must not swallow the community group's paths.
    const handlerAStart = srcText.indexOf("export async function handleAdsRevenueReferralsRoutes");
    const handlerBStart = srcText.indexOf("export async function handleReferralsAdsRoutes");
    const handlerABody = srcText.slice(handlerAStart, handlerBStart);
    expect(handlerABody).not.toContain('"/referrals"');
    expect(handlerABody).not.toContain('"/ads"');
  });

  it("handler B conditions appear in the module in the original relative order", () => {
    const srcText = moduleSrc();
    const handlerBStart = srcText.indexOf("export async function handleReferralsAdsRoutes");
    const handlerBBody = srcText.slice(handlerBStart);
    const markers = [
      'path.endsWith("/referrals")',
      'path.endsWith("/referrals/click") && request.method === "POST"',
      'path.endsWith("/ads")',
      'path.endsWith("/ads/click") && request.method === "POST"',
    ];
    let last = -1;
    for (const marker of markers) {
      const idx = handlerBBody.indexOf(marker);
      expect(idx, `expected route marker in handler B: ${marker}`).toBeGreaterThan(-1);
      expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
      last = idx;
    }
    expect(handlerBBody).not.toContain('"/categories"');
    expect(handlerBBody).not.toContain('"/external-ads"');
    expect(handlerBBody).not.toContain('"/revenue"');
  });

  it("the original inline blocks are gone from orchestrator.ts; both delegations stand at the original positions", () => {
    const orchSrc = src("agents/orchestrator.ts");
    expect(orchSrc).toContain("handleAdsRevenueReferralsRoutes(request, url, path, sessionId,");
    expect(orchSrc).toContain("handleReferralsAdsRoutes(request, url, path, sessionId,");
    // Distinctive comments that headed the original inline blocks.
    for (const comment of [
      "// Referral Categories ORM Management API",
      "// Revenue Management Summary API",
      "// External Ad Network Placements & Monetization API",
      "// Referrals & Affiliate Links endpoint",
      "// Sponsored Ads & Marketplace endpoint",
    ]) {
      expect(orchSrc, `inline block comment should be gone: ${comment}`).not.toContain(comment);
    }
    // No leftover inline conditions for these paths.
    for (const cond of [
      'if (path.endsWith("/categories"))',
      'if (path.endsWith("/revenue")',
      'if (path.endsWith("/external-ads"))',
      'if (path.endsWith("/referrals"))',
      'if (path.endsWith("/ads"))',
    ]) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // Call-site A sits between /schema/query and the /audit block.
    // Landmark rule (#405): anchor to the audit DELEGATION CALL, never to a
    // neighboring domain's inline comment — slice 04 (#367) moved the
    // "// Audit logs endpoint" comment into routes/audit.ts, which broke
    // this assertion on main. Delegation calls are the stable landmarks.
    const callAIdx = orchSrc.indexOf("handleAdsRevenueReferralsRoutes(request, url, path, sessionId,");
    expect(callAIdx).toBeGreaterThan(orchSrc.indexOf('if (path.endsWith("/schema/query")'));
    expect(callAIdx).toBeLessThan(orchSrc.indexOf("handleAuditRoutes(request, url, path, sessionId,"));
    // Call-site B sits between /memory and the payments block.
    const callBIdx = orchSrc.indexOf("handleReferralsAdsRoutes(request, url, path, sessionId,");
    expect(callBIdx).toBeGreaterThan(orchSrc.indexOf('if (path.endsWith("/memory"))'));
    expect(callBIdx).toBeLessThan(orchSrc.indexOf("Multi-Gateway Payments & DID Management API"));
  });
});

describe("handleAdsRevenueReferralsRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const { res: r1 } = await callA("GET", "/audit");
    expect(r1).toBeNull();
    const { res: r2 } = await callA("POST", "/referrals");
    expect(r2).toBeNull(); // community group belongs to handler B
    const { res: r3 } = await callA("GET", "/trading/options/scan");
    expect(r3).toBeNull();
  });

  it("GET /categories lists categories via the ORM", async () => {
    const orm = makeOrm({ categories: { findMany: vi.fn(() => [{ id: "cat_1", name: "AI" }]) } });
    const { res } = await callA("GET", "/categories", undefined, baseCtx({ getOrm: () => orm as any }));
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.categories[0].name).toBe("AI");
  });

  it("POST /categories validates name, audits, and creates", async () => {
    const orm = makeOrm();
    const audit = vi.fn();
    const { res } = await callA("POST", "/categories", { name: "" }, baseCtx({ getOrm: () => orm as any, audit }));
    expect(res!.status).toBe(400);
    const { res: ok } = await callA("POST", "/categories", { name: "Finance" }, baseCtx({ getOrm: () => orm as any, audit }));
    const body = (await ok!.json()) as any;
    expect(body.success).toBe(true);
    expect(audit).toHaveBeenCalledWith("category.created", "orchestrator", expect.objectContaining({ name: "Finance" }));
  });

  it("DELETE /categories requires an id query param", async () => {
    const { res } = await callA("DELETE", "/categories");
    expect(res!.status).toBe(400);
  });

  it("GET /revenue returns the ORM revenue summary", async () => {
    const orm = makeOrm({ rest: { getRevenueSummary: vi.fn(() => ({ total: 42, currency: "USD" })) } });
    const { res } = await callA("GET", "/revenue", undefined, baseCtx({ getOrm: () => orm as any }));
    expect((await res!.json()) as any).toEqual({ total: 42, currency: "USD" });
  });

  it("POST /external-ads validates title/targetUrl, then creates and audits", async () => {
    const orm = makeOrm();
    const audit = vi.fn();
    const bad = await callA("POST", "/external-ads", { title: "x" }, baseCtx({ getOrm: () => orm as any, audit }));
    expect(bad.res!.status).toBe(400);
    const ok = await callA(
      "POST",
      "/external-ads",
      { title: "Ad", targetUrl: "https://example.com", network: "direct" },
      baseCtx({ getOrm: () => orm as any, audit })
    );
    const body = (await ok.res!.json()) as any;
    expect(body.success).toBe(true);
    expect(body.ad.id).toMatch(/^ext_direct_/);
    expect(audit).toHaveBeenCalledWith("external_ad.created", "orchestrator", expect.objectContaining({ title: "Ad" }));
  });

  it("POST /external-ads/impression bumps impressions and earnings", async () => {
    const orm = makeOrm({
      externalAds: {
        findById: vi.fn(() => ({ id: "e1", impressions: 5, earnings: 0.075, cpmRate: 15 })),
        update: vi.fn(),
      },
    });
    const { res } = await callA("POST", "/external-ads/impression", { id: "e1" }, baseCtx({ getOrm: () => orm as any }));
    const body = (await res!.json()) as any;
    expect(body).toEqual({ success: true, impressions: 6, earnings: 0.09 });
    expect(orm.externalAds.update).toHaveBeenCalledWith("e1", { impressions: 6, earnings: 0.09 });
  });

  it("POST /external-ads/click bumps clicks, earnings, and audits", async () => {
    const orm = makeOrm({
      externalAds: {
        findById: vi.fn(() => ({ id: "e1", clicks: 2, earnings: 1.25, cpcRate: 1.25 })),
        update: vi.fn(),
      },
    });
    const audit = vi.fn();
    const { res } = await callA("POST", "/external-ads/click", { id: "e1" }, baseCtx({ getOrm: () => orm as any, audit }));
    const body = (await res!.json()) as any;
    expect(body).toEqual({ success: true, clicks: 3, earnings: 2.5 });
    expect(audit).toHaveBeenCalledWith("external_ad.clicked", "orchestrator", expect.objectContaining({ id: "e1", clicks: 3 }));
  });
});

describe("handleReferralsAdsRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    const { res: r1 } = await callB("GET", "/categories");
    expect(r1).toBeNull(); // inventory group belongs to handler A
    const { res: r2 } = await callB("GET", "/payments/gateways");
    expect(r2).toBeNull();
  });

  it("GET /referrals lists mapped rows", async () => {
    const sql = makeSql((query) =>
      query.includes("mas_referrals")
        ? [{ id: "ref_1", session_id: "s1", title: "T", url: "https://u", category: "C", reward_text: "R", clicks: 3, signups: 1, created_at: "2026-01-01" }]
        : []
    );
    const { res } = await callB("GET", "/referrals", undefined, baseCtx({ ensureTables: () => sql }));
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.referrals[0]).toMatchObject({ id: "ref_1", userLogin: "s1", clicks: 3, rewardText: "R" });
  });

  it("POST /referrals validates, inserts with the session id, and audits", async () => {
    const sql = makeSql();
    const audit = vi.fn();
    const bad = await callB("POST", "/referrals", { title: "x" }, baseCtx({ ensureTables: () => sql, audit }));
    expect(bad.res!.status).toBe(400);
    const ok = await callB(
      "POST",
      "/referrals",
      { title: "T", url: "https://u" },
      baseCtx({ ensureTables: () => sql, audit })
    );
    const body = (await ok.res!.json()) as any;
    expect(body.success).toBe(true);
    expect(body.referral.id).toMatch(/^ref_/);
    expect(body.referral.userLogin).toBe("sess-1");
    const insertCall = (sql.exec as any).mock.calls.find((c: any[]) => String(c[0]).startsWith("INSERT INTO mas_referrals"));
    expect(insertCall[1]).toMatch(/^ref_/);
    expect(insertCall[2]).toBe("sess-1");
    expect(audit).toHaveBeenCalledWith("referral.created", "orchestrator", expect.objectContaining({ title: "T" }));
  });

  it("DELETE /referrals deletes by id and audits", async () => {
    const sql = makeSql();
    const audit = vi.fn();
    const url = new URL("https://agent.internal/referrals?id=ref_9");
    const ctx = baseCtx({ ensureTables: () => sql, audit });
    const res = await handleReferralsAdsRoutes(
      new Request(url, { method: "DELETE" }),
      url,
      "/referrals",
      "sess-1",
      ctx
    );
    expect((await res!.json()) as any).toEqual({ success: true });
    expect((sql.exec as any).mock.calls.some((c: any[]) => String(c[0]).startsWith("DELETE FROM mas_referrals") && c[1] === "ref_9")).toBe(true);
    expect(audit).toHaveBeenCalledWith("referral.deleted", "orchestrator", { id: "ref_9" });
  });

  it("POST /referrals/click increments and returns success", async () => {
    const sql = makeSql();
    const { res } = await callB("POST", "/referrals/click", { id: "ref_1" }, baseCtx({ ensureTables: () => sql }));
    expect((await res!.json()) as any).toEqual({ success: true });
    expect((sql.exec as any).mock.calls.some((c: any[]) => String(c[0]).includes("mas_referrals SET clicks"))).toBe(true);
  });

  it("GET /ads bumps impressions, then lists mapped rows", async () => {
    const sql = makeSql((query) => {
      if (query.startsWith("UPDATE mas_ads")) return [];
      return query.includes("mas_ads")
        ? [{ id: "ad_1", title: "T", tagline: "tg", sponsor: "S", badge: "PROMOTED", url: "https://u", cta_text: "Go", accent_color: "#fff", impressions: 11, clicks: 2, created_at: "2026-01-01" }]
        : [];
    });
    const { res } = await callB("GET", "/ads", undefined, baseCtx({ ensureTables: () => sql }));
    const body = (await res!.json()) as any;
    expect(body.count).toBe(1);
    expect(body.ads[0]).toMatchObject({ id: "ad_1", ctaText: "Go", impressions: 11 });
    expect((sql.exec as any).mock.calls[0][0]).toBe("UPDATE mas_ads SET impressions = impressions + 1");
  });

  it("POST /ads validates, inserts, and audits", async () => {
    const sql = makeSql();
    const audit = vi.fn();
    const bad = await callB("POST", "/ads", { title: "x" }, baseCtx({ ensureTables: () => sql, audit }));
    expect(bad.res!.status).toBe(400);
    const ok = await callB("POST", "/ads", { title: "T", url: "https://u" }, baseCtx({ ensureTables: () => sql, audit }));
    const body = (await ok.res!.json()) as any;
    expect(body.success).toBe(true);
    expect(body.ad.id).toMatch(/^ad_/);
    const insertCall = (sql.exec as any).mock.calls.find((c: any[]) => String(c[0]).startsWith("INSERT INTO mas_ads"));
    expect(insertCall).toBeTruthy();
    expect(audit).toHaveBeenCalledWith("ad.submitted", "orchestrator", expect.objectContaining({ title: "T" }));
  });

  it("POST /ads/click increments, audits, and returns success", async () => {
    const sql = makeSql();
    const audit = vi.fn();
    const { res } = await callB("POST", "/ads/click", { id: "ad_1" }, baseCtx({ ensureTables: () => sql, audit }));
    expect((await res!.json()) as any).toEqual({ success: true });
    expect((sql.exec as any).mock.calls.some((c: any[]) => String(c[0]).includes("mas_ads SET clicks") && c[1] === "ad_1")).toBe(true);
    expect(audit).toHaveBeenCalledWith("ad.clicked", "orchestrator", { id: "ad_1" });
  });
});
