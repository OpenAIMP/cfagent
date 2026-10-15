import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AsyncState, Button, StatusBadge, Surface } from '../src/client/components/ui/Foundations';

describe('shared UI foundations', () => {
  it('defaults to a non-submitting button with an accessible text label', () => {
    const html = renderToStaticMarkup(React.createElement(Button, null, 'Refresh jobs'));
    expect(html).toContain('type="button"');
    expect(html).toContain('Refresh jobs');
    expect(html).toContain('data-variant="secondary"');
  });
  it('disables loading buttons and exposes busy state', () => {
    const html = renderToStaticMarkup(React.createElement(Button, { loading: true }, 'Refresh'));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Refresh');
  });
  it('preserves explicit form semantics and disabled state', () => {
    const html = renderToStaticMarkup(React.createElement(Button, { type: 'submit', disabled: true, 'aria-label': 'Save appearance' }, 'Save'));
    expect(html).toContain('type="submit"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-label="Save appearance"');
  });
  it('supports scoped surface variants and caller attributes', () => {
    const html = renderToStaticMarkup(React.createElement(Surface, { tone: 'sunken', id: 'job-result' }, 'Result'));
    expect(html).toContain('data-tone="sunken"');
    expect(html).toContain('id="job-result"');
  });
  it('keeps status labels textual and non-live by default', () => {
    const html = renderToStaticMarkup(React.createElement(StatusBadge, { tone: 'danger' }, 'Failed'));
    expect(html).toContain('Failed');
    expect(html).toContain('data-tone="danger"');
    expect(html).not.toContain('role="alert"');
  });
  it('distinguishes errors from loading and empty states', () => {
    for (const state of ['loading', 'empty', 'error'] as const) {
      const html = renderToStaticMarkup(React.createElement(AsyncState, { state, title: 'Job status', description: 'Details', action: React.createElement(Button, null, 'Retry') }));
      expect(html).toContain(`role="${state === 'error' ? 'alert' : 'status'}"`);
      expect(html).toContain('Job status');
      expect(html).toContain('Details');
      expect(html).toContain('Retry');
    }
  });
  it('keeps component styles scoped and token-driven', () => {
    const css = readFileSync('src/client/components/ui/foundations.css', 'utf8');
    expect(css).not.toMatch(/!important|#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).toContain(':focus-visible');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('--app-font-scale');
    expect(css).toContain('--control-height');
  });
});
