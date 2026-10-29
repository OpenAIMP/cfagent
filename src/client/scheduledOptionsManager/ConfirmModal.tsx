import React from "react";
import { Button, Modal } from "../components/ui";

export interface ConfirmModalProps {
  open: boolean;
  /** Question the dialog asks (its accessible name). */
  title: string;
  /** What the confirmed action does, and what it cannot undo. */
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Danger for destructive actions (the default), primary otherwise. */
  tone?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * One destructive-confirmation dialog (issue #2329), built on the
 * Modal primitive so Escape, focus trap/restore, backdrop close and
 * scroll lock behave everywhere the same. Replaces the per-surface
 * footer copies so every confirmation states the same three things:
 * what is named, what will happen, and what cannot be undone.
 */
export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Keep",
  tone = "danger",
  busy = false,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="none"
      panelClassName="sched-confirm-modal"
      footer={
        <div className="ui-modal-actions">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {children}
    </Modal>
  );
}
