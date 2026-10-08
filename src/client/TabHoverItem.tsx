import React, { useId, useState, useEffect } from "react";

export interface TabHoverItemProps {
  eyebrow?: string;
  title: string;
  description: string;
  children: React.ReactNode;
  align?: "center" | "left" | "right";
  className?: string;
}

/**
 * TabHoverItem: Reusable, accessible tab hover card component.
 * Complies with:
 * - WCAG 2.2 SC 1.3.1 (Info and Relationships) & SC 4.1.2 (Name, Role, Value) via aria-describedby
 * - WCAG 2.2 SC 1.4.13 (Content on Hover or Focus) with Escape dismissal
 * - ISO 9241-110 (Self-descriptiveness & Controllability)
 */
export function TabHoverItem({
  eyebrow,
  title,
  description,
  children,
  align = "center",
  className = "",
}: TabHoverItemProps) {
  const tooltipId = useId();
  const [dismissed, setDismissed] = useState(false);

  // WCAG 2.2 SC 1.4.13: Allow dismissing hover/focus popover with Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setDismissed(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Clone child with aria-describedby for assistive tech (WCAG 2.2 SC 4.1.2)
  // Suppress native browser title tooltips on child buttons to avoid overlapping native & custom popovers
  const accessibleChild = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<any>, {
        "aria-describedby": (children.props as any)["aria-describedby"]
          ? `${(children.props as any)["aria-describedby"]} ${tooltipId}`
          : tooltipId,
        title: "",
      })
    : children;

  return (
    <div
      className={`tab-hover-wrapper align-${align} ${className} ${dismissed ? "tooltip-dismissed" : ""}`}
      onMouseEnter={() => setDismissed(false)}
      onFocus={() => setDismissed(false)}
    >
      {accessibleChild}
      {!dismissed && (
        <div
          className="tab-hover-popover"
          role="tooltip"
          id={tooltipId}
          aria-live="polite"
        >
          {eyebrow && <span className="tab-hover-eyebrow">{eyebrow}</span>}
          <strong className="tab-hover-title">{title}</strong>
          <p className="tab-hover-desc">{description}</p>
        </div>
      )}
    </div>
  );
}
