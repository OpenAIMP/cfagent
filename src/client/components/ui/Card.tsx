import React from "react";

export interface CardProps {
  /** Raised surface + stronger shadow instead of the flat card surface. */
  elevated?: boolean;
  /** Primary-tinted background + border for the lead tile (issue 2149: preserves the old first-stat highlight without a bespoke class). */
  highlight?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  className?: string;
  /**
   * Data-driven inline style (issue 2161: per-ad accent colors from the
   * ad record, not design values — layout still comes from tokens).
   */
  style?: React.CSSProperties;
  children: React.ReactNode;
}

/**
 * Card (#492)
 * The shared surface container: card background, subtle border, 12px
 * radius, card shadow — the values the app's incumbent section cards
 * already use, formalized. Styles: ./primitives.css.
 */
export function Card({ elevated = false, highlight = false, padding = "md", className = "", style, children }: CardProps) {
  return (
    <div className={`ui-card ${elevated ? "elevated" : ""} ${highlight ? "highlight" : ""} pad-${padding} ${className}`} style={style}>
      {children}
    </div>
  );
}
