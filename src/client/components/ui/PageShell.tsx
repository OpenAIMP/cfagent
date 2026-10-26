import React from "react";
import { Spinner } from "./Spinner";
import { EmptyState } from "./EmptyState";
import { Notice } from "./Notice";

export interface PageShellProps {
  /** Page title (the page's h1). */
  title: string;
  /** One-line scope note under the title: what this page covers. */
  scopeNote?: string;
  /** Loading state wins over error/empty/children. */
  loading?: boolean;
  loadingLabel?: string;
  /** Error state wins over empty/children; rendered as a danger Notice. */
  error?: string | null;
  /** Empty state wins over children. */
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  /** Page sections (PageSection components). */
  children?: React.ReactNode;
}

export interface PageSectionProps {
  /** Section title (the section's h2) — the shared section treatment that
   * replaces hand-rolled `<h3 style={{ margin ... }}>` headers. */
  title?: string;
  description?: string;
  children?: React.ReactNode;
}

/**
 * PageShell (#1804 S1, issue #1808)
 * The page chrome every left-nav page renders inside: title + scope note
 * + sections, with the loading (Spinner), empty (EmptyState), and error
 * (Notice) states carried by primitives. Pages compose sections; they
 * never hand-roll page chrome, and never re-implement these states with
 * raw divs. Styles: ./primitives.css (token values only).
 */
export function PageShell({
  title,
  scopeNote,
  loading = false,
  loadingLabel = "Loading",
  error = null,
  empty = false,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  emptyAction,
  children,
}: PageShellProps) {
  return (
    <div className="ui-page-shell">
      <div className="ui-page-shell-header">
        <h1 className="ui-page-shell-title">{title}</h1>
        {scopeNote && <p className="ui-page-shell-scope">{scopeNote}</p>}
      </div>
      {loading ? (
        <div className="ui-page-shell-state">
          <Spinner label={loadingLabel} />
        </div>
      ) : error ? (
        <Notice tone="danger">{error}</Notice>
      ) : empty ? (
        <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
      ) : (
        <div className="ui-page-shell-sections">{children}</div>
      )}
    </div>
  );
}

/**
 * PageSection (#1804 S1, issue #1808)
 * One section inside a PageShell: optional title + description, then the
 * section's content (which owns its own data and surface — usually Cards).
 * Splitting a page into PageSections is what kills the monolith pattern:
 * each section fetches and renders its own slice.
 */
export function PageSection({ title, description, children }: PageSectionProps) {
  return (
    <section className="ui-page-section">
      {title && <h2 className="ui-page-section-title">{title}</h2>}
      {description && <p className="ui-page-section-description">{description}</p>}
      {children}
    </section>
  );
}
