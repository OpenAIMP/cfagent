/**
 * Issue #71: ErrorBoundary contract tests (DOM-free so they run in the
 * plain node suite — jsdom is not a repo dependency):
 *  - getDerivedStateFromError captures the thrown error.
 *  - componentDidCatch records the component stack.
 *  - With an error in state, render() produces the fallback: the label,
 *    the error name + message (diagnosable from a screenshot, no
 *    devtools needed), and a Retry button.
 *  - With no error, render() returns the children untouched.
 * React's boundary recovery semantics themselves are framework-provided;
 * this suite pins OUR fallback content and state handling.
 */
import { describe, it, expect } from "vitest";
import { createElement, isValidElement, type ReactNode } from "react";
import { ErrorBoundary } from "../src/client/ErrorBoundary";

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return collectText(props.children);
  }
  return "";
}

/** Find a primitive-button element by its exact label text (unrendered tree walk). */
function findButtonByText(node: ReactNode, text: string): { onClick?: () => void } | null {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButtonByText(child, text);
      if (found) return found;
    }
    return null;
  }
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode; onClick?: () => void };
    if (props.children === text && props.onClick) return { onClick: props.onClick };
    return findButtonByText(props.children, text);
  }
  return null;
}

function errorBoundary(): ErrorBoundary {
  const boundary = new ErrorBoundary({ label: "Portfolio Risk panel", children: createElement("p", null, "never shown") });
  boundary.state = {
    error: new TypeError("Cannot read properties of undefined (reading 'positions')"),
    componentStack: "at Boom",
  };
  boundary.setState = ((update: unknown) => {
    Object.assign(boundary.state, typeof update === "function" ? (update as (s: unknown) => unknown)(boundary.state) : update);
  }) as typeof boundary.setState;
  return boundary;
}

describe("ErrorBoundary (issue #71)", () => {
  it("captures the error via getDerivedStateFromError", () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'positions')");
    const partial = ErrorBoundary.getDerivedStateFromError(err);
    expect(partial.error).toBe(err);
  });

  it("records the component stack via componentDidCatch", () => {
    const boundary = new ErrorBoundary({ label: "Portfolio Risk panel", children: null });
    const err = new Error("boom");
    boundary.setState = ((update: unknown) => {
      Object.assign(boundary.state, typeof update === "function" ? (update as (s: unknown) => unknown)(boundary.state) : update);
    }) as typeof boundary.setState;
    boundary.componentDidCatch(err, { componentStack: "\n    at Boom\n    at PortfolioRiskPanel" } as never);
    expect(boundary.state.componentStack).toContain("at PortfolioRiskPanel");
  });

  it("renders the fallback (label + error + Retry) when an error is in state", () => {
    const boundary = new ErrorBoundary({ label: "Portfolio Risk panel", children: createElement("p", null, "never shown") });
    boundary.state = {
      error: new TypeError("Cannot read properties of undefined (reading 'positions')"),
      componentStack: "at Boom",
    };
    const text = collectText(boundary.render());
    expect(text).toContain("Portfolio Risk panel");
    expect(text).toContain("TypeError");
    expect(text).toContain("reading 'positions'");
    expect(text).toContain("Retry");
    expect(text).not.toContain("never shown");
  });

  it("renders children untouched when there is no error", () => {
    const boundary = new ErrorBoundary({ label: "Anything", children: createElement("p", null, "all good") });
    const out = boundary.render();
    expect(collectText(out)).toContain("all good");
  });

  it("A3-b: fallback leads with business language, not the technical error", () => {
    const text = collectText(errorBoundary().render());
    expect(text).toContain("Portfolio Risk panel");
    expect(text).toContain("unavailable");
    expect(text).toContain("rest of the app is affected");
    expect(text).toContain("Retry");
    expect(text).toContain("Reload page");
    // Technical detail is kept (collapsed) for screenshot diagnosability (#71).
    expect(text).toContain("TypeError");
    expect(text).toContain("reading 'positions'");
  });

  it("A3-b: Retry clears the error state (view-only recovery)", () => {
    const boundary = errorBoundary();
    const retry = findButtonByText(boundary.render(), "Retry");
    expect(retry).not.toBeNull();
    retry!.onClick!();
    expect(boundary.state.error).toBeNull();
  });

  it("A3-b: Reload page handler exists and is safe without a window", () => {
    const reload = findButtonByText(errorBoundary().render(), "Reload page");
    expect(reload).not.toBeNull();
    expect(() => reload!.onClick!()).not.toThrow();
  });
});
