/**
 * Issue #1806: Client-side Feature Flag Registry & Helpers.
 */
import React from "react";
import type { FeatureFlag } from "../config/featureFlags";
import type { NavTabId } from "./components/NavigationMenu";
import { Badge, Card } from "./components/ui";

declare global {
  interface Window {
    __FEATURES__?: Record<string, boolean>;
  }
}

/**
 * Maps Navigation tabs to their controlling feature flags.
 * If a tab has no entry, it is considered core/always accessible.
 */
export const TAB_TO_FEATURE_MAP: Partial<Record<NavTabId, FeatureFlag>> = {
  screeners: "screener",
  scanner: "screener",
  reports: "screener",
  schedules: "schedules",
  options: "screener",
  "options-flows": "options_research",
  research: "screener",
  autopilot: "autopilot",
  trading: "autopilot",
  order: "trading_orders",
  orders: "trading_orders",
  voice: "voice_trading",
  social: "social_publishing",
  nlq: "nlq",
  payments: "payments",
  // Issue #2049: assurance page, own flag, default OFF fail-closed.
  "payment-assurance": "payment_assurance",
};

/**
 * Reads initial feature flags injected by the server on page load (window.__FEATURES__),
 * falling back to screener-enabled default if not injected (e.g. dev server).
 */
export function getClientFeatureFlags(): Record<string, boolean> {
  if (typeof window !== "undefined" && window.__FEATURES__ && typeof window.__FEATURES__ === "object") {
    return window.__FEATURES__;
  }
  return {
    screener: true,
  };
}

/**
 * Checks whether a given tab is enabled according to the feature flags.
 */
export function isTabFeatureEnabled(
  tabId: NavTabId,
  flags: Record<string, boolean> = getClientFeatureFlags()
): boolean {
  const feature = TAB_TO_FEATURE_MAP[tabId];
  if (!feature) return true; // core tab (not gated)
  return flags[feature] === true;
}

/**
 * Card displayed when navigating directly to a disabled feature tab.
 */
export function FeatureDisabledNotice({
  featureName,
  tabLabel,
}: {
  featureName?: string;
  tabLabel?: string;
}) {
  return (
    <div
      role="region"
      aria-label="Feature Disabled"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "360px",
        padding: "var(--space-8, 2rem)",
      }}
    >
      <div style={{ maxWidth: "560px", width: "100%", textAlign: "center" }}>
        <Card padding="lg">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--space-3, 0.75rem)",
            }}
          >
            <div style={{ fontSize: "2.5rem" }}>🔒</div>
            <h3
              style={{
                margin: 0,
                fontSize: "1.25rem",
                fontWeight: 700,
                color: "var(--color-text-primary)",
              }}
            >
              {tabLabel ? `${tabLabel} is Disabled` : "Feature Disabled"}
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: "0.9rem",
                color: "var(--color-text-muted)",
                lineHeight: 1.5,
              }}
            >
              This capability {featureName ? `(${featureName}) ` : ""}is currently disabled by Cloudflare feature flag configuration. Only approved and enabled features are exposed.
            </p>
            <Badge tone="neutral" size="sm">
              Flag: {featureName ?? "FEATURE_DISABLED"} • Status: OFF
            </Badge>
          </div>
        </Card>
      </div>
    </div>
  );
}
