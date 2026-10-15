/** Typed semantic tokens and density preference compatibility APIs. */
export const colorRoles = [
  "surface", "surface-foreground", "surface-raised", "surface-raised-foreground",
  "surface-sunken", "surface-sunken-foreground", "card", "card-foreground",
  "muted", "muted-foreground", "input", "input-foreground", "input-border",
  "text-primary", "text-secondary", "text-muted", "text-dim", "text-inverse",
  "border-subtle", "border-medium", "border-focus",
  "accent", "accent-contrast", "primary", "primary-foreground",
  "danger", "danger-foreground", "success", "success-foreground",
  "warning", "warning-foreground", "info", "info-foreground",
] as const;
export type ColorRole = (typeof colorRoles)[number];

export const surfaceRoles = ["surface", "surface-raised", "surface-sunken", "card", "muted"] as const;
export type SurfaceRole = (typeof surfaceRoles)[number];

export function tokenVar(role: ColorRole): string {
  return `var(--color-${role})`;
}

export type DensityMode = "compact" | "comfortable";
export const DENSITY_STORAGE_KEY = "nextgentp_density";

export function normalizeDensity(value: unknown): DensityMode {
  return value === "compact" || value === "comfortable" ? value : "comfortable";
}

export function getStoredDensity(): DensityMode {
  if (typeof window === "undefined") return "comfortable";
  try {
    return normalizeDensity(localStorage.getItem(DENSITY_STORAGE_KEY));
  } catch {
    return "comfortable";
  }
}

export function applyDensityToDocument(mode: DensityMode): void {
  if (typeof document === "undefined") return;
  const density = normalizeDensity(mode);
  document.documentElement.setAttribute("data-density", density);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("density-changed", { detail: { density } }));
  }
}

export function persistDensity(mode: DensityMode): void {
  try {
    if (typeof window !== "undefined") localStorage.setItem(DENSITY_STORAGE_KEY, normalizeDensity(mode));
  } catch {
    // Document preferences remain usable without storage.
  }
}

/** Compatibility API for explicit user changes. */
export function applyDensity(mode: DensityMode): void {
  applyDensityToDocument(mode);
  persistDensity(mode);
}

export function initDensityListener(): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: StorageEvent) => {
    if (event.key !== DENSITY_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    applyDensityToDocument(event.key === null ? getStoredDensity() : normalizeDensity(event.newValue));
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
