import React from "react";
import { adAccentPalette } from "../../designTokens";
import { Select } from "../../components/ui";
import type { AdItem } from "../types";

export interface AdsTabProps {
  adFormError: string;
  adFormSuccess: string;
  ads: AdItem[];
  adsLoading: boolean;
  fetchAds: () => Promise<void>;
  handleAdClick: (ad: AdItem) => void;
  handleCreateAd: (e: React.FormEvent) => Promise<void>;
  newAdColor: string;
  newAdCta: string;
  newAdSponsor: string;
  newAdTagline: string;
  newAdTitle: string;
  newAdUrl: string;
  savingAd: boolean;
  setNewAdColor: React.Dispatch<React.SetStateAction<string>>;
  setNewAdCta: React.Dispatch<React.SetStateAction<string>>;
  setNewAdSponsor: React.Dispatch<React.SetStateAction<string>>;
  setNewAdTagline: React.Dispatch<React.SetStateAction<string>>;
  setNewAdTitle: React.Dispatch<React.SetStateAction<string>>;
  setNewAdUrl: React.Dispatch<React.SetStateAction<string>>;
}

export function AdsTab({adFormError, adFormSuccess, ads, adsLoading, fetchAds, handleAdClick, handleCreateAd, newAdColor, newAdCta, newAdSponsor, newAdTagline, newAdTitle, newAdUrl, savingAd, setNewAdColor, setNewAdCta, setNewAdSponsor, setNewAdTagline, setNewAdTitle, setNewAdUrl}: AdsTabProps) {
  return (
          <div className="ads-view">
            {/* Header */}
            <div className="tab-hero-header">
              <div className="hero-text-block">
                <h3>🚀 Sponsored Offers & Partner Marketplace</h3>
                <p>
                  Discover verified developer promotions, cloud compute grants, and API discounts. All placements run with real-time impression and click tracking.
                </p>
              </div>
              <button
                className="refresh-btn"
                onClick={fetchAds}
                disabled={adsLoading}
              >
                {adsLoading ? "Refreshing…" : "🔄 Refresh"}
              </button>
            </div>

            {/* Sponsored Offers Grid */}
            <div className="ads-grid">
              {ads.map((ad) => (
                <div
                  key={ad.id}
                  className="ad-spotlight-card"
                  style={{
                    borderColor: `${ad.accentColor}50`,
                    boxShadow: `0 8px 32px ${ad.accentColor}15`,
                  }}
                >
                  <div className="ad-card-top">
                    <span
                      className="ad-badge-tag"
                      style={{ background: `${ad.accentColor}25`, color: ad.accentColor }}
                    >
                      {ad.badge}
                    </span>
                    <span className="ad-sponsor-label">Sponsored by {ad.sponsor}</span>
                  </div>

                  <h4 className="ad-card-title">{ad.title}</h4>
                  <p className="ad-card-tagline">{ad.tagline}</p>

                  <div className="ad-stats-row">
                    <span className="ad-stat-pill">👁️ {ad.impressions} impressions</span>
                    <span className="ad-stat-pill">🖱️ {ad.clicks} clicks</span>
                  </div>

                  <div className="ad-card-action">
                    <button
                      type="button"
                      className="ad-cta-button"
                      style={{ background: ad.accentColor }}
                      onClick={() => handleAdClick(ad)}
                    >
                      {ad.ctaText}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Self-serve Ad Submission Form */}
            <div className="sponsor-submission-card">
              <div className="card-header">
                <h4>📢 Submit a Sponsored Placement</h4>
                <p>Feature your tool, API, or infrastructure platform to autonomous agent developers across the network.</p>
              </div>

              <form onSubmit={handleCreateAd} className="ad-submission-form">
                {adFormSuccess && <div className="form-alert success">{adFormSuccess}</div>}
                {adFormError && <div className="form-alert error">{adFormError}</div>}

                <div className="form-row-2">
                  <div className="form-group">
                    <label>Campaign / Product Title *</label>
                    <input
                      type="text"
                      placeholder="e.g. Workers AI Vectorize Bundle"
                      value={newAdTitle}
                      onChange={(e) => setNewAdTitle(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>Sponsor / Brand Name *</label>
                    <input
                      type="text"
                      placeholder="e.g. Cloudflare Platform or Acme Corp"
                      value={newAdSponsor}
                      onChange={(e) => setNewAdSponsor(e.target.value)}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label>Tagline / Offer Description *</label>
                  <input
                    type="text"
                    placeholder="e.g. Accelerate multi-turn LLM reasoning with sub-millisecond vector lookups."
                    value={newAdTagline}
                    onChange={(e) => setNewAdTagline(e.target.value)}
                    required
                  />
                </div>

                <div className="form-row-3">
                  <div className="form-group">
                    <label>Destination Landing URL *</label>
                    <input
                      type="url"
                      placeholder="https://..."
                      value={newAdUrl}
                      onChange={(e) => setNewAdUrl(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>CTA Button Label</label>
                    <input
                      type="text"
                      placeholder="e.g. Claim $50 Credit →"
                      value={newAdCta}
                      onChange={(e) => setNewAdCta(e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <Select
                      label="Accent Color"
                      value={newAdColor}
                      onChange={(e) => setNewAdColor(e.target.value)}
                    >
                      {adAccentPalette.map((c) => (
                        <option key={c.value} value={c.value}>{c.label} ({c.value})</option>
                      ))}
                    </Select>
                  </div>
                </div>

                <button
                  type="submit"
                  className="submit-action-btn ad-btn"
                  disabled={savingAd || !newAdTitle.trim() || !newAdUrl.trim()}
                >
                  {savingAd ? "Submitting Placement…" : "🚀 Launch Sponsored Placement"}
                </button>
              </form>
            </div>
          </div>
  );
}
