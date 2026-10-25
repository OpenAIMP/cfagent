import React from "react";

export interface SkeletonProps {
  variant?: "text" | "block" | "circle";
  width?: string | number;
  height?: string | number;
  /** For variant="text": render this many stacked lines. */
  lines?: number;
  className?: string;
}

/**
 * Skeleton (#492)
 * Decorative loading placeholder (aria-hidden — announce loading through
 * a Spinner/status region, not the placeholder itself). Pulse animation
 * is disabled under prefers-reduced-motion. Styles: ./primitives.css.
 */
export function Skeleton({ variant = "text", width, height, lines = 1, className = "" }: SkeletonProps) {
  if (variant === "text" && lines > 1) {
    return (
      <span className={`ui-skeleton-lines ${className}`} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="ui-skeleton variant-text" style={{ width, height }} />
        ))}
      </span>
    );
  }
  return (
    <span
      className={`ui-skeleton variant-${variant} ${className}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
