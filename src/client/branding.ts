/**
 * Thematic Branding Token Architecture (Issue #1297)
 *
 * Single source of truth for system branding, naming, metadata, and
 * multi-agent ecosystem hierarchy within the NextGenTP UX token architecture.
 *
 * All UI surfaces (NavigationMenu, landing page, Chat, AskAgentWidget,
 * StockSearchBar, CapabilityNavBar, AutopilotControlCenter) MUST derive their
 * branding from this module rather than hardcoding string literals.
 *
 * Modifying the system name, brand tagline, or ecosystem attributes here
 * instantly updates the entire system.
 */

export interface BrandEcosystemAgent {
  id: string;
  name: string;
  role: string;
  category: "Execution" | "Intelligence" | "Playbooks";
  badge?: string;
  badgeType?: "live" | "pro" | "ai" | "mcp" | "new" | "neutral";
}

export interface BrandConfig {
  /** Canonical system display name. Single point of modification for the whole app. */
  name: string;
  /** Short abbreviation or acronym for compact displays. */
  shortName: string;
  /** Subtitle or category descriptor. */
  tagline: string;
  /** Tier or environment badge text. */
  badge: string;
  /** Copilot assistant name. */
  copilotName: string;
  /** Search bar brand label. */
  searchName: string;
  /** Storage keys prefix ensuring consistency across all localStorage items. */
  storagePrefix: string;
  /** Multi-agent ecosystem definition ensuring AI Search Agent is positioned as one agent among many. */
  ecosystem: {
    systemName: string;
    description: string;
    agents: BrandEcosystemAgent[];
  };
}

export const BRAND: BrandConfig = {
  name: "NextGenTP",
  shortName: "NextGenTP",
  tagline: "Autonomous Multi-Agent Options & Equity Trading Platform",
  badge: "PRO",
  copilotName: "NextGenTP Agent Copilot",
  searchName: "NextGenTP Global Search",
  storagePrefix: "nextgentp",
  ecosystem: {
    systemName: "NextGenTP",
    description: "Institutional multi-agent architecture coordinating specialized trading agents under deterministic policy invariants.",
    agents: [
      {
        id: "orchestrator",
        name: "NextGenTP Orchestrator",
        role: "Autonomous policy enforcement, limit controls, and workflow orchestration",
        category: "Execution",
        badge: "Core",
        badgeType: "live",
      },
      {
        id: "ai_search",
        name: "AI Search Agent",
        role: "Market-wide intelligence, SEC filing retrieval, financial news, and web grounding",
        category: "Intelligence",
        badge: "Knowledge",
        badgeType: "ai",
      },
      {
        id: "screener",
        name: "Options Screener Agent",
        role: "Options chain screening, implied volatility surfaces, and multi-leg strategy discovery",
        category: "Intelligence",
        badge: "Multi",
        badgeType: "pro",
      },
      {
        id: "research",
        name: "Deep Research Agent",
        role: "Autonomous quantitative research, peer comparisons, and historical thesis backtesting",
        category: "Intelligence",
        badge: "Market Data",
        badgeType: "new",
      },
      {
        id: "trader",
        name: "Trading Execution Agent",
        role: "Cryptographic order attestation, two-step HITL previews, and broker connectivity",
        category: "Execution",
        badge: "DID",
        badgeType: "pro",
      },
    ],
  },
};

/**
 * Returns the effective brand configuration.
 * Checks for runtime environment overrides on window.__BRAND_CONFIG__
 * before falling back to the canonical static BRAND tokens.
 */
export function getBrand(): BrandConfig {
  if (typeof window !== "undefined" && (window as any).__BRAND_CONFIG__) {
    return {
      ...BRAND,
      ...(window as any).__BRAND_CONFIG__,
      ecosystem: {
        ...BRAND.ecosystem,
        ...((window as any).__BRAND_CONFIG__.ecosystem || {}),
      },
    };
  }
  return BRAND;
}
