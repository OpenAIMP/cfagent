import React, { useState } from "react";

export interface PartnerDeal {
  id: string;
  title: string;
  tagline: string;
  sponsor: string;
  badge?: string;
  url: string;
  ctaText?: string;
  accentColor?: string;
  category?: string;
}

export interface PartnerDealsModalProps {
  isOpen: boolean;
  onClose: () => void;
  ads?: any[];
  externalAds?: any[];
  onAdClick?: (ad: any) => void;
  onExternalAdClick?: (ad: any) => void;
}

const DEFAULT_PARTNER_DEALS: PartnerDeal[] = [
  {
    id: "ad_workers_ai",
    title: "Cloudflare Workers AI",
    tagline: "Run state-of-the-art models (GLM-4.7, Llama 3.3) on serverless GPUs with zero cold starts.",
    sponsor: "Cloudflare",
    badge: "FLAGSHIP PARTNER",
    url: "https://developers.cloudflare.com/workers-ai/",
    ctaText: "Deploy in 60s →",
    accentColor: "var(--color-warning)",
    category: "AI & Serverless",
  },
  {
    id: "ad_ai_search",
    title: "Cloudflare AI Search",
    tagline: "Build enterprise RAG pipelines with native auto-chunking, Vectorize indexes, and real-time semantic retrieval.",
    sponsor: "Cloudflare AI",
    badge: "FEATURED TOOL",
    url: "https://developers.cloudflare.com/ai-search/",
    ctaText: "Explore Docs →",
    accentColor: "var(--color-accent)",
    category: "AI & Serverless",
  },
  {
    id: "ad_durable_objects",
    title: "Durable Objects SQLite",
    tagline: "Strongly consistent transactional databases running natively at the edge for stateful AI agents.",
    sponsor: "Cloudflare Platform",
    badge: "INFRASTRUCTURE",
    url: "https://developers.cloudflare.com/durable-objects/",
    ctaText: "Learn More →",
    accentColor: "var(--color-sentiment-directional)",
    category: "Infrastructure",
  },
  {
    id: "g_ad_vertex",
    title: "Google Cloud Vertex AI & TPU v5e",
    tagline: "Build, deploy, and scale enterprise multimodal AI models with sub-second latency and $300 in free trial credits.",
    sponsor: "Google Cloud",
    badge: "CLOUD CREDITS",
    url: "https://cloud.google.com/vertex-ai",
    ctaText: "Start Free with $300 →",
    accentColor: "var(--color-accent)",
    category: "Cloud Platforms",
  },
  {
    id: "g_ad_bigquery",
    title: "Google BigQuery Serverless Analytics",
    tagline: "Query petabytes of analytics data in seconds without managing servers or storage infrastructure.",
    sponsor: "Google Cloud Data",
    badge: "ANALYTICS",
    url: "https://cloud.google.com/bigquery",
    ctaText: "Explore BigQuery Studio →",
    accentColor: "var(--color-success)",
    category: "Analytics & Data",
  },
];

export function PartnerDealsModal({
  isOpen,
  onClose,
  ads = [],
  externalAds = [],
  onAdClick,
  onExternalAdClick,
}: PartnerDealsModalProps) {
  const [filterCategory, setFilterCategory] = useState<string>("All");

  if (!isOpen) return null;

  // Merge runtime ads with defaults to present comprehensive external deals showcase
  const combinedDeals: PartnerDeal[] = [
    ...ads.map((a) => ({
      id: a.id || `ad_${Math.random()}`,
      title: a.title,
      tagline: a.tagline,
      sponsor: a.sponsor || "Partner",
      badge: a.badge || "SPONSOR",
      url: a.url,
      ctaText: a.ctaText || "View Offer →",
      accentColor: a.accentColor || "var(--color-accent)",
      category: "Direct Partner",
    })),
    ...DEFAULT_PARTNER_DEALS.filter((d) => !ads.some((a) => a.id === d.id)),
  ];

  const categories = ["All", ...Array.from(new Set(combinedDeals.map((d) => d.category || "General")))];
  const filteredDeals = filterCategory === "All"
    ? combinedDeals
    : combinedDeals.filter((d) => d.category === filterCategory);

  return (
    <div className="partner-deals-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="partner-deals-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="partner-deals-header">
          <div className="partner-deals-title-area">
            <span className="partner-deals-icon">⭐</span>
            <div>
              <h3 className="partner-deals-title">Partner Deals &amp; Developer Ecosystem</h3>
              <p className="partner-deals-subtitle">
                Externalized partner offers, sponsored developer credits, and tooling integrations.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="partner-deals-close-btn"
            onClick={onClose}
            aria-label="Close partner deals modal"
          >
            ✕
          </button>
        </div>

        {/* Notice explaining clean UI guarantee */}
        <div className="partner-deals-notice">
          🛡️ <strong>Clean Workspace Guarantee:</strong> Ads and promotional banners have been externalized from all trading tabs. You can browse offers here on-demand without cluttering your workspace.
        </div>

        {/* Category Filters */}
        <div className="partner-deals-category-bar">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`partner-deals-cat-btn ${filterCategory === cat ? "active" : ""}`}
              onClick={() => setFilterCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Deals Grid */}
        <div className="partner-deals-grid">
          {filteredDeals.map((deal) => {
            const color = deal.accentColor || "var(--color-accent)";
            return (
              <div
                key={deal.id}
                className="partner-deal-card"
                style={{ borderTop: `3px solid ${color}` }}
              >
                <div className="deal-card-header">
                  <span
                    className="deal-badge"
                    style={{ background: `${color}22`, color }}
                  >
                    {deal.badge || "PARTNER"}
                  </span>
                  <span className="deal-sponsor">{deal.sponsor}</span>
                </div>

                <h4 className="deal-title">{deal.title}</h4>
                <p className="deal-tagline">{deal.tagline}</p>

                <div className="deal-footer">
                  <button
                    type="button"
                    className="deal-cta-btn"
                    style={{ background: color }}
                    onClick={() => {
                      if (onAdClick) {
                        onAdClick(deal);
                      } else {
                        window.open(deal.url, "_blank", "noopener,noreferrer");
                      }
                    }}
                  >
                    {deal.ctaText || "Claim Deal →"}
                  </button>
                  <a
                    href={deal.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="deal-direct-link"
                    title={`Visit ${deal.sponsor}`}
                  >
                    Direct Link ↗
                  </a>
                </div>
              </div>
            );
          })}
        </div>

        {/* External Ad Network placements summary */}
        {externalAds && externalAds.length > 0 && (
          <div className="partner-deals-networks-strip">
            <span className="networks-label">🌐 Active Network Placements:</span>
            <div className="networks-list">
              {externalAds.map((ea, idx) => (
                <span
                  key={idx}
                  className="network-item-chip"
                  onClick={() => onExternalAdClick?.(ea)}
                  title={`Open ${ea.title}`}
                >
                  {ea.title} ({ea.network}) ➔
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="partner-deals-footer">
          <span className="deals-counter">Showing {filteredDeals.length} partner offer{filteredDeals.length === 1 ? "" : "s"}</span>
          <button type="button" className="partner-deals-dismiss-btn" onClick={onClose}>
            Back to Workspace
          </button>
        </div>
      </div>
    </div>
  );
}
