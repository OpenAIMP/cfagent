/**
 * Issue #1998 (Phase 3): the persisted gather for the goal stock leg.
 *
 * The goal stock leg screens the listing feed, whose quotes carry no
 * technical fields — so thesis filters (RSI, momentum) refuse with a
 * validationError. The gather enriches the acquired universe before
 * evaluation:
 *
 *   batch live quotes (E*TRADE-primary + Yahoo gap-fill) for
 *   week52High/averageVolume → technicals batch (Yahoo history) for
 *   real RSI/MACD → persist one mas_data_captures row per symbol
 *   (capability "quotes", runId = the caller run id per D2) → read
 *   the rows BACK and evaluate those, never the in-memory join.
 *
 * No new store, no new capability value, no gather.ts schema. A
 * symbol with no valid stored row is missing, never zero-filled:
 * per-field missingness is recorded, and the screen ledger-rejects
 * it with the honest reason. Provider attribution is exact — the
 * composer labels primary quotes "E*TRADE live" and gap-fill quotes
 * "Yahoo Finance"; any other source label is unattributed and its
 * symbol goes missing rather than riding an invented provider.
 */

import type { ETradeQuote } from "../types";
import type { SqlStorage } from "../orm";
import {
  canonicalJson,
  fetchPlatformTechnicalsBatch,
  listCapabilityRoutes,
  listCapturesByRun,
  readCaptureRaw,
  recordCapture,
  sha256Hex,
  type CapabilityRouteRecord,
  type CaptureBlobDeps,
  type CaptureBlobStorage,
  type DataProviderId,
  type QuoteScreenerDeps,
  type ScreenLiveEnrichment,
  type ScreenLiveEnrichmentResult,
  type YahooHistoryDeps,
} from "../trading";
import type { ObservabilitySink } from "../observability/observabilityPorts";

export const GATHER_REQUEST_MARKER = "goal-gather-1998";

const ETRADE_LIVE_SOURCE = "E*TRADE live";
const YAHOO_SOURCE = "Yahoo Finance";

function providerIdForSource(source: string | undefined): DataProviderId | null {
  if (source === ETRADE_LIVE_SOURCE) return "etrade";
  if (source === YAHOO_SOURCE) return "yahoo";
  return null;
}

function missingFieldsFor(enriched: Partial<ETradeQuote>): string[] {
  const missing: string[] = [];
  if (enriched.week52High == null && enriched.high52 == null) missing.push("week52High");
  if (enriched.averageVolume == null) missing.push("averageVolume");
  if (enriched.rsi == null) missing.push("rsi");
  return missing;
}

export interface GoalGatherInput {
  sql: SqlStorage;
  blobStorage: CaptureBlobStorage;
  blobEnv: { REPORTS_BUCKET?: R2Bucket };
  tenantId: string;
  userLogin?: string;
  /** Caller run id (D2: the idempotency key) — the rows' runId. */
  runId: string;
  /** Composed platform quote seam (primary + gap-fill). */
  quoteDeps: QuoteScreenerDeps;
  /** History deps; absent = technicals degrade to null per symbol. */
  historyDeps?: YahooHistoryDeps;
  /**
   * Capability routes override (test seam). Absent = read from sql
   * at enrich time, so the snapshot is the run-time route table.
   */
  routes?: CapabilityRouteRecord[];
  /** #1743 sink; absent = no emission, never a failure. */
  sink?: ObservabilitySink;
}

function routeSnapshotHash(routes: CapabilityRouteRecord[]): Promise<string> {
  const snapshot = routes
    .filter((r) => r.capability === "quotes" || r.capability === "historicalBars")
    .map((r) => ({
      capability: r.capability,
      primaryProviderId: r.primaryProviderId,
      gapFillProviderId: r.gapFillProviderId,
      minTier: r.minTier,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => a.capability.localeCompare(b.capability));
  return sha256Hex(canonicalJson(snapshot));
}

export function createGoalGatherEnrichment(input: GoalGatherInput): ScreenLiveEnrichment {
  const blobDeps: CaptureBlobDeps = { storage: input.blobStorage, env: input.blobEnv };
  return {
    async enrich(quotes: ETradeQuote[]): Promise<ScreenLiveEnrichmentResult> {
      const listingsBySymbol = new Map<string, ETradeQuote>();
      for (const q of quotes) listingsBySymbol.set(q.symbol.toUpperCase(), q);
      const symbols = [...listingsBySymbol.keys()];

      // 1. Batch live quotes (primary + gap-fill, composer-diffed).
      const served = new Map<string, ETradeQuote>();
      try {
        if (input.quoteDeps.fetchQuotes) {
          for (const row of await input.quoteDeps.fetchQuotes(symbols)) {
            if (row && row.lastPrice > 0) served.set(row.symbol.toUpperCase(), row);
          }
        } else {
          for (const symbol of symbols) {
            try {
              const row = await input.quoteDeps.fetchQuote(symbol);
              if (row && row.lastPrice > 0) served.set(symbol, row);
            } catch {
              // Per-symbol failure → honest null, never fabricated.
            }
          }
        }
      } catch {
        // Whole-batch failure: every symbol stays missing below.
      }

      // 2. Technicals batch (per-symbol null on failure, by contract).
      const technicals = input.historyDeps
        ? await fetchPlatformTechnicalsBatch(input.historyDeps, symbols)
        : new Map();

      // 3. Route snapshot at run time = the version.
      const routes = input.routes ?? listCapabilityRoutes(input.sql);
      const routeVersionHash = await routeSnapshotHash(routes);
      const quotesRoute = routes.find((r) => r.capability === "quotes");
      const gapFillId = quotesRoute?.gapFillProviderId ?? null;

      // 4. Persist one row per served, attributable symbol.
      const missingFields: Record<string, string[]> = {};
      for (const symbol of symbols) {
        const servedQuote = served.get(symbol);
        const providerId = providerIdForSource(servedQuote?.source);
        if (!servedQuote || !providerId) {
          missingFields[symbol] = servedQuote ? ["provider"] : ["quote"];
          continue;
        }
        const base = listingsBySymbol.get(symbol)!;
        const t = technicals.get(symbol);
        const enriched: ETradeQuote = {
          ...base,
          lastPrice: servedQuote.lastPrice,
          price: servedQuote.lastPrice,
          change: servedQuote.change,
          changePercent: servedQuote.changePercent,
          bid: servedQuote.bid,
          ask: servedQuote.ask,
          volume: servedQuote.volume,
          open: servedQuote.open,
          high: servedQuote.high,
          low: servedQuote.low,
          previousClose: servedQuote.previousClose ?? base.previousClose,
          week52High: servedQuote.week52High,
          week52Low: servedQuote.week52Low,
          high52: servedQuote.high52 ?? servedQuote.week52High,
          low52: servedQuote.low52 ?? servedQuote.week52Low,
          averageVolume: servedQuote.averageVolume,
          source: servedQuote.source,
          quoteStatus: servedQuote.quoteStatus ?? base.quoteStatus,
          timestamp: servedQuote.timestamp ?? base.timestamp,
          ...(t?.rsi14 != null ? { rsi: t.rsi14 } : {}),
          ...(t?.macdSignal != null ? { macdSignal: t.macdSignal } : {}),
        };
        const missing = missingFieldsFor(enriched);
        // A row is stored even when some fields are missing: the row
        // IS the audit trail for partial coverage, and the screen
        // rejects on the missing fields honestly (see step 5 note).
        // Only unattributed/unserved symbols go missing.
        missingFields[symbol] = missing;
        await recordCapture(input.sql, blobDeps, {
          providerId,
          capability: "quotes",
          requestParams: {
            gather: GATHER_REQUEST_MARKER,
            runId: input.runId,
            symbol,
            routeVersionHash,
            gapFilled: gapFillId !== null && providerId === gapFillId,
            routeSnapshot: routes
              .filter((r) => r.capability === "quotes" || r.capability === "historicalBars")
              .map((r) => ({
                capability: r.capability,
                primaryProviderId: r.primaryProviderId,
                gapFillProviderId: r.gapFillProviderId,
                minTier: r.minTier,
                updatedAt: r.updatedAt,
              })),
          },
          runId: input.runId,
          tenantId: input.tenantId,
          ...(input.userLogin ? { userLogin: input.userLogin } : {}),
          rawPayload: enriched,
          normalizedResult: enriched,
        });
      }

      // 5. Read back: the gate evaluates STORED rows, never the join.
      // Duplicate rows for a symbol (retries) dedup to the latest
      // write; a corrupt latest row fails closed to missing, never
      // silently back to a stale row.
      const rows = listCapturesByRun(input.sql, input.tenantId, input.runId)
        .filter(
          (r) =>
            r.capability === "quotes" &&
            (r.requestParams as Record<string, unknown> | undefined)?.gather === GATHER_REQUEST_MARKER
        )
        .sort((a, b) => (b.fetchedAt ?? "").localeCompare(a.fetchedAt ?? ""));
      const seen = new Set<string>();
      const enrichedBySymbol = new Map<string, ETradeQuote>();
      let gapFilledCount = 0;
      for (const row of rows) {
        const params = row.requestParams as Record<string, unknown>;
        const symbol = String(params.symbol ?? "");
        if (!symbol || seen.has(symbol)) continue;
        seen.add(symbol);
        try {
          const read = await readCaptureRaw(input.sql, blobDeps, input.tenantId, row.id);
          if (!read || !read.rawBytes) continue;
          const parsed = JSON.parse(new TextDecoder().decode(read.rawBytes)) as ETradeQuote;
          if (row.normalizedDigest) {
            const digest = await sha256Hex(canonicalJson(parsed));
            if (digest !== row.normalizedDigest) continue;
          }
          enrichedBySymbol.set(symbol, parsed);
          if (params.gapFilled === true) gapFilledCount += 1;
        } catch {
          continue;
        }
      }
      const enrichedQuotes = quotes
        .map((q) => q.symbol.toUpperCase())
        .filter((s) => enrichedBySymbol.has(s))
        .map((s) => enrichedBySymbol.get(s)!);
      const missingSymbols = symbols.filter((s) => !enrichedBySymbol.has(s));
      for (const s of missingSymbols) {
        if (!missingFields[s]) missingFields[s] = ["quote"];
      }

      // 6. #1743 stage event, best-effort (never fails the run).
      if (input.sink) {
        try {
          await input.sink.write({
            type: "goal.gather.stored",
            level: "info",
            operation: "goal.gather.stored",
            tenantId: input.tenantId,
            runId: input.runId,
            sessionRef: null,
            traceId: crypto.randomUUID(),
            timestampMs: Date.now(),
            count: enrichedQuotes.length,
            fields: {
              stored: enrichedQuotes.length,
              missing: missingSymbols.length,
              gapFilled: gapFilledCount,
              routeVersionHash,
            },
          });
        } catch {
          // Best-effort only.
        }
      }

      return {
        runId: input.runId,
        enrichedQuotes,
        missingSymbols,
        missingFields,
        gapFilledCount,
        routeVersionHash,
      };
    },
  };
}
