import { describe, it, expect, vi } from "vitest";
import {
  AgentErrorCode,
  AGENT_ERROR_CATALOG,
  resolveErrorAspect,
  AgentError,
  ETradeErrorCode,
} from "../src/aspects/errorCodes";
import {
  logAspectEvent,
  withAgentAspect,
  type AspectEvent,
} from "../src/aspects/loggingAspect";

describe("Aspect-Oriented Error Codes and Resolution", () => {
  it("resolves Cloudflare Workers AI Error 4006 (neuron quota exceeded) into ERR_AI_NEURON_QUOTA_EXCEEDED", () => {
    const rawError =
      "4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.";

    const aspect = resolveErrorAspect(rawError);

    expect(aspect.code).toBe(AgentErrorCode.AI_NEURON_QUOTA_EXCEEDED);
    expect(aspect.isAiQuota).toBe(true);
    expect(aspect.title).toContain("Workers AI Daily Allocation Reached");
    expect(aspect.message).toContain("10,000 neurons");
    expect(aspect.resolutionSteps.length).toBeGreaterThanOrEqual(3);
    expect(aspect.resolutionSteps[0]).toContain("E*TRADE · Multi-Asset Screeners");
    expect(aspect.resolutionSteps[1]).toContain("Workers Paid");
    expect(aspect.suggestedTab).toBe("trading");
    expect(aspect.suggestedTabLabel).toBe("Open Stock Screener Tab");
  });

  it("resolves rate limiting into ERR_AI_RATE_LIMITED", () => {
    const aspect = resolveErrorAspect("HTTP 429: Too Many Requests - Rate limit exceeded");

    expect(aspect.code).toBe(AgentErrorCode.AI_RATE_LIMITED);
    expect(aspect.title).toContain("Rate Limit");
    expect(aspect.resolutionSteps.length).toBeGreaterThan(0);
    expect(aspect.suggestedTab).toBe("trading");
  });

  it("resolves WebSocket connection drops into ERR_AGENT_CONNECTION_DROPPED", () => {
    const aspect = resolveErrorAspect("WebSocket connection closed unexpectedly; readyState 3");

    expect(aspect.code).toBe(AgentErrorCode.AGENT_CONNECTION_DROPPED);
    expect(aspect.title).toContain("WebSocket");
    expect(aspect.resolutionSteps.some((s) => s.includes("Reconnect"))).toBe(true);
  });

  it("resolves stream errors into ERR_AI_STREAM_FAILURE", () => {
    const aspect = resolveErrorAspect(new Error("Agent connection or stream error. Try sending a message"));

    expect(aspect.code).toBe(AgentErrorCode.AI_STREAM_FAILURE);
    expect(aspect.title).toContain("Stream");
    expect(aspect.resolutionSteps.some((s) => s.includes("Reconnect"))).toBe(true);
  });

  it("resolves E*TRADE token expired into ETRADE_TOKEN_EXPIRED", () => {
    const aspect = resolveErrorAspect("ETRADE_TOKEN_EXPIRED: Your E*TRADE session expired at midnight ET");

    expect(aspect.code).toBe(ETradeErrorCode.TOKEN_EXPIRED);
    expect(aspect.suggestedTab).toBe("trading");
    expect(aspect.suggestedTabLabel).toBe("Authenticate E*TRADE");
  });

  it("catalog defines complete remediation metadata for every AgentErrorCode", () => {
    for (const code of Object.values(AgentErrorCode)) {
      const entry = AGENT_ERROR_CATALOG[code];
      expect(entry).toBeDefined();
      expect(entry.code).toBe(code);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.defaultMessage.length).toBeGreaterThan(0);
      expect(entry.remediation.length).toBeGreaterThan(0);
      expect(entry.resolutionSteps.length).toBeGreaterThan(0);
    }
  });

  it("AgentError serializes properly to JSON with full aspect metadata", () => {
    const err = new AgentError(
      AgentErrorCode.AI_NEURON_QUOTA_EXCEEDED,
      "Daily quota breached"
    );

    const json = err.toJSON();
    expect(json.success).toBe(false);
    expect(json.code).toBe("ERR_AI_NEURON_QUOTA_EXCEEDED");
    expect(json.httpStatus).toBe(429);
    expect(json.resolutionSteps.length).toBeGreaterThan(0);
    expect(json.suggestedTab).toBe("trading");
  });
});

describe("Aspect-Oriented Logging & Interception", () => {
  it("logAspectEvent formats and records audit aspect correctly", () => {
    const auditMock = vi.fn();
    const event: AspectEvent = {
      aspect: "ChatStream",
      operationName: "streamError",
      code: "ERR_AI_NEURON_QUOTA_EXCEEDED",
      level: "error",
      message: "Daily allocation used up",
      durationMs: 42,
      audit: auditMock,
    };

    logAspectEvent(event);

    expect(auditMock).toHaveBeenCalledWith(
      "chatstream.streamerror.error",
      "chatstream",
      expect.objectContaining({
        operationName: "streamError",
        code: "ERR_AI_NEURON_QUOTA_EXCEEDED",
        level: "error",
        durationMs: 42,
      })
    );
  });

  it("withAgentAspect executes successfully and logs aspect", async () => {
    const auditMock = vi.fn();

    const result = await withAgentAspect(
      {
        operationName: "testOperation",
        userLogin: "trader_alice",
        audit: auditMock,
      },
      async () => "success_payload"
    );

    expect(result).toBe("success_payload");
    expect(auditMock).toHaveBeenCalledWith(
      "agent.testoperation.completed",
      "agent",
      expect.objectContaining({ operationName: "testOperation" })
    );
  });

  it("withAgentAspect intercepts raw error, translates to AgentError, and logs aspect", async () => {
    const auditMock = vi.fn();

    await expect(
      withAgentAspect(
        {
          operationName: "failingAiCall",
          userLogin: "trader_bob",
          audit: auditMock,
        },
        async () => {
          throw new Error("4006: you have used up your daily free allocation of 10,000 neurons");
        }
      )
    ).rejects.toThrowError(AgentError);

    expect(auditMock).toHaveBeenCalledWith(
      "agent.failingaicall.error",
      "agent",
      expect.objectContaining({
        code: "ERR_AI_NEURON_QUOTA_EXCEEDED",
      })
    );
  });
});
