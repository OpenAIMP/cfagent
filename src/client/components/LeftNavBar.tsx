import React, { useState, useEffect } from "react";
import { Badge, Button } from "../components/ui";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  isNavItemOrSubItemActive,
  type LeftNavConfig,
  type NavMenuItemConfig,
  type NavSubMenuItemConfig,
} from "../navConfig";
import {
  NavIcons,
  NAV_ICON_MAP,
  NAV_BADGE_TONES,
  type NavTabId,
} from "./NavigationMenu";
import { BRAND } from "../branding";
import { isTabFeatureEnabled } from "../featureFlags";
import { getNavGroup } from "../routes";

export interface LeftNavBarProps {
  config?: LeftNavConfig;
  activeTab: NavTabId;
  onSelectTab: (tab: NavTabId) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  visibleTabs?: Record<string, boolean>;
  alertBadgeCount?: number;
  className?: string;
  brandTitle?: string;
  brandTagline?: string;
}

export function LeftNavBar({
  config = DEFAULT_LEFT_NAV_CONFIG,
  activeTab,
  onSelectTab,
  collapsed = false,
  onToggleCollapse,
  visibleTabs,
  alertBadgeCount,
  className = "",
  brandTitle = BRAND.name,
  brandTagline = BRAND.tagline,
}: LeftNavBarProps) {
  // Track open/closed state of sub-menus by item id
  const [expandedMenus, setExpandedMenus] = useState<Record<string, boolean>>(() => {
    // Automatically expand any menu whose sub-item is active
    const initial: Record<string, boolean> = {};
    for (const section of config.sections) {
      for (const item of section.items) {
        if (item.subItems && item.subItems.length > 0) {
          if (isNavItemOrSubItemActive(item, activeTab)) {
            initial[item.id] = true;
          }
        }
      }
    }
    return initial;
  });

  // Ensure sub-menu expands when activeTab navigates to one of its sub-items
  useEffect(() => {
    for (const section of config.sections) {
      for (const item of section.items) {
        if (item.subItems && item.subItems.length > 0) {
          if (isNavItemOrSubItemActive(item, activeTab)) {
            setExpandedMenus((prev) => (prev[item.id] ? prev : { ...prev, [item.id]: true }));
          }
        }
      }
    }
  }, [activeTab, config]);

  const toggleSubMenu = (itemId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedMenus((prev) => ({
      ...prev,
      [itemId]: !prev[itemId],
    }));
  };

  const isTabVisible = (id: string) => {
    if (!isTabFeatureEnabled(id as NavTabId)) return false;
    if (!visibleTabs) return true;
    return visibleTabs[id] !== false;
  };

  const isSubActive = (subId: string): boolean => {
    return activeTab === subId;
  };

  return (
    <aside
      className={`app-sidebar nextgentp-sidebar ${collapsed ? "collapsed" : ""} ${className}`.trim()}
      aria-label="Sidebar Navigation"
    >
      {/* Brand Header */}
      <div className="sidebar-brand-wrapper">
        <div
          className="sidebar-brand"
          onClick={() => onSelectTab("autopilot")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelectTab("autopilot");
            }
          }}
          aria-label={`${brandTitle} home`}
        >
          <NavIcons.NextGenLogo />
          {!collapsed && (
            <div className="brand-text-block">
              <span className="brand-main-title">{brandTitle}</span>
              <span className="brand-sub-badge">{brandTagline}</span>
            </div>
          )}
        </div>

        {onToggleCollapse && (
          <Button
            variant="ghost"
            className="sidebar-collapse-btn"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <NavIcons.ChevronRight /> : <NavIcons.ChevronLeft />}
          </Button>
        )}
      </div>

      {/* Navigation Categories and Items built from externalized configuration */}
      <div className="sidebar-nav-scroll">
        {config.sections.map((section) => {
          const visibleItems = section.items.filter((item) => isTabVisible(item.id));
          if (visibleItems.length === 0) return null;

          return (
            <div key={section.id} className="sidebar-nav-section">
              {!collapsed && (
                <div className="sidebar-section-title">{section.title}</div>
              )}
              <div className="sidebar-items-group" role="tree">
                {visibleItems.map((item) => {
                  const hasSubMenu = Boolean(item.subItems && item.subItems.length > 0);
                  const isExpanded = Boolean(!collapsed && expandedMenus[item.id]);
                  const active = getNavGroup(activeTab) === item.id || activeTab === item.id;
                  const Icon = NAV_ICON_MAP[item.icon] || NavIcons.Screeners;

                  return (
                    <div
                      key={item.id}
                      className={`sidebar-nav-item-wrapper ${hasSubMenu ? "has-submenu" : ""} ${isExpanded ? "expanded" : ""}`}
                      role="treeitem"
                      aria-expanded={hasSubMenu ? isExpanded : undefined}
                    >
                      <div className={`sidebar-nav-item-row ${active ? "active" : ""}`}>
                        <Button
                          variant="ghost"
                          className={`sidebar-nav-item ${active ? "active" : ""}`}
                          onClick={() => onSelectTab(item.id as NavTabId)}
                          title={`${item.label} — ${item.description}`}
                        >
                          <span className="item-icon-wrapper">
                            <Icon active={active} />
                          </span>
                          {!collapsed && <span className="item-label">{item.label}</span>}
                          {!collapsed && item.badge && (
                            <Badge
                              size="sm"
                              uppercase
                              tone={NAV_BADGE_TONES[item.badgeType || "default"]}
                            >
                              {item.badge}
                            </Badge>
                          )}
                          {!collapsed && item.id === "portfolio" && !!alertBadgeCount && alertBadgeCount > 0 && (
                            <Badge size="sm" tone="danger" title={`${alertBadgeCount} unread broker alert(s)`}>
                              🔔 {alertBadgeCount}
                            </Badge>
                          )}
                          {active && <span className="active-pill-bar" />}
                        </Button>

                        {/* Expandable sub-menu toggle indicator '>' */}
                        {!collapsed && hasSubMenu && (
                          <Button
                            variant="ghost"
                            className={`submenu-toggle-btn ${isExpanded ? "open" : ""}`}
                            onClick={(e) => toggleSubMenu(item.id, e)}
                            title={isExpanded ? `Collapse ${item.label} sub-menu` : `Expand ${item.label} sub-menu`}
                            aria-label={isExpanded ? `Collapse ${item.label} sub-menu` : `Expand ${item.label} sub-menu`}
                            aria-expanded={isExpanded}
                            aria-controls={`submenu-${item.id}`}
                          >
                            <span className="submenu-toggle-chevron">
                              {isExpanded ? "▼" : "›"}
                            </span>
                          </Button>
                        )}
                      </div>

                      {/* Expandable Sub-Menu Options */}
                      {!collapsed && hasSubMenu && isExpanded && (
                        <div
                          id={`submenu-${item.id}`}
                          className="sidebar-submenu"
                          role="group"
                          aria-label={`${item.label} sub-menu`}
                        >
                          {item.subItems!.map((sub: NavSubMenuItemConfig) => {
                            const subActive = isSubActive(sub.id);
                            const SubIcon = sub.icon ? NAV_ICON_MAP[sub.icon] : null;

                            return (
                              <Button
                                variant="ghost"
                                key={sub.id}
                                className={`sidebar-submenu-item ${subActive ? "active" : ""}`}
                                onClick={() => onSelectTab(sub.id as NavTabId)}
                                title={`${sub.label}${sub.description ? ` — ${sub.description}` : ""}`}
                              >
                                <span className="submenu-item-bullet">
                                  {SubIcon ? <SubIcon active={subActive} /> : "•"}
                                </span>
                                <span className="submenu-item-label">{sub.label}</span>
                                {sub.badge && (
                                  <Badge
                                    size="sm"
                                    tone={NAV_BADGE_TONES[sub.badgeType || "default"]}
                                  >
                                    {sub.badge}
                                  </Badge>
                                )}
                              </Button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

