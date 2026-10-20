/**
 * Issue #658 (Think migration step 2) — parity harness fixture.
 *
 * A Think subclass wiring the orchestrator's real pieces the way the
 * step-1 spike (#646) proved they compose:
 *  - getModel(): the CONSTRUCTED arm — getWorkersAIModel(this.env),
 *    preserving today's exact provider construction (the string arm
 *    would reroute through Think's bundled provider / AI Gateway).
 *  - getTools(): createAgentMcpTools — the factory the manual loop
 *    actually calls per turn (spike correction: not createMAS).
 *  - maxSteps: Think's first-class bound, resolved by the same clamp
 *    expression the manual loop applies to MAS_MAX_STEPS today.
 *
 * Test fixture only: never exported from src/server.ts, never bound
 * in wrangler, never routed. The parity test mocks the Think base
 * class (the api_chat_route.test.ts idiom), so this file's own
 * methods run for real while framework internals are stubbed.
 */
import { Think } from "@cloudflare/think";
import type { ToolSet } from "ai";
import { createAgentMcpTools } from "../src/agents/mcpAdapter";
import type { McpToolContext } from "../src/patterns/interfaces";
import { getWorkersAIModel } from "../src/agents/model";
import type { Env } from "../src/types";

/**
 * The manual loop's step clamp, verbatim
 * (src/agents/orchestrator.ts: Math.max(1, Math.min(10,
 * Number(this.env.MAS_MAX_STEPS || 6)))). Extracted here as a pure
 * function so both sides of the parity claim use the same expression;
 * production extraction is step-3 work.
 */
export function resolveMasMaxSteps(env: Partial<Env>): number {
  return Math.max(1, Math.min(10, Number(env.MAS_MAX_STEPS || 6)));
}

/** Stub context for tool-set construction/enumeration (execute paths
 * are never invoked by the parity tests). */
export function stubMcpContext(env: Partial<Env>): McpToolContext {
  return {
    env: env as Env,
    orm: {} as McpToolContext["orm"],
    sessionId: "think-parity",
    requestId: "think-parity",
    audit: () => {},
  };
}

export class ThinkOrchestratorHarness extends Think<Env> {
  constructor(ctx: unknown, env: Env) {
    super(ctx as never, env);
    this.maxSteps = resolveMasMaxSteps(env);
  }

  getModel() {
    return getWorkersAIModel(this.env);
  }

  getSystemPrompt(): string {
    return "Think orchestrator parity harness (issue #658). Not a production prompt.";
  }

  getTools(): ToolSet {
    return createAgentMcpTools(stubMcpContext(this.env));
  }
}

/**
 * Issue #658 R3 — legacy session-row transform prototype.
 *
 * A legacy `cf_ai_chat_agent_messages` row stores a whole AI SDK
 * UIMessage as JSON in `message`. The agents SDK's SessionMessage is
 * documented as structurally UIMessage-compatible, so the migration
 * transform is an envelope mapping: id/role/parts/metadata carried
 * through, createdAt taken from the row. Pure and fixture-tested;
 * the production one-time migration is step-4 work.
 */
export interface LegacyChatRow {
  id: string;
  message: string;
  created_at: string;
}

export interface SessionMessageShape {
  id: string;
  role: string;
  parts: unknown[];
  metadata?: unknown;
  createdAt?: string;
}

export function legacyRowToSessionMessage(row: LegacyChatRow): SessionMessageShape {
  const msg = JSON.parse(row.message) as {
    id?: string;
    role: string;
    parts?: unknown[];
    metadata?: unknown;
  };
  const out: SessionMessageShape = {
    id: msg.id ?? row.id,
    role: msg.role,
    parts: msg.parts ?? [],
    createdAt: row.created_at,
  };
  if (msg.metadata !== undefined) out.metadata = msg.metadata;
  return out;
}
