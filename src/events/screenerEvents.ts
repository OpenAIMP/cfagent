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
  /** Issue #822: explicit PDF status. If 'failed', the publisher must NOT
   *  fall back to a stale PDF — log the error and skip the attachment. */
  pdfStatus?: "generated" | "failed" | "skipped";
  pdfError?: string;
  /** Issue #1191 (#1173 R3): per-run XLSX artifact, mirroring the PDF
   *  triple — outcomes carry it so deliveries attach text+PDF+XLSX. */
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
  xlsxError?: string;
  /** Stable delivery id used to suppress duplicate scheduled notifications. */
  deliveryId?: string;
  sector: string;
  totalScanned: number;
  matchedCount: number;
  opportunities: ScreenerOpportunity[];
  /**
   * Issue #462: qualification for a screen run on an incomplete quote set.
   * The delivered result is a qualified partial report — never presented as
   * a complete screen and never as a failure. Failed symbols carry no
   * fallback data.
   */
  partial?: {
    quotedCount: number;
    requestedCount: number;
    failedSymbols: string[];
    failureReasons: Record<string, number>;
  };
  /**
   * Issue #728: per-symbol rejection reasons. The Slack publisher groups
   * these into a breakdown (e.g. "42 downtrend, 31 negative-EV") so a
   * 0-match screen explains itself instead of just reporting the count.
   */
  rejections?: { symbol: string; reason: string }[];
  /** Summary of criteria applied during screening. */
  filterSummary?: string;
  /** Direct recipient email (enables email dispatch via cfpay A2A or local fallback). */
  emailTo?: string;
  /** Explicit Slack channel destination. */
  slackChannel?: string;
  /** Outbound webhook endpoint. */
  webhookUrl?: string;
}

export interface ScreenerFailedEvent {
  type: "screener.failed";
  timestamp: string;
  universe?: string;
  trigger?: "manual" | "scheduled";
  deliveryId?: string;
  sector: string;
  error: string;
  emailTo?: string;
  slackChannel?: string;
  webhookUrl?: string;
}

/** One options opportunity as carried on the bus: a summary, not the full row. */
export interface OptionsOpportunitySummary {
  symbol: string;
  strategy?: string;
  directionTags?: string[];
}

/**
 * Issue #223: the options counterpart of screener.completed. Delivery for
 * options runs stays on the service's direct A2A path (PDF-centric); this
 * event puts the run's lifecycle on the bus so subscribers — digests
 * (#218), audit consumers, future publishers — see options runs exactly
 * like stock screens.
 */
export interface OptionsCompletedEvent {
  type: "options.completed";
  timestamp: string;
  trigger?: "manual" | "scheduled";
  universe?: string;
  thesis: string;
  totalScanned: number;
  withTrades: number;
  symbols: string[];
  summary: string;
  reportUrl?: string;
  opportunities: OptionsOpportunitySummary[];
}

export interface OptionsFailedEvent {
  type: "options.failed";
  timestamp: string;
  trigger?: "manual" | "scheduled";
  universe?: string;
  thesis: string;
  error: string;
}

export type ScreenerEvent =
  | ScreenerCompletedEvent
  | ScreenerFailedEvent
  | OptionsCompletedEvent
  | OptionsFailedEvent;
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
