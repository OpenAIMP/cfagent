import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, applyThemeToDocument, getEffectiveTheme, getStoredTheme, initThemeListener, normalizeTheme, THEME_STORAGE_KEY } from "../src/client/theme";

describe("theme preference foundations", () => {
  let dark: boolean;
  let attrs: Map<string, string>;
  let store: Map<string, string>;
  let listeners: Map<string, (event: any) => void>;
  let mediaListeners: Map<string, () => void>;
  let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
  let root: { setAttribute: ReturnType<typeof vi.fn>; getAttribute: ReturnType<typeof vi.fn>; classList: { toggle: ReturnType<typeof vi.fn> }; style: { colorScheme: string } };

  beforeEach(() => {
    dark = false;
    attrs = new Map();
    store = new Map();
    listeners = new Map();
    mediaListeners = new Map();
    storage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
    };
    root = {
      setAttribute: vi.fn((key: string, value: string) => { attrs.set(key, value); }),
      getAttribute: vi.fn((key: string) => attrs.get(key) ?? null),
      classList: { toggle: vi.fn() },
      style: { colorScheme: "" },
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("document", { documentElement: root, body: null });
    vi.stubGlobal("CustomEvent", class {
      constructor(public type: string, public init: unknown) {}
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({
        get matches() { return dark; },
        addEventListener: (key: string, handler: () => void) => mediaListeners.set(key, handler),
        removeEventListener: (key: string) => mediaListeners.delete(key),
      })),
      dispatchEvent: vi.fn(),
      addEventListener: (key: string, handler: (event: any) => void) => listeners.set(key, handler),
      removeEventListener: (key: string) => listeners.delete(key),
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it("validates saved values and defaults to system", () => {
    for (const value of [null, undefined, "invalid", "", 1]) expect(normalizeTheme(value)).toBe("system");
    for (const value of ["light", "dark", "system", "high-contrast"] as const) expect(normalizeTheme(value)).toBe(value);
    store.set(THEME_STORAGE_KEY, "invalid");
    expect(getStoredTheme()).toBe("system");
  });

  it("resolves system independently from explicit choices", () => {
    dark = true;
    expect(getEffectiveTheme("system")).toBe("dark");
    expect(getEffectiveTheme("light")).toBe("light");
    dark = false;
    expect(getEffectiveTheme("system")).toBe("light");
    expect(getEffectiveTheme("high-contrast")).toBe("high-contrast");
  });

  it("separates application from persistence", () => {
    applyThemeToDocument("dark");
    expect(attrs.get("data-theme")).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(storage.setItem).not.toHaveBeenCalled();
    applyTheme("light");
    expect(store.get(THEME_STORAGE_KEY)).toBe("light");
  });

  it("keeps explicit choices when storage is blocked", () => {
    storage.getItem.mockImplementation(() => { throw new Error("blocked"); });
    storage.setItem.mockImplementation(() => { throw new Error("blocked"); });
    expect(getStoredTheme()).toBe("system");
    applyTheme("light");
    const cleanup = initThemeListener();
    dark = true;
    mediaListeners.get("change")?.();
    expect(attrs.get("data-theme")).toBe("light");
    cleanup();
  });

  it("updates system mode without rewriting storage", () => {
    applyThemeToDocument("system");
    const callback = vi.fn();
    const cleanup = initThemeListener(callback);
    dark = true;
    mediaListeners.get("change")?.();
    expect(attrs.get("data-theme")).toBe("dark");
    expect(callback).toHaveBeenCalledWith("dark");
    expect(storage.setItem).not.toHaveBeenCalled();
    cleanup();
    expect(listeners.size).toBe(0);
    expect(mediaListeners.size).toBe(0);
  });

  it("syncs other tabs without storage feedback", () => {
    const cleanup = initThemeListener();
    const handler = listeners.get("storage")!;
    handler({ key: THEME_STORAGE_KEY, newValue: "dark", storageArea: storage });
    expect(attrs.get("data-theme-preference")).toBe("dark");
    handler({ key: "unrelated", newValue: "light", storageArea: storage });
    expect(attrs.get("data-theme-preference")).toBe("dark");
    handler({ key: THEME_STORAGE_KEY, newValue: null, storageArea: storage });
    expect(attrs.get("data-theme-preference")).toBe("system");
    handler({ key: THEME_STORAGE_KEY, newValue: "light", storageArea: {} });
    expect(attrs.get("data-theme-preference")).toBe("system");
    expect(storage.setItem).not.toHaveBeenCalled();
    cleanup();
  });

  it("handles storage clear events and unavailable matchMedia", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    expect(getEffectiveTheme("system")).toBe("light");
    const cleanup = initThemeListener();
    applyThemeToDocument("dark");
    listeners.get("storage")?.({ key: null, storageArea: storage });
    expect(attrs.get("data-theme-preference")).toBe("system");
    cleanup();
  });
});
