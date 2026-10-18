/**
 * Issue #210: screener event bus — pub/sub for harvesting screen results.
 *
 * Pinned here:
 * - subscribers receive published events;
 * - a failing subscriber never blocks the others;
 * - publish never throws;
 * - unsubscribe works.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ScreenerEventBus,
  type ScreenerCompletedEvent,
} from "../src/events/screenerEvents";

const completedEvent: ScreenerCompletedEvent = {
  type: "screener.completed",
  timestamp: new Date().toISOString(),
  sector: "Technology",
  totalScanned: 100,
  matchedCount: 3,
  opportunities: [
    {
      symbol: "AAPL",
      companyName: "Apple Inc",
      signal: "BULLISH_MOMENTUM",
      momentumScore: 75,
      lastPrice: 250.0,
      changePercent: 1.5,
    },
  ],
};

describe("ScreenerEventBus (#210)", () => {
  it("delivers events to subscribers", async () => {
    const bus = new ScreenerEventBus();
    const received: unknown[] = [];
    bus.subscribe("screener.completed", (e) => void received.push(e));
    await bus.publish(completedEvent);
    expect(received).toHaveLength(1);
    expect((received[0] as ScreenerCompletedEvent).opportunities[0].symbol).toBe("AAPL");
  });

  it("a failing subscriber never blocks the others", async () => {
    const bus = new ScreenerEventBus();
    const good = vi.fn();
    bus.subscribe("screener.completed", () => {
      throw new Error("subscriber boom");
    });
    bus.subscribe("screener.completed", good);
    await bus.publish(completedEvent);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("publish never throws with no subscribers", async () => {
    const bus = new ScreenerEventBus();
    await expect(bus.publish(completedEvent)).resolves.toBeUndefined();
  });

  it("unsubscribe removes the handler", async () => {
    const bus = new ScreenerEventBus();
    const handler = vi.fn();
    const unsub = bus.subscribe("screener.completed", handler);
    unsub();
    await bus.publish(completedEvent);
    expect(handler).not.toHaveBeenCalled();
    expect(bus.subscriberCount("screener.completed")).toBe(0);
  });

  it("failed events route to their own subscribers", async () => {
    const bus = new ScreenerEventBus();
    const completed = vi.fn();
    const failed = vi.fn();
    bus.subscribe("screener.completed", completed);
    bus.subscribe("screener.failed", failed);
    await bus.publish({
      type: "screener.failed",
      timestamp: new Date().toISOString(),
      sector: "Technology",
      error: "boom",
    });
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
