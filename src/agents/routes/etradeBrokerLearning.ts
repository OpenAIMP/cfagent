/**
 * Issue #995: E*TRADE broker route sub-domain module, split out of
 * src/agents/routes/etradeBroker.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeBroker.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the setup catalog, learnings store, and reflection trigger (activity-handler extras)
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import type { EtradeBrokerRouteContext } from "./etradeBroker";

export async function handleTradingSetupCatalog(): Promise<Response> {
  try {
    const { listSetups } = await import("../../trading");
    return Response.json({ setups: listSetups() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to load catalog" }, { status: 500 });
  }
}

export async function handleLearningsList(request: Request, url: URL, ctx: EtradeBrokerRouteContext): Promise<Response> {
  try {
    const { getActiveLearnings, getLearningHistory } = await import("../../services/learnings");
    const domain = url.searchParams.get("domain") || undefined;
    const history = url.searchParams.get("history") === "true";
    const learnings = history
      ? getLearningHistory(ctx.getOrm(), domain)
      : getActiveLearnings(ctx.getOrm(), domain);
    return Response.json({ learnings });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to list learnings" }, { status: 500 });
  }
}

export async function handleLearningsCreate(request: Request, ctx: EtradeBrokerRouteContext): Promise<Response> {
  try {
    const { recordLearning } = await import("../../services/learnings");
    const body = (await request.json().catch(() => ({}))) as any;
    if (!body.domain || !body.observation) {
      return Response.json({ error: "domain and observation required" }, { status: 400 });
    }
    const id = recordLearning(ctx.getOrm(), {
      domain: body.domain,
      observation: body.observation,
      evidenceRefs: body.evidenceRefs,
      confidence: body.confidence,
      source: "human",
    });
    return Response.json({ id, success: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to record learning" }, { status: 500 });
  }
}

export async function handleReflectionRun(ctx: EtradeBrokerRouteContext): Promise<Response> {
  try {
    const { runReflection } = await import("../../services/reflection");
    const result = runReflection(ctx.getOrm(), new Date());
    return Response.json({ success: true, ...result, timestamp: new Date().toISOString() });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Reflection failed" }, { status: 500 });
  }
}
