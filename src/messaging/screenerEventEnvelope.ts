/**
 * Issue #1739 — translators between screener domain events and
 * CloudEvents v1.0 messaging envelopes. The envelope carries the
 * CloudEvents required attributes (specversion, id, source,
 * type, time, data); the screener event rides inside data
 * together with the dispatch owner, mirroring the established
 * data-owner pattern for unattended queue work (a message
 * carries its owner's login; with neither a data owner nor a
 * configured service identity, the consumer refuses to dispatch
 * rather than attributing work to a fabricated identity).
 *
 * Idempotency anchor: the id is deterministic per run —
 * the event's stable delivery id when present, else its
 * timestamp — so a redelivered envelope carries the same
 * idempotency key as the original, and the consumer dedups it.
 * The subject is the entity the event is about: the delivery
 * id when the event carries one (the run's stable identity),
 * omitted otherwise. The stage extension marks these as
 * deliver-stage events.
 */
import type {
  ScreenerEvent,
  ScreenerEventType,
} from "../events/screenerEvents";
import type { MessageEnvelope } from "./messagingPorts";

const SCREENER_EVENT_TYPES: readonly ScreenerEventType[] = [
  "screener.completed",
  "screener.failed",
  "options.completed",
  "options.failed",
];

/** Data shape for screener envelopes: the event + its owner. */
export interface ScreenerEnvelopePayload {
  event: ScreenerEvent;
  ownerLogin?: string;
}

export function toScreenerEnvelope(
  event: ScreenerEvent,
  ownerLogin?: string,
  // Trigger source for audit (trigger-agnostic execution: UX and
  // scheduled triggers produce the same envelope and path; the
  // consumer never branches on this value).
  source = "scheduled-tasks"
): MessageEnvelope {
  // deliveryId exists only on the screener.* variants (optional
  // there); options.* events anchor on their timestamp.
  const deliveryId =
    "deliveryId" in event ? event.deliveryId : undefined;
  const anchor = deliveryId ?? event.timestamp;
  const data: ScreenerEnvelopePayload = ownerLogin
    ? { event, ownerLogin }
    : { event };
  const envelope: MessageEnvelope = {
    specversion: "1.0",
    id: `screener-event:${event.type}:${anchor}`,
    source,
    type: event.type,
    time: event.timestamp,
    correlationid: anchor,
    // Screener completion/failure events are deliver-stage events.
    stage: "deliver",
    data,
  };
  if (deliveryId) envelope.subject = deliveryId;
  return envelope;
}

/**
 * Unwrap a screener envelope, or null when the data is not a
 * screener event. Null means "drop": the message can never
 * become a delivery, so the consumer must not retry it.
 */
export function fromScreenerEnvelope(
  envelope: MessageEnvelope
): { event: ScreenerEvent; ownerLogin?: string } | null {
  const data = envelope.data as Partial<ScreenerEnvelopePayload> | null;
  if (!data || typeof data !== "object") return null;
  const event = data.event as Partial<ScreenerEvent> | undefined;
  if (!event || typeof event !== "object") return null;
  if (
    typeof event.type !== "string" ||
    !(SCREENER_EVENT_TYPES as readonly string[]).includes(event.type) ||
    typeof event.timestamp !== "string"
  ) {
    return null;
  }
  const ownerLogin = data.ownerLogin;
  if (ownerLogin !== undefined && typeof ownerLogin !== "string") {
    return null;
  }
  return { event: event as ScreenerEvent, ownerLogin };
}
