import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AsyncJobsPanel } from '../src/client/AsyncJobsPanel';

describe('async jobs UI rendering', () => {
  it('starts embedded view in a loading state rather than a false empty state', () => {
    const html = renderToStaticMarkup(React.createElement(AsyncJobsPanel, { embedded: true }));
    expect(html).toContain('Loading background jobs');
    expect(html).toContain('role="status"');
    expect(html).toContain('Background work');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('No background jobs');
    expect(html).not.toContain('No active tasks');
  });
  it('preserves a native disclosure in standalone view', () => {
    const html = renderToStaticMarkup(React.createElement(AsyncJobsPanel));
    expect(html).toContain('<details');
    expect(html).toContain('<summary>Async tasks');
    expect(html).toContain('Loading background jobs');
    expect(html).toContain('type="button"');
    expect(html).toContain('ds-button');
    expect(html).toContain('aria-labelledby=');
  });
  it('keeps layout colors token-driven and avoids important overrides', () => {
    const css = readFileSync('src/client/asyncJobs.css', 'utf8');
    expect(css).not.toMatch(/!important|#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).toContain(':focus-visible');
  });
});
