/**
 * Issue #2216 (#1969 P1): every screener Slack message carries a
 * human-readable trace block, and failure messages render from the
 * catalog — so a reader of any single message can answer which
 * schedule, run, workflow, stage, and job produced it without
 * opening the audit log.
 *
 * TDD: this file pins the trace renderer, the guard alert, and the
 * failure leg before the wiring lands.
 */
import { describe, expect, it } from "vitest";
import {
  formatTraceBlock,
  type ScreenerTrace,
} from "../src/services/screenerTrace";
import {
  guardScheduledETradeAuth,
  type AuthEpisodeStore,
} from "../src/services/etradeAuthPreflight";
import { formatLifecycleNotification } from "../src/services/screenerFollowups";

const fullTrace: ScreenerTrace = {
  scheduleId: "_D6hWyU_S",
  scheduleName: "hourly options NASDAQ100",
  runId: "options_scanner:2026-10-29T04:35:02.787Z:bullish",
  workflow: "autonomousOptionsAnalysis",
  trigger: "scheduled",
  stage: "auth guard",
  jobId: "job_01",
  firedAt: "2026-10-29T04:35:02.787Z",
  runAs: "OpenAIMP",
  universe: "NASDAQ100",
  thesis: "bullish",
};

function mapStore(): AuthEpisodeStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

describe("#2216 trace block renderer", () => {
  it("renders every carried field with human-readable labels", () => {
    const block = formatTraceBlock(fullTrace);
    expect(block).toContain("Schedule: hourly options NASDAQ100 (_D6hWyU_S)");
    expect(block).toContain(
      "Run: options_scanner:2026-10-29T04:35:02.787Z:bullish"
    );
    expect(block).toContain("Workflow: autonomousOptionsAnalysis");
    expect(block).toContain("Stage: auth guard");
    expect(block).toContain("Fired: 2026-10-29T04:35:02.787Z");
    expect(block).toContain("Run-as: OpenAIMP");
    expect(block).toContain("Job: job_01");
  });

  it("omits absent optional fields without leaking undefined", () => {
    const block = formatTraceBlock({
      runId: "options_scanner:2026-10-29T04:35:02.787Z:bullish",
      workflow: "autonomousOptionsAnalysis",
      trigger: "scheduled",
      stage: "auth guard",
      firedAt: "2026-10-29T04:35:02.787Z",
      runAs: "OpenAIMP",
    });
    expect(block).toContain("Run: options_scanner:2026-10-29T04:35:02.787Z:bullish");
    expect(block).not.toContain("Schedule:");
    expect(block).not.toContain("Job:");
    expect(block).not.toContain("undefined");
  });

  it("renders empty for a trace with no identity (backward compat)", () => {
    expect(formatTraceBlock(undefined)).toBe("");
  });
});

describe("#2216 guard alert carries catalog message + trace", () => {
  it("alerts from the catalog and appends the trace block", async () => {
    const posted: string[] = [];
    const res = await guardScheduledETradeAuth({
      env: {} as never,
      userLogin: "OpenAIMP",
      environment: "PROD",
      store: mapStore(),
      kind: "options",
      label: "options screen",
      trace: fullTrace,
      deps: {
        getTokens: async () => null,
        renew: async () => null,
        isExpired: () => false,
        now: () => Date.parse("2026-10-29T04:35:02.787Z"),
        isProduction: () => true,
      },
      sendSlackAlert: async (text: string) => {
        posted.push(text);
      },
    });
    expect(res.blocked).toBe(true);
    expect(posted.length).toBe(1);
    // Catalog-rendered (FAILURE_AUTH_NO_SESSION businessMessage), not the hand-built variant.
    expect(posted[0]).toContain(
      "[FAILURE_AUTH_NO_SESSION] No E*TRADE session is stored for this account. Please connect your account in Settings."
    );
    expect(posted[0]).not.toContain("No stored E*TRADE session exists");
    expect(posted[0]).toContain("Run: options_scanner:2026-10-29T04:35:02.787Z:bullish");
    expect(posted[0]).toContain("Workflow: autonomousOptionsAnalysis");
    expect(posted[0]).toContain("Stage: auth guard");
  });

  it("bridges the failed outcome with the trace attached", async () => {
    const bridged: Array<{ outcome: unknown }> = [];
    await guardScheduledETradeAuth({
      env: {} as never,
      userLogin: "OpenAIMP",
      environment: "PROD",
      store: mapStore(),
      kind: "options",
      label: "options screen",
      trace: fullTrace,
      deps: {
        getTokens: async () => null,
        renew: async () => null,
        isExpired: () => false,
        now: () => Date.parse("2026-10-29T04:35:02.787Z"),
        isProduction: () => true,
      },
      sendSlackAlert: async () => {},
      bridge: (async (outcome: unknown) => {
        bridged.push({ outcome });
      }) as never,
    });
    expect(bridged.length).toBe(1);
    expect(
      (bridged[0].outcome as { trace?: ScreenerTrace }).trace
    ).toEqual(fullTrace);
  });
});

describe("#2216 failure leg appends the trace block", () => {
  it("appends the block when the outcome carries a trace", () => {
    const text = formatLifecycleNotification(
      "failed",
      {
        kind: "options",
        trigger: "scheduled",
        success: false,
        pdfKeys: [],
        thesis: "bullish",
        error: "[FAILURE_AUTH_NO_SESSION] No E*TRADE session is stored for this account.",
        trace: fullTrace,
      } as never,
    );
    expect(text).toContain("❌ [FAILURE_SCREEN_RUN_FAILED] The screen run failed. — Options screen — bullish");
    expect(text).toContain("Run: options_scanner:2026-10-29T04:35:02.787Z:bullish");
    expect(text).toContain("Schedule: hourly options NASDAQ100 (_D6hWyU_S)");
  });

  it("renders from the catalog when no trace is carried (#2248; supersedes the #2216 byte-identical pin for this leg)", () => {
    const text = formatLifecycleNotification("failed", {
      kind: "options",
      trigger: "scheduled",
      success: false,
      pdfKeys: [],
      thesis: "bullish",
      error: "[FAILURE_AUTH_NO_SESSION] No E*TRADE session is stored for this account.",
    } as never);
    expect(text).toBe(
      "❌ [FAILURE_SCREEN_RUN_FAILED] The screen run failed. — Options screen — bullish — [FAILURE_AUTH_NO_SESSION] No E*TRADE session is stored for this account."
    );
  });
});
