/**
 * Issue #1739 — the in-memory messaging adapter. The standing
 * portability proof: the exact same port, the exact same
 * conformance suite, with no provider behind it at all. Used by
 * tests, local development, and any future host that wants the
 * pipeline without a provider queue.
 *
 * Two primitives, same as every adapter:
 *  - Point-to-point: `send` enqueues on an internal work queue;
 *    `consume` runs the shared consumption core (dedup on
 *    id, exactly-once effect per consumer instance).
 *  - Broadcast: `publish` fans out immediately to every
 *    registered subscriber's handler for the event type, via
 *    the shared broadcast core (dedup per subscriber). The
 *    provider adapters instead enqueue to one queue per
 *    subscriber and dispatch later; the guarantee is the same
 *    (each subscriber's handler runs at most once per id),
 *    only the timing differs, and that difference is documented
 *    on the port.
 *
 * This adapter is NOT a silent production fallback: production
 * hosts use the provider adapter when bound and the legacy bus
 * when unbound (see the composition root). An in-memory queue
 * in a worker isolate cannot survive a restart, so silently
 * substituting it for a durable queue would be a lie about
 * delivery guarantees.
 */
import {
  assertMessageEnvelope,
  deliverEnvelopes,
  dispatchEnvelope,
  type ConsumeOutcome,
  type ConsumeReport,
  type MessageConsumer,
  type MessageEnvelope,
  type MessageHandler,
  type MessageProducer,
  type MessagePublisher,
  type MessageSubscriber,
  type PublishReport,
  type SubscriberHandlers,
} from "./messagingPorts";

export class InMemoryMessagingAdapter
  implements
    MessageProducer,
    MessageConsumer,
    MessagePublisher,
    MessageSubscriber
{
  private queued: MessageEnvelope[] = [];
  private seen: Set<string>;
  private handlers: SubscriberHandlers = new Map();
  private subSeen: Set<string>;

  constructor(opts?: { seenIds?: Set<string> }) {
    this.seen = opts?.seenIds ?? new Set<string>();
    this.subSeen = new Set<string>();
  }

  async send(envelope: MessageEnvelope): Promise<void> {
    this.queued.push(assertMessageEnvelope(envelope));
  }

  async sendBatch(envelopes: readonly MessageEnvelope[]): Promise<void> {
    // Validate the whole batch first: a bad item rejects the batch
    // without partially enqueueing it.
    const valid = envelopes.map((e) => assertMessageEnvelope(e));
    this.queued.push(...valid);
  }

  async consume(
    envelopes: readonly unknown[],
    handler: MessageHandler
  ): Promise<ConsumeReport> {
    return deliverEnvelopes(envelopes, this.seen, handler);
  }

  async publish(envelope: MessageEnvelope): Promise<PublishReport> {
    const valid = assertMessageEnvelope(envelope);
    const deliveredTo: string[] = [];
    const failedTo: string[] = [];
    for (const subscriber of this.handlers.keys()) {
      const outcome = await dispatchEnvelope(
        this.handlers,
        this.subSeen,
        subscriber,
        valid
      );
      if (outcome === "processed") deliveredTo.push(subscriber);
      else if (outcome === "retry") failedTo.push(subscriber);
      // "drop" (no handler for this type, or terminal refusal)
      // lands in neither list: the subscriber did not take it.
    }
    return { deliveredTo, failedTo };
  }

  subscribe(
    subscriber: string,
    type: string,
    handler: MessageHandler
  ): () => void {
    let byType = this.handlers.get(subscriber);
    if (!byType) {
      byType = new Map();
      this.handlers.set(subscriber, byType);
    }
    // One handler per (subscriber, type): a second
    // registration replaces the first.
    byType.set(type, handler);
    return () => {
      const current = this.handlers.get(subscriber)?.get(type);
      if (current === handler) {
        this.handlers.get(subscriber)?.delete(type);
      }
    };
  }

  async dispatch(
    subscriber: string,
    envelope: MessageEnvelope
  ): Promise<ConsumeOutcome> {
    return dispatchEnvelope(this.handlers, this.subSeen, subscriber, envelope);
  }

  /** Drain everything currently queued through the consumer core. */
  async drain(handler: MessageHandler): Promise<ConsumeReport> {
    const batch = this.queued;
    this.queued = [];
    return this.consume(batch, handler);
  }

  get pendingCount(): number {
    return this.queued.length;
  }
}
