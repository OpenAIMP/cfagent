/**
 * #1722 (parent #1717, slice (b)): ONE runtime config switch for the
 * NLQ port contract — the PAYMENTS_FLOW_MODE (#1711) / ads-revenue
 * (#1721) pattern applied to this domain.
 *
 * Switch (Worker env var, non-secret, owner-set; this slice sets NO
 * production value — production values are an owner action):
 *   NLQ_MODE
 * Values: "rest" | "mcp" (case-insensitive, surrounding whitespace
 * ignored). Built-in default: "rest" — the REST-sync public route
 * behavior, recorded explicitly so the owner can overturn it later.
 * (The async-job contract is the other "public route" spelling; it is
 * NOT the default. The slice names "rest" rather than assuming.)
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in ("rest").
 * Carriers: run = the per-request / per-call `mode` field (REST body
 * `mode`, MCP input `mode`, async-job payload `mode`); session / user
 * = the optional `scopedNlqModes` carrier on the execution context
 * (McpToolContext.scopedNlqModes / route ctx scopedNlqModes / async
 * job payload scopedNlqModes, populated by the execution-context
 * owner or job submitter); global env = the Worker env var NLQ_MODE.
 * A blank/unset level falls through to the next level. The FIRST
 * non-blank level wins; if that value is unrecognized, the resolution
 * FAILS CLOSED to "rest" (invalid=true, level = the winning level)
 * and does NOT fall through to a lower level that might say "mcp".
 * Callers must log + audit `nlq.config_error` on invalid.
 *
 * What the switch governs (port/validation contract ONLY):
 * - "rest": the full-function execution (executeNaturalLanguageQuery)
 *   with the calling context's bound ports. REST route: scheduling,
 *   scan/profile stores, discovery + fit runners, social brief
 *   (trusted only — see the withholding rule below); async job
 *   nlq.execute: scheduling, stock screen (ScreenerAgent, maxItems 10),
 *   discovery + fit runners, stores (the async context binds NO
 *   social port, in either mode); MCP contexts bind no ports, so
 *   rest = the full function with no options — which RESTORES the LLM
 *   validation + planSource patch the legacy facade path skipped.
 * - "mcp": each surface's own legacy execution, verbatim. REST route
 *   and async job drop to the MCP-direct shape (full function, NO
 *   options: no ports, no stores, no runners). The MCP facade path
 *   keeps planNLQ + executeNLQQueryAsync (no validation patch). The
 *   MCP direct path keeps the full function with no options (its
 *   legacy already) — the switch is a no-op there except for
 *   config_error auditing on invalid values.
 *
 * Pinned port matrix (scan appendix (b) N01), both modes:
 * | context      | rest mode                              | mcp mode                 |
 * | REST /nlq    | sched YES, stock NO→listings fallback, | all ports NO, stores NO, |
 * |              | social YES (trusted only), disc YES,   | runners NO, LLM fn YES  |
 * |              | stores YES, LLM fn YES                 | (full fn, no options)  |
 * | async job    | sched YES, stock YES, social NO,       | all ports NO, stores NO, |
 * |              | disc YES, stores YES, LLM fn YES       | runners NO, LLM fn YES  |
 * | MCP facade   | ports NO, stores NO, runners NO,       | plan+async, NO validation|
 * |              | LLM fn YES (validation restored)       | patch (legacy verbatim) |
 * | MCP direct   | ports NO, stores NO, runners NO,       | identical (legacy verbatim)|
 * |              | LLM fn YES                             |                          |
 * Discovery/fit without runners (verified on current main, closing
 * the scan's untraced item; issue #1918 unified the two actions):
 * the unified options_fit_discovery action's scope leg without a
 * discovery runner → "Discovery isn't wired in this context.";
 * its fit leg without a fit runner → "Fit discovery isn't
 * available in this context — the Name↔Strategy discovery
 * runner (Phase 2 of epic #1096) is not wired here."
 * (src/agents/nlqOptionsStrategy.ts). Scheduling without a port:
 * "Scheduling (…) unavailable: no live agent scheduling port … NOT
 * executed". Social without a port: "Social brief: this action
 * requires the asynchronous NLQ executor with a live social brief
 * port. Nothing was stored."
 *
 * What the switch does NOT govern (ENFORCEMENT, never opt-out):
 * - The REST x-user-login gate (401 without it) stands in BOTH modes.
 * - Webhook social-port withholding stands in BOTH modes: a request
 *   with x-nlq-source: webhook gets NO social brief port, whatever
 *   the resolved mode and whatever the run/session/user/env levels
 *   say. The header can only REMOVE the port, never grant it, and no
 *   switch value re-grants it — a design that let a webhook caller
 *   re-enable its own withheld port would be a defect. Scheduling and
 *   discovery are NOT withheld on the webhook path, in either mode.
 * - Identity is not switched: REST keeps x-user-login, MCP keeps
 *   sessionId, async keeps payload userLogin / session key.
 * - Transport envelopes stay per surface (REST sync result, MCP
 *   async-job receipt, job result). Chat-error fallback is untouched:
 *   it is a degraded error path, not an intentional NLQ execution,
 *   and must not depend on a caller-settable mode.
 *
 * Both code paths are preserved as branches at the call sites (never
 * deleted): "rest" branches reproduce the pre-#1722 surface code
 * verbatim, "mcp" branches reproduce the pre-#1722 MCP-direct /
 * facade code verbatim.
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in resolution
 * order and unit-pinned, but in production today only run
 * (per-request `mode`) and global env are settable; an admin-owned
 * persisted settings surface is a follow-up, not smuggled in via the
 * memory store (whose keys any MCP caller can write — an unsafe home
 * for a switch, per the #1721 boundary note). The async-job
 * session/user carrier travels inside the job payload, set by the job
 * submitter; no production submitter sets it yet.
 */

/** The two contract variants behind the switch. */
export type NlqMode = "rest" | "mcp";

/** The switch's Worker env var name. */
export const NLQ_MODE_SWITCH = "NLQ_MODE" as const;

/** Audit event emitted when a switch value fails closed. */
export function nlqConfigErrorEvent(): string {
  return "nlq.config_error";
}

/** One level of the resolution order. Blank/unset falls through. */
export interface NlqModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

/** Session/user carriers for the switch, as carried by an execution context. */
export interface NlqScopedModes {
  session?: unknown;
  user?: unknown;
}

export interface ResolvedNlqMode {
  mode: NlqMode;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for audit). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

function normalizeModeValue(raw: unknown): NlqMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "rest") return "rest";
  if (normalized === "mcp") return "mcp";
  return "invalid";
}

/**
 * Resolves the switch in run > session > user > env > builtin order.
 * First non-blank level wins; an invalid winner fails closed to
 * "rest" with invalid=true (no fall-through to a lower level).
 */
export function resolveNlqMode(levels: NlqModeScopeLevels): ResolvedNlqMode {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeModeValue(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      return {
        mode: "rest",
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return { mode: normalized, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: "rest", invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set from the scoped carrier + run + env. */
export function levelsForNlq(
  scoped: NlqScopedModes | undefined,
  run: unknown,
  envValue: unknown
): NlqModeScopeLevels {
  return { run, session: scoped?.session, user: scoped?.user, env: envValue };
}
