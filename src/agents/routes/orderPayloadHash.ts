/**
 * Issue #1703 (A3-a): version identifier for previewed trade drafts.
 *
 * The execute path already enforces version binding server-side: the
 * dispatcher rejects any request whose action/symbol/quantity differ
 * from the stored draft (422 Strict Immutability Verification) and
 * derives every execution field from the stored draft, and no
 * `trades.update` site in the repo ever mutates a payload field after
 * preview. What was missing was the VISIBLE side: a version identifier
 * the approval card can show and the audit trail can record, so the
 * binding is verifiable after the fact.
 *
 * This module computes that identifier: SHA-256 over a canonical
 * serialization of the exact payload that will execute. All three call
 * sites — the orders list, the preview audit, and the execute audit —
 * normalize through the same function, so the approve-time version and
 * the execute-time version are comparable strings. Preview-shaped
 * inputs (orderAction/estimatedPrice/estimatedTotal) and stored-record
 * inputs (action/price/totalValue) normalize to the same payload.
 *
 * The hash is a version identifier, not the security boundary itself —
 * the boundary is the dispatcher's immutability check. SHA-256 runs via
 * Web Crypto, available in Workers, browsers, and Node 22 (tests).
 */

export interface OrderPayloadInput {
  symbol?: unknown;
  action?: unknown;
  orderAction?: unknown;
  quantity?: unknown;
  orderType?: unknown;
  price?: unknown;
  estimatedPrice?: unknown;
  totalValue?: unknown;
  estimatedTotal?: unknown;
  previewNotes?: unknown;
  optionLegs?: unknown;
  strategyNetDebit?: unknown;
}

export interface NormalizedOrderPayload {
  symbol: string;
  action: string;
  quantity: number | null;
  orderType: string;
  price: number | null;
  totalValue: number | null;
  optionLegs: unknown[];
  strategyNetDebit: number | null;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Strategy legs travel in `previewNotes` as
 * `{ kind: "strategy-order-v1", optionLegs, strategyNetDebit }`, or
 * arrive explicitly (the execute path passes the parsed strategy order).
 * Only the stored/approved legs count — never a caller-supplied shape
 * that is not the strategy-order-v1 envelope.
 */
export function parseStrategyOrder(previewNotes: unknown): {
  optionLegs: unknown[];
  strategyNetDebit: number | null;
} {
  if (typeof previewNotes !== "string" || !previewNotes.startsWith("{")) {
    return { optionLegs: [], strategyNetDebit: null };
  }
  try {
    const stored = JSON.parse(previewNotes) as Record<string, unknown>;
    if (stored?.kind !== "strategy-order-v1" || !Array.isArray(stored.optionLegs)) {
      return { optionLegs: [], strategyNetDebit: null };
    }
    return {
      optionLegs: stored.optionLegs,
      strategyNetDebit: toNumberOrNull(stored.strategyNetDebit),
    };
  } catch {
    return { optionLegs: [], strategyNetDebit: null };
  }
}

export function normalizeOrderPayload(input: OrderPayloadInput): NormalizedOrderPayload {
  const fromNotes = parseStrategyOrder(input.previewNotes);
  const legs = Array.isArray(input.optionLegs) ? input.optionLegs : fromNotes.optionLegs;
  const netDebit =
    input.strategyNetDebit !== undefined
      ? toNumberOrNull(input.strategyNetDebit)
      : fromNotes.strategyNetDebit;
  // Stored price is what executes: the preview's estimatedPrice IS the
  // execution price (limit price for LIMIT, quote for MARKET), and the
  // stored record carries it as `price`. Never prefer a request-time
  // limitPrice over the stored figure.
  const price = toNumberOrNull(input.price ?? input.estimatedPrice);
  const totalValue = toNumberOrNull(input.totalValue ?? input.estimatedTotal);
  return {
    symbol: String(input.symbol ?? "").toUpperCase().trim(),
    action: String(input.action ?? input.orderAction ?? "").toUpperCase().trim(),
    quantity: toNumberOrNull(input.quantity),
    orderType: String(input.orderType ?? "").toUpperCase().trim(),
    price,
    totalValue,
    optionLegs: legs,
    strategyNetDebit: netDebit,
  };
}

/** Deterministic serialization: object keys sorted recursively, array order kept (leg order matters). */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function orderPayloadCanonical(input: OrderPayloadInput): string {
  return canonicalize(normalizeOrderPayload(input));
}

export async function orderPayloadHash(input: OrderPayloadInput): Promise<string> {
  const bytes = new TextEncoder().encode(orderPayloadCanonical(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Display form: the full hash stays in `title` / audit; cards show the short form. */
export function orderPayloadShortHash(fullHash: string): string {
  return fullHash.slice(0, 12);
}
