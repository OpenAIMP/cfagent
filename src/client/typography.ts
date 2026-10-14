/**
 * Global Typography & Font Scale System for NextGenTP
 * Enforces a single universal font family ('Inter') system-wide
 * and provides centralized font scale preferences.
 */

export const UNIVERSAL_SYSTEM_FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export type FontStyleId = "inter" | "jakarta" | "roboto" | "jetbrains" | "outfit" | "system";

export interface FontStyleOption {
  id: FontStyleId;
  label: string;
  category: string;
  fontFamily: string;
  description: string;
}

export const FONT_STYLE_OPTIONS: FontStyleOption[] = [
  {
    id: "inter",
    label: "Default (Inter)",
    category: "Universal Standard",
    fontFamily: UNIVERSAL_SYSTEM_FONT,
    description: "Universal clean institutional typography across entire system",
  },
];

export interface FontScalePreset {
  id: string;
  label: string;
  scale: number;
  pct: string;
}

export const FONT_SCALE_PRESETS: FontScalePreset[] = [
  { id: "compact", label: "Compact", scale: 0.85, pct: "85%" },
  { id: "normal", label: "Default", scale: 1.0, pct: "100%" },
  { id: "comfortable", label: "Comfortable", scale: 1.15, pct: "115%" },
  { id: "large", label: "Large", scale: 1.30, pct: "130%" },
];

export const FONT_SCALE_STORAGE_KEY = "nextgentp_font_scale";
export const FONT_STYLE_STORAGE_KEY = "nextgentp_font_style";

/**
 * Retrieves the stored font scale (0.75 - 1.5), defaulting to 1.0.
 */
export function getStoredFontScale(): number {
  if (typeof window === "undefined") return 1.0;
  try {
    const saved = localStorage.getItem(FONT_SCALE_STORAGE_KEY);
    if (saved) {
      const val = parseFloat(saved);
      if (!isNaN(val) && val >= 0.75 && val <= 1.5) {
        return Math.round(val * 100) / 100;
      }
    }
  } catch {
    // Ignore storage errors
  }
  return 1.0;
}

/**
 * Retrieves the stored font style ID, always enforcing "inter".
 * Purges any legacy multi-font selection to maintain single-font system integrity.
 */
export function getStoredFontStyle(): FontStyleId {
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(FONT_STYLE_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }
  return "inter";
}

/**
 * Applies the font scale to the HTML root element and enforces the universal Inter font.
 */
export function applyTypography(scale: number, _styleId?: FontStyleId): void {
  if (typeof document === "undefined") return;

  const boundedScale = Math.round(Math.max(0.75, Math.min(1.5, scale)) * 100) / 100;

  document.documentElement.style.setProperty("--app-font-scale", String(boundedScale));
  document.documentElement.style.setProperty("--font-sans", UNIVERSAL_SYSTEM_FONT);
  document.documentElement.style.setProperty("--font-family-base", UNIVERSAL_SYSTEM_FONT);
  document.documentElement.setAttribute("data-font-style", "inter");
  document.documentElement.setAttribute("data-font-scale", String(boundedScale));

  // Determine preset name
  let presetName = "custom";
  for (const p of FONT_SCALE_PRESETS) {
    if (Math.abs(p.scale - boundedScale) < 0.03) {
      presetName = p.id;
      break;
    }
  }
  document.documentElement.setAttribute("data-font-size", presetName);

  try {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(boundedScale));
    localStorage.removeItem(FONT_STYLE_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }

  // Broadcast event for dynamic component updates
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("typography-changed", {
        detail: { scale: boundedScale, styleId: "inter", fontFamily: UNIVERSAL_SYSTEM_FONT },
      })
    );
  }
}

/**
 * Incrementally increases or decreases font scale by delta (e.g. +0.05 or -0.05).
 */
export function adjustFontScale(delta: number): number {
  const current = getStoredFontScale();
  const next = Math.round((current + delta) * 100) / 100;
  applyTypography(next, "inter");
  return next;
}
