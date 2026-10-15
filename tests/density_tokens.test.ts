import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDensity, applyDensityToDocument, colorRoles, DENSITY_STORAGE_KEY, getStoredDensity, initDensityListener, normalizeDensity, surfaceRoles, tokenVar } from '../src/client/designTokens';

describe('density preferences and typed tokens', () => {
  let attrs: Map<string, string>;
  let store: Map<string, string>;
  let handlers: Set<(event: any) => void>;
  let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    attrs = new Map();
    store = new Map();
    handlers = new Set();
    storage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('document', { documentElement: { setAttribute: (key: string, value: string) => attrs.set(key, value) } });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init: unknown) {} });
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
      addEventListener: (_key: string, handler: (event: any) => void) => handlers.add(handler),
      removeEventListener: (_key: string, handler: (event: any) => void) => handlers.delete(handler),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('validates density and handles unavailable storage', () => {
    expect(normalizeDensity('compact')).toBe('compact');
    for (const value of [null, undefined, 'invalid', 'comfortable']) expect(normalizeDensity(value)).toBe('comfortable');
    storage.getItem.mockImplementation(() => { throw new Error('blocked'); });
    storage.setItem.mockImplementation(() => { throw new Error('blocked'); });
    expect(getStoredDensity()).toBe('comfortable');
    expect(() => applyDensity('compact')).not.toThrow();
    expect(attrs.get('data-density')).toBe('compact');
  });

  it('separates DOM application from explicit persistence', () => {
    applyDensityToDocument('compact');
    expect(storage.setItem).not.toHaveBeenCalled();
    applyDensity('comfortable');
    expect(store.get(DENSITY_STORAGE_KEY)).toBe('comfortable');
    expect(window.dispatchEvent).toHaveBeenCalled();
  });

  it('synchronizes other tabs, resets, ignores unrelated storage, and cleans up', () => {
    const cleanup = initDensityListener();
    const send = (event: any) => handlers.forEach(handler => handler(event));
    send({ key: DENSITY_STORAGE_KEY, newValue: 'compact', storageArea: storage });
    expect(attrs.get('data-density')).toBe('compact');
    send({ key: 'unrelated', newValue: 'comfortable', storageArea: storage });
    send({ key: DENSITY_STORAGE_KEY, newValue: 'comfortable', storageArea: {} });
    expect(attrs.get('data-density')).toBe('compact');
    send({ key: DENSITY_STORAGE_KEY, newValue: null, storageArea: storage });
    expect(attrs.get('data-density')).toBe('comfortable');
    store.set(DENSITY_STORAGE_KEY, 'compact');
    send({ key: null, storageArea: storage });
    expect(attrs.get('data-density')).toBe('compact');
    expect(storage.setItem).not.toHaveBeenCalled();
    cleanup();
    expect(handlers.size).toBe(0);
  });

  it('includes every surface and its paired foreground in the typed contract', () => {
    for (const role of surfaceRoles) {
      expect(colorRoles).toContain(role);
      expect(colorRoles).toContain(`${role}-foreground`);
    }
    expect(tokenVar('muted')).toBe('var(--color-muted)');
  });

  it('maps every typed role to a declared CSS token', () => {
    const css = readFileSync('src/client/tokens.css', 'utf8');
    for (const role of colorRoles) {
      expect(tokenVar(role)).toBe(`var(--color-${role})`);
      expect(css).toMatch(new RegExp(`--color-${role}\\s*:`));
    }
  });
});
