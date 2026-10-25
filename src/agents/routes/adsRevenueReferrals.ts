/**
 * Issue #359-03: ads / revenue / referrals routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move —
 * no behavior change.
 *
 * The domain's original inline blocks are NOT contiguous in routeRequest:
 *   - the inventory group (/categories, /revenue, /external-ads,
 *     /external-ads/impression, /external-ads/click) sits between the
 *     /schema/query block and the /audit block;
 *   - the community group (/referrals, /referrals/click, /ads, /ads/click)
 *     sits between the /memory block and the payments block.
 * This module therefore exports TWO handlers, each invoked from
 * routeRequest at the EXACT position its original blocks occupied in the
 * sequential path.endsWith matching sequence. Each returns a Response on
 * match or null when none of its paths matches (the orchestrator then
 * continues its sequential matching) — matching order relative to every
 * other handler is preserved by the two call sites.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them
 * via the explicit AdsRevenueReferralsRouteContext parameter; there are no
 * new globals and no back-references into the class.
 */

import type { AgentName, CategoryRecord, ExternalAdRecord } from "../../types";
import type { DatabaseORM, SqlStorage } from "../../orm";

/** The subset of OrchestratorAgent surface the ads/revenue/referrals handlers need. */
export interface AdsRevenueReferralsRouteContext {
  getOrm(): DatabaseORM;
  ensureTables(): SqlStorage;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
}

/**
 * Handles the inventory/monetization group: referral-category ORM CRUD, the
 * revenue summary, and external ad placements (+ impression/click tracking).
 * Invoked from routeRequest at the position between the /schema/query block
 * and the /audit block.
 */
export async function handleAdsRevenueReferralsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AdsRevenueReferralsRouteContext
): Promise<Response | null> {
  // Referral Categories ORM Management API
  if (path.endsWith("/categories")) {
    const orm = ctx.getOrm();

    if (request.method === "GET") {
      try {
        const categories = orm.categories.findMany({ orderBy: "sort_order ASC" });
        return Response.json({ count: categories.length, categories });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch categories" }, { status: 500 });
      }
    }

    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as Partial<CategoryRecord> & { id?: string };
        const name = (body.name || "").trim();
        if (!name) {
          return Response.json({ error: "Category name is required" }, { status: 400 });
        }

        const now = new Date().toISOString();
        let category: CategoryRecord;

        if (body.id) {
          const existing = orm.categories.findById(body.id);
          if (!existing) {
            return Response.json({ error: "Category not found" }, { status: 404 });
          }
          const updated = orm.categories.update(body.id, {
            name: body.name || existing.name,
            slug: body.slug || (body.name ? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : existing.slug),
            description: body.description ?? existing.description,
            icon: body.icon || existing.icon,
            isActive: body.isActive !== undefined ? Boolean(body.isActive) : existing.isActive,
            sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : existing.sortOrder,
            updatedAt: now,
          });
          category = updated || existing;
          ctx.audit("category.updated", "orchestrator", { id: category.id, name: category.name });
        } else {
          const slug = (body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 32);
          const id = `cat_${slug.slice(0, 16)}_${crypto.randomUUID().slice(0, 4)}`;
          category = orm.categories.create({
            id,
            name,
            slug,
            description: body.description || `Category for ${name} partner links`,
            icon: body.icon || "🏷️",
            isActive: body.isActive !== undefined ? Boolean(body.isActive) : true,
            sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : (orm.categories.count() || 0) + 1,
            createdAt: now,
            updatedAt: now,
          });
          ctx.audit("category.created", "orchestrator", { id, name });
        }

        return Response.json({ success: true, category });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to save category" }, { status: 500 });
      }
    }

    if (request.method === "DELETE") {
      try {
        const id = url.searchParams.get("id");
        if (!id) {
          return Response.json({ error: "Category id is required" }, { status: 400 });
        }
        orm.categories.delete(id);
        ctx.audit("category.deleted", "orchestrator", { id });
        return Response.json({ success: true });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete category" }, { status: 500 });
      }
    }
  }

  // Revenue Management Summary API
  if (path.endsWith("/revenue") && request.method === "GET") {
    try {
      const orm = ctx.getOrm();
      const summary = orm.getRevenueSummary();
      return Response.json(summary);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to calculate revenue" }, { status: 500 });
    }
  }

  // External Ad Network Placements & Monetization API
  if (path.endsWith("/external-ads")) {
    const orm = ctx.getOrm();

    if (request.method === "GET") {
      try {
        const ads = orm.externalAds.findMany({ orderBy: "earnings DESC" });
        return Response.json({ count: ads.length, ads });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch external ads" }, { status: 500 });
      }
    }

    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as Partial<ExternalAdRecord> & { id?: string };
        const title = (body.title || "").trim();
        const targetUrl = (body.targetUrl || "").trim();
        if (!title || !targetUrl) {
          return Response.json({ error: "Title and targetUrl are required" }, { status: 400 });
        }

        const now = new Date().toISOString();
        let ad: ExternalAdRecord;

        if (body.id) {
          const existing = orm.externalAds.findById(body.id);
          if (!existing) {
            return Response.json({ error: "Ad not found" }, { status: 404 });
          }
          const updated = orm.externalAds.update(body.id, {
            title: body.title || existing.title,
            name: body.name || existing.name,
            network: body.network || existing.network,
            placement: body.placement || existing.placement,
            tagline: body.tagline || existing.tagline,
            ctaText: body.ctaText || existing.ctaText,
            targetUrl: body.targetUrl || existing.targetUrl,
            cpmRate: body.cpmRate !== undefined ? Number(body.cpmRate) : existing.cpmRate,
            cpcRate: body.cpcRate !== undefined ? Number(body.cpcRate) : existing.cpcRate,
            isActive: body.isActive !== undefined ? Boolean(body.isActive) : existing.isActive,
          });
          ad = updated || existing;
          ctx.audit("external_ad.updated", "orchestrator", { id: ad.id, title: ad.title });
        } else {
          const id = `ext_${body.network || "net"}_${crypto.randomUUID().slice(0, 6)}`;
          ad = orm.externalAds.create({
            id,
            name: body.name || title,
            network: body.network || "direct",
            placement: body.placement || "header_leaderboard",
            title,
            tagline: body.tagline || "",
            ctaText: body.ctaText || "Learn More →",
            targetUrl,
            bannerImageUrl: body.bannerImageUrl || "",
            cpmRate: Number(body.cpmRate) || 15.0,
            cpcRate: Number(body.cpcRate) || 1.25,
            impressions: 1,
            clicks: 0,
            earnings: (Number(body.cpmRate) || 15.0) / 1000,
            isActive: true,
            createdAt: now,
          });
          ctx.audit("external_ad.created", "orchestrator", { id, title });
        }

        return Response.json({ success: true, ad });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to save external ad" }, { status: 500 });
      }
    }
  }

  if (path.endsWith("/external-ads/impression") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      const id = body.id;
      if (id) {
        const orm = ctx.getOrm();
        const ad = orm.externalAds.findById(id);
        if (ad) {
          const newImpressions = ad.impressions + 1;
          const incremental = (ad.cpmRate || 15.0) / 1000;
          const newEarnings = Math.round((ad.earnings + incremental) * 1000) / 1000;
          orm.externalAds.update(id, {
            impressions: newImpressions,
            earnings: newEarnings,
          });
          return Response.json({ success: true, impressions: newImpressions, earnings: newEarnings });
        }
      }
      return Response.json({ success: false });
    } catch {
      return Response.json({ success: false });
    }
  }

  if (path.endsWith("/external-ads/click") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      const id = body.id;
      if (id) {
        const orm = ctx.getOrm();
        const ad = orm.externalAds.findById(id);
        if (ad) {
          const newClicks = ad.clicks + 1;
          const incremental = ad.cpcRate || 1.25;
          const newEarnings = Math.round((ad.earnings + incremental) * 100) / 100;
          orm.externalAds.update(id, {
            clicks: newClicks,
            earnings: newEarnings,
          });
          ctx.audit("external_ad.clicked", "orchestrator", { id, clicks: newClicks, earnings: newEarnings });
          return Response.json({ success: true, clicks: newClicks, earnings: newEarnings });
        }
      }
      return Response.json({ success: false });
    } catch {
      return Response.json({ success: false });
    }
  }

  return null;
}

/**
 * Handles the community group: referral links (+ click tracking) and
 * sponsored ads (+ click tracking). Invoked from routeRequest at the
 * position between the /memory block and the payments block.
 */
export async function handleReferralsAdsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AdsRevenueReferralsRouteContext
): Promise<Response | null> {
  // Referrals & Affiliate Links endpoint
  const sql = ctx.ensureTables();

  if (path.endsWith("/referrals")) {
    if (request.method === "GET") {
      try {
        const raw = Array.from(
          sql.exec("SELECT id, session_id, title, url, category, reward_text, clicks, signups, created_at FROM mas_referrals ORDER BY created_at DESC LIMIT 100")
        ) as any[];
        const referrals = raw.map((r) => ({
          id: String(r.id),
          userLogin: String(r.session_id),
          title: String(r.title),
          url: String(r.url),
          category: String(r.category),
          rewardText: String(r.reward_text),
          clicks: Number(r.clicks || 0),
          signups: Number(r.signups || 0),
          createdAt: String(r.created_at),
        }));
        return Response.json({ count: referrals.length, referrals });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch referrals" }, { status: 500 });
      }
    }

    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          title?: string;
          url?: string;
          category?: string;
          rewardText?: string;
        };
        const title = (body.title || "").trim();
        const targetUrl = (body.url || "").trim();
        const category = (body.category || "AI & Dev Tools").trim();
        const rewardText = (body.rewardText || "Community referral reward").trim();

        if (!title || !targetUrl) {
          return Response.json({ error: "Title and Target URL are required" }, { status: 400 });
        }

        const id = `ref_${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        sql.exec(
          "INSERT INTO mas_referrals (id, session_id, title, url, category, reward_text, clicks, signups, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
          id,
          sessionId,
          title,
          targetUrl,
          category,
          rewardText,
          now
        );
        ctx.audit("referral.created", "orchestrator", { id, title, targetUrl });
        return Response.json({
          success: true,
          referral: { id, userLogin: sessionId, title, url: targetUrl, category, rewardText, clicks: 0, signups: 0, createdAt: now },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to save referral link" }, { status: 500 });
      }
    }

    if (request.method === "DELETE") {
      try {
        const id = url.searchParams.get("id");
        if (id) {
          sql.exec("DELETE FROM mas_referrals WHERE id = ?", id);
          ctx.audit("referral.deleted", "orchestrator", { id });
        }
        return Response.json({ success: true });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete referral" }, { status: 500 });
      }
    }
  }

  if (path.endsWith("/referrals/click") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      if (body.id) {
        sql.exec("UPDATE mas_referrals SET clicks = clicks + 1 WHERE id = ?", body.id);
      }
      return Response.json({ success: true });
    } catch {
      return Response.json({ success: false });
    }
  }

  // Sponsored Ads & Marketplace endpoint
  // Seed default sponsor offers when the table is empty (the orchestrator's
  // table-creation seed only runs on first creation — an existing-but-empty
  // table never gets seeded).
  function ensureAdsSeeded(sql: SqlStorage): void {
    try {
      const count = Array.from(
        sql.exec("SELECT COUNT(*) AS count FROM mas_ads")
      ) as Array<{ count: number }>;
      if ((count[0]?.count ?? 0) > 0) return;
      const now = new Date().toISOString();
      const seedAds = [
        {
          id: "ad_workers_ai",
          title: "Cloudflare Workers AI",
          tagline: "Run state-of-the-art models (GLM-4.7, Llama 3.3) on serverless GPUs with zero cold starts.",
          sponsor: "Cloudflare",
          badge: "FLAGSHIP PARTNER",
          url: "https://developers.cloudflare.com/workers-ai/",
          cta_text: "Deploy in 60s →",
          accent_color: "#f38020",
        },
        {
          id: "ad_ai_search",
          title: "Cloudflare AI Search",
          tagline: "Build enterprise RAG pipelines with native auto-chunking, Vectorize indexes, and real-time semantic retrieval.",
          sponsor: "Cloudflare AI",
          badge: "FEATURED TOOL",
          url: "https://developers.cloudflare.com/ai-search/",
          cta_text: "Explore Docs →",
          accent_color: "#38bdf8",
        },
        {
          id: "ad_durable_objects",
          title: "Durable Objects SQLite",
          tagline: "Strongly consistent transactional databases running natively at the edge for stateful AI agents.",
          sponsor: "Cloudflare Platform",
          badge: "INFRASTRUCTURE",
          url: "https://developers.cloudflare.com/durable-objects/",
          cta_text: "Learn More →",
          accent_color: "#a855f7",
        },
        {
          id: "ad_openaimp",
          title: "OpenAIMP Agent Studio",
          tagline: "Scale autonomous multi-agent workflows with real-time LLM Judge routing and persistent memory.",
          sponsor: "OpenAIMP",
          badge: "SPONSOR",
          url: "https://agent.openaimp.com",
          cta_text: "Join Program →",
          accent_color: "#10b981",
        },
      ];
      for (const ad of seedAds) {
        sql.exec(
          "INSERT OR IGNORE INTO mas_ads (id, title, tagline, sponsor, badge, url, cta_text, accent_color, impressions, clicks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)",
          ad.id, ad.title, ad.tagline, ad.sponsor, ad.badge, ad.url, ad.cta_text, ad.accent_color, now
        );
      }
    } catch {
      // Ignore if seeding fails
    }
  }

  if (path.endsWith("/ads")) {
    if (request.method === "GET") {
      try {
        ensureAdsSeeded(sql);
        // Increment impressions on fetch
        sql.exec("UPDATE mas_ads SET impressions = impressions + 1");
        const raw = Array.from(
          sql.exec("SELECT id, title, tagline, sponsor, badge, url, cta_text, accent_color, impressions, clicks, created_at FROM mas_ads ORDER BY clicks DESC, impressions ASC LIMIT 20")
        ) as any[];
        const ads = raw.map((a) => ({
          id: String(a.id),
          title: String(a.title),
          tagline: String(a.tagline),
          sponsor: String(a.sponsor),
          badge: String(a.badge),
          url: String(a.url),
          ctaText: String(a.cta_text),
          accentColor: String(a.accent_color || "#6366f1"),
          impressions: Number(a.impressions || 0),
          clicks: Number(a.clicks || 0),
          createdAt: String(a.created_at),
        }));
        return Response.json({ count: ads.length, ads });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch ads" }, { status: 500 });
      }
    }

    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          title?: string;
          tagline?: string;
          sponsor?: string;
          badge?: string;
          url?: string;
          ctaText?: string;
          accentColor?: string;
        };
        const title = (body.title || "").trim();
        const tagline = (body.tagline || "").trim();
        const sponsor = (body.sponsor || "Community Partner").trim();
        const badge = (body.badge || "PROMOTED").trim();
        const targetUrl = (body.url || "").trim();
        const ctaText = (body.ctaText || "Claim Deal →").trim();
        const accentColor = (body.accentColor || "#38bdf8").trim();

        if (!title || !targetUrl) {
          return Response.json({ error: "Title and Target URL are required" }, { status: 400 });
        }

        const id = `ad_${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        sql.exec(
          "INSERT INTO mas_ads (id, title, tagline, sponsor, badge, url, cta_text, accent_color, impressions, clicks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)",
          id,
          title,
          tagline,
          sponsor,
          badge,
          targetUrl,
          ctaText,
          accentColor,
          now
        );
        ctx.audit("ad.submitted", "orchestrator", { id, title, sponsor });
        return Response.json({
          success: true,
          ad: { id, title, tagline, sponsor, badge, url: targetUrl, ctaText, accentColor, impressions: 1, clicks: 0, createdAt: now },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to submit ad" }, { status: 500 });
      }
    }
  }

  if (path.endsWith("/ads/click") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      if (body.id) {
        sql.exec("UPDATE mas_ads SET clicks = clicks + 1 WHERE id = ?", body.id);
        ctx.audit("ad.clicked", "orchestrator", { id: body.id });
      }
      return Response.json({ success: true });
    } catch {
      return Response.json({ success: false });
    }
  }

  return null;
}
