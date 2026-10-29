/**
 * src/data/marketplacePorts.ts — #2345 (#1976 step 3a, ADR
 * 0022 D-A/D-0): the marketplace ports — mas_categories,
 * mas_external_ads, mas_ads, mas_referrals — the ORM core's
 * only D1 residency.
 *
 * WHY D1 (step-3 audit §3): the four tables are fleet-global
 * reference data — seeded identically into every DO instance,
 * holding no per-instance execution state (no D-0 property
 * applies) — whose counters (clicks / impressions / signups /
 * earnings) silently DIVERGE per instance today: each
 * orchestrator instance counts only its own traffic.
 *
 * COUNTER-SEMANTICS CHANGE (disclosed on the PR): moving the
 * four tables to the shared D1 database makes the counters
 * FLEET-WIDE — a click recorded by any instance lands in the
 * one shared row every instance reads. That is the point of
 * the move (the per-instance divergence is the defect), and
 * it is a behaviour change, stated here and on the PR.
 *
 * The ports are ASYNC (D1 is async-only): the same repository
 * shape as repositoryPorts.ts, promise-returning, with the
 * same D-E rules (create = insert-or-throw; update returns
 * the re-read row or null; delete returns true only when a
 * row was removed). incrementCounter is the one addition:
 * an ATOMIC counter step (the routes' `clicks = clicks + 1`
 * form), returning the new value or null when the row is
 * absent — read-modify-write through update() would lose
 * increments across instances now that the table is shared.
 *
 * When AGENT_DB is unbound the composition root serves the
 * same ports from DO-SQLite adapters over the instance's own
 * tables (the pre-move behaviour, per-instance counters and
 * all) — see buildMarketplacePorts.ts.
 *
 * #CDO-mha7
 */
import type {
  AdRecord,
  CategoryRecord,
  ExternalAdRecord,
  ReferralRecord,
  RevenueSummary,
  TransactionRecord,
} from "../types";
import type { RepositoryPort, RepositoryQueryOptions } from "./repositoryPorts";

/** Async repository contract for the D1-resident tables. */
export interface AsyncRepositoryPort<T extends Record<string, any>> {
  readonly tableName: string;
  findMany(options?: RepositoryQueryOptions): Promise<T[]>;
  findById(id: string): Promise<T | null>;
  findOne(where: Record<string, unknown>): Promise<T | null>;
  create(record: T): Promise<T>;
  update(id: string, updates: Partial<T>): Promise<T | null>;
  upsert(record: T): Promise<T>;
  delete(id: string): Promise<boolean>;
  count(where?: Record<string, unknown>): Promise<number>;
  /**
   * Atomically add `delta` to a numeric counter column and
   * return its new value; null when the row does not exist.
   */
  incrementCounter(
    id: string,
    counter: string,
    delta: number,
  ): Promise<number | null>;
}

export interface CategoryPort extends AsyncRepositoryPort<CategoryRecord> {}

export interface ExternalAdPort extends AsyncRepositoryPort<ExternalAdRecord> {
  /** Atomically add `delta` to earnings; new value or null. */
  incrementEarnings(id: string, delta: number): Promise<number | null>;
}

export interface AdPort extends AsyncRepositoryPort<AdRecord> {
  /** Atomically add `delta` to EVERY row's impressions (the /ads fetch bump). */
  incrementAllImpressions(delta: number): Promise<void>;
}

export interface ReferralPort extends AsyncRepositoryPort<ReferralRecord> {}

/** The marketplace aggregate served by the composition roots. */
export interface MarketplacePorts {
  categories: CategoryPort;
  externalAds: ExternalAdPort;
  ads: AdPort;
  referrals: ReferralPort;
}

/**
 * The canonical seed rows for the three seeded tables,
 * moved verbatim from DatabaseORM.initializeSchema (the
 * values every instance seeds today). `now` is the seeding
 * instant, exactly as the legacy code stamped it. Both the
 * DO facade's initializeSchema and the D1 adapter's
 * seed-if-empty consume this one definition.
 */
export function marketplaceSeedData(now: string): {
  categories: CategoryRecord[];
  externalAds: ExternalAdRecord[];
  ads: AdRecord[];
} {
  return {
    categories: [
      {
        id: "cat_ai_dev",
        name: "AI & Dev Tools",
        slug: "ai-dev-tools",
        description: "LLM frameworks, vector databases, and autonomous agent tools.",
        icon: "🤖",
        isActive: true,
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cat_cloud_host",
        name: "Cloud & Hosting",
        slug: "cloud-hosting",
        description: "Edge workers, serverless compute, and distributed storage.",
        icon: "☁️",
        isActive: true,
        sortOrder: 2,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cat_db_store",
        name: "Database & Storage",
        slug: "database-storage",
        description: "Transactional SQLite, Vectorize, and edge key-value databases.",
        icon: "🗄️",
        isActive: true,
        sortOrder: 3,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cat_sec_auth",
        name: "Security & Auth",
        slug: "security-auth",
        description: "OAuth 2.0, Agent Decentralized Identifiers (DIDs), and compliance.",
        icon: "🛡️",
        isActive: true,
        sortOrder: 4,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cat_saas_prod",
        name: "SaaS & Productivity",
        slug: "saas-productivity",
        description: "Developer workstations, IDE assistants, and automation pipelines.",
        icon: "⚡",
        isActive: true,
        sortOrder: 5,
        createdAt: now,
        updatedAt: now,
      },
    ],
    externalAds: [
      {
        id: "ext_ethicalads_dev",
        name: "EthicalAds Developer Network",
        network: "ethicalads",
        placement: "header_leaderboard",
        title: "EthicalAds for AI Engineers",
        tagline: "Privacy-first advertising that funds open-source AI tooling.",
        ctaText: "Advertise on Network →",
        targetUrl: "https://www.ethicalads.io/",
        bannerImageUrl: "",
        cpmRate: 18.5,
        cpcRate: 1.45,
        impressions: 48,
        clicks: 3,
        earnings: 5.24,
        isActive: true,
        createdAt: now,
      },
      {
        id: "ext_carbon_infra",
        name: "Carbon Ads Infra Spot",
        network: "carbon",
        placement: "in_stream",
        title: "Cloudflare Workers AI Serverless GPUs",
        tagline: "Deploy Meta Llama 3.3 and DeepSeek R1 globally in under 60 seconds.",
        ctaText: "Start Free Tier →",
        targetUrl: "https://developers.cloudflare.com/workers-ai/",
        bannerImageUrl: "",
        cpmRate: 22.0,
        cpcRate: 1.8,
        impressions: 112,
        clicks: 8,
        earnings: 16.86,
        isActive: true,
        createdAt: now,
      },
      {
        id: "ext_direct_openaimp",
        name: "OpenAIMP Partner Direct",
        network: "direct",
        placement: "footer_deck",
        title: "Autonomous Agent Orchestration Suite",
        tagline: "Empower your business with multi-agent multi-turn LLM reasoning workflows.",
        ctaText: "Explore Platform →",
        targetUrl: "https://agent.openaimp.com",
        bannerImageUrl: "",
        cpmRate: 25.0,
        cpcRate: 2.0,
        impressions: 85,
        clicks: 6,
        earnings: 14.13,
        isActive: true,
        createdAt: now,
      },
      {
        id: "ext_google_cloud_ai",
        name: "Google Cloud Vertex AI & TPUs",
        network: "google",
        placement: "header_leaderboard",
        title: "Google Cloud Vertex AI & TPU v5e Accelerators",
        tagline: "Build, deploy, and scale enterprise AI models globally with ultra-low latency.",
        ctaText: "Start with $300 Credits →",
        targetUrl: "https://cloud.google.com/vertex-ai",
        bannerImageUrl: "",
        cpmRate: 24.5,
        cpcRate: 2.1,
        impressions: 142,
        clicks: 11,
        earnings: 26.58,
        isActive: true,
        createdAt: now,
      },
    ],
    ads: [
      {
        id: "ad_workers_ai",
        title: "Workers AI Edge GPUs",
        tagline: "Run DeepSeek R1 & Llama 3.3 serverless models globally at the edge.",
        sponsor: "Cloudflare",
        badge: "Featured Partner",
        url: "https://developers.cloudflare.com/workers-ai/",
        ctaText: "Build Free",
        accentColor: "#f38020",
        impressions: 420,
        clicks: 34,
        createdAt: now,
      },
      {
        id: "ad_stripe_payments",
        title: "Autonomous Agent Checkout",
        tagline: "Accept payments with Stripe, PayPal, and DID signature verification.",
        sponsor: "Stripe Connect",
        badge: "Verified Gateway",
        url: "https://stripe.com",
        ctaText: "Integrate Now",
        accentColor: "#635bff",
        impressions: 215,
        clicks: 18,
        createdAt: now,
      },
    ],
  };
}

/**
 * The revenue summary computation, as a pure function over the
 * four input row sets — the SINGLE implementation shared by the
 * facade's synchronous getRevenueSummary() (over its DO ports)
 * and computeMarketplaceRevenueSummary below (over whichever
 * residency the marketplace ports resolve to). Rates as found:
 * marketplace revenue = $20 per sponsored ad + $0.50 per click;
 * payment platform fee = 2.5% of settled (completed|authorized)
 * charge volume; referral payouts = $10 per signup; averageRPM
 * defaults to 18.5 with zero impressions.
 */
export function computeRevenueSummaryFromRows(rows: {
  externalAds: ExternalAdRecord[];
  ads: AdRecord[];
  transactions: TransactionRecord[];
  referrals: ReferralRecord[];
}): RevenueSummary {
  const extAds = rows.externalAds;
  const adNetworkRevenue = extAds.reduce((sum, ad) => sum + (ad.earnings || 0), 0);
  const totalImpressions = extAds.reduce((sum, ad) => sum + (ad.impressions || 0), 0);
  const totalAdClicks = extAds.reduce((sum, ad) => sum + (ad.clicks || 0), 0);

  const marketplaceAds = rows.ads;
  const marketplaceRevenue =
    marketplaceAds.length * 20.0 + marketplaceAds.reduce((sum, a) => sum + a.clicks * 0.5, 0);

  const txs = rows.transactions;
  const settledGross = txs
    .filter((t) => t.status === "completed" || t.status === "authorized")
    .reduce((sum, t) => sum + (t.action === "charge" ? t.amount : 0), 0);
  const paymentPlatformFees = settledGross * 0.025;

  const referrals = rows.referrals;
  const referralPayouts = referrals.reduce((sum, r) => sum + (r.signups || 0) * 10.0, 0);

  const grossRevenue = adNetworkRevenue + marketplaceRevenue + paymentPlatformFees;
  const netRevenue = Math.max(0, grossRevenue - referralPayouts);
  const averageRPM = totalImpressions > 0 ? (adNetworkRevenue / totalImpressions) * 1000 : 18.5;

  return {
    grossRevenue,
    adNetworkRevenue,
    marketplaceRevenue,
    paymentPlatformFees,
    referralPayouts,
    netRevenue,
    totalImpressions,
    totalAdClicks,
    averageRPM,
  };
}

export async function computeMarketplaceRevenueSummary(
  marketplace: MarketplacePorts,
  transactions: RepositoryPort<TransactionRecord>,
): Promise<RevenueSummary> {
  const [externalAds, ads, referrals] = await Promise.all([
    marketplace.externalAds.findMany(),
    marketplace.ads.findMany(),
    marketplace.referrals.findMany(),
  ]);
  return computeRevenueSummaryFromRows({
    externalAds,
    ads,
    transactions: transactions.findMany(),
    referrals,
  });
}

