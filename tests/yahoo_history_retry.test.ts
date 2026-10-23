/**
 * Issue #1184 (#1173 R2): the Yahoo history leg retries.
 *
 * Before R2, fetchYahooDailyHistory tried query1→query2 once each;
 * a throttle storm zeroed MACD/Gap for an entire run. Pins: a
 * 429-then-OK sequence now recovers through the shared acquisition
 * policy; total failure still returns honest null.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchYahooDailyHistory } from "../src/trading/yahooHistory";

function chartPayload(days = 30) {
  const base = Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000);
  const timestamps = Array.from({ length: days }, (_, i) => base + i * 86_400);
  const closes = Array.from({ length: days }, (_, i) => 100 + i);
  return {
    chart: {
      result: [
        {
          timestamp: timestamps,
          indicators: {
            quote: [
              {
                close: closes,
                open: closes.map((c) => c - 0.5),
                high: closes.map((c) => c + 0.5),
                low: closes.map((c) => c - 1),
                volume: closes.map(() => 1_000_000),
              },
            ],
          },
        },
      ],
    },
  };
}

function httpResponse(status: number, payload?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload ?? {},
  };
}

const policy = { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
const noSleep = async () => {};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchYahooDailyHistory — retry under the acquisition policy", () => {
  it("recovers when the first attempt is throttled on both hosts", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      // Attempt 1: query1 429, query2 429. Attempt 2: query1 OK.
      return calls <= 2 ? httpResponse(429) : httpResponse(200, chartPayload());
    });
    const bars = await fetchYahooDailyHistory("ZZRTRY1", undefined, { retryPolicy: policy, retrySleep: noSleep });
    expect(bars).not.toBeNull();
    expect(bars!).toHaveLength(30);
    expect(calls).toBe(3);
  });

  it("returns honest null when every attempt fails", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return httpResponse(503);
    });
    const bars = await fetchYahooDailyHistory("ZZRTRY2", undefined, { retryPolicy: policy, retrySleep: noSleep });
    expect(bars).toBeNull();
    // 2 attempts × 2 hosts.
    expect(calls).toBe(4);
  });
});
