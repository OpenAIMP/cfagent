/**
 * Issue #1743 — in-memory adapter for the observability port.
 * The second adapter behind the port (tests + local
 * development): it records redacted events in memory. It is
 * NEVER a silent production fallback — the composition root
 * returns the console sink (not this adapter) when the
 * Analytics Engine binding is absent, so unbound production
 * degrades to local logging, not to a lie about durability.
 */
import {
  redactForStream,
  type ObservabilityEvent,
  type ObservabilitySink,
} from "./observabilityPorts";

export class InMemoryObservabilityAdapter implements ObservabilitySink {
  private readonly stored: ObservabilityEvent[] = [];

  /** A copy — callers cannot mutate recorded state. */
  get events(): ObservabilityEvent[] {
    return [...this.stored];
  }

  write(event: ObservabilityEvent): void {
    this.stored.push({
      ...event,
      fields: redactForStream(event.fields) as Record<string, unknown>,
    });
  }

  writeBatch(events: readonly ObservabilityEvent[]): void {
    for (const event of events) this.write(event);
  }

  clear(): void {
    this.stored.length = 0;
  }
}
