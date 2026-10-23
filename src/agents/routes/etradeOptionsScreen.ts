/**
 * Issue #995: E*TRADE options route sub-domain module, split out of
 * src/agents/routes/etradeOptions.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeOptions.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the manual options screen and unified options execution (post-parse tails)
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import {
  DynamicOptionsScreener,
  UnifiedOptionsService,
  SqlScanRunStore,
  SqlStrategyProfileStore,
  buildCalibratedOptionChains,
  parseOptionsScreenRequest,
} from "../../trading";
import { isDemoCalibratedChainsEnabled } from "../../config/demoMode";
import { deliverScreenerToSlackA2A } from "../../services/screenerSlackDelivery";
import { screenerOutcomeFromRunResult } from "../../services/screenerFollowups";
import { getEventCalendarCoverage, toEventCalendarInfo } from "../../services/eventCalendar";
import type { EtradeOptionsRouteContext } from "./etradeOptions";

type OptionsScreenValue = Extract<ReturnType<typeof parseOptionsScreenRequest>, { ok: true }>["value"];

export async function executeOptionsScreen(args: {
  ctx: EtradeOptionsRouteContext;
  userLogin: string;
  screener: DynamicOptionsScreener;
  screenFilter: OptionsScreenValue["filter"];
  screenPushToSlack: OptionsScreenValue["pushToSlack"];
  screenSlackChannel: OptionsScreenValue["slackChannel"];
  screenUniverseLabel: OptionsScreenValue["universe"];
  /** Issue #1123: when the screen runs as a tracked job, the follow-up
   *  pipeline owns delivery — skip the inline Slack delivery. */
  deferDelivery?: boolean;
}): Promise<Response> {
  const { ctx, userLogin, screener, screenFilter, screenPushToSlack, screenSlackChannel, screenUniverseLabel, deferDelivery } = args;
  let result = await screener.screenOptions(screenFilter);

  // Demo-mode fallback (issue #65): generated chains may substitute for an
  // empty live screen ONLY in dev/demo deployments with the gate enabled,
  // and the result is stamped dataSource "calibrated-demo". Production is
  // live-only: an empty live screen returns empty, with its fetch errors.
  if (result.contracts.length === 0 && isDemoCalibratedChainsEnabled() && screenFilter.underlyingSymbols && screenFilter.underlyingSymbols.length > 0 && screenFilter.underlyingSymbols[0] !== "BROKEN") {
    const fallbackChains = buildCalibratedOptionChains(screenFilter.underlyingSymbols, screenFilter.minDte ?? 0, screenFilter.maxDte ?? 90);
    if (fallbackChains.length > 0) {
      const chainItems = fallbackChains.map((c) => ({ symbol: c.symbol, chain: c }));
      const fallbackResult = screener.evaluateChains(chainItems, screenFilter, screenFilter.underlyingSymbols.length, {
        warnings: ["Calibrated demo chains — generated data for development/demo, not live market data."],
      });
      if (fallbackResult.contracts.length > 0) {
        fallbackResult.dataSource = "calibrated-demo";
        result = fallbackResult;
      }
    }
  }
  if (result.dataSource === undefined) result.dataSource = "live";

  // Issue #294/#421/#423/#424 (PR #432): manual screens honor pushToSlack
  // — PDF generated, stored per-run, delivered via the Slack A2A path
  // with a reportUrl; failures notify too.
  // Issue #1023 (S4): generation goes through the ONE unified report
  // pipeline (delegates to ReportAssetAgent per #680/#914) — the same
  // idiom as the scheduled path in ScheduledTasksService. There is no
  // direct-generator fallback: on pipeline failure the run continues
  // with no pdfKey/reportUrl, exactly as a scheduled failure surfaces.
  let optionsReportUrl: string | undefined;
  let optionsPdfKey: string | undefined;
  let pdfBytes: Uint8Array | undefined;
  let fileName: string | undefined;

  try {
    const { runReportPipeline } = await import("../../services/unifiedReportPipeline");
    const pipelineResult = await runReportPipeline(
      ctx.env as any,
      null as any, // Storage handled by ReportAssetAgent internally
      {
        type: "options",
        trigger: "manual",
        result,
        userLogin,
        title: `Options contract screen — ${(screenFilter.underlyingSymbols || []).join(", ") || screenUniverseLabel || "selected underlyings"}`,
        summary: `${result.totalUnderlyingsScanned} underlyings scanned, ${result.totalContractsEvaluated} contracts evaluated, ${result.matchedCount} matched.`,
        timestamp: new Date().toISOString(),
      }
    );
    if (pipelineResult.pdfStatus === "generated") {
      optionsPdfKey = pipelineResult.pdfKey;
      // Fetch the bytes for Slack delivery (same seam the scheduled
      // path uses: ScreenerAgent storage first, ReportAssetAgent
      // fallback inside getPdfByKey).
      const screenerAgent = ctx.getScreenerAgent(userLogin);
      const pdfData = await screenerAgent.getPdfByKey(optionsPdfKey);
      if (pdfData) {
        pdfBytes = pdfData.bytes;
        fileName = pdfData.fileName;
      }
      optionsReportUrl = `/api/options/report.pdf?key=${encodeURIComponent(optionsPdfKey)}`;
    } else {
      console.warn("[Orchestrator] Manual options contract PDF generation failed:", pipelineResult.pdfError);
    }
  } catch (pdfErr) {
    console.warn("[Orchestrator] Manual options contract PDF generation failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
  }

  // Deliver over A2A to Slack channel unless caller explicitly opted out
  // (or the tracked follow-up pipeline owns delivery — issue #1123).
  // S5a: when the host provides the follow-up bridge, the run is
  // recorded + chained through the pipeline instead of delivering
  // inline; the A2A block remains the fallback for hosts without it.
  const shouldNotifySlack = screenPushToSlack !== false && !deferDelivery;
  if (shouldNotifySlack && ctx.scheduleScreenerFollowups) {
    await ctx.scheduleScreenerFollowups(
      screenerOutcomeFromRunResult("options", {
        success: true,
        thesis: screenUniverseLabel,
        totalScanned: result.totalUnderlyingsScanned,
        matchedCount: result.matchedCount,
        pdfKey: optionsPdfKey,
        pdfStatus: optionsPdfKey ? "generated" : undefined,
        summary: `${result.totalUnderlyingsScanned} underlyings scanned · ${result.totalContractsEvaluated} contracts evaluated · ${result.matchedCount} matched.`,
      }),
      userLogin,
    );
  } else if (shouldNotifySlack) {
    const slackChannel = screenSlackChannel || (ctx.env as any).SCREENER_SLACK_CHANNEL || (ctx.env as any).SLACK_CHANNEL;
    const summary = `📊 Options Contract Screen — ${(screenFilter.underlyingSymbols || []).join(", ") || screenUniverseLabel || "selected underlyings"}\n${result.totalUnderlyingsScanned} underlyings scanned · ${result.totalContractsEvaluated} contracts evaluated · ${result.matchedCount} matched.\n${result.filterSummary || ""}`;
    try {
      const sent = await deliverScreenerToSlackA2A(ctx.env, {
        text: summary,
        channel: slackChannel,
        ...(pdfBytes && fileName ? {
          pdf: {
            bytes: pdfBytes,
            fileName,
            title: `Options Contract Screen — ${new Date().toISOString().slice(0, 10)}`,
            comment: `📄 Options contract screener PDF\n\n${summary}`,
          },
        } : {}),
      });
      if (!sent.ok) console.warn("[Orchestrator] Slack A2A options contract PDF delivery failed:", sent.error);
    } catch (slackErr) {
      console.warn("[Orchestrator] Slack A2A options delivery error:", slackErr instanceof Error ? slackErr.message : String(slackErr));
    }
  }

  const generatedAt = new Date().toISOString();
  const generationId = `options_scanner:manual:${generatedAt}`;
  ctx.getOrm().storeCanonicalReport({
    runId: generationId,
    generationId,
    title: `Options contract screen — ${(screenFilter.underlyingSymbols || []).join(", ") || screenUniverseLabel || "selected underlyings"}`,
    source: "options_scanner",
    summary: `${result.totalUnderlyingsScanned} underlyings scanned, ${result.totalContractsEvaluated} contracts evaluated, ${result.matchedCount} matched.`,
    body: { generatedAt, filter: screenFilter, result, pdfKey: optionsPdfKey, reportUrl: optionsReportUrl },
    createdAt: generatedAt,
  });

  return Response.json({ ...result, pdfKey: optionsPdfKey, reportUrl: optionsReportUrl });
}

export async function executeUnifiedOptions(args: {
  request: Request;
  sessionId: string;
  ctx: EtradeOptionsRouteContext;
  reqData: any;
}): Promise<Response> {
  const { request, sessionId, ctx, reqData } = args;
  const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
  const service = new UnifiedOptionsService(ctx.env, userLogin, ctx.requestedEnv, ctx.getOrm(), new SqlScanRunStore(ctx.agentCtx.storage.sql), new SqlStrategyProfileStore(ctx.agentCtx.storage.sql), ctx.agentCtx.storage.sql, { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage, env: ctx.env });
  // Issue #16: event calendars are server-side facts — strip any
  // client-supplied calendar, then fetch coverage for the
  // actions that run the strategy engine. The calendar service
  // never throws; uncovered names stay unverified.
  delete reqData.eventCalendarBySymbol;
  delete reqData.eventCalendar;
  if (reqData.action === "opportunities" || reqData.action === "strategies" || reqData.action === "best_trade" || reqData.action === "compare" || reqData.action === "llm_ideas" || reqData.action === "llm_evaluate") {
    const calSymbols = reqData.action === "opportunities"
      ? (Array.isArray(reqData.symbols) && reqData.symbols.length > 0 ? reqData.symbols : (reqData.symbol ? [reqData.symbol] : []))
      : [reqData.symbol || (reqData.action === "llm_ideas" || reqData.action === "llm_evaluate" ? "NVDA" : "SPY")];
    if (calSymbols.length > 0) {
      const calendarCoverage = await getEventCalendarCoverage(calSymbols);
      reqData.eventCalendarBySymbol = Object.fromEntries(
        Array.from(calendarCoverage.bySymbol, ([sym, cal]) => [sym, toEventCalendarInfo(cal)])
      );
    }
  }
  const result = await service.execute(reqData);

  let reportUrl: string | undefined;
  let pdfKey: string | undefined;
  let scannerPdfBytes: Uint8Array | undefined;
  let scannerPdfFileName: string | undefined;

  if (reqData.action === "opportunities" && result.success) {
    const timestamp = new Date().toISOString();
    // Issue #1023 (S4): the ONE unified report pipeline (delegates
    // to ReportAssetAgent per #680/#914), same idiom as the
    // scheduled path in ScheduledTasksService — no direct-generator
    // fallback; on failure pdfKey/reportUrl stay undefined.
    try {
      const { runReportPipeline } = await import("../../services/unifiedReportPipeline");
      const pipelineResult = await runReportPipeline(
        ctx.env as any,
        null as any, // Storage handled by ReportAssetAgent internally
        {
          type: "options",
          trigger: "manual",
          result: result.data,
          userLogin,
          title: `Options scanner — ${reqData.thesis || "mixed"} (${timestamp.slice(0, 10)})`,
          summary: result.summary,
          timestamp,
        }
      );
      if (pipelineResult.pdfStatus === "generated") {
        pdfKey = pipelineResult.pdfKey;
        const screenerAgent = ctx.getScreenerAgent(userLogin);
        const pdfData = await screenerAgent.getPdfByKey(pdfKey);
        if (pdfData) {
          scannerPdfBytes = pdfData.bytes;
          scannerPdfFileName = pdfData.fileName;
        }
        reportUrl = `/api/options/report.pdf?key=${encodeURIComponent(pdfKey)}`;
      } else {
        console.warn("[Orchestrator] Manual options PDF generation failed:", pipelineResult.pdfError);
      }
    } catch (pdfErr) {
      console.warn("[Orchestrator] Manual options PDF generation failed:", pdfErr instanceof Error ? pdfErr.message : String(pdfErr));
    }

    const shouldNotifySlack = reqData.pushToSlack !== false && reqData.pushToSlack !== "false";
    if (shouldNotifySlack) {
      const slackChannel = reqData.slackChannel || (ctx.env as any).SCREENER_SLACK_CHANNEL || (ctx.env as any).SLACK_CHANNEL;
      try {
        const slackPayload = result.toSlack();
        const text = typeof slackPayload === "string" ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
        const matchCount = result.data?.opportunities?.length ?? result.data?.matchedCount ?? 0;
        const sent = await deliverScreenerToSlackA2A(ctx.env, {
          text,
          channel: slackChannel,
          ...(scannerPdfBytes && scannerPdfFileName ? {
            pdf: {
              bytes: scannerPdfBytes,
              fileName: scannerPdfFileName,
              title: `Options Scanner Report — manual ${timestamp.slice(0, 10)}`,
              comment: `📄 Manual options scan PDF — ${matchCount} matches\n\n${text}`,
            },
          } : {}),
        });
        if (!sent.ok) console.warn("[Orchestrator] Slack A2A PDF delivery (manual options) failed:", sent.error);
      } catch (slackErr) {
        console.warn("[Orchestrator] Slack notification (manual options) error:", slackErr instanceof Error ? slackErr.message : String(slackErr));
      }
    }

    const generatedAt = timestamp;
    const generationId = `options_scanner:${generatedAt}:${reqData.thesis || "mixed"}`;
    ctx.getOrm().storeCanonicalReport({
      runId: generationId,
      generationId,
      title: `Options scanner — ${reqData.thesis || "mixed"} (${generatedAt.slice(0, 10)})`,
      source: "options_scanner",
      summary: result.summary,
      body: { generatedAt, request: reqData, report: result.toWebhook(), pdfKey, reportUrl },
      createdAt: generatedAt,
    });
  } else if (!result.success && reqData.pushToSlack !== false && reqData.pushToSlack !== "false") {
    const slackChannel = reqData.slackChannel || (ctx.env as any).SCREENER_SLACK_CHANNEL || (ctx.env as any).SLACK_CHANNEL;
    const slackPayload = result.toSlack();
    const text = typeof slackPayload === "string" ? slackPayload : slackPayload.text || JSON.stringify(slackPayload);
    const sent = await deliverScreenerToSlackA2A(ctx.env, { text, channel: slackChannel });
    if (!sent.ok) console.warn("[Orchestrator] Slack A2A notification (manual options failed) error:", sent.error);
  }

  const channel = reqData.channel || "ui";
  if (channel === "slack") {
    return Response.json(result.toSlack());
  }
  if (channel === "email") {
    return Response.json({ html: result.toEmailHtml(), text: result.toEmailText(), summary: result.summary });
  }
  if (channel === "voice") {
    return Response.json(result.toVoice());
  }
  if (channel === "webhook") {
    return Response.json({ ...result.toWebhook(), reportUrl });
  }
  if (channel === "mcp") {
    return Response.json(result.toMcp());
  }
  return Response.json({ ...result.toUi(), reportUrl });
}
