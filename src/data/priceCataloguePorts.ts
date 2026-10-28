/**
 * Issue #2185 (sub-issue of #2012) — externalized per-run price
 * catalogue port (slice 0 of the native-payments program).
 *
 * Prices are OPERATOR DATA, never code constants: the monetization
 * gate reads them through this port, and an operator changes a
 * price via the operator-gated upsert route with no code deploy.
 * The port module is the ADR 0002 R1 boundary: it imports no
 * store client, references no env binding, and writes no SQL.
 * Only the adapters (Drizzle D1, in-memory) touch a store, and
 * only the composition root (createPriceCataloguePorts.ts) maps
 * a Worker binding to an adapter.
 *
 * Fail-closed contract: a family with no stored price reads as
 * null, and the gate treats null (or an invalid stored value) as
 * "refuse to charge" — never as a reason to fall back to a
 * hardcoded price. There is no runtime fallback anywhere in this
 * module: the seed values below are WRITE-time data only. They
 * are written into the store once, at schema-ensure time (D1) or
 * at adapter construction (in-memory test double), and from then
 * on the store is the only source of truth. An operator edit
 * survives re-ensure (INSERT OR IGNORE seeding).
 */

/** Screener families with a per-run price. Mirrors the gate's family union. */
export type PriceFamily = "stock" | "goal" | "options" | "strategy";

export const PRICE_FAMILIES: readonly PriceFamily[] = ["stock", "goal", "options", "strategy"];

export function assertPriceFamily(family: unknown): PriceFamily {
  if (family !== "stock" && family !== "goal" && family !== "options" && family !== "strategy") {
    throw new Error(`Invalid price family: ${String(family)} (must be stock, goal, options, or strategy).`);
  }
  return family;
}

/** Money is stored to the cent; anything finer is a caller bug, not a rounding policy. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function assertPriceUSD(priceUSD: unknown): number {
  const value = Number(priceUSD);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("priceUSD must be a finite positive number.");
  }
  return round2(value);
}

/**
 * PROPOSED seed prices, NOT owner-approved and NOT an activation.
 * Seeded into the store at ensure time (migration 0010) so a
 * fresh store has prices to read; the gate never reads this
 * constant. An owner-approved price replaces these rows in
 * operator data, not in code. Values: stock $0.02, goal $0.10,
 * options $0.05, strategy $0.10.
 */
export const PROPOSED_SEED_PRICES: Record<PriceFamily, number> = {
  stock: 0.02,
  goal: 0.1,
  options: 0.05,
  strategy: 0.1,
};

export interface PriceEntry {
  family: PriceFamily;
  priceUSD: number;
  updatedAtMs: number;
}

/**
 * The price catalogue store surface. `getPrice` returns null for
 * a family with no stored row — that null is the fail-closed
 * signal, not an invitation to guess a price.
 */
export interface PriceCatalogue {
  getPrice(family: string): Promise<number | null>;
  getAllPrices(): Promise<PriceEntry[]>;
  setPrice(input: { family: unknown; priceUSD: unknown }): Promise<PriceEntry>;
}
