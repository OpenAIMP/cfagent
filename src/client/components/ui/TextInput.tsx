import React from "react";
import { FieldShell, fieldDescribedBy } from "./Field";

export interface TextInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  hint?: string;
  /** Error message; sets aria-invalid and the danger styling. */
  error?: string;
  size?: "sm" | "md";
  wrapperClassName?: string;
}

/**
 * TextInput (#492)
 * Labeled text field on the token input family (--color-input*). With no
 * label/hint/error it renders the bare control (toolbars, filters).
 * Styles: ./primitives.css.
 */
export function TextInput({
  label,
  hint,
  error,
  size = "md",
  wrapperClassName = "",
  id,
  className = "",
  ...rest
}: TextInputProps) {
  const autoId = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fieldId = id ?? `ui-input-${autoId}`;
  const control = (
    <input
      id={fieldId}
      className={`ui-input size-${size} ${error ? "invalid" : ""} ${className}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={fieldDescribedBy(fieldId, hint, error)}
      {...rest}
    />
  );
  if (!label && !hint && !error) return control;
  return (
    <FieldShell id={fieldId} label={label} hint={hint} error={error} className={wrapperClassName}>
      {control}
    </FieldShell>
  );
}
