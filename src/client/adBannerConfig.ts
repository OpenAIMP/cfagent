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
