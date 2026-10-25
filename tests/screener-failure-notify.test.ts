import { describe, it, expect, vi } from "vitest";
import { publishScreenerFailed } from "../src/events/screenerPublishers";

/**
 * #424: failed screener runs must notify Slack.
 */

describe("#424 failure notification", () => {
  it("sends a Slack message on screener failure", async () => {
    const posted: string[] = [];
    const deps = {
      env: {
        SLACK_WEBHOOK_URL: "https://hooks.slack.test/xxx",
      },
      userLogin: "tester",
    } as any;

    // Mock fetch for the webhook path.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      posted.push(JSON.parse(init.body).text);
      return { ok: true, json: async () => ({}) };
    }) as any;

    try {
      await publishScreenerFailed(deps, {
        type: "screener.failed",
        timestamp: new Date().toISOString(),
        universe: "RUSSELL2000",
        trigger: "manual",
        deliveryId: "manual:test",
        error: "E*TRADE unavailable: no live quotes returned",
      });
      expect(posted.length).toBe(1);
      expect(posted[0]).toContain("FAILED");
      expect(posted[0]).toContain("RUSSELL2000");
      expect(posted[0]).toContain("E*TRADE unavailable");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
