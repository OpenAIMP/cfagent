import React from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "trade" | "accent" | "warning";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** solid = filled; subtle = tinted background + tone text/border (dense chips, table actions). */
  tone?: "solid" | "subtle";
  size?: "sm" | "md" | "lg";
  /** Shows a spinner and sets aria-busy; the button is disabled while loading. */
  loading?: boolean;
}

/**
 * Button (#492)
 * The shared action button. Variants map to semantic token pairs only
 * (./primitives.css), so it follows every theme by construction.
 * Defaults to type="button" — pass type="submit" inside forms.
 */
export function Button({
  variant = "secondary",
  tone = "solid",
  size = "md",
  loading = false,
  disabled,
  type = "button",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`ui-btn variant-${variant} tone-${tone} size-${size} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="ui-btn-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
