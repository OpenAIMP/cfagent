export type ThemeMode = "light" | "dark" | "system";

const THEME_STORAGE_KEY = "nextgentp_theme";

/**
 * Resolves the effective active theme ("light" or "dark") given the user preference.
 */
export function getEffectiveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return "light";
  }
  return mode;
}

/**
 * Retrieves the stored theme preference from localStorage, defaulting to "system".
 */
export function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") {
      return saved;
    }
  } catch {
    // Ignore storage errors
  }
  return "system";
}

/**
 * Saves and applies the theme attribute to the HTML root element.
 */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const effective = getEffectiveTheme(mode);
  
  document.documentElement.setAttribute("data-theme", effective);
  document.documentElement.setAttribute("data-theme-preference", mode);
  document.documentElement.classList.toggle("dark", effective === "dark");
  document.documentElement.classList.toggle("light", effective === "light");
  document.documentElement.style.colorScheme = effective;

  if (document.body) {
    document.body.classList.toggle("theme-light", effective === "light");
    document.body.classList.toggle("theme-dark", effective === "dark");
    document.body.setAttribute("data-theme", effective);
  }

  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore storage errors
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("theme-changed", {
        detail: { theme: effective, preference: mode },
      })
    );
  }
}

/**
 * Subscribes to OS color scheme changes when theme preference is "system".
 */
export function initThemeListener(onThemeChange?: (effective: "light" | "dark") => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    const current = getStoredTheme();
    if (current === "system") {
      applyTheme("system");
      onThemeChange?.(getEffectiveTheme("system"));
    }
  };

  mediaQuery.addEventListener("change", handler);
  return () => mediaQuery.removeEventListener("change", handler);
}
