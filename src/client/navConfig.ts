import { ROUTES, hasNavEntry, getNavGroup, type RouteCategory, type RouteBadgeType, type NavEntryMeta } from "./routes";

export interface NavSubMenuItemConfig {
  id: string;
  label: string;
  shortLabel?: string;
  icon?: string;
  badge?: string;
  badgeType?: RouteBadgeType;
  description?: string;
  subItems?: NavSubMenuItemConfig[];
}

export interface NavMenuItemConfig {
  id: string;
  label: string;
  shortLabel?: string;
  category: RouteCategory;
  icon: string;
  badge?: string;
  badgeType?: RouteBadgeType;
  description: string;
  subItems?: NavSubMenuItemConfig[];
}

export interface NavSectionConfig {
  id: string;
  title: string;
  category: RouteCategory;
  items: NavMenuItemConfig[];
}

export interface LeftNavConfig {
  sections: NavSectionConfig[];
}

/**
 * Sub-menu configuration map for navigation items that contain sub-menus.
 * For example, Screeners provides choices for stocks and options.
 */
export const SUB_MENU_CONFIGS: Record<string, NavSubMenuItemConfig[]> = {
  screeners: [
    {
      id: "screeners",
      label: "Stock Screener",
      shortLabel: "Stocks",
      icon: "Screeners",
      badge: "Stocks",
      badgeType: "pro",
      description: "Multi-factor equity screener and fundamental valuation filters",
    },
    {
      id: "options",
      label: "Options Screener",
      shortLabel: "Options",
      icon: "Options",
      badge: "Options",
      badgeType: "ai",
      description: "Options chain, unusual activity, and Greeks scanner",
    },
    {
      id: "scanner",
      label: "Strategy Scanner",
      shortLabel: "Scanner",
      icon: "Scanner",
      badge: "Scan",
      badgeType: "mcp",
      description: "Pattern matching, technical breakout, and momentum scans",
    },
    {
      id: "options-flows",
      label: "Options Flows",
      shortLabel: "Flows",
      icon: "Options",
      badge: "Flows",
      badgeType: "live",
      description: "Institutional block trades, sweeps, and dark pool prints",
    },
    {
      id: "iv-history",
      label: "IV History & Volatility",
      shortLabel: "IV",
      icon: "Options",
      badge: "IV",
      badgeType: "neutral",
      description: "Historical and implied volatility percentile ranks",
    },
  ],
};

const SECTION_METADATA: { category: RouteCategory; title: string; id: string }[] = [
  { category: "Execution", title: "TRADING & EXECUTION", id: "section-execution" },
  { category: "Intelligence", title: "INTELLIGENCE & COPILOT", id: "section-intelligence" },
  { category: "Playbooks", title: "PLAYBOOKS & TOOLS", id: "section-playbooks" },
  { category: "Platform", title: "PLATFORM & BILLING", id: "section-platform" },
];

/**
 * Builds the default externalized LeftNavConfig derived from the single-source-of-truth
 * route table and enhanced with sub-menu definitions.
 */
export function buildDefaultLeftNavConfig(): LeftNavConfig {
  const navRoutes = ROUTES.filter(hasNavEntry).sort(
    (a, b) => a.navEntry.navOrder - b.navEntry.navOrder
  );

  const sections: NavSectionConfig[] = SECTION_METADATA.map((sec) => {
    const items: NavMenuItemConfig[] = navRoutes
      .filter((r) => r.category === sec.category)
      .map((r) => {
        const meta: NavEntryMeta = r.navEntry;
        const subItems = SUB_MENU_CONFIGS[r.id];
        return {
          id: r.id,
          label: meta.label,
          shortLabel: meta.shortLabel,
          category: r.category,
          icon: r.icon,
          badge: meta.badge,
          badgeType: meta.badgeType,
          description: r.description,
          ...(subItems ? { subItems } : {}),
        };
      });

    return {
      id: sec.id,
      title: sec.title,
      category: sec.category,
      items,
    };
  });

  return { sections };
}

export const DEFAULT_LEFT_NAV_CONFIG: LeftNavConfig = buildDefaultLeftNavConfig();

/**
 * Find a menu item within a LeftNavConfig by id.
 */
export function findNavItemConfig(
  config: LeftNavConfig,
  id: string
): NavMenuItemConfig | undefined {
  for (const section of config.sections) {
    for (const item of section.items) {
      if (item.id === id) return item;
    }
  }
  return undefined;
}

/**
 * Check if a menu item or any of its sub-items matches the current active tab.
 */
export function isNavItemOrSubItemActive(
  item: NavMenuItemConfig,
  currentTab: string
): boolean {
  if (item.id === currentTab) return true;
  if (getNavGroup(currentTab) === item.id) return true;
  if (item.subItems) {
    return item.subItems.some(
      (sub) => sub.id === currentTab || getNavGroup(currentTab) === sub.id
    );
  }
  return false;
}

