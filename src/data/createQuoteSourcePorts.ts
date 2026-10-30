/**
 * Issue #2362 (#1976 step 4f) — composition root for the
 * quote-source setting port: the ONLY module that maps a D1
 * binding to the port implementation for this family.
 * Domain code imports this helper and the port types, never
 * a store client.
 */
import { D1QuoteSourceAdapter } from "./d1QuoteSourceAdapter";
import type { QuoteSourceD1Db, QuoteSourcePort } from "./quoteSourcePorts";

export function createQuoteSourcePort(db: QuoteSourceD1Db): QuoteSourcePort {
  return new D1QuoteSourceAdapter(db);
}

export type { QuoteSource, QuoteSourceD1Db, QuoteSourcePort } from "./quoteSourcePorts";
