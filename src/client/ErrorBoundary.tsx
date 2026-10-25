/**
 * ErrorBoundary — containment for panel render failures.
 *
 * The app previously had NO error boundary anywhere: a single throw in
 * any panel unmounted the entire React tree and left a blank page with
 * no diagnostics (the Portfolio & Holdings crash, issue #71). This
 * boundary (1) contains the failure to the wrapped subtree so the rest
 * of the app keeps working, and (2) renders the error name, message,
 * and React component stack on screen, so the failure is diagnosable
 * from a screenshot without devtools. A Retry button re-mounts the
 * children (useful for transient data states).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Human label naming the wrapped area, shown in the fallback. */
  label: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // Keep the failure visible in the console as well.
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          margin: "12px 0",
          padding: "12px 14px",
          border: "1px solid var(--color-danger)",
          borderRadius: 10,
          background: "var(--color-danger-subtle)",
          color: "inherit",
          fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          ⚠ {this.props.label} hit an error and was stopped so the rest of the app keeps working.
        </div>
        <div style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {error.name}: {error.message}
        </div>
        {componentStack && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer" }}>Component stack</summary>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11, margin: "6px 0 0" }}>
              {componentStack.trim()}
            </pre>
          </details>
        )}
        {error.stack && (
          <details style={{ marginTop: 4 }}>
            <summary style={{ cursor: "pointer" }}>Error stack</summary>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11, margin: "6px 0 0" }}>
              {error.stack}
            </pre>
          </details>
        )}
        <button
          type="button"
          onClick={this.handleRetry}
          style={{
            marginTop: 10,
            padding: "5px 12px",
            borderRadius: 8,
            border: "1px solid var(--color-danger)",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          Retry
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
