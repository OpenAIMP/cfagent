import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FONT_STYLE_OPTIONS,
  FONT_SCALE_PRESETS,
  getStoredFontScale,
  getStoredFontStyle,
  applyTypography,
  adjustFontScale,
  FONT_SCALE_STORAGE_KEY,
  FONT_STYLE_STORAGE_KEY,
} from "../src/client/typography";

describe("Global Typography & Font Sizing System", () => {
  const store = new Map<string, string>();
  const styleProps = new Map<string, string>();
  const docAttrs = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    styleProps.clear();
    docAttrs.clear();

    // Mock localStorage
    (globalThis as any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => store.set(key, String(val)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    };

    // Mock document
    (globalThis as any).document = {
      documentElement: {
        style: {
          setProperty: (k: string, v: string) => styleProps.set(k, v),
          getPropertyValue: (k: string) => styleProps.get(k) || "",
          removeProperty: (k: string) => styleProps.delete(k),
        },
        setAttribute: (k: string, v: string) => docAttrs.set(k, v),
        getAttribute: (k: string) => docAttrs.get(k) || null,
      },
    };

    // Mock window event dispatching
    (globalThis as any).window = {
      dispatchEvent: vi.fn(),
    };
  });

  describe("Defaults & Specification", () => {
    it("provides institutional default font scale of 1.0 (100%)", () => {
      expect(getStoredFontScale()).toBe(1.0);
    });

    it("provides default font style of Plus Jakarta Sans", () => {
      expect(getStoredFontStyle()).toBe("jakarta");
    });

    it("supports all required typefaces including Inter, Roboto, JetBrains Mono, Outfit", () => {
      const ids = FONT_STYLE_OPTIONS.map((opt) => opt.id);
      expect(ids).toContain("jakarta");
      expect(ids).toContain("inter");
      expect(ids).toContain("roboto");
      expect(ids).toContain("jetbrains");
      expect(ids).toContain("outfit");
      expect(ids).toContain("system");
    });

    it("provides structured font scale presets matching standard readability tiers", () => {
      const presetIds = FONT_SCALE_PRESETS.map((p) => p.id);
      expect(presetIds).toEqual(["compact", "normal", "comfortable", "large"]);
      expect(FONT_SCALE_PRESETS.find((p) => p.id === "compact")?.scale).toBe(0.85);
      expect(FONT_SCALE_PRESETS.find((p) => p.id === "large")?.scale).toBe(1.3);
    });

    it("provides a 'Default' font option matching the default font size option pattern", () => {
      const defaultFont = FONT_STYLE_OPTIONS.find((opt) => opt.id === "jakarta");
      expect(defaultFont).toBeDefined();
      expect(defaultFont?.label).toBe("Default");
      expect(defaultFont?.fontFamily).toContain("Plus Jakarta Sans");
    });
  });

  describe("Application & Persistence", () => {
    it("applies font scale and style to documentElement CSS properties", () => {
      applyTypography(1.15, "inter");

      expect(styleProps.get("--app-font-scale")).toBe("1.15");
      expect(styleProps.get("--font-sans")).toContain("Inter");
      expect(docAttrs.get("data-font-size")).toBe("comfortable");
      expect(docAttrs.get("data-font-style")).toBe("inter");
      expect(store.get(FONT_SCALE_STORAGE_KEY)).toBe("1.15");
      expect(store.get(FONT_STYLE_STORAGE_KEY)).toBe("inter");
    });

    it("clamps font scale safely between 0.75 and 1.5", () => {
      applyTypography(0.5, "roboto");
      expect(getStoredFontScale()).toBe(0.75);

      applyTypography(2.5, "outfit");
      expect(getStoredFontScale()).toBe(1.5);
    });

    it("adjusts font scale incrementally via adjustFontScale", () => {
      store.set(FONT_SCALE_STORAGE_KEY, "1.0");

      const increased = adjustFontScale(0.05);
      expect(increased).toBe(1.05);
      expect(getStoredFontScale()).toBe(1.05);

      const decreased = adjustFontScale(-0.1);
      expect(decreased).toBe(0.95);
      expect(getStoredFontScale()).toBe(0.95);
    });

    it("broadcasts typography-changed event on update", () => {
      applyTypography(1.2, "jetbrains");
      expect((globalThis as any).window.dispatchEvent).toHaveBeenCalled();
    });
  });
});
