import React, { useState } from "react";

export type NavTabId =
  | "trading"
  | "research"
  | "options-flows"
  | "workflows"
  | "endpoints"
  | "chat"
  | "nlq"
  | "audit"
  | "payments"
  | "referrals"
  | "ads"
  | "revenue";

export type NavLayoutMode = "left" | "top";

export interface NavItemDef {
  id: NavTabId;
  label: string;
  shortLabel: string;
  category: "Execution" | "Intelligence" | "Playbooks" | "Platform";
  badge?: string;
  badgeType?: "pro" | "live" | "ai" | "mcp" | "new";
  icon: (props: { active?: boolean; className?: string }) => React.ReactNode;
  description: string;
}

export interface NavigationMenuProps {
  layout: NavLayoutMode;
  onToggleLayout: (newLayout: NavLayoutMode) => void;
  activeTab: NavTabId;
  onSelectTab: (tab: NavTabId) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  user: {
    login: string;
    name: string;
    avatar: string;
  };
  agentStatus?: {
    dotClass: string;
    label: string;
  };
  accountMode?: "paper" | "live";
  onToggleAccountMode?: () => void;
  headerChildren?: React.ReactNode;
}

// Crisp, modern SVG icons designed for institutional UI
export const NavIcons = {
  Autopilot: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      <circle cx="12" cy="12" r="4" fill={active ? "currentColor" : "none"} fillOpacity={0.2} />
    </svg>
  ),
  Research: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <path d="M11 8v6M8 11h6" />
    </svg>
  ),
  Options: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      <circle cx="15" cy="21" r="1.5" fill={active ? "currentColor" : "none"} />
      <circle cx="9" cy="3" r="1.5" fill={active ? "currentColor" : "none"} />
    </svg>
  ),
  Workflows: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 19 21 12 17 5 21 12 2" fill={active ? "currentColor" : "none"} fillOpacity={0.15} />
    </svg>
  ),
  Endpoints: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
      <line x1="14" y1="4" x2="10" y2="20" />
    </svg>
  ),
  Copilot: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M9 10h.01M15 10h.01M12 14c1.5 0 2-.8 2-.8" strokeWidth="2.5" />
    </svg>
  ),
  Database: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  Audit: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill={active ? "currentColor" : "none"} fillOpacity={0.15} />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  Payments: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="3" ry="3" />
      <line x1="1" y1="10" x2="23" y2="10" />
      <line x1="5" y1="15" x2="9" y2="15" strokeWidth="2.5" />
    </svg>
  ),
  Referrals: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 12 20 22 4 22 4 12" />
      <rect x="2" y="7" width="20" height="5" />
      <line x1="12" y1="22" x2="12" y2="7" />
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
    </svg>
  ),
  Ads: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  ),
  Revenue: ({ active }: { active?: boolean; className?: string }) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  LayoutSidebar: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  ),
  LayoutTop: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
    </svg>
  ),
  ChevronLeft: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  ),
  ChevronRight: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  NextGenLogo: () => (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="#0b1329" stroke="rgba(16, 185, 129, 0.45)" strokeWidth="1.5" />
      <path d="M7 23V9L15 23V9" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 14H26M22.5 10.5V23" stroke="#34d399" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
};

export const NAVIGATION_ITEMS: NavItemDef[] = [
  {
    id: "trading",
    label: "Autopilot Desk",
    shortLabel: "Autopilot",
    category: "Execution",
    badge: "Live",
    badgeType: "live",
    icon: NavIcons.Autopilot,
    description: "Autonomous execution within written policy, E*TRADE broker desk & real-time controls",
  },
  {
    id: "options-flows",
    label: "Hedging (F&O)",
    shortLabel: "Options",
    category: "Execution",
    badge: "Sweeps",
    badgeType: "pro",
    icon: NavIcons.Options,
    description: "Options flows, dark pool prints, institutional sweeps, blocks, and insider disclosures",
  },
  {
    id: "research",
    label: "Research & Screener",
    shortLabel: "Research",
    category: "Intelligence",
    badge: "FOSS",
    icon: NavIcons.Research,
    description: "Zero-credential Yahoo Finance and Alpaca dual feed, fundamental peer comparison",
  },
  {
    id: "chat",
    label: "Copilot Ideas",
    shortLabel: "Copilot",
    category: "Intelligence",
    badge: "AI",
    badgeType: "ai",
    icon: NavIcons.Copilot,
    description: "Conversational trading copilot, natural language strategies, and agent chat",
  },
  {
    id: "workflows",
    label: "Workflows & FAQ",
    shortLabel: "Workflows",
    category: "Playbooks",
    badge: "14 Guides",
    icon: NavIcons.Workflows,
    description: "Platform architecture guides, strategy playbooks, order mechanics & FAQ",
  },
  {
    id: "endpoints",
    label: "Developer & MCP",
    shortLabel: "Endpoints",
    category: "Playbooks",
    badge: "MCP",
    badgeType: "mcp",
    icon: NavIcons.Endpoints,
    description: "Interactive Model Context Protocol (MCP) tool and REST endpoint testing suite",
  },
  {
    id: "nlq",
    label: "Database Explorer",
    shortLabel: "Database",
    category: "Playbooks",
    badge: "ORM",
    icon: NavIcons.Database,
    description: "Natural language SQLite query engine, schema inspector & table data browser",
  },
  {
    id: "audit",
    label: "AI Transparency",
    shortLabel: "Audit Log",
    category: "Platform",
    icon: NavIcons.Audit,
    description: "W3C Agent DID verification, memory vault, and immutable audit logs",
  },
  {
    id: "payments",
    label: "Billing & Accounts",
    shortLabel: "Billing",
    category: "Platform",
    badge: "x402",
    icon: NavIcons.Payments,
    description: "x402 protocol, MPP micropayments, Stripe, PayPal, and DID billing",
  },
  {
    id: "referrals",
    label: "Referrals & Earn",
    shortLabel: "Referrals",
    category: "Platform",
    icon: NavIcons.Referrals,
    description: "Community referral engine, reward tracking, and social share links",
  },
  {
    id: "ads",
    label: "Sponsored Marketplace",
    shortLabel: "Deals",
    category: "Platform",
    icon: NavIcons.Ads,
    description: "Curated partner marketplace, developer sponsorships, and deal feed",
  },
  {
    id: "revenue",
    label: "Revenue Analytics",
    shortLabel: "Revenue",
    category: "Platform",
    icon: NavIcons.Revenue,
    description: "Platform monetization engine, ad network yield, CPM/CPC metrics, and ledger",
  },
];

export function NavigationMenu({
  layout,
  onToggleLayout,
  activeTab,
  onSelectTab,
  collapsed = false,
  onToggleCollapse,
  user,
  agentStatus,
  accountMode = "paper",
  onToggleAccountMode,
  headerChildren,
}: NavigationMenuProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Group items by category for sidebar navigation
  const executionItems = NAVIGATION_ITEMS.filter((i) => i.category === "Execution");
  const intelligenceItems = NAVIGATION_ITEMS.filter((i) => i.category === "Intelligence");
  const playbookItems = NAVIGATION_ITEMS.filter((i) => i.category === "Playbooks");
  const platformItems = NAVIGATION_ITEMS.filter((i) => i.category === "Platform");

  // 1. LEFT SIDEBAR LAYOUT
  if (layout === "left") {
    return (
      <aside
        className={`nextgentp-sidebar algonexus-sidebar ${collapsed ? "collapsed" : ""}`}
        aria-label="Sidebar Navigation"
      >
        {/* Brand Header */}
        <div className="sidebar-brand-wrapper">
          <div className="sidebar-brand" onClick={() => onSelectTab("trading")}>
            <NavIcons.NextGenLogo />
            {!collapsed && (
              <div className="brand-text-block">
                <span className="brand-main-title">NextGenTP</span>
                <span className="brand-sub-badge">Trading Platform</span>
              </div>
            )}
          </div>

          {onToggleCollapse && (
            <button
              type="button"
              className="sidebar-collapse-btn"
              onClick={onToggleCollapse}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <NavIcons.ChevronRight /> : <NavIcons.ChevronLeft />}
            </button>
          )}
        </div>

        {/* Account Mode Pill */}
        {!collapsed && (
          <div className="sidebar-mode-strip">
            <span className="pill-pro">PRO</span>
            <button
              type="button"
              className={`mode-toggle-pill ${accountMode}`}
              onClick={onToggleAccountMode}
              title="Click to toggle Paper / Live simulated execution mode"
            >
              <span className="mode-dot" />
              <span className="mode-name">{accountMode === "paper" ? "Paper (Simulated)" : "Live Trading"}</span>
            </button>
          </div>
        )}

        {/* Navigation Categories and Items */}
        <div className="sidebar-nav-scroll">
          {/* Section: Execution */}
          {!collapsed && <div className="sidebar-section-title">TRADING &amp; HEDGING</div>}
          <div className="sidebar-items-group">
            {executionItems.map((item) => {
              const active = activeTab === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`sidebar-nav-item ${active ? "active" : ""}`}
                  onClick={() => onSelectTab(item.id)}
                  title={`${item.label} — ${item.description}`}
                >
                  <span className="item-icon-wrapper">
                    <Icon active={active} />
                  </span>
                  {!collapsed && <span className="item-label">{item.label}</span>}
                  {!collapsed && item.badge && (
                    <span className={`item-badge badge-${item.badgeType || "default"}`}>
                      {item.badge}
                    </span>
                  )}
                  {active && <span className="active-pill-bar" />}
                </button>
              );
            })}
          </div>

          {/* Section: Intelligence */}
          {!collapsed && <div className="sidebar-section-title">INTELLIGENCE &amp; COPILOT</div>}
          <div className="sidebar-items-group">
            {intelligenceItems.map((item) => {
              const active = activeTab === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`sidebar-nav-item ${active ? "active" : ""}`}
                  onClick={() => onSelectTab(item.id)}
                  title={`${item.label} — ${item.description}`}
                >
                  <span className="item-icon-wrapper">
                    <Icon active={active} />
                  </span>
                  {!collapsed && <span className="item-label">{item.label}</span>}
                  {!collapsed && item.badge && (
                    <span className={`item-badge badge-${item.badgeType || "default"}`}>
                      {item.badge}
                    </span>
                  )}
                  {active && <span className="active-pill-bar" />}
                </button>
              );
            })}
          </div>

          {/* Section: Playbooks */}
          {!collapsed && <div className="sidebar-section-title">PLAYBOOKS &amp; TOOLS</div>}
          <div className="sidebar-items-group">
            {playbookItems.map((item) => {
              const active = activeTab === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`sidebar-nav-item ${active ? "active" : ""}`}
                  onClick={() => onSelectTab(item.id)}
                  title={`${item.label} — ${item.description}`}
                >
                  <span className="item-icon-wrapper">
                    <Icon active={active} />
                  </span>
                  {!collapsed && <span className="item-label">{item.label}</span>}
                  {!collapsed && item.badge && (
                    <span className={`item-badge badge-${item.badgeType || "default"}`}>
                      {item.badge}
                    </span>
                  )}
                  {active && <span className="active-pill-bar" />}
                </button>
              );
            })}
          </div>

          {/* Section: Platform */}
          {!collapsed && <div className="sidebar-section-title">PLATFORM &amp; BILLING</div>}
          <div className="sidebar-items-group">
            {platformItems.map((item) => {
              const active = activeTab === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`sidebar-nav-item ${active ? "active" : ""}`}
                  onClick={() => onSelectTab(item.id)}
                  title={`${item.label} — ${item.description}`}
                >
                  <span className="item-icon-wrapper">
                    <Icon active={active} />
                  </span>
                  {!collapsed && <span className="item-label">{item.label}</span>}
                  {!collapsed && item.badge && (
                    <span className={`item-badge badge-${item.badgeType || "default"}`}>
                      {item.badge}
                    </span>
                  )}
                  {active && <span className="active-pill-bar" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Sidebar Bottom Controls: Layout Switcher + Profile */}
        <div className="sidebar-footer">
          {/* Menu Position Switcher */}
          <button
            type="button"
            className="sidebar-layout-toggle-btn"
            onClick={() => onToggleLayout("top")}
            title="Switch menu to Top Nav Bar"
          >
            <NavIcons.LayoutTop />
            {!collapsed && <span>Switch to Top Menu</span>}
          </button>

          {/* User Dock */}
          <div className="sidebar-user-dock">
            <img src={user.avatar} alt={user.login} className="sidebar-user-avatar" />
            {!collapsed && (
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{user.name}</span>
                <span className="sidebar-user-login">@{user.login}</span>
              </div>
            )}
            {!collapsed && (
              <a href="/auth/logout" className="sidebar-signout-btn" title="Sign out">
                Sign out
              </a>
            )}
          </div>
        </div>
      </aside>
    );
  }

  // 2. TOP NAV BAR LAYOUT
  const primaryTopItems = NAVIGATION_ITEMS.slice(0, 6);
  const overflowTopItems = NAVIGATION_ITEMS.slice(6);
  const isOverflowActive = overflowTopItems.some((i) => i.id === activeTab);

  return (
    <nav className="nextgentp-top-nav algonexus-top-nav" aria-label="Top Navigation Bar">
      {/* Brand & Market Badges */}
      <div className="top-nav-brand-section">
        <div className="top-brand" onClick={() => onSelectTab("trading")}>
          <NavIcons.NextGenLogo />
          <span className="top-brand-name">NextGenTP</span>
        </div>

        {/* Institutional Status Badges */}
        <div className="top-status-pills">
          <span className="pill-pro">PRO</span>
          <span className="pill-region">🇺🇸 US</span>
          <button
            type="button"
            className={`pill-mode ${accountMode}`}
            onClick={onToggleAccountMode}
            title="Toggle Paper / Live execution mode"
          >
            <span className="mode-dot" />
            <span>{accountMode === "paper" ? "Paper" : "Live"}</span>
            <span className="chevron-down">▾</span>
          </button>
          <span className="pill-market-status">
            <span className="market-dot closed" />
            <span>Market CLOSED · opens Mon 09:30 ET</span>
          </span>
        </div>
      </div>

      {/* Primary Horizontal Tabs */}
      <div className="top-nav-tabs">
        {primaryTopItems.map((item) => {
          const active = activeTab === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={`top-nav-tab-btn ${active ? "active" : ""}`}
              onClick={() => {
                onSelectTab(item.id);
                setDropdownOpen(false);
              }}
              title={item.description}
            >
              <Icon active={active} />
              <span>{item.shortLabel}</span>
              {item.badge && (
                <span className={`item-badge badge-${item.badgeType || "default"}`}>
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}

        {/* Overflow "More ▾" Dropdown */}
        <div className="top-nav-dropdown-wrapper">
          <button
            type="button"
            className={`top-nav-tab-btn dropdown-trigger ${isOverflowActive ? "active" : ""}`}
            onClick={() => setDropdownOpen((prev) => !prev)}
            aria-expanded={dropdownOpen}
            aria-haspopup="menu"
          >
            <span>More Platform</span>
            <span className="chevron-down">▾</span>
          </button>

          {dropdownOpen && (
            <div className="top-nav-dropdown-menu" role="menu">
              {overflowTopItems.map((item) => {
                const active = activeTab === item.id;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className={`dropdown-menu-item ${active ? "active" : ""}`}
                    onClick={() => {
                      onSelectTab(item.id);
                      setDropdownOpen(false);
                    }}
                  >
                    <Icon active={active} />
                    <div className="dropdown-item-text">
                      <span className="dropdown-item-label">{item.label}</span>
                      <span className="dropdown-item-desc">{item.description}</span>
                    </div>
                    {item.badge && (
                      <span className={`item-badge badge-${item.badgeType || "default"}`}>
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right Controls: Extra Children, Switch to Left Nav, User Profile */}
      <div className="top-nav-right-controls">
        {headerChildren}

        {/* Layout Switcher button: Switch to Left Sidebar */}
        <button
          type="button"
          className="top-layout-switcher-btn"
          onClick={() => onToggleLayout("left")}
          title="Switch menu to Left Sidebar layout"
          aria-label="Switch menu to Left Sidebar layout"
        >
          <NavIcons.LayoutSidebar />
          <span className="layout-btn-text">Left Sidebar</span>
        </button>

        {/* User Pill */}
        <div className="top-user-pill" title={`Logged in as ${user.name} (@${user.login})`}>
          <img src={user.avatar} alt={user.login} className="top-user-avatar" />
          <span className="top-user-email">{user.login.includes("@") ? user.login : `${user.login}@nextgentp`}</span>
          <a href="/auth/logout" className="top-logout-link" title="Sign out">
            Sign out
          </a>
        </div>
      </div>
    </nav>
  );
}
