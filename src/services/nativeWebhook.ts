/**
 * Issue #2192 ([Native payments] Slice 0) — native webhook
 * recognition for POST /payments/webhook.
 *
 * Slice 0 defines the contract slice 1's native checkout
 * adapter must honor, and the webhook arm consumes:
 *
 * - The native Stripe adapter creates sessions with
 *   client_reference_id = the run request id (or `sub-<uuid>`
 *   for a subscription draft) and metadata
 *   `{ origin: "screener-native", userId, family, tenantId }`.
 *   The metadata is the native marker: cfpay sessions live in
 *   cfpay's Stripe account and never reach this webhook, and
 *   non-screener drafts created through this worker's own
 *   gateway service carry no such marker — so the marker is
 *   what keeps the native branch from misrouting any existing
 *   traffic.
 * - The webhook arm fires ONLY on a verified
 *   `checkout.session.completed` with payment_status `paid`.
 *   A success-page redirect is never proof (same rule as the
 *   cfpay return page); confirm-by-retrieve in slice 1 remains
 *   the source of truth, and the webhook is a wake-up plus an
 *   audit trail, not the confirm.
 * - Until slice 1 lands, the webhook arm RECORDS AND AUDITS
 *   ONLY: it never delivers `payment_verified` to any
 *   workflow, never touches mas_transactions, and never
 *   forwards to a draft owner (native drafts have no
 *   draft-owner registry entry — forwarding would misroute
 *   them to the loud-unmatched path).
 *
 * This module is pure: recognition + session-to-ledger-input
 * mapping only. The route handler owns the adapter, the
 * audit calls, and the response shape, so these helpers are
 * unit-testable without a worker runtime.
 */
import type { NativeLedgerRowInput } from "../data/nativeLedgerPorts";

/**
 * Metadata marker the native checkout adapter (slice 1) sets
 * on every Stripe session it creates for a screener run or
 * subscription draft.
 */
export const NATIVE_WEBHOOK_METADATA_ORIGIN = "screener-native";

/** Subscription drafts use the `sub-` prefix (same rule as #2142). */
export function isNativeSubscriptionDraft(draftId: string): boolean {
  return draftId.startsWith("sub-");
}

type StripeSessionObject = {
  id?: unknown;
  client_reference_id?: unknown;
  payment_status?: unknown;
  payment_intent?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  metadata?: Record<string, unknown> | null;
};

function sessionObject(body: unknown): StripeSessionObject | null {
  if (!body || typeof body !== "object") return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const object = (data as { object?: unknown }).object;
  if (!object || typeof object !== "object") return null;
  return object as StripeSessionObject;
}

/**
 * Whether a verified webhook event is a native screener
 * settlement: Stripe only, session completed + paid, the
 * reference matches the extracted draft id, and the session
 * carries the native metadata marker. Anything else falls
 * through to the existing draft-settlement path unchanged.
 */
export function isNativeScreenerDraft(
  body: unknown,
  draftId: string,
  provider: string,
): boolean {
  if (provider !== "stripe") return false;
  if (!body || typeof body !== "object") return false;
  if ((body as { type?: unknown }).type !== "checkout.session.completed") return false;
  const session = sessionObject(body);
  if (!session) return false;
  if (session.client_reference_id !== draftId) return false;
  if (session.payment_status !== "paid") return false;
  return session.metadata?.origin === NATIVE_WEBHOOK_METADATA_ORIGIN;
}

/**
 * Map a verified native session to a native ledger charge
 * input. Returns an error reason instead of an input when
 * the session lacks a field the ledger requires — the caller
 * audits the unrecorded settlement with that reason rather
 * than writing a row with invented attribution. A missing
 * userId/family/tenantId must never become "unknown": the
 * row would be unattributable, and unattributable money rows
 * are worse than no row (slice 1's confirm-by-retrieve still
 * records the run).
 */
export function nativeWebhookRecordInput(
  body: unknown,
): { input: NativeLedgerRowInput } | { error: string } {
  const session = sessionObject(body);
  if (!session) return { error: "no Stripe session object in webhook body" };
  const runRequestId =
    typeof session.client_reference_id === "string" ? session.client_reference_id : "";
  if (!runRequestId) return { error: "session has no client_reference_id" };
  const amountTotal = Number(session.amount_total);
  if (!Number.isFinite(amountTotal) || amountTotal <= 0) {
    return { error: "session has no positive amount_total" };
  }
  if (typeof session.currency === "string" && session.currency.toLowerCase() !== "usd") {
    return { error: `session currency is ${session.currency}, not USD` };
  }
  const metadata = session.metadata ?? {};
  for (const field of ["userId", "family", "tenantId"] as const) {
    const value = metadata[field];
    if (typeof value !== "string" || !value.trim()) {
      return { error: `session metadata is missing ${field}` };
    }
  }
  return {
    input: {
      kind: "charge",
      runRequestId,
      tenantId: metadata["tenantId"] as string,
      userId: metadata["userId"] as string,
      family: metadata["family"] as string,
      priceUSD: amountTotal / 100,
      rail: "stripe",
      sessionId: typeof session.id === "string" ? session.id : undefined,
      paymentIntentId:
        typeof session.payment_intent === "string" ? session.payment_intent : undefined,
    },
  };
}
