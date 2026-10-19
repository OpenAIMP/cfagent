/**
 * Issue #210: Event-driven screener — pub/sub event bus.
 *
 * When the Autonomous Market Screen completes (or fails), it publishes a
 * typed event instead of only broadcasting to a WebSocket nobody listens
 * to. Subscribers (Slack, email, webhook publishers in
 * ./screenerPublishers.ts) react to the event and harvest the value.
 *
 * The bus is intentionally simple: synchronous in-process pub/sub within
 * the Durable Object. Subscribers are independent — a failure in one
 * never blocks the others.
 */

export interface ScreenerOpportunity {
  symbol: string;
  companyName: string;
  signal: string;
  momentumScore: number;
  lastPrice: number;
  changePercent: number;
}

export interface ScreenerCompletedEvent {
  type: "screener.completed";
  timestamp: string;
  /** The selected stock universe; distinct from the sector filter. */
  universe?: string;
  trigger?: "manual" | "scheduled";
  /** Target size before any E*TRADE quote failures or filters. */
  expectedCount?: number;
  /** Per-run PDF storage key, avoiding races through the latest-report pointer. */
  pdfKey?: string;
  /** Stable delivery id used to suppress duplicate scheduled notifications. */
  deliveryId?: string;
  sector: string;
  totalScanned: number;
  matchedCount: number;
  opportunities: ScreenerOpportunity[];
}

export interface ScreenerFailedEvent {
  type: "screener.failed";
  timestamp: string;
  universe?: string;
  trigger?: "manual" | "scheduled";
  deliveryId?: string;
  sector: string;
  error: string;
}

export type ScreenerEvent = ScreenerCompletedEvent | ScreenerFailedEvent;
export type ScreenerEventType = ScreenerEvent["type"];

export type ScreenerEventHandler = (event: ScreenerEvent) => Promise<void> | void;

/**
 * Minimal typed pub/sub bus. Handlers run sequentially in registration
 * order; each handler's errors are caught and logged so one failing
 * subscriber never breaks the others.
 */
export class ScreenerEventBus {
  private handlers = new Map<ScreenerEventType, ScreenerEventHandler[]>();

  /**
   * Subscribe to an event type. Returns an unsubscribe function.
   */
  subscribe(type: ScreenerEventType, handler: ScreenerEventHandler): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return () => {
      const current = this.handlers.get(type) ?? [];
      this.handlers.set(
        type,
        current.filter((h) => h !== handler)
      );
    };
  }

  /**
   * Publish an event to all subscribers. Never throws.
   */
  async publish(event: ScreenerEvent): Promise<void> {
    const list = this.handlers.get(event.type) ?? [];
    for (const handler of list) {
      try {
        await handler(event);
      } catch (err) {
        console.warn(
          `[ScreenerEventBus] subscriber failed for ${event.type}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  /** Number of subscribers for a type (useful for tests/health). */
  subscriberCount(type: ScreenerEventType): number {
    return this.handlers.get(type)?.length ?? 0;
  }
}
