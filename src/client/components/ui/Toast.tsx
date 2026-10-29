import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Toast (#2283, epic #2150 slice 5) — the ONE familiar place for
 * transient success/failure feedback.
 *
 * Rule: anything the user did that succeeded or failed, and that does
 * not need to stay on screen, goes here — never in a native alert(),
 * never in a one-off panel toast, never only in a console log.
 * Persistent state that must remain visible (warnings, guarantees,
 * empty/error page states) still belongs to the inline Notice.
 *
 * Best-practice shape, kept deliberately small:
 * - One fixed viewport, bottom-right on desktop, full-width bottom
 *   sheet on narrow screens, above modals (z-index clears the modal
 *   backdrop), newest toast on top, at most 4 visible.
 * - Tones: success/info auto-dismiss (5s), warning 8s, danger stays
 *   until dismissed — an error the user must see is never timed out
 *   from under them. Every toast has a dismiss button.
 * - Hover or focus pauses the timer; leaving resumes it with the
 *   remaining time. Escape dismisses the newest toast while focus is
 *   inside the viewport. Toasts never steal focus on arrival.
 * - Announced: danger/warning via role="alert", success/info via
 *   role="status". Identical visible toasts dedupe instead of
 *   stacking (the timer restarts).
 * - Token-only styling in ./primitives.css; animation disabled under
 *   prefers-reduced-motion.
 */

export type ToastTone = "success" | "info" | "warning" | "danger";

export interface ToastInput {
  tone: ToastTone;
  title?: string;
  message: string;
  /** Override the tone default; null = never auto-dismiss. */
  durationMs?: number | null;
}

interface ToastItem {
  id: number;
  tone: ToastTone;
  title?: string;
  message: string;
  /** Resolved auto-dismiss duration, or null for persistent. */
  durationMs: number | null;
}

export interface ToastApi {
  toast: (input: ToastInput) => number;
  success: (message: string, title?: string) => number;
  info: (message: string, title?: string) => number;
  warning: (message: string, title?: string) => number;
  danger: (message: string, title?: string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

const MAX_VISIBLE = 4;
const DEFAULT_DURATION: Record<ToastTone, number | null> = {
  success: 5000,
  info: 5000,
  warning: 8000,
  danger: null,
};
const TONE_ICON: Record<ToastTone, string> = {
  success: "✓",
  info: "ℹ",
  warning: "⚠",
  danger: "!",
};

interface TimerState {
  handle: ReturnType<typeof setTimeout>;
  expiresAt: number;
  remainingMs: number;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Ref mirror of the list: toast() and dismiss() must read the current
  // list without doing side effects inside a setState updater (updaters
  // must stay pure — StrictMode double-invokes them).
  const toastsRef = useRef<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, TimerState>());

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer.handle);
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      toastsRef.current = toastsRef.current.filter((t) => t.id !== id);
      setToasts(toastsRef.current);
    },
    [clearTimer],
  );

  const schedule = useCallback(
    (item: ToastItem) => {
      clearTimer(item.id);
      if (item.durationMs === null) return;
      const expiresAt = Date.now() + item.durationMs;
      const handle = setTimeout(() => dismiss(item.id), item.durationMs);
      timers.current.set(item.id, { handle, expiresAt, remainingMs: item.durationMs });
    },
    [clearTimer, dismiss],
  );

  const toast = useCallback(
    (input: ToastInput): number => {
      const durationMs = input.durationMs !== undefined ? input.durationMs : DEFAULT_DURATION[input.tone];
      const existing = toastsRef.current.find(
        (t) => t.tone === input.tone && t.title === input.title && t.message === input.message,
      );
      if (existing) {
        const refreshed = { ...existing, durationMs };
        toastsRef.current = toastsRef.current.map((t) => (t.id === existing.id ? refreshed : t));
        setToasts(toastsRef.current);
        schedule(refreshed);
        return existing.id;
      }
      const item: ToastItem = {
        id: nextId.current++,
        tone: input.tone,
        title: input.title,
        message: input.message,
        durationMs,
      };
      const next = [item, ...toastsRef.current].slice(0, MAX_VISIBLE);
      // A toast pushed off the cap keeps no timer behind it.
      for (const dropped of toastsRef.current) {
        if (!next.some((t) => t.id === dropped.id)) clearTimer(dropped.id);
      }
      toastsRef.current = next;
      setToasts(next);
      schedule(item);
      return item.id;
    },
    [schedule],
  );

  const pause = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (!timer) return;
    clearTimeout(timer.handle);
    timer.remainingMs = Math.max(0, timer.expiresAt - Date.now());
  }, []);

  const resume = useCallback(
    (id: number) => {
      const timer = timers.current.get(id);
      if (!timer || timer.remainingMs <= 0) return;
      const handle = setTimeout(() => dismiss(id), timer.remainingMs);
      timer.handle = handle;
      timer.expiresAt = Date.now() + timer.remainingMs;
    },
    [dismiss],
  );

  // Timers must not leak across unmount (tests, StrictMode remounts).
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer.handle);
      timers.current.clear();
    },
    [],
  );

  const api = useMemoApi(toast, dismiss);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          className="ui-toast-viewport"
          aria-label="Notifications"
          onKeyDown={(e) => {
            if (e.key === "Escape" && toasts.length > 0) {
              e.stopPropagation();
              dismiss(toasts[0].id);
            }
          }}
        >
          {toasts.map((item) => (
            <div
              key={item.id}
              role={item.tone === "danger" || item.tone === "warning" ? "alert" : "status"}
              className={`ui-toast tone-${item.tone}`}
              onMouseEnter={() => pause(item.id)}
              onMouseLeave={() => resume(item.id)}
              onFocus={() => pause(item.id)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume(item.id);
              }}
            >
              <span className="ui-toast-icon" aria-hidden="true">
                {TONE_ICON[item.tone]}
              </span>
              <div className="ui-toast-body">
                {item.title && <strong className="ui-toast-title">{item.title}</strong>}
                <span>{item.message}</span>
              </div>
              <button
                type="button"
                className="ui-toast-dismiss"
                aria-label="Dismiss notification"
                onClick={() => dismiss(item.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

function useMemoApi(toast: ToastApi["toast"], dismiss: ToastApi["dismiss"]): ToastApi {
  const ref = useRef<ToastApi | null>(null);
  if (!ref.current) {
    const withTone =
      (tone: ToastTone) =>
      (message: string, title?: string) =>
        toast({ tone, message, title });
    ref.current = {
      toast,
      success: withTone("success"),
      info: withTone("info"),
      warning: withTone("warning"),
      danger: withTone("danger"),
      dismiss,
    };
  }
  ref.current.toast = toast;
  ref.current.dismiss = dismiss;
  return ref.current;
}
