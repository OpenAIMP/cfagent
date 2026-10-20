/** Typography preference state. Inter remains the only supported UI font. */
export const UNIVERSAL_SYSTEM_FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const UNIVERSAL_CODE_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

/** Legacy IDs remain accepted by public APIs during migration. */
export type FontStyleId = "inter" | "jakarta" | "roboto" | "jetbrains" | "outfit" | "system";
export interface FontStyleOption {
  id: FontStyleId; label: string; category: string; fontFamily: string; description: string;
}
export const FONT_STYLE_OPTIONS: FontStyleOption[] = [{
  id: "inter", label: "Default (Inter)", category: "Product font",
  fontFamily: UNIVERSAL_SYSTEM_FONT, description: "The currently supported UI font",
}];
export interface FontScalePreset { id: string; label: string; scale: number; pct: string; }
export const FONT_SCALE_PRESETS: FontScalePreset[] = [
  { id: "compact", label: "Small", scale: 0.85, pct: "85%" },
  { id: "normal", label: "Default", scale: 1, pct: "100%" },
  { id: "comfortable", label: "Large", scale: 1.15, pct: "115%" },
  { id: "large", label: "Extra large", scale: 1.3, pct: "130%" },
];
export const FONT_SCALE_STORAGE_KEY = "nextgentp_font_scale";
export const FONT_STYLE_STORAGE_KEY = "nextgentp_font_style";

export function normalizeFontScale(scale: number): number {
  return Number.isFinite(scale) ? Math.round(Math.max(0.75, Math.min(1.5, scale)) * 100) / 100 : 1;
}

/** Retains legacy parseFloat compatibility; invalid/out-of-range saved values default. */
export function parseStoredFontScale(saved: string | null): number {
  const value = saved ? parseFloat(saved) : NaN;
  return Number.isFinite(value) && value >= 0.75 && value <= 1.5 ? normalizeFontScale(value) : 1;
}

export function getStoredFontScale(): number {
  if (typeof window === "undefined") return 1;
  try { return parseStoredFontScale(localStorage.getItem(FONT_SCALE_STORAGE_KEY)); } catch { return 1; }
}

/** Read-only compatibility API; unsupported legacy choices resolve to Inter. */
export function getStoredFontStyle(): FontStyleId { return "inter"; }

export function applyTypographyToDocument(scale: number, _styleId?: FontStyleId): void {
  if (typeof document === "undefined") return;
  const bounded = normalizeFontScale(scale);
  const root = document.documentElement;
  root.style.setProperty("--app-font-scale", String(bounded));
  root.style.setProperty("--font-sans", UNIVERSAL_SYSTEM_FONT);
  root.style.setProperty("--font-family-base", UNIVERSAL_SYSTEM_FONT);
  root.style.setProperty("--font-mono", UNIVERSAL_CODE_FONT);
  root.style.setProperty("--font-code", UNIVERSAL_CODE_FONT);
  root.setAttribute("data-font-style", "inter");
  root.setAttribute("data-font-scale", String(bounded));
  root.setAttribute("data-font-size", FONT_SCALE_PRESETS.find(p => Math.abs(p.scale - bounded) < 0.03)?.id ?? "custom");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("typography-changed", {
      detail: { scale: bounded, styleId: "inter", fontFamily: UNIVERSAL_SYSTEM_FONT },
    }));
  }
}

export function persistTypography(scale: number): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(normalizeFontScale(scale))); } catch {}
  // Explicit changes may clean up legacy state; reads and startup must not.
  try { localStorage.removeItem(FONT_STYLE_STORAGE_KEY); } catch {}
}

export function applyTypography(scale: number, styleId?: FontStyleId): void {
  applyTypographyToDocument(scale, styleId);
  persistTypography(scale);
}

export function adjustFontScale(delta: number): number {
  const active = typeof document !== "undefined" ? document.documentElement.getAttribute("data-font-scale") : null;
  const current = active === null ? getStoredFontScale() : parseStoredFontScale(active);
  const next = normalizeFontScale(current + (Number.isFinite(delta) ? delta : 0));
  applyTypography(next, "inter");
  return next;
}

export function initTypographyListener(): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: StorageEvent) => {
    if (event.key !== FONT_SCALE_STORAGE_KEY && event.key !== FONT_STYLE_STORAGE_KEY && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== localStorage) return; } catch { return; }
    const active = typeof document !== "undefined" ? document.documentElement.getAttribute("data-font-scale") : null;
    const scale = event.key === FONT_SCALE_STORAGE_KEY ? parseStoredFontScale(event.newValue)
      : event.key === null ? getStoredFontScale()
      : active === null ? getStoredFontScale() : parseStoredFontScale(active);
    applyTypographyToDocument(scale, "inter");
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
