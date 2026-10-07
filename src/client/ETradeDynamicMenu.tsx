import React, { useState, useRef, useEffect } from "react";
import { OptionsDataDownloadDropdown } from "./options/optionsDataExporter";

export interface ETradeDynamicMenuProps {
  activeEnv: "TEST" | "PROD";
  oauthStatus: {
    authenticated?: boolean;
    renewable?: boolean;
    accessTokenExpiresAt?: string;
    environment?: string;
    error?: string;
  } | null;
  account: {
    accountId?: string;
    accountDesc?: string;
    netAccountValue?: number;
  } | null;
  brokerStatus?: {
    environment?: string;
    activeEnvironment?: string;
  } | null;
  maskAccount: boolean;
  setMaskAccount: (val: boolean) => void;
  diagnosticsLoading: boolean;
  oauthLoading: boolean;
  oauthMsg: string;
  setOauthMsg: (msg: string) => void;
  handleSwitchEnvironment: (env: "TEST" | "PROD") => void;
  handleSwitchAndConnect: (env: "TEST" | "PROD") => void;
  runDiagnostics: () => void;
  handleRenewOAuth: () => void;
  handleRevokeOAuth: () => void;
  handleStartOAuth: () => void;
  onOpenEtapiTuning: () => void;
  userLogin?: string;
  defaultSymbol?: string;
}

export function ETradeDynamicMenu({
  activeEnv,
  oauthStatus,
  account,
  brokerStatus,
  maskAccount,
  setMaskAccount,
  diagnosticsLoading,
  oauthLoading,
  oauthMsg,
  setOauthMsg,
  handleSwitchEnvironment,
  handleSwitchAndConnect,
  runDiagnostics,
  handleRenewOAuth,
  handleRevokeOAuth,
  handleStartOAuth,
  onOpenEtapiTuning,
  userLogin,
  defaultSymbol = "NVDA",
}: ETradeDynamicMenuProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [downloadSymbol, setDownloadSymbol] = useState(defaultSymbol);
  const menuRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isOpen = isHovered || isPinned;

  const isLive =
    activeEnv === "PROD" ||
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

  return (
    <div
      className="etrade-dynamic-menu-container"
      ref={menuRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className={`etrade-dynamic-menu-trigger ${isConnected ? "connected" : "disconnected"} ${isLive ? "prod" : "test"} ${isOpen ? "open" : ""} ${isPinned ? "pinned" : ""}`}
        onClick={handleTriggerClick}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={isPinned ? "E*TRADE Menu pinned open (click to unpin)" : "Hover for quick details, click to pin open"}
      >
        <span className={`menu-status-dot ${isConnected ? "connected" : "disconnected"}`} />
        <span className={`menu-env-tag ${isLive ? "prod" : "test"}`}>{isLive ? "PROD" : "TEST"}</span>
        <span className="menu-summary-label">
          {isConnected
            ? maskAccount
              ? "••••••"
              : accountValue === undefined
              ? "Connected"
              : `$${accountValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
            : "Offline"}
        </span>
        <span className="menu-caret">{isPinned ? "📌" : "▾"}</span>
      </button>

      {isOpen && (
        <div className="etrade-dynamic-dropdown-panel" role="menu">
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
                {maskAccount
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
                  ? maskAccount
                    ? `••••${account.accountId.slice(-4)}`
                    : account.accountId
                  : "Not connected"}
              </span>
              <button
                type="button"
                className="btn-mask-mini"
                onClick={() => setMaskAccount(!maskAccount)}
                title={maskAccount ? "Reveal account value" : "Mask account value"}
              >
                {maskAccount ? "👁️ Show" : "🔒 Hide"}
              </button>
            </div>
          </div>

          {/* Environment Switcher */}
          <div className="etrade-panel-section">
            <div className="section-label-row">
              <span>Environment</span>
              <small>{isLive ? "Live execution" : "Paper sandbox testing"}</small>
            </div>
            <div className="etrade-env-switch-bar">
              <button
                type="button"
                className={!isLive ? "active" : ""}
                onClick={() => handleSwitchEnvironment("TEST")}
              >
                🧪 TEST (Sandbox)
              </button>
              <button
                type="button"
                className={isLive ? "active" : ""}
                onClick={() => handleSwitchEnvironment("PROD")}
              >
                🔴 PROD (Live)
              </button>
            </div>
          </div>

          {/* Connection Actions */}
          <div className="etrade-panel-section">
            <div className="section-label-row">
              <span>Connection &amp; Diagnostics</span>
            </div>
            <div className="etrade-actions-grid">
              <button
                type="button"
                className="btn-menu-action sync"
                disabled={diagnosticsLoading}
                onClick={runDiagnostics}
              >
                {diagnosticsLoading ? "🔄 Testing…" : "🔄 Test & Sync API"}
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
                onClick={() => {
                  setIsPinned(false);
                  setIsHovered(false);
                  onOpenEtapiTuning();
                }}
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
                  activeEnv={activeEnv}
                  userLogin={userLogin}
                  label="📥 Download Data"
                  className="menu-data-download-btn"
                />
              </div>
            </div>
          </div>

          {/* Banner message / alert */}
          {oauthMsg && (
            <div className="etrade-panel-message" role="status">
              <div className="msg-content">{oauthMsg}</div>
              <div className="msg-actions">
                {oauthMsg.includes("SANDBOX") || oauthMsg.includes("switch environment to TEST") ? (
                  <button
                    type="button"
                    className="btn-msg-fix"
                    onClick={() => handleSwitchAndConnect("TEST")}
                  >
                    Switch to TEST &amp; Connect
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-msg-dismiss"
                  aria-label="Dismiss message"
                  onClick={() => setOauthMsg("")}
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
