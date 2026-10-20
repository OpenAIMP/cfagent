import React from "react";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "purple"
  | "trade";

export interface BadgeProps {
  tone?: BadgeTone;
  size?: "sm" | "md";
  /** Show a leading status dot in the badge's tone color. */
  dot?: boolean;
  /** Render the label in tracked uppercase (nav/status-label style). */
  uppercase?: boolean;
  title?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Badge (#492)
 * Small status/label pill. Tone is semantic (docs/agents/ux-architecture.md
 * section 6: status is never carried by color alone — pair with the label
 * text; the dot is only a redundant cue). Styles: ./primitives.css.
 */
export function Badge({
  tone = "neutral",
  size = "md",
  dot = false,
  uppercase = false,
  title,
  className = "",
  children,
}: BadgeProps) {
  return (
    <span className={`ui-badge tone-${tone} size-${size} ${uppercase ? "uppercase" : ""} ${className}`} title={title}>
      {dot && <span className="ui-badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
