/**
 * Issue #1703 (A3-a): payload version identifier for previewed drafts.
 *
 * Pins:
 *  - the hash is deterministic for identical payloads
 *  - preview-shaped inputs (orderAction/estimatedPrice/estimatedTotal)
 *    and stored-record inputs (action/price/totalValue) normalize to
 *    the same version — the approve-time and execute-time versions
 *    must be comparable
 *  - any payload change (quantity, legs) changes the version
 *  - the digest is real SHA-256 over the canonical string (vector
 *    cross-checked against the system sha256sum during development)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  orderPayloadHash,
  orderPayloadCanonical,
  parseStrategyOrder,
} from "../src/agents/routes/orderPayloadHash";

const stored = {
  symbol: "NVDA",
  action: "BUY",
  quantity: 10,
  orderType: "LIMIT",
  price: 180.5,
  totalValue: 1805,
  previewNotes: null,
};

const previewShaped = {
  symbol: "nvda",
  orderAction: "buy",
  quantity: "10",
  orderType: "limit",
  estimatedPrice: 180.5,
  estimatedTotal: 1805,
};

describe("Issue #1703 — order payload version", () => {
  it("is deterministic for identical payloads", async () => {
    expect(await orderPayloadHash(stored)).toBe(await orderPayloadHash(stored));
    expect(await orderPayloadHash(stored)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes preview-shaped and stored-record inputs to the same version", async () => {
    expect(await orderPayloadHash(previewShaped)).toBe(await orderPayloadHash(stored));
  });

  it("changes when any payload field changes", async () => {
    const base = await orderPayloadHash(stored);
    expect(await orderPayloadHash({ ...stored, quantity: 11 })).not.toBe(base);
    expect(await orderPayloadHash({ ...stored, price: 180.6 })).not.toBe(base);
    expect(await orderPayloadHash({ ...stored, symbol: "AMD" })).not.toBe(base);
  });

  it("changes when strategy legs change", async () => {
    const notes = (legs: unknown[]) =>
      JSON.stringify({ kind: "strategy-order-v1", optionLegs: legs, strategyNetDebit: 1.25 });
    const one = await orderPayloadHash({
      ...stored,
      previewNotes: notes([{ securityType: "OPTN", quantity: 1 }]),
    });
    const two = await orderPayloadHash({
      ...stored,
      previewNotes: notes([
        { securityType: "OPTN", quantity: 1 },
        { securityType: "OPTN", quantity: 1 },
      ]),
    });
    expect(one).not.toBe(two);
  });

  it("matches SHA-256 of the canonical string (pinned vector)", async () => {
    const canonical = orderPayloadCanonical(stored);
    expect(canonical).toBe(
      '{"action":"BUY","optionLegs":[],"orderType":"LIMIT","price":180.5,"quantity":10,"strategyNetDebit":null,"symbol":"NVDA","totalValue":1805}'
    );
    expect(await orderPayloadHash(stored)).toBe(
      "bb33ea7844d857ca256c9421f97d80eb45154039df577237d5436cdb4828e81f"
    );
  });

  it("ignores non-strategy preview notes", () => {
    expect(parseStrategyOrder("human-readable note")).toEqual({
      optionLegs: [],
      strategyNetDebit: null,
    });
    expect(parseStrategyOrder("{not json")).toEqual({ optionLegs: [], strategyNetDebit: null });
    expect(
      parseStrategyOrder(JSON.stringify({ kind: "other", optionLegs: [{ securityType: "OPTN" }] }))
    ).toEqual({ optionLegs: [], strategyNetDebit: null });
  });

  it("orders list handler attaches the server-computed version (source pin)", () => {
    const routes = readFileSync("src/agents/routes/etradeBroker.ts", "utf8");
    expect(routes).toContain("payloadHash: await orderPayloadHash(trade)");
    const orders = readFileSync("src/agents/routes/etradeBrokerOrders.ts", "utf8");
    expect(orders).toContain("payloadHash: previewPayloadHash");
    expect(orders).toContain("payloadHash: executedPayloadHash");
  });
});
