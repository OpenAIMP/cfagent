import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FONT_STYLE_OPTIONS,
  FONT_SCALE_PRESETS,
  UNIVERSAL_SYSTEM_FONT,
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

  describe("Single Universal Font Enforcement", () => {
    it("provides institutional default font scale of 1.0 (100%)", () => {
      expect(getStoredFontScale()).toBe(1.0);
    });

    it("enforces single universal font style of Inter", () => {
      expect(getStoredFontStyle()).toBe("inter");
      expect(UNIVERSAL_SYSTEM_FONT).toContain("Inter");
    });

    it("purges any legacy non-inter font preference on retrieval", () => {
      store.set(FONT_STYLE_STORAGE_KEY, "jetbrains");
      expect(getStoredFontStyle()).toBe("inter");
      expect(store.has(FONT_STYLE_STORAGE_KEY)).toBe(false);
    });

    it("provides structured font scale presets matching standard readability tiers", () => {
      const presetIds = FONT_SCALE_PRESETS.map((p) => p.id);
      expect(presetIds).toEqual(["compact", "normal", "comfortable", "large"]);
      expect(FONT_SCALE_PRESETS.find((p) => p.id === "compact")?.scale).toBe(0.85);
      expect(FONT_SCALE_PRESETS.find((p) => p.id === "large")?.scale).toBe(1.3);
    });

    it("ensures default font option is Inter", () => {
      const defaultFont = FONT_STYLE_OPTIONS.find((opt) => opt.id === "inter");
      expect(defaultFont).toBeDefined();
      expect(defaultFont?.fontFamily).toContain("Inter");
    });
  });

  describe("Application & Persistence", () => {
    it("applies font scale and single Inter font to documentElement CSS properties", () => {
      applyTypography(1.15, "inter");

      expect(styleProps.get("--app-font-scale")).toBe("1.15");
      expect(styleProps.get("--font-sans")).toContain("Inter");
      expect(docAttrs.get("data-font-size")).toBe("comfortable");
      expect(docAttrs.get("data-font-style")).toBe("inter");
      expect(store.get(FONT_SCALE_STORAGE_KEY)).toBe("1.15");
      expect(store.has(FONT_STYLE_STORAGE_KEY)).toBe(false);
    });

    it("clamps font scale safely between 0.75 and 1.5", () => {
      applyTypography(0.5);
      expect(getStoredFontScale()).toBe(0.75);

      applyTypography(2.5);
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

    it("broadcasts typography-changed event on update with Inter font", () => {
      applyTypography(1.2);
      expect((globalThis as any).window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "typography-changed",
        })
      );
    });
  });
});
