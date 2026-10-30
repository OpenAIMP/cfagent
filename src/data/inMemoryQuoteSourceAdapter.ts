/**
 * Issue #2362 (#1976 step 4f) — in-memory QuoteSourcePort
 * adapter: the conformance suite's second implementation of
 * the contract (and a test double for consumers). Mirrors the
 * D1 adapter's semantics exactly: reads fail open to "auto"
 * before any write, writes normalize.
 */
import {
  normalizeQuoteSource,
  type QuoteSource,
  type QuoteSourcePort,
} from "./quoteSourcePorts";

export class InMemoryQuoteSourceAdapter implements QuoteSourcePort {
  private stored: QuoteSource | null = null;

  async ensureSchema(): Promise<void> {
    // Nothing to create: presence is the field above.
  }

  async get(): Promise<QuoteSource> {
    return this.stored ?? "auto";
  }

  async set(source: QuoteSource): Promise<QuoteSource> {
    this.stored = normalizeQuoteSource(source);
    return this.stored;
  }
}
