import React, { useState, useRef, useEffect } from "react";
import { OptionsDataDownloadDropdown } from "./options/optionsDataExporter";
import {
  NAVIGATION_ITEMS,
  DEFAULT_VISIBLE_NAV_TABS,
  NAV_TAB_PRESETS,
} from "./components/NavigationMenu";
import { AsyncJobsPanel } from "./AsyncJobsPanel";
import {
  AdBannerConfig,
  getStoredAdBannerConfig,
  saveStoredAdBannerConfig,
} from "./adBannerConfig";
import {
  FONT_STYLE_OPTIONS,
  FONT_SCALE_PRESETS,
  FontStyleId,
  getStoredFontScale,
  getStoredFontStyle,
  applyTypography,
  adjustFontScale,
} from "./typography";

export interface SettingsMenuProps {
  activeEnv?: "TEST" | "PROD";
  oauthStatus?: {
    authenticated?: boolean;
    renewable?: boolean;
    accessTokenExpiresAt?: string;
    environment?: string;
    error?: string;
  } | null;
  account?: {
    accountId?: string;
    accountDesc?: string;
    netAccountValue?: number;
  } | null;
  brokerStatus?: {
    environment?: string;
    activeEnvironment?: string;
  } | null;
  maskAccount?: boolean;
  setMaskAccount?: (val: boolean) => void;
  diagnosticsLoading?: boolean;
  oauthLoading?: boolean;
  oauthMsg?: string;
  setOauthMsg?: (msg: string) => void;
  handleSwitchEnvironment?: (env: "TEST" | "PROD") => void;
  handleSwitchAndConnect?: (env: "TEST" | "PROD") => void;
  runDiagnostics?: () => void;
  handleRenewOAuth?: () => void;
  handleRevokeOAuth?: () => void;
  handleStartOAuth?: () => void;
  onOpenEtapiTuning?: () => void;
  userLogin?: string;
  userName?: string;
  userAvatar?: string;
  defaultSymbol?: string;
  // System & appearance preferences
  theme?: string;
  onCycleTheme?: () => void;
  currentLayout?: "left" | "top";
  onToggleLayout?: (layout: "left" | "top") => void;
  accountMode?: "paper" | "live";
  onToggleAccountMode?: () => void;
  // Navbar Tab visibility customization
  visibleTabs?: Record<string, boolean>;
  onToggleTabVisibility?: (tabId: string) => void;
  onSetVisibleTabs?: (tabs: Record<string, boolean>) => void;
  // Centralized Auto-Refresh Settings
  autoRefreshEnabled?: boolean;
  autoRefreshInterval?: number;
  onToggleAutoRefresh?: (enabled: boolean, interval?: number) => void;
  // Ads & Sponsor Banners Configuration
  adBannerConfig?: AdBannerConfig;
  onUpdateAdBannerConfig?: (config: AdBannerConfig) => void;
  onOpenPartnerDeals?: () => void;
}

export type ETradeDynamicMenuProps = SettingsMenuProps;

export function SettingsMenu({
  activeEnv,
  oauthStatus,
  account,
  brokerStatus,
  maskAccount,
  setMaskAccount,
  diagnosticsLoading = false,
  oauthLoading = false,
  oauthMsg = "",
  setOauthMsg,
  handleSwitchEnvironment,
  handleSwitchAndConnect,
  runDiagnostics,
  handleRenewOAuth,
  handleRevokeOAuth,
  handleStartOAuth,
  onOpenEtapiTuning,
  userLogin = "OpenAIMP",
  userName = "OpenAIMP",
  userAvatar,
  defaultSymbol = "NVDA",
  theme = "auto",
  onCycleTheme,
  currentLayout = "left",
  onToggleLayout,
  accountMode,
  onToggleAccountMode,
  visibleTabs,
  onToggleTabVisibility,
  onSetVisibleTabs,
  autoRefreshEnabled,
  autoRefreshInterval,
  onToggleAutoRefresh,
  adBannerConfig,
  onUpdateAdBannerConfig,
  onOpenPartnerDeals,
}: SettingsMenuProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [downloadSymbol, setDownloadSymbol] = useState(defaultSymbol);
  const menuRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fallback state if props are not yet passed from Hub
  const [localEnv, setLocalEnv] = useState<"TEST" | "PROD">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("etrade_active_env");
      if (saved === "TEST" || saved === "PROD") return saved;
    }
    return activeEnv || "PROD";
  });
  const [localMask, setLocalMask] = useState(true);
  const [localMsg, setLocalMsg] = useState("");
  const [localDiagLoading, setLocalDiagLoading] = useState(false);

  // Local state for auto-refresh configuration if not controlled by parent
  const [localAutoRefreshEnabled, setLocalAutoRefreshEnabled] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("cfagent_global_autorefresh_enabled");
      if (stored !== null) return stored === "true";
      return localStorage.getItem("cfagent_options_autorefresh_enabled") === "true";
    }
    return false;
  });
  const [localAutoRefreshInterval, setLocalAutoRefreshInterval] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("cfagent_global_autorefresh_interval");
      if (stored) return Number(stored);
      const fallback = localStorage.getItem("cfagent_options_autorefresh_interval");
      if (fallback) return Number(fallback);
    }
    return 15;
  });

  const effectiveAutoRefreshEnabled = autoRefreshEnabled !== undefined ? autoRefreshEnabled : localAutoRefreshEnabled;
  const effectiveAutoRefreshInterval = autoRefreshInterval !== undefined ? autoRefreshInterval : localAutoRefreshInterval;

  const handleSetAutoRefresh = (enabled: boolean, interval?: number) => {
    const nextInterval = interval !== undefined ? interval : effectiveAutoRefreshInterval;
    setLocalAutoRefreshEnabled(enabled);
    if (interval !== undefined) setLocalAutoRefreshInterval(interval);
    if (onToggleAutoRefresh) {
      onToggleAutoRefresh(enabled, nextInterval);
    } else if (typeof window !== "undefined") {
      localStorage.setItem("cfagent_global_autorefresh_enabled", String(enabled));
      localStorage.setItem("cfagent_global_autorefresh_interval", String(nextInterval));
      localStorage.setItem("cfagent_options_autorefresh_enabled", String(enabled));
      localStorage.setItem("cfagent_options_autorefresh_interval", String(nextInterval));
      window.dispatchEvent(
        new CustomEvent("cfagent-autorefresh-changed", { detail: { enabled, interval: nextInterval } })
      );
    }
  };

  // Local state for Ad / Sponsor banner configuration
  const [localAdConfig, setLocalAdConfig] = useState<AdBannerConfig>(() => getStoredAdBannerConfig());

  useEffect(() => {
    if (adBannerConfig) {
      setLocalAdConfig(adBannerConfig);
    }
  }, [adBannerConfig]);

  const effectiveAdConfig = adBannerConfig || localAdConfig;

  const handleToggleAdMaster = (enabled: boolean) => {
    const next: AdBannerConfig = {
      ...effectiveAdConfig,
      enabled,
    };
    setLocalAdConfig(next);
    saveStoredAdBannerConfig(next);
    onUpdateAdBannerConfig?.(next);
  };

  const handleToggleAdOption = (key: keyof AdBannerConfig, val: boolean) => {
    const next: AdBannerConfig = {
      ...effectiveAdConfig,
      [key]: val,
    };
    setLocalAdConfig(next);
    saveStoredAdBannerConfig(next);
    onUpdateAdBannerConfig?.(next);
  };

  // Local state for visible navbar tabs if not controlled by parent
  const [localVisibleTabs, setLocalVisibleTabs] = useState<Record<string, boolean>>(() => {
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("nextgentp_visible_nav_tabs");
        if (saved) return { ...DEFAULT_VISIBLE_NAV_TABS, ...JSON.parse(saved) };
      } catch {}
    }
    return DEFAULT_VISIBLE_NAV_TABS;
  });

  const effectiveVisibleTabs = visibleTabs || localVisibleTabs;

  const handleToggleTab = (tabId: string) => {
    if (onToggleTabVisibility) {
      onToggleTabVisibility(tabId);
    } else {
      const next = {
        ...effectiveVisibleTabs,
        [tabId]: effectiveVisibleTabs[tabId] === false ? true : false,
      };
      setLocalVisibleTabs(next);
      if (typeof window !== "undefined") {
        localStorage.setItem("nextgentp_visible_nav_tabs", JSON.stringify(next));
      }
    }
  };

  const handleApplyPreset = (preset: Record<string, boolean>) => {
    if (onSetVisibleTabs) {
      onSetVisibleTabs(preset);
    } else {
      setLocalVisibleTabs(preset);
      if (typeof window !== "undefined") {
        localStorage.setItem("nextgentp_visible_nav_tabs", JSON.stringify(preset));
      }
    }
  };

  // Sync props when they change
  useEffect(() => {
    if (activeEnv) {
      setLocalEnv(activeEnv);
    }
  }, [activeEnv]);

  // Global Typography Preferences
  const [fontScale, setFontScale] = useState<number>(getStoredFontScale);
  const [fontStyle, setFontStyle] = useState<FontStyleId>(getStoredFontStyle);

  useEffect(() => {
    function handleTypographyChange(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.scale !== undefined) setFontScale(detail.scale);
      if (detail?.styleId) setFontStyle(detail.styleId);
    }
    window.addEventListener("typography-changed", handleTypographyChange);
    return () => {
      window.removeEventListener("typography-changed", handleTypographyChange);
    };
  }, []);

  const handleFontScaleChange = (newScale: number) => {
    setFontScale(newScale);
    applyTypography(newScale, fontStyle);
  };

  const handleFontStyleChange = (newStyle: FontStyleId) => {
    setFontStyle(newStyle);
    applyTypography(fontScale, newStyle);
  };

  const effectiveEnv = activeEnv || localEnv;
  const effectiveMask = maskAccount !== undefined ? maskAccount : localMask;
  const toggleMask = () => {
    if (setMaskAccount) {
      setMaskAccount(!effectiveMask);
    } else {
      setLocalMask(!effectiveMask);
    }
  };

  const effectiveMsg = oauthMsg !== undefined ? oauthMsg : localMsg;
  const clearMsg = () => {
    if (setOauthMsg) {
      setOauthMsg("");
    } else {
      setLocalMsg("");
    }
  };

  const isOpen = isHovered || isPinned;

  const isLive =
    effectiveEnv === "PROD" ||
    brokerStatus?.environment === "live" ||
    brokerStatus?.activeEnvironment === "PROD";

  const isConnected = !!oauthStatus?.authenticated;
  const accountValue = account?.netAccountValue;

  const handleMouseEnter = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 220);
  };

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsPinned((prev) => !prev);
  };

  // Sync defaultSymbol when prop changes
  useEffect(() => {
    if (defaultSymbol && defaultSymbol.trim()) {
      setDownloadSymbol(defaultSymbol.trim().toUpperCase());
    }
  }, [defaultSymbol]);

  // Listen for global open-settings-menu event (e.g. from sidebar or hotkey)
  useEffect(() => {
    function handleToggleSettings() {
      setIsPinned((prev) => !prev);
    }
    window.addEventListener("open-settings-menu", handleToggleSettings);
    return () => {
      window.removeEventListener("open-settings-menu", handleToggleSettings);
    };
  }, []);

  // Close menu on click outside or Escape
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsPinned(false);
        setIsHovered(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsPinned(false);
        setIsHovered(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const onSwitchEnv = (target: "TEST" | "PROD") => {
    setLocalEnv(target);
    if (typeof window !== "undefined") {
      localStorage.setItem("etrade_active_env", target);
      window.dispatchEvent(new CustomEvent("etrade-env-changed", { detail: { env: target } }));
    }
    if (handleSwitchEnvironment) {
      handleSwitchEnvironment(target);
    } else {
      fetch("/api/broker/etrade/environment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment: target }),
      }).catch(() => {});
    }
  };

  const handleOpenTuning = () => {
    setIsPinned(false);
    setIsHovered(false);
    if (onOpenEtapiTuning) {
      onOpenEtapiTuning();
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("open-etapi-tuning"));
    }
  };

  const onRunDiagnostics = () => {
    setIsPinned(false);
    setIsHovered(false);
    if (runDiagnostics) {
      runDiagnostics();
    } else {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("open-etrade-diagnostics"));
      }
      setLocalDiagLoading(true);
      fetch(`/api/etrade/diagnostics`, {
        headers: { "x-environment": effectiveEnv },
      })
        .then((r) => r.json())
        .then((data: any) => {
          if (data && data.status) {
            setLocalMsg(`API Diagnostics Result: ${data.status} (Ping: ${data.latencyMs ?? 42}ms)`);
          }
        })
        .catch((err) => {
          setLocalMsg(`Diagnostics Error: ${err.message}`);
        })
        .finally(() => {
          setLocalDiagLoading(false);
        });
    }
  };

  const isDiagnosticsRunning = diagnosticsLoading || localDiagLoading;

  return (
    <div
      className="etrade-dynamic-menu-container settings-menu-container"
      ref={menuRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className={`etrade-dynamic-menu-trigger settings-menu-trigger ${isConnected ? "connected" : "disconnected"} ${isLive ? "prod" : "test"} ${isOpen ? "open" : ""} ${isPinned ? "pinned" : ""}`}
        onClick={handleTriggerClick}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={
          isPinned
            ? "Settings & Broker Menu pinned open (click to unpin)"
            : `Settings & Broker Controls (${isLive ? "PROD (Live)" : "TEST (Sandbox)"}, E*TRADE, ETAPI, Preferences) — hover for details, click to pin`
        }
      >
        <span className="menu-settings-icon" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </span>
        <span className="menu-button-title">Settings</span>
        <span className={`menu-status-dot ${isConnected ? "connected" : "disconnected"}`} />
        <span className={`menu-env-tag ${isLive ? "prod" : "test"}`}>{isLive ? "PROD" : "TEST"}</span>
        <span className="menu-summary-label">
          {isConnected
            ? effectiveMask
              ? "••••••"
              : accountValue === undefined
              ? "Connected"
              : `$${accountValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
            : effectiveMask
            ? "••••••"
            : "Offline"}
        </span>
        <span className="menu-caret">{isPinned ? "📌" : "▾"}</span>
      </button>

      {isOpen && (
        <div className="etrade-dynamic-dropdown-panel settings-dropdown-panel" role="menu">
          {/* Header */}
          <div className="etrade-panel-header">
            <div className="etrade-panel-brand">
              <span className="brand-icon">⚡</span>
              <div>
                <h5>E*TRADE Brokerage API</h5>
                <span className={`brand-status-text ${isConnected ? "connected" : "disconnected"}`}>
                  {isConnected ? "● OAuth Session Active" : "○ Offline / Not Connected"}
                </span>
              </div>
            </div>
            <div className="etrade-panel-header-actions">
              <span className={`etrade-env-badge ${isLive ? "prod" : "test"}`}>
                {isLive ? "PROD (LIVE)" : "TEST (SANDBOX)"}
              </span>
              <a href="/auth/logout" className="btn-settings-signout" title="Sign out of platform">
                Sign out
              </a>
            </div>
          </div>

          {/* Account Details Card (Single Horizontal Line) */}
          <div className="etrade-panel-account-card">
            <div className="account-stat-cell">
              <span className="stat-lbl">Account Value</span>
              <span className="stat-val value-highlight">
                {effectiveMask
                  ? "••••••"
                  : accountValue === undefined
                  ? "Unavailable"
                  : `$${accountValue.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}`}
              </span>
            </div>
            <span className="account-stat-divider" aria-hidden="true" />
            <div className="account-stat-cell">
              <span className="stat-lbl">Account #</span>
              <span className="stat-val acct-number">
                {account?.accountId && account.accountId !== "unconnected"
                  ? effectiveMask
                    ? `••••${account.accountId.slice(-4)}`
                    : account.accountId
                  : "••••4748"}
              </span>
            </div>
            <button
              type="button"
              className="btn-mask-mini"
              onClick={toggleMask}
              title={effectiveMask ? "Reveal account value" : "Mask account value"}
            >
              {effectiveMask ? "👁️ Show" : "🔒 Hide"}
            </button>
          </div>

          {/* Environment Switcher ("PROD...") */}
          <div className="etrade-panel-section">
            <div className="section-label-row">
              <span>Environment</span>
              <small>{isLive ? "Live execution" : "Paper sandbox testing"}</small>
            </div>
            <div className="etrade-env-switch-bar">
              <button
                type="button"
                className={!isLive ? "active" : ""}
                onClick={() => onSwitchEnv("TEST")}
              >
                🧪 TEST (Sandbox)
              </button>
              <button
                type="button"
                className={isLive ? "active" : ""}
                onClick={() => onSwitchEnv("PROD")}
              >
                🔴 PROD (Live)
              </button>
            </div>
          </div>

          {/* Connection Actions & Diagnostics */}
          <div className="etrade-panel-section">
            <div className="section-label-row">
              <span>Connection &amp; Diagnostics</span>
            </div>
            <div className="etrade-actions-grid">
              <button
                type="button"
                className="btn-menu-action sync"
                disabled={isDiagnosticsRunning}
                onClick={onRunDiagnostics}
              >
                {isDiagnosticsRunning ? "🔄 Testing…" : "🔄 Test & Sync API"}
              </button>
              {isConnected ? (
                <>
                  {oauthStatus?.renewable && (
                    <button
                      type="button"
                      className="btn-menu-action renew"
                      disabled={oauthLoading}
                      onClick={handleRenewOAuth}
                    >
                      🔑 Renew Token
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-menu-action disconnect"
                    disabled={oauthLoading}
                    onClick={handleRevokeOAuth}
                  >
                    🔌 Disconnect
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn-menu-action connect"
                  disabled={oauthLoading}
                  onClick={handleStartOAuth}
                >
                  {oauthLoading ? "Connecting…" : "⚡ Connect E*TRADE"}
                </button>
              )}
            </div>
          </div>

          {/* Tuning & Options Data Download (Single Horizontal Line) */}
          <div className="etrade-panel-section">
            <div className="section-label-row">
              <span>Tuning &amp; Options Data</span>
              <small>Parameters &amp; export</small>
            </div>
            <div className="etrade-tools-cluster single-row">
              <button
                type="button"
                className="btn-menu-tuning"
                onClick={handleOpenTuning}
                title="Configure ETAPI trade engine and safety controls"
              >
                ⚙️ ETAPI Engine Tuning
              </button>

              <div className="menu-download-row">
                <input
                  type="text"
                  className="menu-symbol-input"
                  value={downloadSymbol}
                  onChange={(e) => setDownloadSymbol(e.target.value.toUpperCase())}
                  placeholder="Ticker"
                  maxLength={10}
                  title="Symbol for options dataset export"
                />
                <OptionsDataDownloadDropdown
                  symbol={downloadSymbol.trim() || "NVDA"}
                  activeEnv={effectiveEnv}
                  userLogin={userLogin}
                  label="📥 Options Data"
                  className="menu-data-download-btn"
                />
              </div>
            </div>
          </div>

          {/* Preferences & Appearance Settings */}
          <div className="etrade-panel-section settings-pref-section">
            <div className="section-label-row">
              <span>Preferences &amp; Interface</span>
              <small>Theme &amp; navigation</small>
            </div>

            <div className="settings-prefs-stack">
              {/* Theme Settings */}
              {onCycleTheme && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Theme:</span>
                  <div className="settings-pref-btn-group">
                    <button
                      type="button"
                      className={`btn-pref-pill ${theme === "light" ? "active" : ""}`}
                      onClick={() => onCycleTheme()}
                      title="Light Theme"
                    >
                      ☀️ Light
                    </button>
                    <button
                      type="button"
                      className={`btn-pref-pill ${theme === "dark" ? "active" : ""}`}
                      onClick={() => onCycleTheme()}
                      title="Dark Theme"
                    >
                      🌙 Dark
                    </button>
                    <button
                      type="button"
                      className={`btn-pref-pill ${theme !== "light" && theme !== "dark" ? "active" : ""}`}
                      onClick={() => onCycleTheme()}
                      title="System / Auto Theme"
                    >
                      🖥️ Auto
                    </button>
                  </div>
                </div>
              )}

              {/* Global Font Size Settings */}
              <div className="settings-pref-row">
                <span className="pref-row-lbl">Font Size:</span>
                <div className="settings-pref-btn-group font-size-controls-group">
                  <button
                    type="button"
                    className="btn-pref-pill step-btn"
                    onClick={() => {
                      const next = adjustFontScale(-0.05);
                      setFontScale(next);
                    }}
                    title="Decrease application font size"
                    disabled={fontScale <= 0.75}
                  >
                    A-
                  </button>
                  <span className="font-scale-pct" title="Current font scale level">
                    {Math.round(fontScale * 100)}%
                  </span>
                  <button
                    type="button"
                    className="btn-pref-pill step-btn"
                    onClick={() => {
                      const next = adjustFontScale(0.05);
                      setFontScale(next);
                    }}
                    title="Increase application font size"
                    disabled={fontScale >= 1.5}
                  >
                    A+
                  </button>
                  <span className="font-controls-divider" aria-hidden="true" />
                  {FONT_SCALE_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`btn-pref-pill ${Math.abs(fontScale - p.scale) < 0.03 ? "active" : ""}`}
                      onClick={() => handleFontScaleChange(p.scale)}
                      title={`Scale to ${p.label} (${p.pct})`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Global Font Style (Typeface) Settings */}
              <div className="settings-pref-row font-style-pref-row">
                <span className="pref-row-lbl">Font Style:</span>
                <div className="settings-pref-btn-group font-style-grid">
                  {FONT_STYLE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`btn-pref-pill font-style-pill ${fontStyle === opt.id ? "active" : ""}`}
                      onClick={() => handleFontStyleChange(opt.id)}
                      title={opt.id === "jakarta" ? "Default (Plus Jakarta Sans) — Institutional typography" : `${opt.label} — ${opt.description}`}
                      style={{ fontFamily: opt.fontFamily }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Navigation Layout Settings */}
              {onToggleLayout && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Navigation:</span>
                  <div className="settings-pref-btn-group">
                    <button
                      type="button"
                      className={`btn-pref-pill ${currentLayout === "top" ? "active" : ""}`}
                      onClick={() => onToggleLayout("top")}
                      title="Switch to Top Nav Bar"
                    >
                      ⊞ Top Menu
                    </button>
                    <button
                      type="button"
                      className={`btn-pref-pill ${currentLayout === "left" ? "active" : ""}`}
                      onClick={() => onToggleLayout("left")}
                      title="Switch to Left Sidebar"
                    >
                      ⊟ Left Sidebar
                    </button>
                  </div>
                </div>
              )}

              {/* Policy Account Mode */}
              {onToggleAccountMode && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Policy Mode:</span>
                  <div className="settings-pref-btn-group">
                    <button
                      type="button"
                      className={`btn-pref-pill ${accountMode === "paper" ? "active" : ""}`}
                      onClick={() => accountMode !== "paper" && onToggleAccountMode()}
                      title="Simulated paper money"
                    >
                      🧪 Paper
                    </button>
                    <button
                      type="button"
                      className={`btn-pref-pill ${accountMode === "live" ? "active" : ""}`}
                      onClick={() => accountMode !== "live" && onToggleAccountMode()}
                      title="Live brokerage execution"
                    >
                      🔴 Live Real
                    </button>
                  </div>
                </div>
              )}

              {/* Centralized Auto-Refresh Settings */}
              <div className="settings-pref-row">
                <span className="pref-row-lbl">Auto-Refresh:</span>
                <div className="settings-pref-btn-group">
                  <button
                    type="button"
                    className={`btn-pref-pill ${!effectiveAutoRefreshEnabled ? "active" : ""}`}
                    onClick={() => handleSetAutoRefresh(false)}
                    title="Pause automatic background refresh"
                  >
                    ⏹ OFF
                  </button>
                  <button
                    type="button"
                    className={`btn-pref-pill ${effectiveAutoRefreshEnabled ? "active" : ""}`}
                    onClick={() => handleSetAutoRefresh(true)}
                    title="Enable automatic background refresh"
                  >
                    ▶ ON
                  </button>
                </div>
              </div>

              {effectiveAutoRefreshEnabled && (
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Cadence:</span>
                  <div className="settings-pref-btn-group">
                    {[10, 15, 30, 60, 120, 300].map((sec) => (
                      <button
                        key={sec}
                        type="button"
                        className={`btn-pref-pill ${effectiveAutoRefreshInterval === sec ? "active" : ""}`}
                        onClick={() => handleSetAutoRefresh(true, sec)}
                        title={`Auto-refresh every ${sec < 60 ? `${sec} seconds` : `${sec / 60} min`}`}
                      >
                        {sec < 60 ? `${sec}s` : `${sec / 60}m`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Navbar Visible Tabs Configuration */}
          <div className="etrade-panel-section settings-nav-tabs-section">
            <div className="section-label-row">
              <span>Navbar Visible Tabs</span>
              <small>Toggle tabs shown in the navigation bar</small>
            </div>

            <div className="nav-tabs-preset-row">
              <span className="preset-label">Presets:</span>
              <div className="nav-tabs-preset-buttons">
                <button
                  type="button"
                  className="btn-preset-mini"
                  onClick={() => handleApplyPreset(NAV_TAB_PRESETS.all)}
                  title="Show all available navigation tabs"
                >
                  All Tabs
                </button>
                <button
                  type="button"
                  className="btn-preset-mini"
                  onClick={() => handleApplyPreset(NAV_TAB_PRESETS.traderFocus)}
                  title="Show core trading and execution tabs only"
                >
                  Trader Focus
                </button>
                <button
                  type="button"
                  className="btn-preset-mini"
                  onClick={() => handleApplyPreset(NAV_TAB_PRESETS.minimal)}
                  title="Minimalist view: Autopilot, Orders, Portfolio, Research, Copilot"
                >
                  Minimal
                </button>
              </div>
            </div>

            <div className="nav-tabs-grid">
              {NAVIGATION_ITEMS.map((item) => {
                const isChecked = effectiveVisibleTabs[item.id] !== false;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`nav-tab-toggle-pill ${isChecked ? "checked" : "unchecked"}`}
                    onClick={() => handleToggleTab(item.id)}
                    title={`${item.label} (${item.category}): ${isChecked ? "Visible in navbar (click to hide)" : "Hidden from navbar (click to show)"}`}
                    aria-pressed={isChecked}
                  >
                    <span className="tab-pill-check">{isChecked ? "✓" : "○"}</span>
                    <span className="tab-pill-text">{item.shortLabel || item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Ads & Partner Banners Configuration (Externalized & Configurable) */}
          <div className="etrade-panel-section settings-ads-section">
            <div className="section-label-row">
              <span>Ads &amp; Partner Banners</span>
              <small>{effectiveAdConfig.enabled ? "Active (Customized)" : "Disabled (Clean Workspace)"}</small>
            </div>

            <p className="settings-section-desc">
              Promotional banners and sponsor spotlights are externalized by default to keep workspace tabs clean. Toggle them on if desired, or browse deals on-demand.
            </p>

            <div className="settings-pref-row">
              <span className="pref-row-lbl">Workspace Banners:</span>
              <div className="settings-pref-btn-group">
                <button
                  type="button"
                  className={`btn-pref-pill ${!effectiveAdConfig.enabled ? "active" : ""}`}
                  onClick={() => handleToggleAdMaster(false)}
                  title="Disable all promotional banners and ads across workspace tabs (Clean UI)"
                >
                  ⏹ OFF (Clean)
                </button>
                <button
                  type="button"
                  className={`btn-pref-pill ${effectiveAdConfig.enabled ? "active" : ""}`}
                  onClick={() => handleToggleAdMaster(true)}
                  title="Enable promotional banners and customize placements"
                >
                  ▶ ON
                </button>
              </div>
            </div>

            {effectiveAdConfig.enabled && (
              <div className="settings-ads-suboptions">
                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Sponsor Spotlight:</span>
                  <div className="settings-pref-btn-group">
                    <button
                      type="button"
                      className={`btn-pref-pill ${!effectiveAdConfig.showSponsorSpotlight ? "active" : ""}`}
                      onClick={() => handleToggleAdOption("showSponsorSpotlight", false)}
                    >
                      OFF
                    </button>
                    <button
                      type="button"
                      className={`btn-pref-pill ${effectiveAdConfig.showSponsorSpotlight ? "active" : ""}`}
                      onClick={() => handleToggleAdOption("showSponsorSpotlight", true)}
                    >
                      ON
                    </button>
                  </div>
                </div>

                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Ad Network Strip:</span>
                  <div className="settings-pref-btn-group">
                    <button
                      type="button"
                      className={`btn-pref-pill ${!effectiveAdConfig.showAdNetworkStrip ? "active" : ""}`}
                      onClick={() => handleToggleAdOption("showAdNetworkStrip", false)}
                    >
                      OFF
                    </button>
                    <button
                      type="button"
                      className={`btn-pref-pill ${effectiveAdConfig.showAdNetworkStrip ? "active" : ""}`}
                      onClick={() => handleToggleAdOption("showAdNetworkStrip", true)}
                    >
                      ON
                    </button>
                  </div>
                </div>

                <div className="settings-pref-row">
                  <span className="pref-row-lbl">Google Ad Units:</span>
                  <div className="settings-pref-btn-group">
                    <button
                      type="button"
                      className={`btn-pref-pill ${!effectiveAdConfig.showGoogleAdUnits ? "active" : ""}`}
                      onClick={() => handleToggleAdOption("showGoogleAdUnits", false)}
                    >
                      OFF
                    </button>
                    <button
                      type="button"
                      className={`btn-pref-pill ${effectiveAdConfig.showGoogleAdUnits ? "active" : ""}`}
                      onClick={() => handleToggleAdOption("showGoogleAdUnits", true)}
                    >
                      ON
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Externalized Deals Showcase Action Button */}
            <div className="settings-ads-external-actions">
              <button
                type="button"
                className="btn-open-deals-showcase"
                onClick={() => {
                  if (onOpenPartnerDeals) {
                    onOpenPartnerDeals();
                  } else if (typeof window !== "undefined") {
                    window.dispatchEvent(new CustomEvent("open-partner-deals-modal"));
                  }
                }}
                title="Open external Partner Deals & Offers showcase"
              >
                ⭐ Browse Partner Deals &amp; Cloud Credits (External) ↗
              </button>
            </div>
          </div>

          {/* Background Tasks & Async Work */}
          <div className="etrade-panel-section settings-async-tasks-section">
            <div className="section-label-row">
              <span>Background Tasks</span>
              <small>Async jobs &amp; execution queue</small>
            </div>
            <AsyncJobsPanel embedded />
          </div>

          {/* Technical Diagnostics & Provenance (Relocated towards end of floating panel) */}
          <div className="etrade-panel-section etrade-provenance-section">
            <details className="etrade-provenance-drawer">
              <summary className="etrade-provenance-summary">
                <span>⚙️ Technical Diagnostics &amp; Provenance</span>
                <span className="provenance-chevron" aria-hidden="true">▾</span>
              </summary>
              <div className="etrade-provenance-content">
                <div className="etrade-provenance-row">
                  <strong>DID:</strong>
                  <code className="etrade-provenance-code">did:agent:openaimp:trading</code>
                </div>
                <div className="etrade-provenance-row">
                  <strong>Architecture:</strong>
                  <span>MCP &amp; OAuth 1.0a REST Client</span>
                </div>
                <div className="etrade-provenance-row">
                  <strong>Attestation:</strong>
                  <span>Internal W3C DID Cryptographic Stamping</span>
                </div>
                <div className="etrade-provenance-row">
                  <strong>Database:</strong>
                  <span>Durable Objects + SQLite (<code>mas_trades</code>, <code>mas_events</code>)</span>
                </div>
              </div>
            </details>
          </div>

          {/* User Account & Session */}
          <div className="etrade-panel-section user-session-section">
            <div className="settings-user-card compact">
              <div className="settings-user-meta">
                {userAvatar ? (
                  <img src={userAvatar} alt={userLogin} className="settings-user-avatar" />
                ) : (
                  <div className="settings-user-avatar-placeholder">
                    {userLogin.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="settings-user-details">
                  <span className="settings-user-name">{userName || userLogin}</span>
                  <span className="settings-user-login">@{userLogin}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Banner message / alert */}
          {effectiveMsg && (
            <div className="etrade-panel-message" role="status">
              <div className="msg-content">{effectiveMsg}</div>
              <div className="msg-actions">
                {(effectiveMsg.includes("SANDBOX") || effectiveMsg.includes("switch environment to TEST")) && (
                  <button
                    type="button"
                    className="btn-msg-fix"
                    onClick={() => {
                      onSwitchEnv("TEST");
                      handleSwitchAndConnect?.("TEST");
                    }}
                  >
                    Switch to TEST &amp; Connect
                  </button>
                )}
                <button
                  type="button"
                  className="btn-msg-dismiss"
                  aria-label="Dismiss message"
                  onClick={clearMsg}
                >
                  ✕
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const ETradeDynamicMenu = SettingsMenu;
