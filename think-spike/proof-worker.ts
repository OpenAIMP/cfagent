/**
 * Issue #1935 (O3 spike) — workerd proof worker. NOT part of the
 * migration: spike scaffolding only, deleted or moved before any PR.
 *
 * Runs a REAL Think DO (ProofThinkAgent extends PortThink) under
 * wrangler dev and exercises the Think-backed actor port through
 * the same cases as the node conformance suite, plus Think-session
 * observations the node suite cannot make. The worker's fetch
 * handler returns raw evidence as JSON; the assertions live in
 * run-proof.mjs so a failed case prints its evidence, not just a
 * red test name.
 *
 * Case isolation: the port session uses a per-run, per-case
 * prefixed storage backend (wrangler dev persists DO storage
 * across runs). Think's own session cannot be prefixed and is
 * deliberately NOT cleared: on an RPC-only instance clearMessages
 * throws because native RPC bypasses the lifecycle startup that
 * configures this.session (the adapter's turn boots it via
 * lifecycle.ready(); the proof's own clear would need the same
 * boot first). Turn cases therefore assert Think-history deltas
 * (last-N entries, per-id counts), not absolute histories.
 * The schedule case uses the REAL SDK scheduler (alarms 1h out, so
 * nothing fires during the run); the missing-cancel outcome is
 * recorded, not asserted — the real scheduler's missing-id
 * behavior is shared with the cf runtime in production, not a
 * Think-specific semantic.
 */
import {
  PortThink,
  createThinkActorSchedule,
  createThinkActorState,
  createThinkActorSession,
  createThinkActorTurn,
} from "../src/actors/thinkAdapter";
import { ActorSessionStore } from "../src/actors/actorSessionStore";
import type { ActorTurnHooks, UiChatMessage } from "../src/actors/actorPorts";
import type { LanguageModel } from "ai";

function textOf(msg: any): string {
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  return parts
    .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
}

function stubModel(fail: () => boolean): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "stub",
    modelId: "stub-model",
    supportedUrls: {},
    async doGenerate() {
      if (fail()) throw new Error("provider down");
      return {
        content: [{ type: "text", text: "Stub Think reply." }],
        finishReason: "stop",
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
      };
    },
    async doStream() {
      if (fail()) throw new Error("provider down");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", delta: "Stub Think reply." });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          });
          controller.close();
        },
      });
      return { stream };
    },
  } as unknown as LanguageModel;
}

export class ProofThinkAgent extends PortThink {
  failModel = false;
  seen: { beforeTurn: number; responses: any[]; errors: any[] } = {
    beforeTurn: 0,
    responses: [],
    errors: [],
  };
  thinkResponseFired = false;

  hooks: ActorTurnHooks = {
    getModel: () => stubModel(() => this.failModel),
    getSystemPrompt: () => "test system prompt",
    getTools: () => ({}),
    beforeTurn: async () => {
      this.seen.beforeTurn++;
      return { instructions: "test instructions", maxSteps: 3 };
    },
    onChatResponse: async (result) => {
      this.seen.responses.push(result);
    },
    onChatError: (error) => {
      this.seen.errors.push(error);
      return "test error text";
    },
    maxSteps: 5,
  };

  constructor(ctx: any, env: any) {
    super(ctx, env);
    this.portHooks = this.hooks;
  }

  override getModel() {
    return stubModel(() => this.failModel);
  }

  override getSystemPrompt() {
    return "test system prompt";
  }

  override getTools() {
    return {};
  }

  override async onChatResponse(result: any) {
    this.thinkResponseFired = true;
    return super.onChatResponse(result);
  }

  // Scheduler callbacks must exist as methods: the real SDK
  // scheduler rejects unknown callback names at schedule time
  // (the node conformance stub merely records them).
  async tick() {}
  async hourly() {}

  /**
   * Cold-turn probe on a brand-new DO instance (run-unique name,
   * so truly cold): the FIRST rpc to this instance is a turn —
   * no schedule case first, no warmup. This is the case that
   * FAILED before the adapter booted the lifecycle (turn threw
   * "reading 'appendMessage'", this.session undefined forever —
   * native RPC bypasses the lifecycle startup that fetch/alarm/
   * WebSocket entry points run automatically, so onStart never
   * ran at all; no amount of waiting helped). The adapter now
   * calls lifecycle.start() at the start of every turn, so this
   * probe must pass on a fresh instance. The probe ALSO calls
   * start() explicitly first and reports the outcome — isolating
   * whether start() itself boots the session (mechanism) from
   * whether the adapter's boot ran (bundle/placement). (An
   * earlier probe revision called lifecycle.ready() — which does
   * NOT exist on the Agent's lifecycle object, so the guarded
   * call silently no-opped and the cold case kept failing. ready()
   * lives only on the Scheduler's capability services object.)
   */
  async runColdTurn(runId: string): Promise<Record<string, unknown>> {
    this.seen = { beforeTurn: 0, responses: [], errors: [] };
    this.thinkResponseFired = false;
    this.failModel = false;
    const lc = (this as any).lifecycle;
    const lcPresent = lc !== undefined;
    const startType = typeof lc?.start;
    let startOutcome = "skipped";
    try {
      await lc?.start?.();
      startOutcome = "resolved";
    } catch (e) {
      startOutcome = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    const sessionAfterStart = (this as any).session !== undefined;
    const rawStorage: any = (this as any).ctx.storage;
    const backend = {
      get: (k: string) => rawStorage.get(`proof:${runId}:turn-cold:` + k),
      put: (k: string, v: unknown) => rawStorage.put(`proof:${runId}:turn-cold:` + k, v),
      delete: (k: string) => rawStorage.delete(`proof:${runId}:turn-cold:` + k),
    };
    const session = new ActorSessionStore(backend);
    const turn = createThinkActorTurn(this, this.hooks, session);
    try {
      const result = await turn.runTurn("hello");
      const portMsgs = (await session.getMessages()).map((m) => ({
        role: m.role,
        text: textOf(m as any),
      }));
      let thinkTail: unknown = null;
      try {
        const h = (await (this as any).session.getHistory()) as any[];
        thinkTail = h.slice(-2).map((m) => ({ role: m.role, text: textOf(m) }));
      } catch (e) {
        thinkTail = `history read failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      return {
        case: "turn-cold",
        lcPresent,
        startType,
        startOutcome,
        sessionAfterStart,
        sessionAfterTurn: (this as any).session !== undefined,
        threw: false,
        status: result.status,
        messageText: result.message ? textOf(result.message) : null,
        beforeTurn: this.seen.beforeTurn,
        responses: this.seen.responses.length,
        portMessages: portMsgs,
        thinkTail,
      };
    } catch (e) {
      return {
        case: "turn-cold",
        lcPresent,
        startType,
        startOutcome,
        sessionAfterStart,
        sessionAfterTurn: (this as any).session !== undefined,
        threw: true,
        thrownMessage: e instanceof Error ? e.message : String(e),
        beforeTurn: this.seen.beforeTurn,
        responses: this.seen.responses.length,
        errors: this.seen.errors.map((x) => (x instanceof Error ? x.message : String(x))),
      };
    }
  }

  async runProofCase(caseName: string, runId: string): Promise<Record<string, unknown>> {
    this.seen = { beforeTurn: 0, responses: [], errors: [] };
    this.thinkResponseFired = false;
    this.failModel = false;
    // NOTE: no clearMessages() here, deliberately. On a cold DO,
    // _clearHistory reads this.session.clearMessages while
    // this.session is still undefined (onStart hasn't configured
    // it yet), so early clears throw — and in wrangler dev that
    // window lasted 60s+ (a 60s warmup poll never succeeded, yet
    // later cases cleared fine). Turns never need a clear, so
    // the proof asserts Think-history DELTAS (last-N entries,
    // per-id counts) instead of absolute histories: equally
    // rigorous, immune to the cold-start race and to wrangler
    // dev's persisted storage across runs.
    const rawStorage: any = (this as any).ctx.storage;
    // Run-unique prefix: wrangler dev persists DO storage across
    // runs, so a case-only prefix would accumulate leftovers.
    const prefix = `proof:${runId}:${caseName}:`;
    const backend = {
      get: (k: string) => rawStorage.get(prefix + k),
      put: (k: string, v: unknown) => rawStorage.put(prefix + k, v),
      delete: (k: string) => rawStorage.delete(prefix + k),
    };
    const session = new ActorSessionStore(backend);
    const port = {
      state: createThinkActorState(rawStorage),
      schedule: createThinkActorSchedule(this as any),
      session,
      turn: createThinkActorTurn(this, this.hooks, session),
    };
    const thinkHistory = async () => {
      try {
        const h = await (this as any).session.getHistory();
        return (h as any[]).map((m) => ({ id: m.id ?? null, role: m.role, text: textOf(m) }));
      } catch (e) {
        return [{ id: null, role: "error", text: e instanceof Error ? e.message : String(e) }];
      }
    };
    const portMessages = async () => {
      const msgs = await session.getMessages();
      return msgs.map((m) => ({ role: m.role, text: textOf(m as any) }));
    };
    const base = { case: caseName };

    if (caseName === "state") {
      const key = `proof:${caseName}:k`;
      await port.state.put(key, "v1");
      const got = await port.state.get(key);
      await port.state.delete(key);
      const afterDelete = await port.state.get(key);
      port.state.sql("CREATE TABLE IF NOT EXISTS proof_state (k TEXT PRIMARY KEY, v TEXT)");
      port.state.sql("DELETE FROM proof_state");
      port.state.sql("INSERT INTO proof_state (k, v) VALUES ('a', 'b')");
      const rows = [...port.state.sql("SELECT k, v FROM proof_state")];
      return { ...base, putGet: got, afterDelete: afterDelete ?? null, sqlRows: rows };
    }

    if (caseName === "schedule") {
      const s1: any = await port.schedule.schedule(new Date(Date.now() + 3600000), "tick", {});
      const s2: any = await port.schedule.scheduleEvery(3600, "hourly", {});
      const list1: any[] = await port.schedule.listSchedules();
      const cancelOwn = await port.schedule.cancelSchedule(s1?.id ?? s1);
      let missingCancel: unknown;
      try {
        missingCancel = await port.schedule.cancelSchedule("missing");
      } catch (e) {
        missingCancel = `threw: ${e instanceof Error ? e.message : String(e)}`;
      }
      const list2: any[] = await port.schedule.listSchedules();
      const ids = (list: any[]) => list.map((s) => s?.id ?? s);
      return {
        ...base,
        scheduledIds: [s1?.id ?? s1, s2?.id ?? s2],
        listBeforeCancel: ids(list1),
        cancelOwn,
        missingCancel,
        listAfterCancel: ids(list2),
      };
    }

    if (caseName === "session") {
      await session.appendMessages([
        { id: "m1", role: "user", parts: [{ type: "text", text: "one" }] },
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "two" }] },
      ]);
      const ordered = await portMessages();
      await session.appendMessages([
        { id: "m1", role: "user", parts: [{ type: "text", text: "one-updated" }] },
      ]);
      const afterUpsert = await portMessages();
      await session.deleteMessages(["m1"]);
      const afterDelete = await portMessages();
      await session.clear();
      const afterClear = await portMessages();
      await session.migrateLegacyRows([
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
      const legacy = await session.getMessages();
      return {
        ...base,
        ordered,
        afterUpsert,
        afterDelete,
        afterClear,
        legacy: legacy.map((m) => ({
          id: m.id,
          role: m.role,
          createdAt: m.createdAt ?? null,
          metadata: m.metadata ?? null,
        })),
      };
    }

    if (caseName === "turn-string") {
      const thinkBefore = await thinkHistory();
      const result = await port.turn.runTurn("hello");
      return {
        ...base,
        status: result.status,
        messageRole: result.message?.role ?? null,
        messageText: result.message ? textOf(result.message) : null,
        beforeTurn: this.seen.beforeTurn,
        responses: this.seen.responses.length,
        thinkResponseFired: this.thinkResponseFired,
        portMessages: await portMessages(),
        thinkBeforeLength: thinkBefore.length,
        thinkHistory: await thinkHistory(),
      };
    }

    if (caseName === "turn-factory") {
      await session.appendMessages([
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]);
      const result = await port.turn.runTurn((current: UiChatMessage[]) => current);
      const portMsgs = await portMessages();
      const thinkHist = await thinkHistory();
      return {
        ...base,
        status: result.status,
        beforeTurn: this.seen.beforeTurn,
        responses: this.seen.responses.length,
        thinkResponseFired: this.thinkResponseFired,
        portUserCount: portMsgs.filter((m) => m.role === "user").length,
        portMessages: portMsgs,
        thinkUserCount: thinkHist.filter((m) => m.role === "user").length,
        thinkHistory: thinkHist,
      };
    }

    if (caseName === "turn-configOverride") {
      const thinkBefore = await thinkHistory();
      const result = await port.turn.runTurn({
        configOverride: { instructions: "override", maxSteps: 1 },
      });
      const portMsgs = await portMessages();
      const thinkHist = await thinkHistory();
      return {
        ...base,
        status: result.status,
        beforeTurn: this.seen.beforeTurn,
        responses: this.seen.responses.length,
        thinkResponseFired: this.thinkResponseFired,
        portMessages: portMsgs,
        thinkBeforeLength: thinkBefore.length,
        thinkHistory: thinkHist,
      };
    }

    if (caseName === "turn-configOverride-nonempty") {
      await session.appendMessages([
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ]);
      const result = await port.turn.runTurn({
        configOverride: { instructions: "override", maxSteps: 1 },
      });
      const portMsgs = await portMessages();
      const thinkHist = await thinkHistory();
      return {
        ...base,
        status: result.status,
        beforeTurn: this.seen.beforeTurn,
        responses: this.seen.responses.length,
        thinkResponseFired: this.thinkResponseFired,
        portMessages: portMsgs,
        thinkUserCount: thinkHist.filter((m) => m.role === "user").length,
        thinkHistory: thinkHist,
      };
    }

    if (caseName === "turn-failure") {
      this.failModel = true;
      let threw = false;
      let thrownMessage: string | null = null;
      try {
        await port.turn.runTurn("hello");
      } catch (e) {
        threw = true;
        thrownMessage = e instanceof Error ? e.message : String(e);
      } finally {
        this.failModel = false;
      }
      return {
        ...base,
        threw,
        thrownMessage,
        errors: this.seen.errors.map((e) => (e instanceof Error ? e.message : String(e))),
        responses: this.seen.responses.length,
        adapterErrorReported: this.adapterTurnErrorReported,
        thinkResponseFired: this.thinkResponseFired,
        thinkHistory: await thinkHistory(),
      };
    }

    return { ...base, error: `unknown case ${caseName}` };
  }
}

const CASES = [
  "state",
  "schedule",
  "session",
  "turn-string",
  "turn-factory",
  "turn-configOverride",
  "turn-configOverride-nonempty",
  "turn-failure",
];

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/proof") {
      const stub = env.PROOF_THINK_AGENT.get(env.PROOF_THINK_AGENT.idFromName("proof"));
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const results: Record<string, unknown>[] = [];
      for (const c of CASES) {
        try {
          results.push(await stub.runProofCase(c, runId));
        } catch (e) {
          results.push({ case: c, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return Response.json({ cases: results });
    }
    if (url.pathname === "/proof-cold") {
      const runId = `cold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const stub = env.PROOF_THINK_AGENT.get(env.PROOF_THINK_AGENT.idFromName(runId));
      try {
        return Response.json(await stub.runColdTurn(runId));
      } catch (e) {
        return Response.json({
          case: "turn-cold",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return new Response("ok");
  },
};
