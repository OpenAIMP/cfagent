import React from "react";
import { FieldShell, fieldDescribedBy } from "./Field";

export interface FileInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  label?: string;
  hint?: string;
  error?: string;
  size?: "sm" | "md";
  wrapperClassName?: string;
}

/**
 * FileInput (#1169 knowledge UI) — the file-selection member of the
 * token input family, following the TextInput/Select pattern exactly
 * (FieldShell label/hint/error wiring, ui-input token class). The
 * type is forced to "file": HTML offers no other file-selection
 * mechanism, and a raw <input type="file"> outside components/ui
 * trips the #1580 primitive-usage freeze, so the picker lives here
 * with the other primitives. Styles: ./primitives.css.
 */
export function FileInput({
  label,
  hint,
  error,
  size = "md",
  wrapperClassName = "",
  id,
  className = "",
  ...rest
}: FileInputProps) {
  const autoId = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fieldId = id ?? `ui-file-${autoId}`;
  const control = (
    <input
      id={fieldId}
      type="file"
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
