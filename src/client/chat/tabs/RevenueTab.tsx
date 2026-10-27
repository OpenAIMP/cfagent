import React from "react";
import { GoogleAdUnit } from "../../GoogleAdUnit";
import { AdBannerConfig } from "../../adBannerConfig";
import type { AdItem } from "../types";
import type { CategoryItem } from "../types";
import type { ExternalAdItem } from "../types";
import { NavTabId } from "../../components/NavigationMenu";
import type { RevenueSummaryData } from "../types";
import type { TableMetadataItem } from "../types";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { PageShell, PageSection } from "../../components/ui/PageShell";
import { Card } from "../../components/ui/Card";
import { Notice } from "../../components/ui/Notice";
import { Select } from "../../components/ui/Select";
import { Table } from "../../components/ui/Table";
import { TextInput } from "../../components/ui/TextInput";

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
            <PageShell
              title="Revenue & Monetization Management"
              scopeNote="Platform revenue accounting across external ad networks (CPM/CPC), sponsored marketplace placements, agent payment processing fees, and referral partner payouts with transactional double-entry ledger persistence."
            >
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  fetchRevenueSummary();
                  fetchExternalAds();
                  fetchCategories();
                  fetchTables();
                }}
                disabled={revenueLoading}
              >
                {revenueLoading ? "Refreshing…" : "🔄 Refresh Financials"}
              </Button>
            </div>

            {/* Comprehensive Revenue Metrics Grid */}
            <PageSection>
            <div className="revenue-grid">
              <Card padding="none" className="rev-card highlight-rev">
                <span className="rev-icon">💵</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.grossRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Total Gross Platform Revenue</span>
                </div>
              </Card>

              <Card padding="none" className="rev-card">
                <span className="rev-icon">🌐</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.adNetworkRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">External Ad Networks (CPM + CPC)</span>
                </div>
              </Card>

              <Card padding="none" className="rev-card">
                <span className="rev-icon">🚀</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.marketplaceRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Direct Sponsored Marketplace</span>
                </div>
              </Card>

              <Card padding="none" className="rev-card">
                <span className="rev-icon">💳</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.paymentPlatformFees?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Payment Processing Fees (2.5%)</span>
                </div>
              </Card>

              <Card padding="none" className="rev-card expense-card">
                <span className="rev-icon">🎁</span>
                <div className="rev-meta">
                  <span className="rev-val">-${revenueSummary?.referralPayouts?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Referral Partner Payouts</span>
                </div>
              </Card>

              <Card padding="none" className="rev-card net-profit-card">
                <span className="rev-icon">💎</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.netRevenue?.toFixed(2) || "0.00"}</span>
                  <span className="rev-label">Net Platform Margin</span>
                </div>
              </Card>

              <Card padding="none" className="rev-card">
                <span className="rev-icon">👁️</span>
                <div className="rev-meta">
                  <span className="rev-val">
                    {revenueSummary?.totalImpressions || 0} / {revenueSummary?.totalAdClicks || 0}
                  </span>
                  <span className="rev-label">Ad Views / Link Clicks</span>
                </div>
              </Card>

              <Card padding="none" className="rev-card">
                <span className="rev-icon">📈</span>
                <div className="rev-meta">
                  <span className="rev-val">${revenueSummary?.averageRPM?.toFixed(2) || "18.50"}</span>
                  <span className="rev-label">Average Ad Network RPM</span>
                </div>
              </Card>
            </div>
            </PageSection>

            {/* External Ad Network Inventory Manager */}
            <PageSection>
            <Card padding="none" className="revenue-section-card">
              <div className="card-header">
                <h4>📡 External Ad Network Placements ({externalAds.length})</h4>
                <p>
                  Manage active network units (EthicalAds, Carbon Ads, Google AdSense, Direct) generating revenue per 1,000 views (CPM) and per click (CPC).
                </p>
              </div>

              <div className="results-table-container">
                <Table
                    columns={[
                      { key: "title", header: "Placement Unit", render: (ad) => (<><strong>{ad.title}</strong><div className="table-subtext">{ad.tagline}</div></>) },
                      { key: "network", header: "Network", render: (ad) => (<span className={`ad-net-tag ${ad.network}`}>{ad.network === "ethicalads" ? "EthicalAds" : ad.network === "carbon" ? "Carbon" : ad.network === "adsense" ? "AdSense" : "Direct"}</span>) },
                      { key: "slot", header: "Slot", render: (ad) => <code>{ad.placement}</code> },
                      { key: "cpm", header: "CPM Rate", render: (ad) => <>${ad.cpmRate.toFixed(2)}</> },
                      { key: "cpc", header: "CPC Rate", render: (ad) => <>${ad.cpcRate.toFixed(2)}</> },
                      { key: "views", header: "Views", render: (ad) => <>{ad.impressions}</> },
                      { key: "clicks", header: "Clicks", render: (ad) => <>{ad.clicks}</> },
                      { key: "earned", header: "Total Earned", render: (ad) => <strong className="earned-text">${ad.earnings.toFixed(2)}</strong> },
                      { key: "status", header: "Status", render: (ad) => <Badge size="xs" uppercase tone={ad.isActive ? "success" : "neutral"}>{ad.isActive ? "ACTIVE" : "PAUSED"}</Badge> },
                      { key: "preview", header: "Live Preview", render: (ad) => <Button variant="accent" tone="subtle" size="sm" onClick={() => handleExternalAdClick(ad)}>{ad.ctaText}</Button> },
                    ]}
                    rows={externalAds}
                    rowKey={(ad) => ad.id}
                  />
              </div>

              {/* Form to Register New Ad Unit */}
              <Card padding="none" className="create-subcard">
                <h5>➕ Register New External Ad Network Placement</h5>
                {extAdSuccessMsg && <Notice tone="success" className="form-alert success">{extAdSuccessMsg}</Notice>}
                {extAdErrorMsg && <Notice tone="danger" className="form-alert error">{extAdErrorMsg}</Notice>}

                <form onSubmit={handleCreateExternalAd} className="compact-form">
                  <div className="form-row-3">
                    <div className="form-group">
                      <label>Ad Campaign Title *</label>
                      <TextInput
                        type="text"
                        placeholder="e.g. DeepSeek R1 Global Inference"
                        value={newExtTitle}
                        onChange={(e) => setNewExtTitle(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Ad Network Provider</label>
                      <Select
                        value={newExtNetwork}
                        onChange={(e) => setNewExtNetwork(e.target.value as any)}
                      >
                        <option value="ethicalads">🛡️ EthicalAds Developer Network</option>
                        <option value="carbon">⚡ Carbon Ads</option>
                        <option value="adsense">🌐 Google AdSense</option>
                        <option value="direct">⭐ Direct Sponsor</option>
                      </Select>
                    </div>
                    <div className="form-group">
                      <label>Placement Slot</label>
                      <Select
                        value={newExtPlacement}
                        onChange={(e) => setNewExtPlacement(e.target.value as any)}
                      >
                        <option value="header_leaderboard">Header Leaderboard (Top)</option>
                        <option value="in_stream">In-Stream Banner (Chat)</option>
                        <option value="footer_deck">Footer Deck</option>
                        <option value="sidebar">Sidebar Rail</option>
                      </Select>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Tagline / Promo Copy</label>
                    <TextInput
                      type="text"
                      placeholder="e.g. Serverless GPUs running 70B reasoning models with sub-second latency."
                      value={newExtTagline}
                      onChange={(e) => setNewExtTagline(e.target.value)}
                    />
                  </div>

                  <div className="form-row-4">
                    <div className="form-group">
                      <label>Target URL *</label>
                      <TextInput
                        type="url"
                        placeholder="https://..."
                        value={newExtUrl}
                        onChange={(e) => setNewExtUrl(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>CTA Label</label>
                      <TextInput
                        type="text"
                        placeholder="Claim Offer →"
                        value={newExtCta}
                        onChange={(e) => setNewExtCta(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>CPM Rate ($/1,000 views)</label>
                      <TextInput
                        type="number"
                        step="0.5"
                        placeholder="18.50"
                        value={newExtCpm}
                        onChange={(e) => setNewExtCpm(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>CPC Rate ($/click)</label>
                      <TextInput
                        type="number"
                        step="0.1"
                        placeholder="1.50"
                        value={newExtCpc}
                        onChange={(e) => setNewExtCpc(e.target.value)}
                      />
                    </div>
                  </div>

                  <Button
                    type="submit"
                    variant="primary"
                    className="submit-action-btn"
                    disabled={savingExtAd || !newExtTitle.trim() || !newExtUrl.trim()}
                  >
                    {savingExtAd ? "Activating Placement…" : "🚀 Activate Ad Network Unit"}
                  </Button>
                </form>
              </Card>
            </Card>
            </PageSection>

            {/* Referral Categories Taxonomy Manager (ORM) */}
            <PageSection>
            <Card padding="none" className="revenue-section-card">
              <div className="card-header">
                <h4>🏷️ Referral Categories &amp; Taxonomy Manager</h4>
                <p>
                  Configure and maintain the categorization taxonomy used by partners to list developer tools, affiliate links, and monetization campaigns.
                </p>
              </div>

              <div className="results-table-container">
                <Table
                    columns={[
                      { key: "icon", header: "Icon", align: "center", render: (cat) => <span style={{ fontSize: "1.25rem", textAlign: "center" }}>{cat.icon}</span> },
                      { key: "name", header: "Category Name", render: (cat) => <strong>{cat.name}</strong> },
                      { key: "slug", header: "Slug", render: (cat) => <code>{cat.slug}</code> },
                      { key: "desc", header: "Description", render: (cat) => <>{cat.description}</> },
                      { key: "order", header: "Sort Order", render: (cat) => <>{cat.sortOrder}</> },
                      { key: "status", header: "Status", render: (cat) => <Badge size="xs" uppercase tone={cat.isActive ? "success" : "neutral"}>{cat.isActive ? "ACTIVE" : "INACTIVE"}</Badge> },
                      { key: "actions", header: "Actions", render: (cat) => <Button variant="danger" tone="subtle" size="sm" onClick={() => handleDeleteCategory(cat.id)} title="Delete category">🗑️ Delete</Button> },
                    ]}
                    rows={categories}
                    rowKey={(cat) => cat.id}
                  />
              </div>

              {/* Form to Add New Category */}
              <Card padding="none" className="create-subcard">
                <h5>➕ Add New Referral Category</h5>
                {catSuccessMsg && <Notice tone="success" className="form-alert success">{catSuccessMsg}</Notice>}
                {catErrorMsg && <Notice tone="danger" className="form-alert error">{catErrorMsg}</Notice>}

                <form onSubmit={handleCreateCategory} className="compact-form">
                  <div className="form-row-3">
                    <div className="form-group">
                      <label>Category Name *</label>
                      <TextInput
                        type="text"
                        placeholder="e.g. Web3 & Crypto, DevOps & CI/CD"
                        value={newCatName}
                        onChange={(e) => setNewCatName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label>Emoji Icon</label>
                      <TextInput
                        type="text"
                        placeholder="⚡"
                        value={newCatIcon}
                        onChange={(e) => setNewCatIcon(e.target.value)}
                        style={{ width: "80px", textAlign: "center" }}
                      />
                    </div>
                    <div className="form-group">
                      <label>Sort Priority (Order)</label>
                      <TextInput
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
                    <TextInput
                      type="text"
                      placeholder="e.g. Decentralized infrastructure, smart contracts, and wallet tooling."
                      value={newCatDesc}
                      onChange={(e) => setNewCatDesc(e.target.value)}
                    />
                  </div>

                  <Button
                    type="submit"
                    variant="primary"
                    className="submit-action-btn"
                    disabled={savingCat || !newCatName.trim()}
                  >
                    {savingCat ? "Saving Category…" : "🏷️ Save Category"}
                  </Button>
                </form>
              </Card>
            </Card>
            </PageSection>

            {/* SQLite ORM Database Tables Schema Inspection */}
            <PageSection>
            <Card padding="none" className="revenue-section-card">
              <div className="card-header">
                <h4>🗄️ Institutional Data Schemas &amp; Record Counts</h4>
                <p>
                  Direct view into institutional records, transaction schemas, and enterprise data repositories.
                </p>
              </div>

              <div className="tables-meta-grid">
                {tables.map((tbl) => (
                  <Card padding="none" key={tbl.name} className="table-card">
                    <div className="table-card-header">
                      <h5><code>{tbl.name}</code></h5>
                      <Badge size="xs" tone="neutral">{tbl.rowCount} rows</Badge>
                    </div>
                    <p className="table-desc">{tbl.description}</p>
                    <div className="table-cols">
                      <span className="col-count">{tbl.columns.length} columns:</span>
                      <div className="col-tags">
                        {tbl.columns.map((c) => (
                          <Badge key={c.name} size="xs" tone={c.isPrimary ? "purple" : "neutral"}>
                            {c.name} {c.isPrimary ? "(PK)" : ""}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div className="table-action">
                      <Button
                        className="browse-data-btn"
                        variant="primary"
                        tone="subtle"
                        size="sm"
                        onClick={() => {
                          setSelectedBrowseTable(tbl.name);
                          browseTable(tbl.name);
                          setTab("nlq");
                        }}
                      >
                        🔍 Browse Table Records →
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </Card>
            </PageSection>

            {/* Google Ads & Multi-Network Monetization Control Center */}
            <PageSection>
            <Card padding="none" className="revenue-section-card">
              <div className="card-header">
                <h4>🌐 Google Ads & Multi-Network Display Engine</h4>
                <p>
                  Configure official Google AdSense and network display banners, test live formats, and track impressions/clicks across the platform.
                </p>
              </div>

              <div className="google-ads-config-grid">
                <Card padding="none" className="config-form-card">
                  <h5>⚙️ Google Ads Configuration</h5>
                  <div className="form-group">
                    <label>Google Ads Display Status</label>
                    <div className="toggle-switch-row">
                      <Button
                        variant={googleAdsEnabled ? "primary" : "secondary"}
                        tone="subtle"
                        onClick={() => setGoogleAdsEnabled(!googleAdsEnabled)}
                      >
                        {googleAdsEnabled ? "🟢 Google Ads Active" : "⚪ Google Ads Paused"}
                      </Button>
                    </div>
                  </div>

                  <div className="form-group">
                    <label>Google AdSense Publisher Client ID</label>
                    <TextInput
                      type="text"
                      placeholder="ca-pub-9842109842109842"
                      value={googlePublisherId}
                      onChange={(e) => setGooglePublisherId(e.target.value)}
                    />
                  </div>

                  <div className="form-row-2">
                    <div className="form-group">
                      <label>Default Ad Slot ID</label>
                      <TextInput
                        type="text"
                        placeholder="7812903456"
                        value={googleSlotId}
                        onChange={(e) => setGoogleSlotId(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>Display Format</label>
                      <Select
                        value={googleAdFormat}
                        onChange={(e) => setGoogleAdFormat(e.target.value as any)}
                      >
                        <option value="responsive">Responsive Banner</option>
                        <option value="leaderboard">728x90 Leaderboard</option>
                        <option value="rectangle">300x250 Medium Rectangle</option>
                      </Select>
                    </div>
                  </div>
                </Card>

                {adBannerConfig.enabled && adBannerConfig.showGoogleAdUnits && Boolean(adBannerConfig.tabVisibility.ads) && googleAdsEnabled && (
                  <Card padding="none" className="live-ad-preview-card">
                    <h5>Live Google Ads Preview</h5>
                    <GoogleAdUnit
                      format={googleAdFormat}
                      publisherId={googlePublisherId}
                      slot={googleSlotId}
                      ad={externalAds.find((a) => a.network === "google" || a.network === "adsense") || externalAds[0]}
                      onTrackClick={handleExternalAdClick}
                    />
                  </Card>
                )}
              </div>
            </Card>
            </PageSection>
            </PageShell>
          </div>
  );
}
