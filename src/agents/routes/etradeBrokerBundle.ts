/**
 * Consolidation C5 (#1361) — bundle route completion, split out of
 * etradeBroker.ts under the #995 pattern: the original keeps the
 * route condition + build prologue, and this module owns the
 * completion (mas_outcomes persistence, canonical mas_reports
 * persistence, inline delivery, response assembly). It constructs
 * no ETradeService — the route's service stays in the original —
 * so the construction ledgers are unaffected.
 */
import type { EtradeBrokerRouteContext } from "./etradeBroker";
import {
  persistBundleReport,
  type RecommendationBundle,
} from "../../services/recommendationBundle";
import type {
  ScreeningChannel,
  ScreeningChannelResult,
} from "../../services/screeningDelivery";

export interface BundleCompletionBody {
  persist?: boolean;
  persistReport?: boolean;
  deliver?: { channels?: ScreeningChannel[]; emailTo?: string };
}

/**
 * Completes a built bundle: optional persistence + delivery, then
 * the Phase 4 response shape (unchanged for existing callers —
 * extra fields appear only when their option was requested).
 */
export async function completeBundleRoute(
  ctx: EtradeBrokerRouteContext,
  args: {
    bundle: RecommendationBundle;
    primarySymbol: string;
    body: BundleCompletionBody;
    userLogin: string;
  },
): Promise<Response> {
  const { bundle, primarySymbol, body, userLogin } = args;
  let outcomeId: string | null = null;
  if (body.persist === true) {
    const { persistRecommendationBundle } = await import("../../services/recommendationBundle");
    const record = persistRecommendationBundle(ctx.getOrm(), bundle, { userLogin });
    outcomeId = record?.id ?? null;
  }
  // C5 (#1361): canonical persistence via the shared store seam
  // (never throws; null reported verbatim, never fails the build).
  const reportPersistenceRequested = body.persistReport === true;
  const reportPersistence = reportPersistenceRequested
    ? persistBundleReport(ctx.getOrm(), bundle, primarySymbol, userLogin)
    : null;
  let delivery: ScreeningChannelResult[] | null = null;
  if (Array.isArray(body.deliver?.channels) && body.deliver.channels.length > 0) {
    const { deliverScreeningContent, formatBundleDelivery, createScreeningDeliverySenders } = await import("../../services/screeningDelivery");
    const formatted = formatBundleDelivery(bundle);
    delivery = await deliverScreeningContent({
      channels: body.deliver.channels,
      subject: formatted.subject,
      text: formatted.text,
      event: "screening.bundle",
      data: { bundleId: bundle.id, decision: bundle.decision, qualification: bundle.qualification, confidence: bundle.confidence, text: formatted.text },
      emailTo: body.deliver.emailTo,
      senders: createScreeningDeliverySenders(ctx.env, ctx.getOrm(), userLogin),
      sql: ctx.getOrm(),
      userLogin,
      actor: "bundle-route",
    });
  }
  if (outcomeId !== null || delivery !== null || reportPersistenceRequested) {
    return Response.json({
      ...bundle,
      ...(outcomeId !== null ? { persistence: { outcomeId } } : {}),
      ...(reportPersistenceRequested ? { reportPersistence } : {}),
      ...(delivery !== null ? { delivery } : {}),
    });
  }
  return Response.json(bundle);
}
