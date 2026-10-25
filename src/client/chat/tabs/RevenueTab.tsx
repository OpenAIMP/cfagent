import React from "react";
import { GoogleAdUnit } from "../../GoogleAdUnit";
import { AdBannerConfig } from "../../adBannerConfig";
import type { AdItem } from "../types";
import type { CategoryItem } from "../types";
import type { ExternalAdItem } from "../types";
import { NavTabId } from "../../components/NavigationMenu";
import type { RevenueSummaryData } from "../types";
import type { TableMetadataItem } from "../types";

export interface RevenueTabProps {
  adBannerConfig: AdBannerConfig;
  ads: AdItem[];
  browseTable: (tableName: string, search?: string) => Promise<void>;
  catErrorMsg: string;
  catSuccessMsg: string;
  categories: CategoryItem[];
  extAdErrorMsg: string;
  extAdSuccessMsg: string;
  externalAds: ExternalAdItem[];
  fetchCategories: () => Promise<void>;
  fetchExternalAds: () => Promise<void>;
  fetchRevenueSummary: () => Promise<void>;
  fetchTables: () => Promise<void>;
  googleAdFormat: "responsive" | "leaderboard" | "rectangle";
  googleAdsEnabled: boolean;
  googlePublisherId: string;
  googleSlotId: string;
  handleCreateCategory: (e: React.FormEvent) => Promise<void>;
  handleCreateExternalAd: (e: React.FormEvent) => Promise<void>;
  handleDeleteCategory: (id: string) => Promise<void>;
  handleExternalAdClick: (ad: ExternalAdItem) => void;
  newCatDesc: string;
  newCatIcon: string;
  newCatName: string;
  newCatOrder: string;
  newExtCpc: string;
  newExtCpm: string;
  newExtCta: string;
  newExtNetwork: "direct" | "ethicalads" | "carbon" | "adsense" | "google";
  newExtPlacement: "header_leaderboard" | "in_stream" | "footer_deck" | "sidebar";
  newExtTagline: string;
  newExtTitle: string;
  newExtUrl: string;
  revenueLoading: boolean;
  revenueSummary: RevenueSummaryData | null;
  savingCat: boolean;
  savingExtAd: boolean;
  setGoogleAdFormat: React.Dispatch<React.SetStateAction<"responsive" | "leaderboard" | "rectangle">>;
  setGoogleAdsEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setGooglePublisherId: React.Dispatch<React.SetStateAction<string>>;
  setGoogleSlotId: React.Dispatch<React.SetStateAction<string>>;
  setNewCatDesc: React.Dispatch<React.SetStateAction<string>>;
  setNewCatIcon: React.Dispatch<React.SetStateAction<string>>;
  setNewCatName: React.Dispatch<React.SetStateAction<string>>;
  setNewCatOrder: React.Dispatch<React.SetStateAction<string>>;
  setNewExtCpc: React.Dispatch<React.SetStateAction<string>>;
  setNewExtCpm: React.Dispatch<React.SetStateAction<string>>;
  setNewExtCta: React.Dispatch<React.SetStateAction<string>>;
  setNewExtNetwork: React.Dispatch<React.SetStateAction<"direct" | "ethicalads" | "carbon" | "adsense" | "google">>;
  setNewExtPlacement: React.Dispatch<React.SetStateAction<"header_leaderboard" | "in_stream" | "footer_deck" | "sidebar">>;
  setNewExtTagline: React.Dispatch<React.SetStateAction<string>>;
  setNewExtTitle: React.Dispatch<React.SetStateAction<string>>;
  setNewExtUrl: React.Dispatch<React.SetStateAction<string>>;
  setSelectedBrowseTable: React.Dispatch<React.SetStateAction<string>>;
  setTab: React.Dispatch<React.SetStateAction<NavTabId>>;
  tables: TableMetadataItem[];
}

export function RevenueTab({adBannerConfig, ads, browseTable, catErrorMsg, catSuccessMsg, categories, extAdErrorMsg, extAdSuccessMsg, externalAds, fetchCategories, fetchExternalAds, fetchRevenueSummary, fetchTables, googleAdFormat, googleAdsEnabled, googlePublisherId, googleSlotId, handleCreateCategory, handleCreateExternalAd, handleDeleteCategory, handleExternalAdClick, newCatDesc, newCatIcon, newCatName, newCatOrder, newExtCpc, newExtCpm, newExtCta, newExtNetwork, newExtPlacement, newExtTagline, newExtTitle, newExtUrl, revenueLoading, revenueSummary, savingCat, savingExtAd, setGoogleAdFormat, setGoogleAdsEnabled, setGooglePublisherId, setGoogleSlotId, setNewCatDesc, setNewCatIcon, setNewCatName, setNewCatOrder, setNewExtCpc, setNewExtCpm, setNewExtCta, setNewExtNetwork, setNewExtPlacement, setNewExtTagline, setNewExtTitle, setNewExtUrl, setSelectedBrowseTable, setTab, tables}: RevenueTabProps) {
  return (
          <div className="revenue-view">
            {/* Header */}
            <div className="tab-hero-header">
              <div className="hero-text-block">
                <h3>💰 Revenue & Monetization Management</h3>
                <p>
                  Platform revenue accounting across external ad networks (CPM/CPC), sponsored marketplace placements, agent payment processing fees, and referral partner payouts with transactional double-entry ledger persistence.
                </p>
              </div>
              <button
                className="refresh-btn"
                onClick={() => {
                  fetchRevenueSummary();
                  fetchExternalAds();
                  fetchCategories();
                  fetchTables();
                }}
                disabled={revenueLoading}
              >
                {revenueLoading ? "Refreshing…" : "🔄 Refresh Financials"}
              </button>
            </div>

            {/* Comprehensive Revenue Metrics Grid */}
            <div className="revenue-grid">
              <div className="rev-card highlight-rev">
                <span className="rev-icon">💵</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.grossRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Total Gross Platform Revenue</span>
                </div>
              </div>

              <div className="rev-card">
                <span className="rev-icon">🌐</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.adNetworkRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">External Ad Networks (CPM + CPC)</span>
                </div>
              </div>

              <div className="rev-card">
                <span className="rev-icon">🚀</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.marketplaceRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Direct Sponsored Marketplace</span>
                </div>
              </div>

              <div className="rev-card">
                <span className="rev-icon">💳</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.paymentPlatformFees?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Payment Processing Fees (2.5%)</span>
                </div>
              </div>

              <div className="rev-card expense-card">
                <span className="rev-icon">🎁</span>
                <div className="rev-meta">
                  <span className="rev-val">-${revenueSummary?.referralPayouts?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Referral Partner Payouts</span>
                </div>
              </div>

              <div className="rev-card net-profit-card">
                <span className="rev-icon">💎</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.netRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Net Platform Margin</span>
                </div>
              </div>

              <div className="rev-card">
                <span className="rev-icon">👁️</span>
                <div className="rev-meta">
                  <span className="rev-val">
                    {revenueSummary?.totalImpressions || 0} / {revenueSummary?.totalAdClicks || 0}
                  </span>
                  <span className="rev-label">Ad Views / Link Clicks</span>
                </div>
              </div>

              <div className="rev-card">
                <span className="rev-icon">📈</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.averageRPM?.toFixed(2) || "18.50"}</span>
                  <span className="rev-label">Average Ad Network RPM</span>
                </div>
              </div>
            </div>

            {/* External Ad Network Inventory Manager */}
            <div className="revenue-section-card">
              <div className="card-header">
                <h4>📡 External Ad Network Placements ({externalAds.length})</h4>
                <p>
                  Manage active network units (EthicalAds, Carbon Ads, Google AdSense, Direct) generating revenue per 1,000 views (CPM) and per click (CPC).
                </p>
              </div>

              <div className="results-table-container">
                <table className="results-table">
                  <thead>
                    <tr>
                      <th>Placement Unit</th>
                      <th>Network</th>
                      <th>Slot</th>
                      <th>CPM Rate</th>
                      <th>CPC Rate</th>
                      <th>Views</th>
                      <th>Clicks</th>
                      <th>Total Earned</th>
                      <th>Status</th>
                      <th>Live Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {externalAds.map((ad) => (
                      <tr key={ad.id}>
                        <td>
                          <strong>{ad.title}</strong>
                          <div className="table-subtext">{ad.tagline}</div>
                        </td>
                        <td>
                          <span className={`ad-net-tag ${ad.network}`}>
                            {ad.network === "ethicalads" ? "EthicalAds" : ad.network === "carbon" ? "Carbon" : ad.network === "adsense" ? "AdSense" : "Direct"}
                          </span>
                        </td>
                        <td><code>{ad.placement}</code></td>
                        <td>${ad.cpmRate.toFixed(2)}</td>
                        <td>${ad.cpcRate.toFixed(2)}</td>
                        <td>{ad.impressions}</td>
                        <td>{ad.clicks}</td>
                        <td><strong className="earned-text">${ad.earnings.toFixed(2)}</strong></td>
                        <td>
                          <span className={`status-pill ${ad.isActive ? "active" : "inactive"}`}>
                            {ad.isActive ? "ACTIVE" : "PAUSED"}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="test-ad-btn"
                            onClick={() => handleExternalAdClick(ad)}
                          >
                            {ad.ctaText}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Form to Register New Ad Unit */}
              <div className="create-subcard">
                <h5>➕ Register New External Ad Network Placement</h5>
                {extAdSuccessMsg && <div className="form-alert success">{extAdSuccessMsg}</div>}
                {extAdErrorMsg && <div className="form-alert error">{extAdErrorMsg}</div>}

                <form onSubmit={handleCreateExternalAd} className="compact-form">
                  <div className="form-row-3">
                    <div className="form-group">
                      <label>Ad Campaign Title *</label>
                      <input
                        type="text"
                        placeholder="e.g. DeepSeek R1 Global Inference"
                        value={newExtTitle}
                        onChange={(e) => setNewExtTitle(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Ad Network Provider</label>
                      <select
                        value={newExtNetwork}
                        onChange={(e) => setNewExtNetwork(e.target.value as any)}
                      >
                        <option value="ethicalads">🛡️ EthicalAds Developer Network</option>
                        <option value="carbon">⚡ Carbon Ads</option>
                        <option value="adsense">🌐 Google AdSense</option>
                        <option value="direct">⭐ Direct Sponsor</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Placement Slot</label>
                      <select
                        value={newExtPlacement}
                        onChange={(e) => setNewExtPlacement(e.target.value as any)}
                      >
                        <option value="header_leaderboard">Header Leaderboard (Top)</option>
                        <option value="in_stream">In-Stream Banner (Chat)</option>
                        <option value="footer_deck">Footer Deck</option>
                        <option value="sidebar">Sidebar Rail</option>
                      </select>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Tagline / Promo Copy</label>
                    <input
                      type="text"
                      placeholder="e.g. Serverless GPUs running 70B reasoning models with sub-second latency."
                      value={newExtTagline}
                      onChange={(e) => setNewExtTagline(e.target.value)}
                    />
                  </div>

                  <div className="form-row-4">
                    <div className="form-group">
                      <label>Target URL *</label>
                      <input
                        type="url"
                        placeholder="https://..."
                        value={newExtUrl}
                        onChange={(e) => setNewExtUrl(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>CTA Label</label>
                      <input
                        type="text"
                        placeholder="Claim Offer →"
                        value={newExtCta}
                        onChange={(e) => setNewExtCta(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>CPM Rate ($/1,000 views)</label>
                      <input
                        type="number"
                        step="0.5"
                        placeholder="18.50"
                        value={newExtCpm}
                        onChange={(e) => setNewExtCpm(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>CPC Rate ($/click)</label>
                      <input
                        type="number"
                        step="0.1"
                        placeholder="1.50"
                        value={newExtCpc}
                        onChange={(e) => setNewExtCpc(e.target.value)}
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="submit-action-btn"
                    disabled={savingExtAd || !newExtTitle.trim() || !newExtUrl.trim()}
                  >
                    {savingExtAd ? "Activating Placement…" : "🚀 Activate Ad Network Unit"}
                  </button>
                </form>
              </div>
            </div>

            {/* Referral Categories Taxonomy Manager (ORM) */}
            <div className="revenue-section-card">
              <div className="card-header">
                <h4>🏷️ Referral Categories &amp; Taxonomy Manager</h4>
                <p>
                  Configure and maintain the categorization taxonomy used by partners to list developer tools, affiliate links, and monetization campaigns.
                </p>
              </div>

              <div className="results-table-container">
                <table className="results-table">
                  <thead>
                    <tr>
                      <th>Icon</th>
                      <th>Category Name</th>
                      <th>Slug</th>
                      <th>Description</th>
                      <th>Sort Order</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categories.map((cat) => (
                      <tr key={cat.id}>
                        <td style={{ fontSize: "1.25rem", textAlign: "center" }}>{cat.icon}</td>
                        <td><strong>{cat.name}</strong></td>
                        <td><code>{cat.slug}</code></td>
                        <td>{cat.description}</td>
                        <td>{cat.sortOrder}</td>
                        <td>
                          <span className={`status-pill ${cat.isActive ? "active" : "inactive"}`}>
                            {cat.isActive ? "ACTIVE" : "INACTIVE"}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="danger-sm-btn"
                            onClick={() => handleDeleteCategory(cat.id)}
                            title="Delete category"
                          >
                            🗑️ Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Form to Add New Category */}
              <div className="create-subcard">
                <h5>➕ Add New Referral Category</h5>
                {catSuccessMsg && <div className="form-alert success">{catSuccessMsg}</div>}
                {catErrorMsg && <div className="form-alert error">{catErrorMsg}</div>}

                <form onSubmit={handleCreateCategory} className="compact-form">
                  <div className="form-row-3">
                    <div className="form-group">
                      <label>Category Name *</label>
                      <input
                        type="text"
                        placeholder="e.g. Web3 & Crypto, DevOps & CI/CD"
                        value={newCatName}
                        onChange={(e) => setNewCatName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Emoji Icon</label>
                      <input
                        type="text"
                        placeholder="⚡"
                        value={newCatIcon}
                        onChange={(e) => setNewCatIcon(e.target.value)}
                        style={{ width: "80px", textAlign: "center" }}
                      />
                    </div>
                    <div className="form-group">
                      <label>Sort Priority (Order)</label>
                      <input
                        type="number"
                        placeholder="10"
                        value={newCatOrder}
                        onChange={(e) => setNewCatOrder(e.target.value)}
                        style={{ width: "100px" }}
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Description</label>
                    <input
                      type="text"
                      placeholder="e.g. Decentralized infrastructure, smart contracts, and wallet tooling."
                      value={newCatDesc}
                      onChange={(e) => setNewCatDesc(e.target.value)}
                    />
                  </div>

                  <button
                    type="submit"
                    className="submit-action-btn"
                    disabled={savingCat || !newCatName.trim()}
                  >
                    {savingCat ? "Saving Category…" : "🏷️ Save Category"}
                  </button>
                </form>
              </div>
            </div>

            {/* SQLite ORM Database Tables Schema Inspection */}
            <div className="revenue-section-card">
              <div className="card-header">
                <h4>🗄️ Institutional Data Schemas &amp; Record Counts</h4>
                <p>
                  Direct view into institutional records, transaction schemas, and enterprise data repositories.
                </p>
              </div>

              <div className="tables-meta-grid">
                {tables.map((tbl) => (
                  <div key={tbl.name} className="table-card">
                    <div className="table-card-header">
                      <h5><code>{tbl.name}</code></h5>
                      <span className="row-count-badge">{tbl.rowCount} rows</span>
                    </div>
                    <p className="table-desc">{tbl.description}</p>
                    <div className="table-cols">
                      <span className="col-count">{tbl.columns.length} columns:</span>
                      <div className="col-tags">
                        {tbl.columns.map((c) => (
                          <span key={c.name} className={`col-pill ${c.isPrimary ? "pk" : ""}`}>
                            {c.name} {c.isPrimary ? "(PK)" : ""}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="table-action">
                      <button
                        type="button"
                        className="browse-data-btn"
                        onClick={() => {
                          setSelectedBrowseTable(tbl.name);
                          browseTable(tbl.name);
                          setTab("nlq");
                        }}
                      >
                        🔍 Browse Table Records →
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Google Ads & Multi-Network Monetization Control Center */}
            <div className="revenue-section-card">
              <div className="card-header">
                <h4>🌐 Google Ads & Multi-Network Display Engine</h4>
                <p>
                  Configure official Google AdSense and network display banners, test live formats, and track impressions/clicks across the platform.
                </p>
              </div>

              <div className="google-ads-config-grid">
                <div className="config-form-card">
                  <h5>⚙️ Google Ads Configuration</h5>
                  <div className="form-group">
                    <label>Google Ads Display Status</label>
                    <div className="toggle-switch-row">
                      <button
                        type="button"
                        className={`toggle-btn ${googleAdsEnabled ? "active" : ""}`}
                        onClick={() => setGoogleAdsEnabled(!googleAdsEnabled)}
                      >
                        {googleAdsEnabled ? "🟢 Google Ads Active" : "⚪ Google Ads Paused"}
                      </button>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Google AdSense Publisher Client ID</label>
                    <input
                      type="text"
                      placeholder="ca-pub-9842109842109842"
                      value={googlePublisherId}
                      onChange={(e) => setGooglePublisherId(e.target.value)}
                    />
                  </div>

                  <div className="form-row-2">
                    <div className="form-group">
                      <label>Default Ad Slot ID</label>
                      <input
                        type="text"
                        placeholder="7812903456"
                        value={googleSlotId}
                        onChange={(e) => setGoogleSlotId(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>Display Format</label>
                      <select
                        value={googleAdFormat}
                        onChange={(e) => setGoogleAdFormat(e.target.value as any)}
                      >
                        <option value="responsive">Responsive Banner</option>
                        <option value="leaderboard">728x90 Leaderboard</option>
                        <option value="rectangle">300x250 Medium Rectangle</option>
                      </select>
                    </div>
                  </div>
                </div>

                {adBannerConfig.enabled && adBannerConfig.showGoogleAdUnits && Boolean(adBannerConfig.tabVisibility.ads) && googleAdsEnabled && (
                  <div className="live-ad-preview-card">
                    <h5>Live Google Ads Preview</h5>
                    <GoogleAdUnit
                      format={googleAdFormat}
                      publisherId={googlePublisherId}
                      slot={googleSlotId}
                      ad={externalAds.find((a) => a.network === "google" || a.network === "adsense") || externalAds[0]}
                      onTrackClick={handleExternalAdClick}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
  );
}
