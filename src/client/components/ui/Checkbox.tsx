import React from "react";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {}

/**
 * Checkbox (#1577; E3) — native boolean toggle on tokens.
 * Bare control by design: callers keep their own <label> wrappers (the
 * ScannerPanel profile/history forms already label their checkboxes),
 * so this renders only the <input type="checkbox"> with the token
 * accent + a fixed box size. There is no Switch/Toggle primitive, and
 * a checkbox through TextInput would inherit text-field sizing
 * (width: 100%) and render as a stretched box, not a check square.
 * Styles: ./primitives.css.
 */
export function Checkbox({ className = "", ...rest }: CheckboxProps) {
  return <input type="checkbox" className={`ui-checkbox ${className}`} {...rest} />;
}
