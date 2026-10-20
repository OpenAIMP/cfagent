import React from "react";

export interface EmptyStateProps {
  /** Decorative glyph/icon shown above the title (aria-hidden). */
  icon?: React.ReactNode;
  title: string;
  description?: string;
  /** Optional call-to-action node (usually a Button). */
  action?: React.ReactNode;
  /** Dashed, muted panel framing (the Autopilot-style empty panel). */
  framed?: boolean;
  className?: string;
}

/**
 * EmptyState (#492)
 * The shared "nothing here yet" block — icon, title, description, action —
 * formalizing the app's incumbent empty-state pattern. Styles:
 * ./primitives.css (values match the legacy global classes it replaces).
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  framed = false,
  className = "",
}: EmptyStateProps) {
  return (
    <div className={`ui-empty ${framed ? "framed" : ""} ${className}`}>
      {icon && (
        <div className="ui-empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="ui-empty-title">{title}</h3>
      {description && <p className="ui-empty-text">{description}</p>}
      {action}
    </div>
  );
}
