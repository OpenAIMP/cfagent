import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeTheme } from '../src/client/theme';
import { getStoredFontScale } from '../src/client/typography';
import { getStoredDensity } from '../src/client/designTokens';

const html = readFileSync('index.html', 'utf8');
const script = html.match(/<script id="appearance-bootstrap">([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('Appearance bootstrap script missing');

function bootstrap(values: Record<string, string> = {}, dark = false, blockedKey?: string, unavailableMedia = false) {
  const attrs = new Map<string, string>();
  const props = new Map<string, string>();
  const classes = new Map<string, boolean>();
  const storage = {
    getItem: (key: string) => {
      if (blockedKey === '*' || blockedKey === key) throw new Error('Storage blocked');
      return values[key] ?? null;
    },
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  const style = { colorScheme: '', setProperty: (key: string, value: string) => props.set(key, value) };
  runInNewContext(script!, {
    localStorage: storage,
    window: { matchMedia: unavailableMedia ? undefined : () => ({ matches: dark }) },
    document: { documentElement: {
      setAttribute: (key: string, value: string) => attrs.set(key, value),
      classList: { toggle: (key: string, value: boolean) => classes.set(key, value) },
      style,
    } },
  });
  return { attrs, props, classes, storage, style };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('pre-paint appearance bootstrap', () => {
  it('matches theme validation and system resolution', () => {
    for (const saved of ['', 'invalid', 'light', 'dark', 'system', 'high-contrast']) {
      for (const dark of [false, true]) {
        const result = bootstrap({ nextgentp_theme: saved }, dark);
        const preference = normalizeTheme(saved);
        const effective = preference === 'system' ? (dark ? 'dark' : 'light') : preference;
        expect(result.attrs.get('data-theme-preference')).toBe(preference);
        expect(result.attrs.get('data-theme')).toBe(effective);
        expect(result.style.colorScheme).toBe(effective);
        expect(result.classes.get('dark')).toBeUndefined();
        expect(result.classes.get('light')).toBeUndefined();
      }
    }
  });

  it('matches stored text-scale validation', () => {
    for (const saved of ['', 'garbage', 'NaN', 'Infinity', '0.5', '2', '0.75', '1.156', '1.5', '1.2legacy']) {
      const result = bootstrap({ nextgentp_font_scale: saved });
      vi.stubGlobal('window', {});
      vi.stubGlobal('localStorage', result.storage);
      expect(result.props.get('--app-font-scale')).toBe(String(getStoredFontScale()));
      expect(result.attrs.get('data-font-scale')).toBe(String(getStoredFontScale()));
    }
  });

  it('matches density validation', () => {
    for (const saved of ['', 'invalid', 'compact', 'comfortable']) {
      const result = bootstrap({ nextgentp_density: saved });
      vi.stubGlobal('window', {});
      vi.stubGlobal('localStorage', result.storage);
      expect(result.attrs.get('data-density')).toBe(getStoredDensity());
    }
  });

  it('applies safe defaults even when all storage is blocked', () => {
    const result = bootstrap({}, true, '*');
    expect(result.attrs.get('data-theme')).toBe('dark');
    expect(result.props.get('--app-font-scale')).toBe('1');
    expect(result.attrs.get('data-density')).toBe('comfortable');
    expect(result.attrs.get('data-font-style')).toBe('inter');
  });

  it('isolates failures between preferences', () => {
    const result = bootstrap({ nextgentp_font_scale: '1.3', nextgentp_density: 'compact' }, false, 'nextgentp_theme');
    expect(result.attrs.get('data-theme-preference')).toBe('system');
    expect(result.attrs.get('data-font-size')).toBe('large');
    expect(result.attrs.get('data-density')).toBe('compact');
  });

  it('handles missing matchMedia and never writes storage', () => {
    const result = bootstrap({}, false, undefined, true);
    expect(result.attrs.get('data-theme')).toBe('light');
    expect(result.storage.setItem).not.toHaveBeenCalled();
    expect(result.storage.removeItem).not.toHaveBeenCalled();
  });
});
