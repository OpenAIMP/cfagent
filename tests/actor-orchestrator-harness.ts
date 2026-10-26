/**
 * Issue #1738 — actor parity harness fixture (successor to the #658
 * Think parity harness, same pieces re-pointed at the Agents SDK).
 *
 * An Agent subclass wiring the orchestrator's real pieces the way the
 * step-1 spike (#646) proved they compose:
 *  - getModel(): the CONSTRUCTED arm — getWorkersAIModel(this.env),
 *    preserving today's exact provider construction (the string arm
 *    would reroute through the SDK's bundled provider / AI Gateway).
 *  - getTools(): createAgentMcpTools — the factory the manual loop
 *    actually calls per turn (spike correction: not createMAS).
 *  - maxSteps: the orchestrator's own step bound (the SDK Agent
 *    class does NOT carry one — that is why the actor port's
 *    TurnConfig carries it), resolved by the same clamp expression
 *    the manual loop applies to MAS_MAX_STEPS today.
 *
 * Test fixture only: never exported from src/server.ts, never bound
 * in wrangler, never routed. The parity test mocks the agents base
 * class (the api_chat_route.test.ts idiom), so this file's own
 * methods run for real while framework internals are stubbed.
 */
import { Agent } from "agents";
import type { ToolSet } from "ai";
import { createAgentMcpTools } from "../src/agents/mcpAdapter";
import type { McpToolContext } from "../src/patterns/interfaces";
import { getWorkersAIModel } from "../src/agents/model";
import type { Env } from "../src/types";

/**
 * The manual loop's step clamp — since step 3a (#668) this is the
 * production resolver from src/agents/chatPrompt.ts, imported here
 * (and re-exported for the parity suite) so the harness keeps
 * guarding the real expression.
 */
import { resolveMasMaxSteps } from "../src/agents/chatPrompt";
export { resolveMasMaxSteps };

/** Stub context for tool-set construction/enumeration (execute paths
 * are never invoked by the parity tests). */
export function stubMcpContext(env: Partial<Env>): McpToolContext {
  return {
    env: env as Env,
    orm: {} as McpToolContext["orm"],
    sessionId: "actor-parity",
    requestId: "actor-parity",
    audit: () => {},
  };
}

export class ActorOrchestratorHarness extends Agent<Env> {
  /** The orchestrator's own step bound (see the header note). */
  maxSteps: number;

  constructor(ctx: unknown, env: Env) {
    super(ctx as never, env);
    this.maxSteps = resolveMasMaxSteps(env);
  }

  getModel() {
    return getWorkersAIModel(this.env);
  }

  getSystemPrompt(): string {
    return "Actor orchestrator parity harness (issue #1738). Not a production prompt.";
  }

  getTools(): ToolSet {
    return createAgentMcpTools(stubMcpContext(this.env));
  }
}

/**
 * Issue #1738 R3 — the legacy session-row transform now lives in
 * production code (src/actors/actorPorts.ts, legacyRowToSessionMessage),
 * where the actor session store's migrateLegacyRows uses it. This
 * harness no longer carries its own copy; the parity suite imports
 * the production function. The transform itself is unchanged: a
 * legacy `cf_ai_chat_agent_messages` row stores a whole AI SDK
 * UIMessage as JSON in `message`, and the mapping is an envelope
 * mapping (id/role/parts/metadata through, createdAt from the row).
 */
