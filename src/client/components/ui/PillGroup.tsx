import React from "react";

export interface PillOption<T extends string = string> {
  id: T;
  label: string;
  icon?: React.ReactNode;
  tooltip?: string;
  disabled?: boolean;
}

export interface PillGroupProps<T extends string = string> {
  options: PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  variant?: "default" | "cyan" | "emerald" | "amber" | "purple";
  ariaLabel?: string;
  className?: string;
}

/**
 * PillGroup
 * Composable, accessible selection pill group for metrics, filters, and categories.
 */
export function PillGroup<T extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  variant = "cyan",
  ariaLabel = "Filter pills",
  className = "",
}: PillGroupProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`pill-group size-${size} variant-${variant} ${className}`}
    >
      {options.map((opt) => {
        const isSelected = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            tabIndex={isSelected ? 0 : -1}
            disabled={opt.disabled}
            title={opt.tooltip}
            className={`pill-btn ${isSelected ? "selected" : ""} ${opt.disabled ? "disabled" : ""}`}
            onClick={() => !opt.disabled && onChange(opt.id)}
          >
            {opt.icon && <span className="pill-icon">{opt.icon}</span>}
            <span className="pill-label">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
