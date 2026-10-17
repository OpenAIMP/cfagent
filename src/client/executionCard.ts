/**
 * Presentation derivation for the Chat E*TRADE execution card
 * (issue #123, audit finding F16). Extracted as a pure helper — the
 * src/client/options/cronTime.ts pattern — so the honesty contract is
 * unit-testable without rendering the Chat tree.
 *
 * The contract: the card may claim FILLED/EXECUTED only on an EXPLICIT
 * success signal in the result — `success === true` or a filled/executed
 * status. An absent or ambiguous status renders a neutral "STATUS
 * UNAVAILABLE" state; an explicit failure renders the result's own
 * status (FAILED / REJECTED / …) rather than a relabelled "CANCELLED".
 * The fallback detail text never fabricates a broker reference: with
 * no brokerOrderRef there is simply no "Ref:" segment (the word
 * "simulated" is never a reference).
 */

export interface ExecutionCardPresentation {
  /** Header verdict word, e.g. "FILLED", "FAILED", "STATUS UNAVAILABLE". */
  verdict: string;
  /** Status pill text — the result's own status when one was reported. */
  pillLabel: string;
  /** Status pill style key: only a real fill earns "success". */
  pillClass: "success" | "priority-urgent" | "info";
  /** Detail line under the header. */
  detail: string;
}

const FILLED_STATUSES = new Set(["EXECUTED", "FILLED"]);
const FAILED_STATUSES = new Set(["FAILED", "REJECTED", "CANCELLED", "CANCELED", "EXPIRED", "ERROR"]);

export function executionCardPresentation(data: any): ExecutionCardPresentation {
  const rawStatus =
    typeof data?.status === "string" && data.status.trim() ? data.status.trim() : undefined;
  const statusUpper = rawStatus?.toUpperCase();
  const orderId = data?.orderId || data?.draftId;

  const filledByStatus = statusUpper !== undefined && FILLED_STATUSES.has(statusUpper);
  const failedByStatus = statusUpper !== undefined && FAILED_STATUSES.has(statusUpper);
  const filled = filledByStatus || (data?.success === true && !failedByStatus);
  const failed = failedByStatus || data?.success === false;

  const verdict = filled ? "FILLED" : failed ? statusUpper ?? "FAILED" : "STATUS UNAVAILABLE";
  const pillLabel =
    statusUpper ?? (filled ? "EXECUTED" : failed ? "FAILED" : "STATUS UNAVAILABLE");
  const pillClass: ExecutionCardPresentation["pillClass"] = filled
    ? "success"
    : failed
      ? "priority-urgent"
      : "info";

  let detail: string;
  if (typeof data?.message === "string" && data.message.trim()) {
    detail = data.message;
  } else if (filled) {
    detail = data?.brokerOrderRef
      ? `Order ${orderId} executed on E*TRADE broker. Ref: ${data.brokerOrderRef}`
      : `Order ${orderId} executed on E*TRADE broker.`;
  } else if (failed) {
    detail = orderId ? `Order ${orderId} was not executed.` : "The order was not executed.";
  } else {
    detail = orderId
      ? `Execution status unavailable for order ${orderId}.`
      : "Execution status unavailable.";
  }

  return { verdict, pillLabel, pillClass, detail };
}
