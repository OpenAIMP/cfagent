/**
 * Issue #359-06: memory + reset routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move — no behavior change.
 *
 * Owns the Persistent Memory facts endpoint (GET /memory, DELETE /memory)
 * and the session reset endpoint (POST|DELETE|GET /clear or /reset). The two
 * blocks were contiguous in routeRequest (between the autopilot handler and
 * the referrals+ads handler), so this module exports ONE handler invoked from
 * routeRequest at the EXACT position the original blocks occupied in the
 * sequential path.endsWith matching sequence. It returns a Response when one
 * of its paths matches, or null when none does — matching order relative to
 * all other handlers is preserved by the call site.
 *
 * The reset endpoints are destructive and their guards/confirmations are
 * preserved byte-for-byte in behavior: the ?purge=false opt-out, the
 * abortAllRequests reason string, and the audit event names
 * (memory.deleted / memory.cleared / history.purged / history.cleared).
 * Session-state teardown stays delegated to the orchestrator via the
 * context — this module never touches OrchestratorAgent internals.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them via
 * the explicit MemoryResetRouteContext parameter; there are no new globals
 * and no back-references into the class.
 */

import type { AgentName } from "../../types";
import type { SqlStorage } from "../../orm";
import type { MemoryRecord } from "../../types";

/** The subset of OrchestratorAgent surface the memory/reset handlers need. */
export interface MemoryResetRouteContext {
  ensureTables(): SqlStorage;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** Aborts all in-flight requests with the given reason (owner: OrchestratorAgent). */
  abortAllRequests(reason: string): void;
  /** Resets per-turn state (owner: OrchestratorAgent). */
  resetTurnState(): void;
  /**
   * Clears the in-memory chat transcript and persists the empty state
   * (owner: OrchestratorAgent — was `this.messages = []; await this.persistMessages([])`).
   */
  clearConversationMessages(): Promise<void>;
}

/**
 * Handles the memory + reset routes. Returns a Response on match, null when
 * no memory/reset path matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handleMemoryResetRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: MemoryResetRouteContext
): Promise<Response | null> {
  // Persistent Memory facts endpoint
  if (path.endsWith("/memory")) {
    if (request.method === "GET") {
      try {
        const sql = ctx.ensureTables();
        const rawMemories = Array.from(
          sql.exec("SELECT key, value, updated_at FROM mas_memory ORDER BY updated_at DESC LIMIT 100")
        ) as Array<{ key: string; value: string; updated_at: string }>;
        const memories: MemoryRecord[] = rawMemories.map((m) => ({
          key: String(m.key),
          value: String(m.value),
          updatedAt: String(m.updated_at),
        }));
        return Response.json({ count: memories.length, memories });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch memories" }, { status: 500 });
      }
    }

    if (request.method === "DELETE") {
      try {
        const sql = ctx.ensureTables();
        const key = url.searchParams.get("key");
        if (key) {
          sql.exec("DELETE FROM mas_memory WHERE key = ?", key);
          ctx.audit("memory.deleted", "memory", { key });
        } else {
          sql.exec("DELETE FROM mas_memory");
          ctx.audit("memory.cleared", "memory", {});
        }
        return Response.json({ success: true });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete memory" }, { status: 500 });
      }
    }
  }

  // Clear active conversation transcript and reset session state
  if ((path.endsWith("/clear") || path.endsWith("/reset")) && (request.method === "POST" || request.method === "DELETE" || request.method === "GET")) {
    try {
      const sql = ctx.ensureTables();
      ctx.abortAllRequests("Session reset requested by user");
      ctx.resetTurnState();
      await ctx.clearConversationMessages();
      const purge = url.searchParams.get("purge") !== "false";
      if (purge) {
        sql.exec("DELETE FROM mas_messages WHERE session_id = ?", sessionId);
        ctx.audit("history.purged", "orchestrator", {});
      } else {
        ctx.audit("history.cleared", "orchestrator", {});
      }
      return Response.json({
        success: true,
        message: purge ? "All chat transcripts and session state purged from SQLite" : "Active chat cleared; historical analytics vault preserved in SQLite",
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to clear history" }, { status: 500 });
    }
  }

  return null;
}
