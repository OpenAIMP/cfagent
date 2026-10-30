/**
 * Issue #2108 (slice C) — the deployment-wide quote source
 * setting. DELEGATE since issue #2362 (#1976 step 4f): the
 * implementation is superseded by the QuoteSourcePort family
 * in the data layer (src/data/quoteSourcePorts.ts +
 * src/data/d1QuoteSourceAdapter.ts, composition in
 * src/data/createQuoteSourcePorts.ts; the table's DDL
 * authority is migration 0022). This module keeps the
 * function-shaped surface its callers import (server routes,
 * marketStream) and forwards to the port; the declared
 * fail-open contract lives on the port.
 *
 * The WS + HTTP quotes surfaces share one Worker-level
 * liveMarketCache, so the source pick is deployment-wide,
 * not per-user (per-user streams are a named structural
 * follow-up). Absent store, missing row, or invalid value
 * all fail open to "auto" — the legacy env-driven behavior —
 * never to an error.
 */
import { D1QuoteSourceAdapter } from "../data/d1QuoteSourceAdapter";
import {
  normalizeQuoteSource,
  type QuoteSource,
  type QuoteSourceD1Db,
} from "../data/quoteSourcePorts";

export { normalizeQuoteSource };
export type { QuoteSource };

/** The structural D1 shape this setting needs (port-owned now). */
export type QuoteSourceStore = QuoteSourceD1Db;

export async function ensureQuoteSourceTable(db: QuoteSourceStore): Promise<void> {
  await new D1QuoteSourceAdapter(db).ensureSchema();
}

export async function getQuoteSource(db?: QuoteSourceStore | null): Promise<QuoteSource> {
  if (!db) return "auto";
  return new D1QuoteSourceAdapter(db).get();
}

export async function setQuoteSource(
  db: QuoteSourceStore,
  source: QuoteSource,
): Promise<QuoteSource> {
  return new D1QuoteSourceAdapter(db).set(source);
}
