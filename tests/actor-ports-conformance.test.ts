/**
 * Issue #1738 — actor port conformance suite.
 *
 * The same contract, run unchanged against both runtimes: the
 * Cloudflare adapter (bound to stub storage/scheduler shapes, the
 * way production binds a live Agent) and the in-memory adapter.
 * A second adapter passing the same suite is the independence proof
 * for the port: swapping runtimes never touches actor domain code.
 */
import { describe, it, expect } from "vitest";
import { createActorPorts, type ActorRuntime } from "../src/actors/createActorPorts";
import {
  createCfActorSchedule,
  createCfActorSession,
  createCfActorState,
  createCfActorTurn,
} from "../src/actors/cfAgentsAdapter";
import {
  createInMemoryActorSchedule,
  createInMemoryActorSession,
  createInMemoryActorState,
  createInMemoryActorTurn,
} from "../src/actors/inMemoryActorAdapter";
import type {
  ActorPort,
  ActorTurnHooks,
  ChatResponseResult,
  TurnConfig,
  UiChatMessage,
} from "../src/actors/actorPorts";

function stubStorage() {
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
}

function stubScheduler() {
  const rows: Array<{ id: string; callback: string; payload?: unknown }> = [];
  let seq = 0;
  return {
    schedule: async (when: unknown, callback: string, payload?: unknown) => {
      const row = { id: `s-${++seq}`, callback, payload };
      void when;
      rows.push(row);
      return row;
    },
    scheduleEvery: async (intervalSeconds: number, callback: string, payload?: unknown) => {
      const row = { id: `s-${++seq}`, callback, payload };
      void intervalSeconds;
      rows.push(row);
      return row;
    },
    listSchedules: async () => [...rows],
    cancelSchedule: async (id: string) => {
      const at = rows.findIndex((r) => r.id === id);
      if (at < 0) return false;
      rows.splice(at, 1);
      return true;
    },
    getScheduleById: async (id: string) => rows.find((r) => r.id === id),
  };
}

function makeHooks(opts?: {
  beforeTurn?: (ctx: unknown) => Promise<TurnConfig | void>;
  onModelThrow?: boolean;
}): { hooks: ActorTurnHooks; seen: { beforeTurn: number; responses: ChatResponseResult[]; errors: unknown[] } } {
  const seen = { beforeTurn: 0, responses: [] as ChatResponseResult[], errors: [] as unknown[] };
  const hooks: ActorTurnHooks = {
    getModel: () => ({ modelId: "test-model" }),
    getSystemPrompt: () => "test system prompt",
    getTools: () => ({}),
    beforeTurn: async (ctx) => {
      seen.beforeTurn++;
      if (opts?.beforeTurn) return opts.beforeTurn(ctx);
      return { instructions: "test instructions", maxSteps: 3 };
    },
    onChatResponse: async (result) => {
      seen.responses.push(result);
    },
    onChatError: (err) => {
      seen.errors.push(err);
      return "test error text";
    },
    maxSteps: 5,
  };
  return { hooks, seen };
}

function buildPort(runtime: ActorRuntime): ActorPort {
  if (runtime === "in-memory") {
    const session = createInMemoryActorSession();
    const { hooks } = makeHooks();
    return {
      state: createInMemoryActorState(),
      schedule: createInMemoryActorSchedule(),
      session,
      turn: createInMemoryActorTurn(hooks, session),
    };
  }
  const storage = stubStorage();
  const session = createCfActorSession(storage);
  const { hooks } = makeHooks();
  return {
    state: createCfActorState(storage),
    schedule: createCfActorSchedule(stubScheduler()),
    session,
    turn: createCfActorTurn(hooks, session, async () => ({ text: "Stub assistant reply." })),
  };
}

const RUNTIMES: ActorRuntime[] = ["cf", "in-memory"];

describe("actor port conformance (#1738)", () => {
  for (const runtime of RUNTIMES) {
    describe(`runtime: ${runtime}`, () => {
      it("state: put/get/delete round-trip", async () => {
        const port = buildPort(runtime);
        await port.state.put("k1", { v: 1 });
        expect(await port.state.get("k1")).toEqual({ v: 1 });
        await port.state.delete("k1");
        expect(await port.state.get("k1")).toBeUndefined();
      });

      it("schedule: record, list, cancel", async () => {
        const port = buildPort(runtime);
        const created: any = await port.schedule.schedule(Date.now() + 1000, "tick", { a: 1 });
        await port.schedule.scheduleEvery(60, "hourly");
        const rows = (await port.schedule.listSchedules()) as Array<{ id: string; callback: string }>;
        expect(rows.map((r) => r.callback)).toEqual(["tick", "hourly"]);
        expect(await port.schedule.cancelSchedule(created.id)).toBe(true);
        expect(await port.schedule.cancelSchedule("missing")).toBe(false);
        expect((await port.schedule.listSchedules()).map((r: any) => r.callback)).toEqual(["hourly"]);
      });

      it("session: append/get preserve order", async () => {
        const port = buildPort(runtime);
        const m1: UiChatMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] };
        const m2: UiChatMessage = { id: "m2", role: "assistant", parts: [{ type: "text", text: "hello" }] };
        await port.session.appendMessages([m1, m2]);
        expect(await port.session.getMessages()).toEqual([m1, m2]);
      });

      it("session: upsert-by-id lands only the delta", async () => {
        const port = buildPort(runtime);
        const m1: UiChatMessage = { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] };
        await port.session.appendMessages([m1]);
        await port.session.appendMessages([m1, { ...m1, parts: [{ type: "text", text: "hi!" }] }]);
        const msgs = await port.session.getMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].parts).toEqual([{ type: "text", text: "hi!" }]);
      });

      it("session: deleteMessages removes by id, keeps order", async () => {
        const port = buildPort(runtime);
        const mk = (id: string): UiChatMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });
        await port.session.appendMessages([mk("a"), mk("b"), mk("c")]);
        await port.session.deleteMessages(["b"]);
        expect((await port.session.getMessages()).map((m) => m.id)).toEqual(["a", "c"]);
      });

      it("session: legacy rows transform mechanically", async () => {
        const port = buildPort(runtime);
        await port.session.migrateLegacyRows([
          {
            id: "row-1",
            message: JSON.stringify({
              id: "msg-1",
              role: "user",
              parts: [{ type: "text", text: "Show me NVDA calls" }],
            }),
            created_at: "2026-10-01T12:00:00.000Z",
          },
          {
            id: "row-2",
            message: JSON.stringify({
              id: "msg-2",
              role: "assistant",
              parts: [{ type: "text", text: "Running." }],
              metadata: { agent: "search" },
            }),
            created_at: "2026-10-01T12:00:05.000Z",
          },
        ]);
        const msgs = await port.session.getMessages();
        expect(msgs[0]).toMatchObject({ id: "msg-1", role: "user", createdAt: "2026-10-01T12:00:00.000Z" });
        expect(msgs[1].metadata).toEqual({ agent: "search" });
      });

      it("session: clear empties the transcript", async () => {
        const port = buildPort(runtime);
        await port.session.appendMessages([{ id: "x", role: "user", parts: [{ type: "text", text: "x" }] }]);
        await port.session.clear();
        expect(await port.session.getMessages()).toEqual([]);
      });

      it("turn: string input drives beforeTurn -> reply -> onChatResponse", async () => {
        const session =
          runtime === "in-memory" ? createInMemoryActorSession() : createCfActorSession(stubStorage());
        const { hooks, seen } = makeHooks();
        const turn =
          runtime === "in-memory"
            ? createInMemoryActorTurn(hooks, session)
            : createCfActorTurn(hooks, session, async () => ({ text: "Stub assistant reply." }));
        const result = await turn.runTurn("hello");
        expect(result.status).toBe("completed");
        expect(result.message?.role).toBe("assistant");
        expect(seen.beforeTurn).toBe(1);
        expect(seen.responses).toHaveLength(1);
        const msgs = await session.getMessages();
        expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
      });

      it("turn: factory returning current history is a no-op delta", async () => {
        const session =
          runtime === "in-memory" ? createInMemoryActorSession() : createCfActorSession(stubStorage());
        const { hooks } = makeHooks();
        const turn =
          runtime === "in-memory"
            ? createInMemoryActorTurn(hooks, session)
            : createCfActorTurn(hooks, session, async () => ({ text: "Stub assistant reply." }));
        await session.appendMessages([{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
        await turn.runTurn((current) => current);
        const msgs = await session.getMessages();
        expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
      });

      it("turn: configOverride skips beforeTurn", async () => {
        const session =
          runtime === "in-memory" ? createInMemoryActorSession() : createCfActorSession(stubStorage());
        const { hooks, seen } = makeHooks();
        const turn =
          runtime === "in-memory"
            ? createInMemoryActorTurn(hooks, session)
            : createCfActorTurn(hooks, session, async () => ({ text: "Stub assistant reply." }));
        await turn.runTurn({ configOverride: { instructions: "override", maxSteps: 1 } });
        expect(seen.beforeTurn).toBe(0);
        expect(seen.responses).toHaveLength(1);
      });

      it("turn: model failure calls onChatError and rethrows", async () => {
        const session =
          runtime === "in-memory" ? createInMemoryActorSession() : createCfActorSession(stubStorage());
        const { hooks, seen } = makeHooks();
        const { AgentChatTurnRunner } = await import("../src/actors/actorTurnRunner");
        const runner = new AgentChatTurnRunner({
          hooks,
          session,
          modelTurn: async () => {
            throw new Error("provider down");
          },
        });
        await expect(runner.runTurn("hello")).rejects.toThrow("provider down");
        expect(seen.errors).toHaveLength(1);
        expect(seen.responses).toHaveLength(0);
      });
    });
  }

  it("factory: cf runtime without storage/scheduler throws", () => {
    const { hooks } = makeHooks();
    expect(() => createActorPorts("cf", { hooks })).toThrow();
  });

  it("factory: in-memory runtime builds a full port", () => {
    const { hooks } = makeHooks();
    const port = createActorPorts("in-memory", { hooks });
    expect(port.state).toBeDefined();
    expect(port.schedule).toBeDefined();
    expect(port.session).toBeDefined();
    expect(port.turn).toBeDefined();
  });
});
