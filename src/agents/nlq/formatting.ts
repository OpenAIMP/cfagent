import { STATIC_FALLBACK_QUOTE_STATUS, isLiveQuoteStatus } from "../../trading";
import type { ETradeQuote } from "../../types";
export function formatMarketCap(cap?: number): string {
  if (!cap || cap <= 0 || isNaN(cap)) return "N/A";
  if (cap >= 1e12) {
    return `$${(cap / 1e12).toFixed(2)}T`;
  }
  if (cap >= 1e9) {
    return `$${(cap / 1e9).toFixed(2)}B`;
  }
  if (cap >= 1e6) {
    return `$${(cap / 1e6).toFixed(2)}M`;
  }
  if (cap >= 1000) {
    return `$${(cap / 1000).toFixed(2)}T`;
  }
  return `$${cap.toFixed(1)}B`;
}

/**
 * Issue #118 (audit F13): NLQ quote answers must announce provenance
 * truthfully. "Real-time" is claimed ONLY for a quote actually fetched live
 * (quoteStatus "REALTIME"); a static fallback / simulated / delayed /
 * unavailable quote is labelled as what it is, in the summary and the rows,
 * because chat and voice surfaces read this text verbatim.
 */
export function formatTradingQuoteHeadline(q: ETradeQuote): string {
  const price = `$${q.lastPrice.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)`;
  const hasBidAsk = q.bid > 0 || q.ask > 0;
  if (isLiveQuoteStatus(q.quoteStatus)) {
    return `Real-time quote for ${q.symbol} (${q.companyName}): ${price}. Bid: $${q.bid.toFixed(2)} / Ask: $${q.ask.toFixed(2)}.`;
  }
  const status = q.quoteStatus || "UNKNOWN";
  const label =
    q.quoteStatus === STATIC_FALLBACK_QUOTE_STATUS
      ? "Static fallback quote (not live market data)"
      : q.quoteStatus === "SIMULATED_LEVEL1"
        ? "Simulated quote (sandbox — not live market data)"
        : q.quoteStatus === "DELAYED"
          ? "Delayed quote"
          : q.quoteStatus === "AUTH_REQUIRED"
            ? "Quote unavailable (E*TRADE authentication required)"
            : `Quote (status: ${status})`;
  const bidAskClause =
    q.quoteStatus === STATIC_FALLBACK_QUOTE_STATUS
      ? "No live bid/ask available — static table price only."
      : hasBidAsk
        ? `Bid: $${q.bid.toFixed(2)} / Ask: $${q.ask.toFixed(2)}.`
        : "No live bid/ask available.";
  return `${label} for ${q.symbol} (${q.companyName}): ${price}. ${bidAskClause}`;
}

/** Bid/ask cell for NLQ quote rows: never renders an invented zero spread as real. */
export function formatTradingQuoteBidAsk(q: ETradeQuote): string {
  return q.bid > 0 || q.ask > 0 ? `$${q.bid.toFixed(2)} / $${q.ask.toFixed(2)}` : "N/A (no live bid/ask)";
}

/**
 * Issue #257 (Assessment P1, part of #143): one structured mas_events row per
 * NLQ execution, at the single seam shared by the sync and async executors.
 * Best-effort and never fatal to execution. Redaction discipline: the payload
 * carries only domain/action/count/duration/source — never the raw query text.
 */
