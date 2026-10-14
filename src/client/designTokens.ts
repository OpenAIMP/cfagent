/**
 * NEXTGEN TP — TYPESCRIPT DESIGN TOKEN CONTRACT
 * 
 * Provides type-safe access to semantic color roles, typography scales,
 * density modes, and theme management utilities.
 */

export const colorRoles = [
  "surface",
  "surface-raised",
  "surface-sunken",
  "card",
  "text-primary",
  "text-secondary",
  "text-muted",
  "text-dim",
  "text-inverse",
  "border-subtle",
  "border-medium",
  "border-focus",
  "accent",
  "accent-contrast",
  "primary",
  "danger",
  "success",
  "warning",
  "info",
] as const;

export type ColorRole = (typeof colorRoles)[number];

export const surfaceRoles = [
  "surface",
  "surface-raised",
  "surface-sunken",
  "card",
  "muted",
] as const;

export type SurfaceRole = (typeof surfaceRoles)[number];

export type DensityMode = "compact" | "comfortable";

export const DENSITY_STORAGE_KEY = "nextgentp_density";

/**
 * Retrieves the stored UI density mode, defaulting to "comfortable".
 */
export function getStoredDensity(): DensityMode {
  if (typeof window === "undefined") return "comfortable";
  try {
    const saved = localStorage.getItem(DENSITY_STORAGE_KEY);
    if (saved === "compact" || saved === "comfortable") {
      return saved;
    }
  } catch {
    // Ignore storage errors
  }
  return "comfortable";
}

/**
 * Applies the density mode to the documentElement and persists to localStorage.
 */
export function applyDensity(mode: DensityMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-density", mode);
  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, mode);
  } catch {
    // Ignore storage errors
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("density-changed", { detail: { density: mode } }));
  }
}

/**
 * Helper to get CSS variable string for a given semantic color role.
 */
export function tokenVar(role: ColorRole): string {
  switch (role) {
    case "surface":
      return "var(--color-surface)";
    case "surface-raised":
      return "var(--color-surface-raised)";
    case "surface-sunken":
      return "var(--color-surface-sunken)";
    case "card":
      return "var(--color-card)";
    case "text-primary":
      return "var(--color-text-primary)";
    case "text-secondary":
      return "var(--color-text-secondary)";
    case "text-muted":
      return "var(--color-text-muted)";
    case "text-dim":
      return "var(--color-text-dim)";
    case "text-inverse":
      return "var(--color-text-inverse)";
    case "border-subtle":
      return "var(--color-border-subtle)";
    case "border-medium":
      return "var(--color-border-medium)";
    case "border-focus":
      return "var(--color-border-focus)";
    case "accent":
      return "var(--color-accent)";
    case "accent-contrast":
      return "var(--color-accent-contrast)";
    case "primary":
      return "var(--color-primary)";
    case "danger":
      return "var(--color-danger)";
    case "success":
      return "var(--color-success)";
    case "warning":
      return "var(--color-warning)";
    case "info":
      return "var(--color-info)";
  }
}
