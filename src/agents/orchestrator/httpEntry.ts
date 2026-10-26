/**
 * Issue #992: HTTP entry helpers (chat-activity logging, async HTTP request queueing) — extracted from
 * OrchestratorAgent (src/agents/orchestrator.ts) with no behaviour
 * change. The class keeps state/lifecycle ownership and composes
 * these functions through the context builder in orchestrator.ts;
 * each function receives its dependencies explicitly via
 * HttpEntryContext.
 */

import type { AgentName, AsyncJobSubmission } from "../../types";

/**
 * Ports the HTTP-entry helper functions receive from the class.
 * addMessages/recordMessage stay class-owned (Think session + audit
 * log); these helpers only compose them.
 */
export interface HttpEntryContext {
  sessionKey: () => string;
  recordMessage: (role: "user" | "assistant" | "system", content: string, agent: AgentName | "orchestrator") => void;
  addMessages: (messages: any[]) => Promise<unknown>;
  submitAsyncJob: (job: AsyncJobSubmission) => Promise<{ jobId: string; status: "queued"; statusUrl: string }>;
}

/**
 * Records a request handled by another agent/tab in the shared chat transcript
 * without invoking the chat model. Entries with the same id are updated in place.
 */
export async function logChatActivity(ctx: HttpEntryContext, request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as { id?: unknown; source?: unknown; text?: unknown } | null;
  const id = typeof body?.id === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(body.id) ? body.id : crypto.randomUUID();
  const source = typeof body?.source === "string" ? body.source.slice(0, 80) : "";
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
  if (!source || !text) {
    return Response.json({ error: "source and text are required." }, { status: 400 });
  }

  const entry = {
    id: `activity_${id}`,
    role: "assistant" as const,
    parts: [{ type: "text" as const, text }],
    metadata: { sourceTab: source, activity: true },
  };
  // Issue #686: Think session upsert by id — an existing activity
  // entry is replaced, a new one appended (the semantics the
  // AIChatAgent-era findIndex/persistMessages pair encoded).
  await ctx.addMessages([entry] as any);
  ctx.recordMessage("system", `[${source}] ${text}`, "orchestrator");
  return Response.json({ id });
}

/**
 * #1724 note: the `x-delivery-mode` header is intentionally NOT
 * forwarded into the job payload — the delivery decision is made at
 * DO entry (onRequest) before queueing, and the replay runs
 * routeRequest directly. Only content-type / accept / x-environment
 * plus the validated x-user-login (or the session key) ride the job.
 */
export async function enqueueHttpRequest(ctx: HttpEntryContext, request: Request, url: URL): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 8_000_000) {
    return Response.json({ error: "Async API request exceeds the 8 MB request limit." }, { status: 413 });
  }

  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  if (new TextEncoder().encode(body).length > 8_000_000) {
    return Response.json({ error: "Async API request exceeds the 8 MB request limit." }, { status: 413 });
  }

  const headers: Record<string, string> = {};
  for (const name of ["content-type", "accept", "x-environment"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  const userLogin = request.headers.get("x-user-login");
  headers["x-user-login"] = userLogin && /^[A-Za-z0-9._-]{1,80}$/.test(userLogin)
    ? userLogin
    : ctx.sessionKey();
  try {
    const job = await ctx.submitAsyncJob({
      capability: "http.request",
      payload: {
        pathAndQuery: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        body,
      },
    });
    return Response.json(job, {
      status: 202,
      headers: { "Location": job.statusUrl, "Retry-After": "1" },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Could not queue API request.",
    }, { status: 503 });
  }
}
