import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adjustFontScale, applyTypography, applyTypographyToDocument, FONT_SCALE_PRESETS, FONT_SCALE_STORAGE_KEY, FONT_STYLE_OPTIONS, FONT_STYLE_STORAGE_KEY, getStoredFontScale, getStoredFontStyle, initTypographyListener, normalizeFontScale, parseStoredFontScale, UNIVERSAL_CODE_FONT, UNIVERSAL_SYSTEM_FONT } from '../src/client/typography';

describe('typography preferences', () => {
  let store: Map<string, string>;
  let props: Map<string, string>;
  let attrs: Map<string, string>;
  let handlers: Set<(event: any) => void>;
  let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    store = new Map(); props = new Map(); attrs = new Map(); handlers = new Set();
    storage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
      removeItem: vi.fn((key: string) => { store.delete(key); }),
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('document', { documentElement: {
      style: { setProperty: (key: string, value: string) => props.set(key, value) },
      setAttribute: (key: string, value: string) => attrs.set(key, value),
      getAttribute: (key: string) => attrs.get(key) ?? null,
    } });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init: unknown) {} });
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      addEventListener: (_key: string, handler: (event: any) => void) => handlers.add(handler),
      removeEventListener: (_key: string, handler: (event: any) => void) => handlers.delete(handler),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps supported font and stable preset IDs explicit', () => {
    expect(FONT_STYLE_OPTIONS.map(p => p.id)).toEqual(['inter']);
    expect(FONT_SCALE_PRESETS.map(p => p.id)).toEqual(['compact', 'normal', 'comfortable', 'large']);
    expect(UNIVERSAL_SYSTEM_FONT).toContain('Inter');
  });
  it('makes reads non-destructive, including legacy font preferences', () => {
    store.set(FONT_STYLE_STORAGE_KEY, 'jetbrains');
    expect(getStoredFontStyle()).toBe('inter');
    expect(getStoredFontScale()).toBe(1);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(store.get(FONT_STYLE_STORAGE_KEY)).toBe('jetbrains');
  });
  it('validates stored scales and preserves legacy parsing compatibility', () => {
    for (const value of [null, '', 'garbage', 'NaN', 'Infinity', '0.5', '2']) expect(parseStoredFontScale(value)).toBe(1);
    expect(parseStoredFontScale('1.156')).toBe(1.16);
    expect(parseStoredFontScale('1.2legacy')).toBe(1.2);
    store.set(FONT_SCALE_STORAGE_KEY, '1.3');
    expect(getStoredFontScale()).toBe(1.3);
  });
  it('handles non-finite input and clamps explicit scale changes', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(normalizeFontScale(value)).toBe(1);
    expect(normalizeFontScale(0.5)).toBe(0.75);
    expect(normalizeFontScale(2.5)).toBe(1.5);
    applyTypography(NaN);
    expect(props.get('--app-font-scale')).toBe('1');
  });
  it('applies typography without storage writes and preserves code tokens', () => {
    applyTypographyToDocument(1.15, 'inter');
    expect(props.get('--app-font-scale')).toBe('1.15');
    expect(props.get('--font-sans')).toBe(UNIVERSAL_SYSTEM_FONT);
    expect(props.get('--font-mono')).toBe(UNIVERSAL_CODE_FONT);
    expect(props.get('--font-code')).toBe(UNIVERSAL_CODE_FONT);
    expect(attrs.get('data-font-size')).toBe('comfortable');
    expect(attrs.get('data-font-style')).toBe('inter');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'typography-changed' }));
  });
  it('persists explicit changes and cleans legacy style only on writes', () => {
    store.set(FONT_STYLE_STORAGE_KEY, 'jetbrains');
    applyTypography(1.3);
    expect(store.get(FONT_SCALE_STORAGE_KEY)).toBe('1.3');
    expect(store.has(FONT_STYLE_STORAGE_KEY)).toBe(false);
  });
  it('uses active scale with blocked storage and returns the bounded result', () => {
    storage.getItem.mockImplementation(() => { throw new Error('blocked'); });
    storage.setItem.mockImplementation(() => { throw new Error('blocked'); });
    storage.removeItem.mockImplementation(() => { throw new Error('blocked'); });
    expect(getStoredFontScale()).toBe(1);
    applyTypographyToDocument(1.45);
    expect(adjustFontScale(0.2)).toBe(1.5);
    expect(adjustFontScale(-0.1)).toBe(1.4);
    expect(adjustFontScale(NaN)).toBe(1.4);
    expect(adjustFontScale(-10)).toBe(0.75);
  });
  it('syncs text scale without storage feedback and cleans up listeners', () => {
    const cleanup = initTypographyListener();
    const send = (event: any) => handlers.forEach(handler => handler(event));
    send({ key: FONT_SCALE_STORAGE_KEY, newValue: '1.3', storageArea: storage });
    expect(attrs.get('data-font-scale')).toBe('1.3');
    send({ key: 'unrelated', newValue: '1', storageArea: storage });
    send({ key: FONT_SCALE_STORAGE_KEY, newValue: '1', storageArea: {} });
    expect(attrs.get('data-font-scale')).toBe('1.3');
    send({ key: FONT_STYLE_STORAGE_KEY, newValue: 'jetbrains', storageArea: storage });
    expect(attrs.get('data-font-scale')).toBe('1.3');
    send({ key: FONT_SCALE_STORAGE_KEY, newValue: null, storageArea: storage });
    expect(attrs.get('data-font-scale')).toBe('1');
    store.set(FONT_SCALE_STORAGE_KEY, '1.15');
    send({ key: null, storageArea: storage });
    expect(attrs.get('data-font-scale')).toBe('1.15');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    cleanup();
    expect(handlers.size).toBe(0);
  });
});
