import React from "react";

export interface SegmentedControlOption<T extends string = string> {
  id: T;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md" | "lg";
  ariaLabel?: string;
  className?: string;
}

/**
 * SegmentedControl
 * Enterprise-grade, accessible, smooth sliding segmented pill switch.
 * Ideal for view toggles (Graph vs Matrix Table, Timeframe switches, Order sides).
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel = "Segmented toggle",
  className = "",
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`segmented-control size-${size} ${className}`}
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
            className={`segmented-btn ${isSelected ? "selected" : ""} ${opt.disabled ? "disabled" : ""}`}
            onClick={() => !opt.disabled && onChange(opt.id)}
          >
            {opt.icon && <span className="segmented-icon">{opt.icon}</span>}
            <span className="segmented-label">{opt.label}</span>
            {opt.badge !== undefined && (
              <span className="segmented-badge">{opt.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
