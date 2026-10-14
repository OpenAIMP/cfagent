import React from "react";
import { TabHoverItem } from "../TabHoverItem";

export interface CapabilityTabTooltip {
  eyebrow?: string;
  title: string;
  description: string;
}

export interface CapabilityTabItem {
  id: string;
  label: string;
  icon?: string | React.ReactNode;
  badge?: string | number;
  badgeType?: "default" | "cyan" | "emerald" | "amber" | "purple" | "live";
  tooltip?: CapabilityTabTooltip;
  disabled?: boolean;
}

export interface CapabilityNavBarProps {
  tabs: CapabilityTabItem[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  ariaLabel?: string;
  rightContent?: React.ReactNode;
  className?: string;
}

/**
 * CapabilityNavBar
 * Universal, accessible, high-density capability navigation bar for web-enabled financial & analytical systems.
 * Provides unified horizontal capability tabs with:
 * - WCAG 2.2 / ISO 9241-110 compliant keyboard navigation (role="tablist", role="tab", aria-selected)
 * - WYSIWYG self-descriptiveness via accessible hover tooltips (TabHoverItem)
 * - Luminous active indicators with theme-aware styling (light & dark mode)
 * - Integrated right-aligned contextual telemetry & actions area (Live status, refresh, dials)
 */
export function CapabilityNavBar({
  tabs,
  activeTabId,
  onTabChange,
  ariaLabel = "Page capabilities",
  rightContent,
  className = "",
}: CapabilityNavBarProps) {
  return (
    <header className={`capability-nav-bar ${className}`}>
      <nav className="capability-tabs-strip" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;

          const tabButton = (
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              disabled={tab.disabled}
              className={`capability-tab-btn ${isActive ? "active" : ""} ${tab.disabled ? "disabled" : ""}`}
              onClick={() => {
                if (!tab.disabled) {
                  onTabChange(tab.id);
                }
              }}
            >
              {tab.icon && <span className="capability-tab-icon">{tab.icon}</span>}
              <span className="capability-tab-label">{tab.label}</span>
              {tab.badge !== undefined && tab.badge !== "" && (
                <span className={`capability-tab-badge badge-${tab.badgeType || "default"}`}>
                  {tab.badge}
                </span>
              )}
            </button>
          );

          if (tab.tooltip) {
            return (
              <TabHoverItem
                key={tab.id}
                eyebrow={tab.tooltip.eyebrow}
                title={tab.tooltip.title}
                description={tab.tooltip.description}
              >
                {tabButton}
              </TabHoverItem>
            );
          }

          return (
            <div key={tab.id} className="capability-tab-wrapper">
              {tabButton}
            </div>
          );
        })}
      </nav>

      {rightContent && <div className="capability-nav-right">{rightContent}</div>}
    </header>
  );
}
