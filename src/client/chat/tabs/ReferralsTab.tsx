import React from "react";
import { GoogleAdUnit } from "../../GoogleAdUnit";
import { AdBannerConfig } from "../../adBannerConfig";
import type { CategoryItem } from "../types";
import type { ExternalAdItem } from "../types";
import type { ReferralItem } from "../types";
import type { User } from "../types";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { PageShell, PageSection } from "../../components/ui/PageShell";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { Select } from "../../components/ui/Select";
import { TextInput } from "../../components/ui/TextInput";

export interface ReferralsTabProps {
  activeShareRefId: string | null;
  adBannerConfig: AdBannerConfig;
  categories: CategoryItem[];
  copiedReferral: boolean;
  copiedShareRefId: string | null;
  discordCopied: boolean;
  externalAds: ExternalAdItem[];
  fetchReferrals: () => Promise<void>;
  googleAdsEnabled: boolean;
  googlePublisherId: string;
  googleSlotId: string;
  handleCopyDiscordEmbed: () => void;
  handleCopyPersonalRef: () => void;
  handleCopyRefDiscordEmbed: (refUrl: string, refTitle: string, refId: string) => void;
  handleCreateReferral: (e: React.FormEvent) => Promise<void>;
  handleDeleteReferral: (id: string) => Promise<void>;
  handleExternalAdClick: (ad: ExternalAdItem) => void;
  handleReferralClick: (ref: ReferralItem) => void;
  newRefCategory: string;
  newRefReward: string;
  newRefTitle: string;
  newRefUrl: string;
  personalReferralUrl: string;
  refFormError: string;
  refFormSuccess: string;
  referrals: ReferralItem[];
  referralsLoading: boolean;
  savingRef: boolean;
  setActiveShareRefId: React.Dispatch<React.SetStateAction<string | null>>;
  setNewRefCategory: React.Dispatch<React.SetStateAction<string>>;
  setNewRefReward: React.Dispatch<React.SetStateAction<string>>;
  setNewRefTitle: React.Dispatch<React.SetStateAction<string>>;
  setNewRefUrl: React.Dispatch<React.SetStateAction<string>>;
  user: User;
}

export function ReferralsTab({activeShareRefId, adBannerConfig, categories, copiedReferral, copiedShareRefId, discordCopied, externalAds, fetchReferrals, googleAdsEnabled, googlePublisherId, googleSlotId, handleCopyDiscordEmbed, handleCopyPersonalRef, handleCopyRefDiscordEmbed, handleCreateReferral, handleDeleteReferral, handleExternalAdClick, handleReferralClick, newRefCategory, newRefReward, newRefTitle, newRefUrl, personalReferralUrl, refFormError, refFormSuccess, referrals, referralsLoading, savingRef, setActiveShareRefId, setNewRefCategory, setNewRefReward, setNewRefTitle, setNewRefUrl, user}: ReferralsTabProps) {
  return (
          <div className="referrals-view">
            <PageShell
              title="Referrals & Partner Hub"
              scopeNote="Invite colleagues to Multi-Agent Studio to unlock GPU compute credits, and place your own developer referral links to earn community rewards."
            >
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={fetchReferrals}
                disabled={referralsLoading}
              >
                {referralsLoading ? "Refreshing…" : "🔄 Refresh"}
              </Button>
            </div>

            {/* Top Share Box */}
            <PageSection>
            <Card padding="none" className="referral-share-card">
              <div className="referral-share-left">
                <Badge size="xs" uppercase tone="neutral">YOUR EXCLUSIVE INVITE LINK</Badge>
                <h4>Share Multi-Agent Studio & Earn $10 Compute Credits</h4>
                <p>
                  When friends or coworkers sign up using your link, both of you unlock 50,000 free inference tokens and premium agent execution limits.
                </p>
                <div className="referral-link-input-group">
                  <TextInput
                    type="text"
                    readOnly
                    value={personalReferralUrl}
                    className="referral-url-field"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <Button
                    variant="primary"
                    onClick={handleCopyPersonalRef}
                  >
                    {copiedReferral ? "✓ Copied!" : "📋 Copy Link"}
                  </Button>
                </div>
              </div>

              <div className="referral-share-right">
                <span className="social-label">Share to All Social Media Platforms:</span>
                <div className="social-buttons-grid">
                  <a
                    href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                      `Build autonomous AI trading and intelligence agents on NextGenTP: ${personalReferralUrl}`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn x-twitter"
                    title="Share on X (Twitter)"
                  >
                    𝕏 X (Twitter)
                  </a>
                  <a
                    href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
                      personalReferralUrl
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn linkedin"
                    title="Share on LinkedIn"
                  >
                    💼 LinkedIn
                  </a>
                  <a
                    href={`https://reddit.com/submit?url=${encodeURIComponent(
                      personalReferralUrl
                    )}&title=${encodeURIComponent("NextGenTP: Autonomous Multi-Agent Trading & Intelligence Platform")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn reddit"
                    title="Share on Reddit"
                  >
                    👽 Reddit
                  </a>
                  <a
                    href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(personalReferralUrl)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn facebook"
                    title="Share on Facebook"
                  >
                    📘 Facebook
                  </a>
                  <a
                    href={`https://api.whatsapp.com/send?text=${encodeURIComponent(
                      `Build autonomous AI agents on Multi-Agent Studio: ${personalReferralUrl}`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn whatsapp"
                    title="Share on WhatsApp"
                  >
                    💬 WhatsApp
                  </a>
                  <a
                    href={`https://t.me/share/url?url=${encodeURIComponent(
                      personalReferralUrl
                    )}&text=${encodeURIComponent("Check out Multi-Agent Studio for edge AI agents")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn telegram"
                    title="Share on Telegram"
                  >
                    ✈️ Telegram
                  </a>
                  <a
                    href={`https://www.threads.net/intent/post?text=${encodeURIComponent(
                      `Autonomous Multi-Agent Trading Platform: ${personalReferralUrl}`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn threads"
                    title="Share on Threads"
                  >
                    🧵 Threads
                  </a>
                  <a
                    href={`https://bsky.app/intent/compose?text=${encodeURIComponent(
                      `Check out NextGenTP for multi-agent trading: ${personalReferralUrl}`
                    )}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn bluesky"
                    title="Share on Bluesky"
                  >
                    🦋 Bluesky
                  </a>
                  <a
                    href={`https://news.ycombinator.com/submitlink?u=${encodeURIComponent(
                      personalReferralUrl
                    )}&t=${encodeURIComponent("NextGenTP: Institutional Multi-Agent Trading System")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn hackernews"
                    title="Share on Hacker News"
                  >
                    🟧 Hacker News
                  </a>
                  <a
                    href={`https://pinterest.com/pin/create/button/?url=${encodeURIComponent(
                      personalReferralUrl
                    )}&description=${encodeURIComponent("Autonomous Multi-Agent Trading & Strategy Execution")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="social-btn pinterest"
                    title="Pin on Pinterest"
                  >
                    📌 Pinterest
                  </a>
                  <Button
                    variant="secondary"
                    onClick={handleCopyDiscordEmbed}
                    title="Copy Discord rich markdown format"
                  >
                    👾 {discordCopied ? "✓ Discord Link Copied!" : "Discord Embed"}
                  </Button>
                </div>
              </div>
            </Card>
            </PageSection>

            {/* Metrics Ribbon */}
            <PageSection>
            <div className="referral-stats-ribbon">
              <Card padding="none" className="stat-card">
                <span className="stat-icon">🔗</span>
                <div className="stat-meta">
                  <span className="stat-num">{referrals.length}</span>
                  <span className="stat-label">Referrals Placed</span>
                </div>
              </Card>
              <Card padding="none" className="stat-card">
                <span className="stat-icon">🖱️</span>
                <div className="stat-meta">
                  <span className="stat-num">{referrals.reduce((sum, r) => sum + r.clicks, 0)}</span>
                  <span className="stat-label">Total Link Clicks</span>
                </div>
              </Card>
              <Card padding="none" className="stat-card">
                <span className="stat-icon">👥</span>
                <div className="stat-meta">
                  <span className="stat-num">
                    {referrals.reduce((sum, r) => sum + r.signups, 0) + (user.login ? 1 : 0)}
                  </span>
                  <span className="stat-label">Referred Sign-ups</span>
                </div>
              </Card>
              <Card padding="none" className="stat-card highlight">
                <span className="stat-icon">💎</span>
                <div className="stat-meta">
                  <span className="stat-num">
                    ${((referrals.reduce((sum, r) => sum + r.signups, 0) + (user.login ? 1 : 0)) * 10).toFixed(0)}.00
                  </span>
                  <span className="stat-label">Earned Compute</span>
                </div>
              </Card>
            </div>
            </PageSection>

            {/* Main 2-column Grid: Place Referral Link Form + Placed Links List */}
            <PageSection>
            <div className="referral-columns-grid">
              {/* Placement Form */}
              <div className="referral-form-card">
                <div className="card-header">
                  <h4>➕ Place a New Referral Link</h4>
                  <p>Publish your affiliate or referral link to your account to share with teammates and fellow developers.</p>
                </div>
                <form onSubmit={handleCreateReferral} className="referral-form">
                  {refFormSuccess && <Notice tone="success" className="form-alert success">{refFormSuccess}</Notice>}
                  {refFormError && <Notice tone="danger" className="form-alert error">{refFormError}</Notice>}

                  <div className="form-group">
                    <label>Link Title / Service *</label>
                    <TextInput
                      type="text"
                      placeholder="e.g. Market Data Pro, Cursor AI, Supabase"
                      value={newRefTitle}
                      onChange={(e) => setNewRefTitle(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>Destination Referral URL *</label>
                    <TextInput
                      type="url"
                      placeholder="https://service.com/?ref=yourname"
                      value={newRefUrl}
                      onChange={(e) => setNewRefUrl(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-row-2">
                    <div className="form-group">
                      <label>Category</label>
                      <Select
                        value={newRefCategory}
                        onChange={(e) => setNewRefCategory(e.target.value)}
                      >
                        {categories.length > 0 ? (
                          categories.map((cat) => (
                            <option key={cat.id} value={cat.name}>
                              {cat.icon} {cat.name}
                            </option>
                          ))
                        ) : (
                          <>
                            <option value="AI & Dev Tools">🤖 AI & Dev Tools</option>
                            <option value="Cloud & Hosting">☁️ Cloud & Hosting</option>
                            <option value="Database & Storage">🗄️ Database & Storage</option>
                            <option value="Security & Auth">🛡️ Security & Auth</option>
                            <option value="SaaS & Productivity">⚡ SaaS & Productivity</option>
                          </>
                        )}
                      </Select>
                    </div>

                    <div className="form-group">
                      <label>Bonus / Reward Offer</label>
                      <TextInput
                        type="text"
                        placeholder="e.g. Get $10 in free API credits"
                        value={newRefReward}
                        onChange={(e) => setNewRefReward(e.target.value)}
                      />
                    </div>
                  </div>

                  <Button
                    type="submit"
                    variant="primary"
                    className="submit-action-btn"
                    disabled={savingRef || !newRefTitle.trim() || !newRefUrl.trim()}
                  >
                    {savingRef ? "Publishing…" : "🚀 Publish Referral Link"}
                  </Button>
                </form>
              </div>

              {/* Placed Links List */}
              <div className="referral-list-card">
                <div className="card-header">
                  <h4>📋 Your Placed Referral Links ({referrals.length})</h4>
                  <p>Track clicks and manage your active promotional URLs.</p>
                </div>

                <div className="referral-items-list">
                  {referrals.length === 0 ? (
                    <EmptyState
                      icon="🔗"
                      title="No referral links placed yet."
                      description="Use the form on the left to add your first affiliate or tool referral link."
                    />
                  ) : (
                    referrals.map((ref) => (
                      <Card padding="none" key={ref.id} className="referral-card-item">
                        <div className="ref-top">
                          <Badge size="xs" tone="accent">{ref.category}</Badge>
                          <Badge size="xs" tone="neutral">🖱️ {ref.clicks} clicks</Badge>
                        </div>
                        <h5 className="ref-title">{ref.title}</h5>
                        <p className="ref-reward">🎁 {ref.rewardText}</p>
                        <div className="ref-url-preview">
                          <code>{ref.url}</code>
                        </div>
                        <div className="ref-footer">
                          <Button
                            variant="secondary"
                            tone="subtle"
                            size="sm"
                            onClick={() => handleReferralClick(ref)}
                          >
                            Test Link ↗
                          </Button>
                          <Button
                            variant="primary"
                            tone="subtle"
                            size="sm"
                            onClick={() => setActiveShareRefId(activeShareRefId === ref.id ? null : ref.id)}
                            title="Share on social media"
                          >
                            📢 Share Link
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteReferral(ref.id)}
                            title="Delete this referral"
                          >
                            🗑️ Delete
                          </Button>
                        </div>
                        {activeShareRefId === ref.id && (
                          <div className="card-social-share-row">
                            <span className="card-share-lbl">Share:</span>
                            <a
                              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn x-twitter"
                              title="Share on X"
                            >
                              𝕏
                            </a>
                            <a
                              href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(ref.url)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn linkedin"
                              title="Share on LinkedIn"
                            >
                              💼
                            </a>
                            <a
                              href={`https://reddit.com/submit?url=${encodeURIComponent(ref.url)}&title=${encodeURIComponent(ref.title)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn reddit"
                              title="Share on Reddit"
                            >
                              👽
                            </a>
                            <a
                              href={`https://api.whatsapp.com/send?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn whatsapp"
                              title="Share on WhatsApp"
                            >
                              💬
                            </a>
                            <a
                              href={`https://t.me/share/url?url=${encodeURIComponent(ref.url)}&text=${encodeURIComponent(ref.title)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn telegram"
                              title="Share on Telegram"
                            >
                              ✈️
                            </a>
                            <a
                              href={`https://threads.net/intent/post?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn threads"
                              title="Share on Threads"
                            >
                              🧵
                            </a>
                            <a
                              href={`https://bsky.app/intent/compose?text=${encodeURIComponent(`${ref.title}: ${ref.url}`)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mini-social-btn bluesky"
                              title="Share on Bluesky"
                            >
                              🦋
                            </a>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleCopyRefDiscordEmbed(ref.url, ref.title, ref.id)}
                              title="Copy Discord embed"
                            >
                              {copiedShareRefId === ref.id ? "✓" : "👾"}
                            </Button>
                          </div>
                        )}
                      </Card>
                    ))
                  )}
                </div>
              </div>
            </div>
            </PageSection>

            {/* Google Ads Display Banner on Referrals Page (Configurable via Settings) */}
            {adBannerConfig.enabled && adBannerConfig.showGoogleAdUnits && Boolean(adBannerConfig.tabVisibility.referrals) && googleAdsEnabled && (
              <div className="referral-ad-slot">
                <GoogleAdUnit
                  format="responsive"
                  publisherId={googlePublisherId}
                  slot={googleSlotId}
                  ad={externalAds.find((a) => a.network === "google" || a.network === "adsense") || externalAds[0]}
                  onTrackClick={handleExternalAdClick}
                />
              </div>
            )}

            {/* Official Social Media Platforms & Developer Community Hub */}
            <PageSection>
            <Card padding="none" className="referral-social-hub-card">
              <div className="card-header">
                <h4>🌐 Official Developer Social Platforms & Communities</h4>
                <p>
                  Connect with the OpenAIMP ecosystem, join real-time agent engineering discussions, and stay updated across all social media networks.
                </p>
              </div>

              <div className="social-platform-grid">
                <a href="https://github.com/OpenAIMP/cfagent" target="_blank" rel="noopener noreferrer" className="platform-card github">
                  <span className="platform-icon">🐙</span>
                  <div className="platform-info">
                    <strong>GitHub</strong>
                    <span>Source code, PRs, and issues</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://discord.com" target="_blank" rel="noopener noreferrer" className="platform-card discord">
                  <span className="platform-icon">👾</span>
                  <div className="platform-info">
                    <strong>Discord Server</strong>
                    <span>Real-time agent developer chat</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://x.com/OpenAIMP" target="_blank" rel="noopener noreferrer" className="platform-card twitter">
                  <span className="platform-icon">𝕏</span>
                  <div className="platform-info">
                    <strong>X (Twitter)</strong>
                    <span>Announcements & product updates</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://youtube.com/@OpenAIMP" target="_blank" rel="noopener noreferrer" className="platform-card youtube">
                  <span className="platform-icon">▶️</span>
                  <div className="platform-info">
                    <strong>YouTube</strong>
                    <span>Video tutorials & agent architecture demos</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://t.me/OpenAIMP" target="_blank" rel="noopener noreferrer" className="platform-card telegram">
                  <span className="platform-icon">✈️</span>
                  <div className="platform-info">
                    <strong>Telegram Community</strong>
                    <span>VIP channel & developer group</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://linkedin.com/company/openaimp" target="_blank" rel="noopener noreferrer" className="platform-card linkedin">
                  <span className="platform-icon">💼</span>
                  <div className="platform-info">
                    <strong>LinkedIn</strong>
                    <span>Enterprise agent solutions & news</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://reddit.com/r/algotrading" target="_blank" rel="noopener noreferrer" className="platform-card reddit">
                  <span className="platform-icon">👽</span>
                  <div className="platform-info">
                    <strong>Reddit</strong>
                    <span>r/algotrading & r/LocalLLaMA discussions</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://bsky.app/profile/openaimp.bsky.social" target="_blank" rel="noopener noreferrer" className="platform-card bluesky">
                  <span className="platform-icon">🦋</span>
                  <div className="platform-info">
                    <strong>Bluesky</strong>
                    <span>Open decentralized social updates</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://threads.net/@openaimp" target="_blank" rel="noopener noreferrer" className="platform-card threads">
                  <span className="platform-icon">🧵</span>
                  <div className="platform-info">
                    <strong>Threads</strong>
                    <span>Bite-sized AI developer discussions</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://instagram.com/openaimp" target="_blank" rel="noopener noreferrer" className="platform-card instagram">
                  <span className="platform-icon">📷</span>
                  <div className="platform-info">
                    <strong>Instagram</strong>
                    <span>Developer behind-the-scenes & clips</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://tiktok.com/@openaimp" target="_blank" rel="noopener noreferrer" className="platform-card tiktok">
                  <span className="platform-icon">🎵</span>
                  <div className="platform-info">
                    <strong>TikTok</strong>
                    <span>Quick tips & AI agent shorts</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
                <a href="https://whatsapp.com" target="_blank" rel="noopener noreferrer" className="platform-card whatsapp">
                  <span className="platform-icon">💬</span>
                  <div className="platform-info">
                    <strong>WhatsApp Community</strong>
                    <span>Direct alerts & release announcements</span>
                  </div>
                  <span className="join-arrow">↗</span>
                </a>
              </div>
            </Card>
            </PageSection>
            </PageShell>
          </div>
  );
}
