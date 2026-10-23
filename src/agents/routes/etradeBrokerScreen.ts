/**
 * Issue #995: E*TRADE broker route sub-domain module, split out of
 * src/agents/routes/etradeBroker.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeBroker.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the equity screen execution (post-parse tail)
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import { parseStockScreenRequest } from "../../trading";
import { publishManualScreenerRun } from "./etradeBroker";
import type { EtradeBrokerRouteContext } from "./etradeBroker";
import type { ScreenerAgent } from "../screener-agent";

type StockScreenValue = Extract<ReturnType<typeof parseStockScreenRequest>, { ok: true }>["value"];

export async function executeEtradeScreen(args: {
  ctx: EtradeBrokerRouteContext;
  sessionId: string;
  requestedEnv: "TEST" | "PROD" | undefined;
  userLogin: string;
  agent: ScreenerAgent;
  universe: StockScreenValue["universe"];
  validatedFilters: StockScreenValue["filters"];
}): Promise<Response> {
  const { ctx, sessionId, requestedEnv, userLogin, agent, universe, validatedFilters } = args;
  if (universe === "ALL") {
    const shards = await agent.runSharded({ trigger: "manual", filters: validatedFilters, userLogin, environment: requestedEnv });
    const orm = ctx.getOrm();
    for (const shard of shards) {
      await publishManualScreenerRun(ctx.env, orm, userLogin, shard);
    }
    const failed = shards.filter((r) => !r.success);
    if (failed.length === shards.length) {
      return Response.json({ error: failed[0]?.error || "E*TRADE unavailable" }, { status: 502 });
    }
    ctx.audit("etrade.screened", "trading", {
      filterSummary: `ALL (sharded: ${shards.length} universes)`,
      count: shards.reduce((n, r) => n + r.allStocks.length, 0),
      success: true,
    });
    // Issue #307/#308: store each shard's canonical report copy
    // (one row per generation) so manual screens are searchable.
    // Issue #911: pass userLogin for correct user scoping.
    for (const r of shards) ctx.persistScreenerReportCanonical({ ...r, userLogin });
    return Response.json({
      sharded: true,
      universes: shards.map((r) => ({
        universe: r.universe,
        totalScanned: r.totalScanned,
        matchedCount: r.matchedCount,
        opportunities: r.opportunities,
        stocks: r.allStocks,
        discoveryMessage: r.discoveryMessage,
        scannedAt: r.timestamp,
        reportUrl: r.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(r.pdfKey)}` : undefined,
        success: r.success,
        error: r.error,
      })),
    });
  }
  // Issue #424: if runScreen throws (instead of returning a failed
  // result), publish the failure notification before propagating.
  let result;
  try {
    result = await agent.runScreen({
      trigger: "manual",
      filters: validatedFilters,
      universe: universe as any,
      userLogin,
      // The screener runs in its own Durable Object, so it cannot infer the
      // environment selected on this orchestrator request. Carry the same
      // authenticated account context into the shared manual/scheduled
      // screening pipeline.
      environment: requestedEnv,
    });
  } catch (screenErr) {
    const error = screenErr instanceof Error ? screenErr.message : String(screenErr);
    // Issue #832: "already running" is not a failure — return 429, don't spam Slack.
    if (error.includes("already running")) {
      return Response.json(
        { error: "Screen already running", message: error, retryable: true },
        { status: 429 }
      );
    }
    await publishManualScreenerRun(ctx.env, ctx.getOrm(), userLogin, {
      success: false,
      error,
      timestamp: new Date().toISOString(),
      universe: universe as any,
    } as any);
    throw screenErr;
  }
  ctx.audit("etrade.screened", "trading", {
    filterSummary: result.discoveryMessage,
    count: result.allStocks.length,
    success: result.success,
  });
  // Issue #307/#308: store the canonical report copy (one row per
  // generation) so manual screens are searchable like scheduled ones.
  // Issue #911: pass userLogin so the report is stored under the
  // correct user scope (not "default").
  ctx.persistScreenerReportCanonical({ ...result, userLogin });
  await publishManualScreenerRun(ctx.env, ctx.getOrm(), userLogin, result);
  if (!result.success) {
    return Response.json({ error: result.error || "E*TRADE unavailable" }, { status: 502 });
  }
  return Response.json({
    universe: result.universe,
    totalScanned: result.totalScanned,
    matchedCount: result.matchedCount,
    opportunities: result.opportunities,
    stocks: result.allStocks,
    discoveryMessage: result.discoveryMessage,
    scannedAt: result.timestamp,
    pdfKey: result.pdfKey,
    pdfStatus: result.pdfStatus,
    pdfError: result.pdfError,
    reportUrl: result.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(result.pdfKey)}` : undefined,
    xlsxKey: result.xlsxKey,
    xlsxStatus: result.xlsxStatus,
    xlsxUrl: result.xlsxKey ? `/api/screener/report.xlsx?key=${encodeURIComponent(result.xlsxKey)}` : undefined,
  });
}
