/**
 * #2173 admin-panel queue wipe slice — API client for the Queue tab.
 *
 * The Queue tab reads and mutates ONLY through existing routes:
 * GET /api/schedules (dump), POST /api/schedules/cancel-all
 * (preview + confirm), POST /api/maintenance/clear-table (preview +
 * confirm), POST /api/schedules/create (Track 1 recreation). No new
 * server route exists for this slice, so there is nothing else to
 * call. A non-ok response throws with the server message; a
 * malformed payload throws instead of rendering partial data.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  fetchQueueDump,
  previewCancelAll,
  confirmCancelAll,
  previewClearTable,
  confirmClearTable,
  track1RecreatePlan,
  recreateTrack1,
} from "../src/client/adminQueueApi";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

let calls: Array<{ url: string; init?: RequestInit }> = [];

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchQueueDump", () => {
  it("parses the schedules list, extracting universe only from payloads", async () => {
    stubFetch(() =>
      jsonResponse({
        count: 3,
        schedules: [
          { id: "a1", callback: "autonomousMarketScreen", type: "cron", cron: "30 12 * * 1-5", payload: { universe: "NASDAQ100", userLogin: "someone@example.com" } },
          { id: "b2", callback: "autonomousOptionsAnalysis", type: "interval", intervalSeconds: 3600, payload: { universe: "SP100" } },
          { id: "p3", callback: "autonomousMarketScreen", paused: true, payload: {} },
        ],
        timestamp: "2026-10-30T12:00:00.000Z",
      }),
    );
    const dump = await fetchQueueDump();
    expect(dump.count).toBe(3);
    expect(dump.schedules).toHaveLength(3);
    expect(dump.schedules[0]).toMatchObject({ id: "a1", callback: "autonomousMarketScreen", cron: "30 12 * * 1-5", universe: "NASDAQ100" });
    expect(dump.schedules[1]).toMatchObject({ id: "b2", intervalSeconds: 3600, universe: "SP100" });
    expect(dump.schedules[2]).toMatchObject({ id: "p3", paused: true });
    // The full payload (logins, delivery) is never surfaced to the UI.
    expect(JSON.stringify(dump)).not.toContain("someone@example.com");
  });

  it("throws on a malformed list payload and on a non-ok response", async () => {
    stubFetch(() => jsonResponse({ schedules: "nope" }));
    await expect(fetchQueueDump()).rejects.toThrow();
    stubFetch(() => jsonResponse({ error: "Forbidden" }, 403));
    await expect(fetchQueueDump()).rejects.toThrow("Forbidden");
  });
});

describe("cancel-all", () => {
  it("preview returns would-cancel + paused-preserved without confirming", async () => {
    stubFetch((url, init) => {
      const body = JSON.parse(String((init as any)?.body ?? "{}"));
      expect(body.confirm).not.toBe(true);
      return jsonResponse({
        cancelled: 0,
        confirmRequired: true,
        wouldCancel: [{ id: "a1", callback: "autonomousMarketScreen" }],
        wouldCancelCount: 1,
        pausedPreserved: 2,
      });
    });
    const preview = await previewCancelAll();
    expect(preview.confirmRequired).toBe(true);
    expect(preview.wouldCancelCount).toBe(1);
    expect(preview.pausedPreserved).toBe(2);
    expect(calls[0].url).toBe("/api/schedules/cancel-all");
  });

  it("confirm posts confirm:true and parses cancelled + failed", async () => {
    stubFetch((_url, init) => {
      const body = JSON.parse(String((init as any)?.body ?? "{}"));
      expect(body.confirm).toBe(true);
      return jsonResponse({
        cancelled: 1,
        cancelledIds: ["a1"],
        failed: [{ id: "b2", error: "not found" }],
        pausedPreserved: 2,
      });
    });
    const result = await confirmCancelAll();
    expect(result.cancelled).toBe(1);
    expect(result.cancelledIds).toEqual(["a1"]);
    expect(result.failed).toHaveLength(1);
  });
});

describe("clear-table", () => {
  it("preview and confirm round-trip the allowlisted table shapes", async () => {
    stubFetch((_url, init) => {
      const body = JSON.parse(String((init as any)?.body ?? "{}"));
      if (body.confirm === true) {
        return jsonResponse({ table: "mas_async_jobs", scope: "session", confirmed: true, deleted: 4, skippedRunning: 1 });
      }
      return jsonResponse({
        table: "mas_async_jobs",
        scope: "session",
        confirmed: false,
        confirmRequired: true,
        wouldDelete: 4,
        breakdown: { queued: 3, failed: 1, running: 1 },
        skippedRunning: 1,
      });
    });
    const preview = await previewClearTable("mas_async_jobs");
    expect(preview.wouldDelete).toBe(4);
    expect(preview.breakdown).toMatchObject({ queued: 3 });
    expect(preview.skippedRunning).toBe(1);
    const result = await confirmClearTable("mas_async_jobs");
    expect(result.confirmed).toBe(true);
    expect(result.deleted).toBe(4);
    expect(result.skippedRunning).toBe(1);
  });

  it("a refused table surfaces the server error, not a silent no-op", async () => {
    stubFetch(() => jsonResponse({ error: "mas_events (audit history) is never bulk-clearable via this endpoint" }, 400));
    await expect(previewClearTable("mas_events" as never)).rejects.toThrow("never bulk-clearable");
  });
});

describe("Track 1 recreation plan", () => {
  it("builds exactly four form-identical schedules with the spec cadences", () => {
    const plan = track1RecreatePlan();
    expect(plan).toHaveLength(4);
    const [pre, intra, optN, optS] = plan;
    expect(pre.label).toBe("Stock pre-market");
    expect(pre.requestBody).toMatchObject({
      callback: "autonomousMarketScreen",
      scheduleType: "cron",
      cron: "30 12 * * 1-5",
    });
    expect(pre.requestBody.payload).toMatchObject({
      universe: "NASDAQ100",
      maxItems: 100,
      sector: "ALL",
      trigger: "scheduled",
      pushToSlack: true,
      slackChannel: "#screener_slack_channel",
      emailTo: "dhmprstw@gmail.com",
    });
    expect(intra.requestBody).toMatchObject({ scheduleType: "cron", cron: "30 16 * * 1-5" });
    expect(intra.requestBody.payload).toMatchObject({ universe: "NASDAQ100" });
    expect(optN.requestBody).toMatchObject({
      callback: "autonomousOptionsAnalysis",
      scheduleType: "interval",
      intervalSeconds: 3600,
    });
    expect(optN.requestBody.payload).toMatchObject({
      universe: "NASDAQ100",
      maxItems: 100,
      thesis: "bullish",
      riskProfile: "balanced",
      trigger: "scheduled",
    });
    // Options legs: the form builder passes slackChannel through raw
    // when push is on (blank stays "", falsy at delivery so alerts flow
    // via the configured env channel) and trims emailTo to undefined.
    expect(optN.requestBody.payload.slackChannel).toBe("");
    expect(optN.requestBody.payload.emailTo).toBeUndefined();
    expect(optS.requestBody.payload).toMatchObject({ universe: "SP100", thesis: "bullish", riskProfile: "balanced" });
  });

  it("recreate posts all four creates and reports per-schedule results", async () => {
    stubFetch((url) => {
      expect(url).toBe("/api/schedules/create");
      const body = JSON.parse(String(calls[calls.length - 1].init?.body ?? "{}"));
      if (body.payload?.universe === "SP100") {
        return jsonResponse({ success: false, error: "Connect an E*TRADE account for this environment before creating an account-scoped schedule." }, 409);
      }
      return jsonResponse({ success: true, schedule: { id: `new-${body.payload?.universe}` } });
    });
    const results = await recreateTrack1();
    expect(results).toHaveLength(4);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const failed = results.find((r) => !r.ok)!;
    expect(failed.label).toBe("Options SP100");
    expect(failed.error).toContain("Connect an E*TRADE account");
    expect(calls).toHaveLength(4);
  });
});
