import adDisplayConfig from "./ad-display.config.json";

export interface AdBannerConfig {
  /** Master switch: whether any ads or sponsor banners are shown in workspace tabs (defaults to false for a clean UI) */
  enabled: boolean;
  /** Whether the top sponsor spotlight banner (e.g. Flagship Partner) is enabled */
  showSponsorSpotlight: boolean;
  /** Whether the external ad network monetization banner strip is enabled */
  showAdNetworkStrip: boolean;
  /** Whether embedded Google AdSense units are enabled */
  showGoogleAdUnits: boolean;
  /** Per-tab ad visibility permissions */
  tabVisibility: Record<string, boolean>;
}

/**
 * Server-resolved ad allowance (issue #2022). Mirrors the shape
 * returned by GET /api/ads/banner-config, which resolves it from the
 * caller's verified tier in src/services/adsTier.ts. The client ANDs
 * each surface with the local preference: the server can suppress, it
 * never forces ads on — a Free user who opted out locally stays
 * opted out.
 */
export interface ServerAdsConfig {
  tier: "Free" | "Subscribed";
  adsAllowed: boolean;
  googleUnitsAllowed: boolean;
  sponsorSpotlightAllowed: boolean;
  adNetworkStripAllowed: boolean;
}

/**
 * Apply the server ad config to the local preference. A null server
 * config (fetch pending or failed) leaves local preference untouched:
 * the server ad LISTS are the enforcement boundary (a suppressed
 * caller gets empty lists), and this display override must not hide
 * a Free user's ads on a transient fetch failure.
 */
export function applyServerAdsConfig(
  local: AdBannerConfig,
  server: ServerAdsConfig | null,
): AdBannerConfig {
  if (!server) return local;
  return {
    ...local,
    enabled: local.enabled && server.adsAllowed,
    showSponsorSpotlight: local.showSponsorSpotlight && server.sponsorSpotlightAllowed,
    showAdNetworkStrip: local.showAdNetworkStrip && server.adNetworkStripAllowed,
    showGoogleAdUnits: local.showGoogleAdUnits && server.googleUnitsAllowed,
    tabVisibility: Object.fromEntries(
      Object.keys(local.tabVisibility).map((tab) => [tab, local.tabVisibility[tab] && server.adsAllowed]),
    ),
  };
}

export const DEFAULT_AD_BANNER_CONFIG: AdBannerConfig = {
  enabled: false,
  showSponsorSpotlight: false,
  showAdNetworkStrip: false,
  showGoogleAdUnits: false,
  tabVisibility: {
    ...adDisplayConfig,
  },
};

const STORAGE_KEY_MASTER = "cfagent_ads_master_enabled";
const STORAGE_KEY_CONFIG = "cfagent_ads_banner_config";

export function getStoredAdBannerConfig(): AdBannerConfig {
  if (typeof window === "undefined") return DEFAULT_AD_BANNER_CONFIG;
  try {
    const rawMaster = localStorage.getItem(STORAGE_KEY_MASTER);
    const masterEnabled = rawMaster !== null ? rawMaster === "true" : false;

    const rawConfig = localStorage.getItem(STORAGE_KEY_CONFIG);
    if (rawConfig) {
      const parsed = JSON.parse(rawConfig);
      return {
        ...DEFAULT_AD_BANNER_CONFIG,
        ...parsed,
        enabled: masterEnabled,
        tabVisibility: {
          ...DEFAULT_AD_BANNER_CONFIG.tabVisibility,
          ...(parsed.tabVisibility || {}),
        },
      };
    }
    return {
      ...DEFAULT_AD_BANNER_CONFIG,
      enabled: masterEnabled,
    };
  } catch {
    return DEFAULT_AD_BANNER_CONFIG;
  }
}

export function saveStoredAdBannerConfig(config: AdBannerConfig): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY_MASTER, String(config.enabled));
    localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(config));
    window.dispatchEvent(
      new CustomEvent("cfagent-ad-config-changed", {
        detail: config,
      })
    );
  } catch {
    // Ignore storage errors
  }
}
