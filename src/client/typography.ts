/**
 * Global Typography & Font Scale System for NextGenTP
 * Provides centralized font scale and font style preferences across the entire application.
 */

export type FontStyleId = "jakarta" | "inter" | "roboto" | "jetbrains" | "outfit" | "system";

export interface FontStyleOption {
  id: FontStyleId;
  label: string;
  category: string;
  fontFamily: string;
  description: string;
}

export const FONT_STYLE_OPTIONS: FontStyleOption[] = [
  {
    id: "jakarta",
    label: "Plus Jakarta Sans",
    category: "Modern Fintech",
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif",
    description: "Default high-contrast, modern fintech design aesthetic",
  },
  {
    id: "inter",
    label: "Inter",
    category: "Clean Tech",
    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    description: "Ultra-crisp institutional UI typography",
  },
  {
    id: "roboto",
    label: "Roboto",
    category: "Standard",
    fontFamily: "'Roboto', -apple-system, BlinkMacSystemFont, sans-serif",
    description: "Familiar, dependable standard typography",
  },
  {
    id: "outfit",
    label: "Outfit",
    category: "Geometric",
    fontFamily: "'Outfit', sans-serif",
    description: "Contemporary geometric presentation",
  },
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    category: "Quant / Terminal",
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    description: "Quantitative trader and terminal monospace style",
  },
  {
    id: "system",
    label: "System Native",
    category: "OS Native",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    description: "Native operating system fonts without web font loading",
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
 * Retrieves the stored font style ID, defaulting to "jakarta".
 */
export function getStoredFontStyle(): FontStyleId {
  if (typeof window === "undefined") return "jakarta";
  try {
    const saved = localStorage.getItem(FONT_STYLE_STORAGE_KEY) as FontStyleId;
    if (saved && FONT_STYLE_OPTIONS.some((opt) => opt.id === saved)) {
      return saved;
    }
  } catch {
    // Ignore storage errors
  }
  return "jakarta";
}

/**
 * Applies the font scale and font style to the HTML root element and persists to localStorage.
 */
export function applyTypography(scale: number, styleId: FontStyleId): void {
  if (typeof document === "undefined") return;

  const boundedScale = Math.round(Math.max(0.75, Math.min(1.5, scale)) * 100) / 100;
  const styleOpt = FONT_STYLE_OPTIONS.find((opt) => opt.id === styleId) || FONT_STYLE_OPTIONS[0];

  document.documentElement.style.setProperty("--app-font-scale", String(boundedScale));
  document.documentElement.style.setProperty("--font-sans", styleOpt.fontFamily);
  document.documentElement.style.setProperty("--font-family-base", styleOpt.fontFamily);
  document.documentElement.setAttribute("data-font-style", styleId);
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
    localStorage.setItem(FONT_STYLE_STORAGE_KEY, styleId);
  } catch {
    // Ignore storage errors
  }

  // Broadcast event for dynamic component updates
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("typography-changed", {
        detail: { scale: boundedScale, styleId, fontFamily: styleOpt.fontFamily },
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
  const style = getStoredFontStyle();
  applyTypography(next, style);
  return next;
}
