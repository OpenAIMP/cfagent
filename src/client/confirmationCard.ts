/**
 * Presentation derivation for the Chat Human-In-The-Loop CONFIRMATION
 * card (issue #141, follow-up to #123 / audit finding F16). Extracted
 * as a pure helper — the src/client/executionCard.ts pattern — so the
 * honesty contract is unit-testable without rendering the Chat tree.
 *
 * The contract: this card renders the result of a human AUTHORIZATION
 * decision on a draft (the `confirmDraft` tool: decision "approved" |
 * "rejected"). An authorization is not an execution — approving a task
 * draft only queues it ("scheduled"), and approving a payment draft
 * authorizes a gateway dispatch whose own artefacts (gatewayRef /
 * checkoutUrl) arrive inside the result and are surfaced verbatim via
 * the result's auditNotice/note. So the card's own wording states ONLY
 * the authorization outcome, in the codebase's decision vocabulary:
 *
 *   approved  → APPROVED  (never "EXECUTED")
 *   rejected  → REJECTED  (never "CANCELLED" — nothing was cancelled;
 *                          a draft was declined before anything ran)
 *   no recognizable decision in the result → STATUS UNAVAILABLE
 *   (never a guessed APPROVED/REJECTED from absence, which is what the
 *   old `isApproved ? … : …` binary did to error/partial results)
 *
 * Execution outcomes belong to the execution card
 * (executionCardPresentation), which renders actual order results.
 */

export type ConfirmationDecision = "approved" | "rejected" | "unknown";

export interface ConfirmationCardPresentation {
  /** The human's authorization decision as recorded in the result. */
  decision: ConfirmationDecision;
  /** Header parenthetical, e.g. "APPROVED". */
  verdict: string;
  /** Status pill text — the authorization outcome, never an execution claim. */
  pillLabel: string;
  /** Status pill style key: only an approval earns "success". */
  pillClass: "success" | "priority-urgent" | "info";
  /** Header icon. */
  icon: string;
  /** Detail line used when the result carries no auditNotice/note. */
  detailFallback: string;
}

/** Result statuses that record an approved authorization. */
const APPROVED_STATUSES = new Set(["authorized", "scheduled", "completed"]);

function normalize(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

export function confirmationCardPresentation(data: any): ConfirmationCardPresentation {
  const decisionField = normalize(data?.decision);
  const status = normalize(data?.status);

  // The explicit human decision is authoritative when present; the
  // draft's resulting status is the fallback signal. Anything else is
  // unknown — the card must not guess an outcome from absence.
  let decision: ConfirmationDecision = "unknown";
  if (decisionField === "approved" || decisionField === "rejected") {
    decision = decisionField;
  } else if (status === "rejected") {
    decision = "rejected";
  } else if (status !== undefined && APPROVED_STATUSES.has(status)) {
    decision = "approved";
  }

  if (decision === "approved") {
    return {
      decision,
      verdict: "APPROVED",
      pillLabel: "APPROVED",
      pillClass: "success",
      icon: "🛡️",
      detailFallback:
        status === "scheduled"
          ? "Draft approved by human reviewer and queued for scheduled execution."
          : "Draft approved by human reviewer.",
    };
  }

  if (decision === "rejected") {
    return {
      decision,
      verdict: "REJECTED",
      pillLabel: "REJECTED",
      pillClass: "priority-urgent",
      icon: "🚫",
      detailFallback: "Draft rejected by human reviewer.",
    };
  }

  return {
    decision,
    verdict: "STATUS UNAVAILABLE",
    pillLabel: "STATUS UNAVAILABLE",
    pillClass: "info",
    icon: "❔",
    detailFallback: "Authorization status unavailable for this draft.",
  };
}
