import React, { useState, useRef, useEffect } from "react";
import { OptionsDataDownloadDropdown } from "./options/optionsDataExporter";
import {
  NAVIGATION_ITEMS,
  DEFAULT_VISIBLE_NAV_TABS,
  NAV_TAB_PRESETS,
} from "./components/NavigationMenu";

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
    if (runDiagnostics) {
      runDiagnostics();
    } else {
      setLocalDiagLoading(true);
      fetch(`/api/broker/etrade/diagnostics?environment=${effectiveEnv}`)
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
            <span className={`etrade-env-badge ${isLive ? "prod" : "test"}`}>
              {isLive ? "PROD (LIVE)" : "TEST (SANDBOX)"}
            </span>
          </div>

          {/* Account Details Card */}
          <div className="etrade-panel-account-card">
            <div className="account-stat-row">
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
            <div className="account-stat-row">
              <span className="stat-lbl">Account #</span>
              <span className="stat-val acct-number">
                {account?.accountId && account.accountId !== "unconnected"
                  ? effectiveMask
                    ? `••••${account.accountId.slice(-4)}`
                    : account.accountId
                  : "••••4748"}
              </span>
              <button
                type="button"
                className="btn-mask-mini"
                onClick={toggleMask}
                title={effectiveMask ? "Reveal account value" : "Mask account value"}
              >
                {effectiveMask ? "👁️ Show" : "🔒 Hide"}
              </button>
            </div>
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

          {/* Tuning & Options Data Download */}
          <div className="etrade-panel-section">
            <div className="section-label-row">
              <span>Tuning &amp; Options Data</span>
              <small>Export &amp; parameters</small>
            </div>
            <div className="etrade-tools-cluster">
              <button
                type="button"
                className="btn-menu-tuning"
                onClick={handleOpenTuning}
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
                  label="📥 Download Data"
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

          {/* User Account & Session */}
          <div className="etrade-panel-section user-session-section">
            <div className="settings-user-card">
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
              <a href="/auth/logout" className="btn-settings-signout" title="Sign out of platform">
                Sign out
              </a>
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
