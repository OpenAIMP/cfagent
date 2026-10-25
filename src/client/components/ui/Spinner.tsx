import React from "react";

export interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  /** Accessible label announced via role="status" (spec section 13). */
  label?: string;
  className?: string;
}

/**
 * Spinner (#492)
 * Token-colored loading indicator. Announce sparingly: wrap a region in
 * it when the wait is the region's only content; the label is read by
 * assistive tech via role="status". Styles: ./primitives.css.
 */
export function Spinner({ size = "md", label = "Loading", className = "" }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={`ui-spinner size-${size} ${className}`}
    />
  );
}
