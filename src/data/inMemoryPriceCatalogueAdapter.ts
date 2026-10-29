/**
 * Issue #2185 (sub-issue of #2012) — in-memory price catalogue.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth —
 * it exists so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate).
 *
 * Seeding: when `initial` is omitted, the adapter starts with the
 * proposed seed prices (the same values the D1 ensure writes).
 * When `initial` is given — even empty — it is used exactly, so
 * a fail-closed test can build a catalogue with no prices at all
 * (`new InMemoryPriceCatalogueAdapter({})`).
 */
import {
  assertPriceFamily,
  assertPriceUSD,
  PROPOSED_SEED_PRICES,
  type PriceCatalogue,
  type PriceEntry,
  type PriceFamily,
} from "./priceCataloguePorts";

export class InMemoryPriceCatalogueAdapter implements PriceCatalogue {
  private prices = new Map<PriceFamily, PriceEntry>();

  constructor(initial?: Partial<Record<PriceFamily, number>>) {
    const seed: Partial<Record<PriceFamily, number>> = initial ?? { ...PROPOSED_SEED_PRICES };
    for (const [family, priceUSD] of Object.entries(seed)) {
      if (priceUSD === undefined) continue;
      this.prices.set(assertPriceFamily(family), {
        family: assertPriceFamily(family),
        priceUSD: assertPriceUSD(priceUSD),
        updatedAtMs: Date.now(),
      });
    }
  }

  async getPrice(family: string): Promise<number | null> {
    const entry = this.prices.get(family as PriceFamily);
    if (!entry) return null;
    if (!Number.isFinite(entry.priceUSD) || entry.priceUSD <= 0) return null;
    return entry.priceUSD;
  }

  async getAllPrices(): Promise<PriceEntry[]> {
    return [...this.prices.values()].sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
  }

  async setPrice(input: { family: unknown; priceUSD: unknown }): Promise<PriceEntry> {
    const record: PriceEntry = {
      family: assertPriceFamily(input.family),
      priceUSD: assertPriceUSD(input.priceUSD),
      updatedAtMs: Date.now(),
    };
    this.prices.set(record.family, record);
    return record;
  }
}
