import React from "react";
import { getSegmentNavigationTarget, getSegmentTabStop } from "./segmentedNavigation";

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

/** Single-selection radio group; use a separate tabs pattern for navigation. */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  size = "md",
  ariaLabel = "Segmented toggle",
  className = "",
}: SegmentedControlProps<T>) {
  const buttons = React.useRef<Array<HTMLButtonElement | null>>([]);
  const tabStop = getSegmentTabStop(options, value);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = getSegmentNavigationTarget(options, index, event.key);
    if (target === null) return;
    event.preventDefault();
    buttons.current[target]?.focus();
    if (options[target].id !== value) onChange(options[target].id);
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`segmented-control size-${size} ${className}`}
    >
      {options.map((opt, index) => {
        const isSelected = opt.id === value;
        return (
          <button
            key={opt.id}
            ref={element => { buttons.current[index] = element; }}
            type="button"
            role="radio"
            aria-checked={isSelected}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={opt.disabled}
            className={`segmented-btn ${isSelected ? "selected" : ""} ${opt.disabled ? "disabled" : ""}`}
            onKeyDown={event => handleKeyDown(event, index)}
            onClick={() => !opt.disabled && onChange(opt.id)}
          >
            {opt.icon && <span className="segmented-icon" aria-hidden="true">{opt.icon}</span>}
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
