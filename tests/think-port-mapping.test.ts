/**
 * Issue #1935 (O3 spike) — node tests for the PURE mapping half of
 * the Think adapter (thinkPortMapping.ts). These tests import NO
 * Think runtime code: thinkPortMapping.ts uses only `import type`
 * from `@cloudflare/think`, so it loads in node vitest. The
 * Think-coupled half (thinkAdapter.ts) cannot load here — its
 * proof runs under workerd (see think-spike/run-proof.mjs) — and
 * nothing in this file pretends otherwise.
 */
import type {
  TurnConfig as ThinkTurnConfig,
  TurnContext as ThinkTurnContext,
  TurnResult as ThinkTurnResult,
} from "@cloudflare/think";
import { describe, expect, it } from "vitest";
import { createActorPorts } from "../src/actors/createActorPorts";
import {
  portMessagesToThink,
  portTurnConfigToThink,
  thinkMessagesToPort,
  thinkMessageToPort,
  thinkTurnContextToPort,
  thinkTurnResultToPort,
} from "../src/actors/thinkPortMapping";

describe("think port mapping", () => {
  it("port -> think messages drop port-only fields, keep id/role/parts", () => {
    const out = portMessagesToThink([
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: { agent: "search" },
        createdAt: "2026-10-01T12:00:00.000Z",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
  });

  it("think -> port message maps id/role/parts, generates an id when absent", () => {
    const withId = thinkMessageToPort({
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "reply" }],
    } as never);
    expect(withId).toMatchObject({ id: "a1", role: "assistant" });
    expect(withId?.parts).toEqual([{ type: "text", text: "reply" }]);
    const noId = thinkMessageToPort({ role: "user", parts: [] } as never);
    expect(typeof noId?.id).toBe("string");
    expect(noId?.id.length).toBeGreaterThan(0);
  });

  it("think -> port message drops unknown roles instead of inventing one", () => {
    expect(thinkMessageToPort({ id: "x", role: "data", parts: [] } as never)).toBeUndefined();
    expect(
      thinkMessagesToPort([
        { id: "a", role: "assistant", parts: [] },
        { id: "b", role: "data", parts: [] },
      ] as never)
    ).toHaveLength(1);
  });

  it("port turn config -> think config passes shared fields 1:1, void stays void", () => {
    expect(portTurnConfigToThink(undefined)).toBeUndefined();
    const out = portTurnConfigToThink({
      instructions: "override",
      maxSteps: 1,
      activeTools: ["search"],
      messages: [{ role: "user", content: "hi" }],
    }) as unknown as Record<string, unknown>;
    expect(out.instructions).toBe("override");
    expect(out.maxSteps).toBe(1);
    expect(out.activeTools).toEqual(["search"]);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
    // No undefined-valued keys leak into Think's config.
    expect(Object.values(out).every((v) => v !== undefined)).toBe(true);
    const empty = portTurnConfigToThink({}) as unknown as Record<string, unknown>;
    expect(Object.keys(empty)).toEqual([]);
  });

  it("think turn context -> port context maps messages to text", () => {
    const out = thinkTurnContextToPort({
      system: "sys",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
            { type: "reasoning", text: "ignored" },
          ],
        },
      ],
      tools: { search: {} },
      model: { modelId: "stub" },
      continuation: true,
      body: { turnId: "t1" },
    } as unknown as ThinkTurnContext);
    expect(out.system).toBe("sys");
    expect(out.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "ab" },
    ]);
    expect(out.continuation).toBe(true);
    expect(out.body).toEqual({ turnId: "t1" });
  });

  it("think wait result -> port result maps completed/skipped/aborted/error", () => {
    const completed = thinkTurnResultToPort(
      {
        status: "completed",
        requestId: "r-think",
        continuation: false,
        message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
      } as unknown as ThinkTurnResult,
      "r-adapter"
    );
    expect(completed).toMatchObject({ status: "completed", requestId: "r-think" });
    expect(completed.message?.role).toBe("assistant");

    const noThinkId = thinkTurnResultToPort(
      { status: "completed", continuation: false } as unknown as ThinkTurnResult,
      "r-adapter"
    );
    expect(noThinkId.requestId).toBe("r-adapter");

    const skipped = thinkTurnResultToPort(
      { status: "skipped", requestId: "r2", continuation: false } as unknown as ThinkTurnResult,
      "r-adapter"
    );
    expect(skipped.status).toBe("completed");
    expect(skipped.message).toBeUndefined();

    const aborted = thinkTurnResultToPort(
      { status: "aborted", requestId: "r3", continuation: false } as unknown as ThinkTurnResult,
      "r-adapter"
    );
    expect(aborted).toMatchObject({ status: "error", error: "aborted" });

    const failed = thinkTurnResultToPort(
      {
        status: "error",
        requestId: "r4",
        continuation: false,
        error: "provider down",
      } as unknown as ThinkTurnResult,
      "r-adapter"
    );
    expect(failed).toMatchObject({ status: "error", error: "provider down" });
  });

  it("unused think config import keeps the mirror honest", () => {
    // If Think 0.19.0's TurnConfig shape drifts, tsc on this file
    // (via the adapter's real-typed calls) fails first; this only
    // pins that the type itself is importable from the package.
    const cfg: ThinkTurnConfig = { maxSteps: 3 };
    expect(cfg.maxSteps).toBe(3);
  });
});

describe("think factory wiring (node-safe: turn is injected, no Think import)", () => {
  const hooks: any = {
    getModel: () => ({ modelId: "test-model" }),
    getSystemPrompt: () => "test system prompt",
    getTools: () => ({}),
    beforeTurn: async () => undefined,
    onChatResponse: async () => {},
    maxSteps: 5,
  };
  const stubStorage = () => {
    const map = new Map<string, unknown>();
    return {
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      delete: async (key: string) => {
        map.delete(key);
      },
      sql: { exec: () => [] as unknown[] },
    };
  };
  const stubScheduler: any = {
    schedule: async () => ({ id: "s1" }),
    scheduleEvery: async () => ({ id: "s2" }),
    listSchedules: async () => [],
    cancelSchedule: async () => true,
  };

  it("think runtime without storage/scheduler/thinkTurn throws", () => {
    expect(() => createActorPorts("think", { hooks })).toThrow();
    expect(() =>
      createActorPorts("think", { hooks, storage: stubStorage(), scheduler: stubScheduler })
    ).toThrow();
  });

  it("think runtime with all three builds a full port around the injected turn", async () => {
    const injected: any = {
      runTurn: async () => ({ status: "completed" }),
    };
    let injectedSession: unknown;
    const port = createActorPorts("think", {
      hooks,
      storage: stubStorage(),
      scheduler: stubScheduler,
      thinkTurn: (session) => {
        injectedSession = session;
        return injected;
      },
    });
    expect(port.state).toBeDefined();
    expect(port.schedule).toBeDefined();
    expect(port.session).toBeDefined();
    expect(port.turn).toBe(injected);
    expect(injectedSession).toBe(port.session);
    await port.session.appendMessages([
      { id: "x", role: "user", parts: [{ type: "text", text: "x" }] },
    ]);
    expect(await port.session.getMessages()).toHaveLength(1);
  });
});
