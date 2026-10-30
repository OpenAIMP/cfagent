/**
 * Issue #2402: one-time boot toast for the sign-in success outcome.
 *
 * Fires exactly once per mount through the shared Toast primitive
 * (the one global place for transient success/failure feedback). The
 * ref guard keeps StrictMode's double effect in dev from double
 * toasting; the component renders nothing itself. The caller strips
 * the outcome parameter at boot, so a refresh never re-fires it.
 */
import React, { useEffect, useRef } from "react";
import { useToast } from "./components/ui/Toast";

export function BootToast({ message }: { message: string | null }) {
  const toast = useToast();
  const firedRef = useRef(false);
  useEffect(() => {
    if (message === null || firedRef.current) return;
    firedRef.current = true;
    toast.success(message);
  }, [message, toast]);
  return null;
}
