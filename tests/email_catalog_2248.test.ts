/**
 * Issue #2248 (AOP P1): a screener failure email renders from the
 * catalog and carries the trace block. The failure email flows
 * through the notify job, whose subject is the failed text's first
 * line — so the email proof is the sent email's subject + body,
 * not the success-subject function (which is the success path only).
 */
import { describe, expect, it } from "vitest";
import { formatLifecycleNotification } from "../src/services/screenerFollowups";
import { createFollowupDeliveryPort } from "../src/services/screenerFollowupDelivery";
import type { ScreenerTrace } from "../src/services/screenerTrace";

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

describe("failure email renders from the catalog with the trace block (#2248)", () => {
  it("sends a catalog-rendered subject and a body carrying the trace block", async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          result: {
            artifacts: [{ parts: [{ kind: "data", data: { ok: true, messageId: "a2a-msg-1" } }] }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const env = {
        SCREENER_EMAIL_TO: "ops@example.com",
        CFPAY_A2A_TOKEN: "test-a2a-token",
        CFPAY_URL: "https://pay.openaimp.com",
      };
      const port = createFollowupDeliveryPort({
        env: env as never,
        getOrm: () => ({}) as never,
        getScreenerAgent: () => ({}) as never,
      });
      const text = formatLifecycleNotification(
        "failed",
        {
          kind: "options",
          trigger: "scheduled",
          success: false,
          pdfKeys: [],
          thesis: "bullish",
          error: "E*TRADE session missing",
          trace: fullTrace,
        } as never,
      );
      const res = await port.notify({
        channel: "email",
        userLogin: "alice",
        text,
      });
      expect(res.ok).toBe(true);
      expect(fetchCalls).toHaveLength(1);
      const data = ((fetchCalls[0].body.params as any).message.parts[0].data) as {
        operation: string;
        to: string;
        subject: string;
        body: string;
      };
      expect(data.operation).toBe("email.send");
      expect(data.to).toBe("ops@example.com");
      expect(data.subject).toBe(
        "❌ [SCREEN_001] The screen run failed. — Options screen — bullish — E*TRADE session missing",
      );
      expect(data.body).toContain("Run: options_scanner:2026-10-29T04:35:02.787Z:bullish");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
