export type ThemeMode = "light" | "dark" | "system" | "high-contrast";
export const THEME_STORAGE_KEY = "nextgentp_theme";

export function normalizeTheme(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system" || value === "high-contrast" ? value : "system";
}

export function getEffectiveTheme(mode: ThemeMode): "light" | "dark" | "high-contrast" {
  const preference = normalizeTheme(mode);
  if (preference !== "system") return preference;
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Root data-theme attributes are the single canonical theme signal (#474):
 *  the legacy root .dark/.light classes, body .theme-* classes and body
 *  data-theme adapters were removed once every consumer keyed off tokens. */
export function applyThemeToDocument(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const preference = normalizeTheme(mode);
  const effective = getEffectiveTheme(preference);
  const root = document.documentElement;
  root.setAttribute("data-theme", effective);
  root.setAttribute("data-theme-preference", preference);
  root.style.colorScheme = effective;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("theme-changed", { detail: { theme: effective, preference } }));
  }
}

export function persistTheme(mode: ThemeMode): void {
  try {
    if (typeof window !== "undefined") localStorage.setItem(THEME_STORAGE_KEY, normalizeTheme(mode));
  } catch {
    // The current document remains usable without storage.
  }
}

/** Compatibility API for explicit user changes. */
export function applyTheme(mode: ThemeMode): void {
  applyThemeToDocument(mode);
  persistTheme(mode);
}

/** Listen without persisting OS changes or echoing cross-tab storage updates. */
export function initThemeListener(onThemeChange?: (effective: "light" | "dark" | "high-contrast") => void): () => void {
  if (typeof window === "undefined") return () => {};
  let mediaQuery: MediaQueryList | undefined;
  try {
    mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  } catch {
    // Storage synchronization can still work without matchMedia.
  }
  const notify = (preference: ThemeMode) => {
    applyThemeToDocument(preference);
    onThemeChange?.(getEffectiveTheme(preference));
  };
  const onSystemChange = () => {
    const active = typeof document !== "undefined"
      ? document.documentElement.getAttribute("data-theme-preference") : null;
    if (normalizeTheme(active ?? getStoredTheme()) === "system") notify("system");
  };
  const onStorageChange = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    notify(event.key === null ? getStoredTheme() : normalizeTheme(event.newValue));
  };
  mediaQuery?.addEventListener("change", onSystemChange);
  window.addEventListener("storage", onStorageChange);
  return () => {
    mediaQuery?.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorageChange);
  };
}
