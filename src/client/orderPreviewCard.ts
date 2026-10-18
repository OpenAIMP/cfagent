/**
 * Presentation derivation for the Chat E*TRADE order-preview (draft)
 * card's status pill (issue #151, related minor found during #141).
 * Extracted as a pure helper — the src/client/executionCard.ts pattern
 * — so the honesty contract is unit-testable without rendering the
 * Chat tree.
 *
 * The contract: the pill is derived from the draft's ACTUAL status,
 * never from a default. The old binary
 * `status === "executed" ? "EXECUTED" : "Awaiting Approval"` rendered
 * a REJECTED draft as "Awaiting Approval" — a stale pending label on a
 * terminal decision (the card's own action buttons already hid
 * themselves for rejected drafts; only the label lied). Now:
 *
 *   executed / filled            → EXECUTED
 *   approved / authorized        → APPROVED (the #141 decision
 *                                  vocabulary — an authorization, not an
 *                                  execution claim)
 *   rejected                     → REJECTED
 *   genuinely pending (previewed / draft / awaiting_confirmation /
 *   pending / no status reported) → "Awaiting Approval"
 *   any other reported status    → the status itself, verbatim
 *                                  (upper-cased) — the draft's own
 *                                  state, never a guessed pending label
 */

export interface OrderPreviewCardPresentation {
  /** Status pill text — the draft's state, never a default guess. */
  pillLabel: string;
  /** Status pill style key: only executed/approved earn "success". */
  pillClass: "success" | "priority-urgent" | "warning" | "info";
}

const PENDING_STATUSES = new Set(["previewed", "draft", "pending", "awaiting_confirmation"]);

export function orderPreviewCardPresentation(status: unknown): OrderPreviewCardPresentation {
  const normalized =
    typeof status === "string" && status.trim() ? status.trim().toLowerCase() : undefined;

  if (normalized === undefined || PENDING_STATUSES.has(normalized)) {
    return { pillLabel: "Awaiting Approval", pillClass: "warning" };
  }
  if (normalized === "executed" || normalized === "filled") {
    return { pillLabel: "EXECUTED", pillClass: "success" };
  }
  if (normalized === "approved" || normalized === "authorized") {
    return { pillLabel: "APPROVED", pillClass: "success" };
  }
  if (normalized === "rejected") {
    return { pillLabel: "REJECTED", pillClass: "priority-urgent" };
  }
  // A status this card doesn't know: show the draft's own state rather
  // than claiming it is still awaiting approval.
  return { pillLabel: normalized.toUpperCase(), pillClass: "info" };
}
