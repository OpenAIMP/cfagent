import React from "react";
import { FieldShell, fieldDescribedBy } from "./Field";

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  label?: string;
  hint?: string;
  error?: string;
  size?: "sm" | "md";
  wrapperClassName?: string;
  children: React.ReactNode;
}

/**
 * Select (#492)
 * Native <select> on the token input family — native is deliberate: the
 * app sets the root color-scheme from the theme, so native dropdowns
 * render in-scheme in every theme (see the #476 note in
 * scheduledOptions.css). Label/hint/error wiring matches TextInput.
 * Styles: ./primitives.css.
 */
export function Select({
  label,
  hint,
  error,
  size = "md",
  wrapperClassName = "",
  id,
  className = "",
  children,
  ...rest
}: SelectProps) {
  const autoId = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fieldId = id ?? `ui-select-${autoId}`;
  const control = (
    <select
      id={fieldId}
      className={`ui-select size-${size} ${error ? "invalid" : ""} ${className}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={fieldDescribedBy(fieldId, hint, error)}
      {...rest}
    >
      {children}
    </select>
  );
  if (!label && !hint && !error) return control;
  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error} className={wrapperClassName}>
      {control}
    </FieldShell>
  );
}
