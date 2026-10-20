/**
 * Issue #359-17 (FINAL slice of the #359 orchestrator breakup): the
 * thin-router inventory.
 *
 * After slices #359-01..16 extracted every domain block and this slice
 * extracted the last two inline blocks (schema introspection into
 * routes/schema.ts, Cloudflare Agentic Payments into
 * routes/agenticPayments.ts), OrchestratorAgent.routeRequest is a THIN
 * ordered dispatcher: a prelude (url/path, ensureTables, sessionKey, the
 * requestedEnv binding), a sequence of delegation calls to
 * src/agents/routes/*.ts - each guarded by `if (response) return
 * response;` - and the Not-found fallthrough. NO path-matched handler
 * block remains inline.
 *
 * This test pins that end state:
 *  (a) the delegation sequence (22 calls, exact order) and its guards;
 *  (b) the absence of any inline path-matching condition in
 *      routeRequest;
 *  (c) the non-handler logic that legitimately stays inline (the
 *      dispatcher prelude and the 404 terminus, after the last
 *      delegation);
 *  (d) the FULL ordered route inventory: every path-matching condition
 *      in the whole router, reconstructed by walking routeRequest and
 *      expanding each delegation into its module's conditions in order -
 *      150 conditions, byte-for-byte the pre-breakup sequence (proven
 *      against the pre-slice tree by the same scripted scan during the
 *      slice; the two blocks this slice moved appear at positions
 *      14-15 (schema) and 44-47 (agentic payments), now attributed to
 *      their handlers).
 *
 * Post-#359 growth, recorded deliberately: issue #126 (PR-E) added
 * two route conditions — GET /etrade/options/discovery-runs (in
 * handleEtradeOptionsRoutes, after scans/diff) and POST
 * /schedules/trigger-discovery (in handleSchedulesRoutes, last) —
 * bringing the inventory to 152. New routes update this pin; the
 * pin's purpose (no UNINTENTIONAL route-surface change) is unchanged.
 * Issue #341 added one more — GET /api/reports/research/browse (in
 * handleReportsRoutes, after the trading/reports webhook handler and
 * before the reports list) — bringing the inventory to 156.
 * Issue #340 added GET /research/track-record (in
 * handleScreenerResearchRoutes, after /research/history) — 157.
 * Issue #273 added seven — POST /schedules/:id/pause, /resume and
 * /trigger plus PUT /schedules/:id (in handleSchedulesRoutes, after
 * the get-by-id block and before create) — bringing the inventory
 * to 164.
 * Issue #649 added one more — POST /reports/semantic-search (in
 * handleReportsRoutes, after the /api/reports list) — bringing the
 * inventory to 165; the pin update landed with #714 after the route
 * was found unpinned during #686 post-merge verification.
 * #714 also pinned five more routes that had landed unpinned:
 * /trading/setup-catalog and /learnings ×2 (handleEtradeBroker-
 * ActivityRoutes, after /etrade/lookup; #650, #706) and
 * /options/strategy-reviews + /options/strategy-reviews/decide
 * (handleEtradeOptionsRoutes, after /trading/options/config; #653)
 * — bringing the inventory to 170. Issue #705 added one more —
 * POST /reflection/run (handleEtradeBrokerActivityRoutes, last) —
 * 171, pinned by #714 as well.
 *
 * LANDMARK RULE (#405): all position assertions anchor to DELEGATION
 * CALLS - the only landmarks a thin router has.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const HANDLER_FILE: Record<string, string> = {
  "handleReportsRoutes": "reports.ts",
  "handleMcpChatNlqRoutes": "mcpChatNlq.ts",
  "handleSchemaRoutes": "schema.ts",
  "handleAdsRevenueReferralsRoutes": "adsRevenueReferrals.ts",
  "handleReferralsAdsRoutes": "adsRevenueReferrals.ts",
  "handleAuditRoutes": "audit.ts",
  "handleAutopilotRoutes": "autopilot.ts",
  "handleMemoryResetRoutes": "memoryReset.ts",
  "handlePaymentsRoutes": "payments.ts",
  "handleAgenticPaymentsRoutes": "agenticPayments.ts",
  "handlePremiumRoutes": "premium.ts",
  "handleEtradeBrokerRoutes": "etradeBroker.ts",
  "handleEtradeBrokerActivityRoutes": "etradeBroker.ts",
  "handleTradingIntegrationsRoutes": "tradingIntegrations.ts",
  "handleEtradeOptionsRoutes": "etradeOptions.ts",
  "handleWatchlistsRoutes": "watchlists.ts",
  "handleAlpacaTradingRoutes": "alpaca.ts",
  "handleAlpacaFossRoutes": "alpaca.ts",
  "handleFossQuoteResearchRoutes": "fossResearch.ts",
  "handleFossCompareScreenRoutes": "fossResearch.ts",
  "handleScreenerResearchRoutes": "screenerResearch.ts",
  "handleSchedulesRoutes": "schedules.ts"
};

const EXPECTED_DELEGATIONS = [
  "handleReportsRoutes",
  "handleMcpChatNlqRoutes",
  "handleSchemaRoutes",
  "handleAdsRevenueReferralsRoutes",
  "handleAuditRoutes",
  "handleAutopilotRoutes",
  "handleMemoryResetRoutes",
  "handleReferralsAdsRoutes",
  "handlePaymentsRoutes",
  "handleAgenticPaymentsRoutes",
  "handlePremiumRoutes",
  "handleEtradeBrokerRoutes",
  "handleTradingIntegrationsRoutes",
  "handleEtradeBrokerActivityRoutes",
  "handleEtradeOptionsRoutes",
  "handleWatchlistsRoutes",
  "handleAlpacaTradingRoutes",
  "handleFossQuoteResearchRoutes",
  "handleAlpacaFossRoutes",
  "handleFossCompareScreenRoutes",
  "handleScreenerResearchRoutes",
  "handleSchedulesRoutes"
];

const EXPECTED_INVENTORY = [
  "handleReportsRoutes :: endsWith(\"/trading/reports/pending\")",
  "handleReportsRoutes :: endsWith(\"/trading/settings/report-dispatch-hitl\")",
  "handleReportsRoutes :: endsWith(\"/trading/settings/report-dispatch-hitl\")",
  "handleReportsRoutes :: endsWith(\"/trading/reports/confirm\")",
  "handleReportsRoutes :: endsWith(\"/trading/reports/email\")",
  "handleReportsRoutes :: endsWith(\"/trading/reports/webhook\")",
  "handleReportsRoutes :: endsWith(\"/reports/research/browse\")",
  "handleReportsRoutes :: endsWith(\"/reports\")",
  "handleReportsRoutes :: === \"/reports\"",
  "handleReportsRoutes :: === \"/api/reports\"",
  "handleReportsRoutes :: endsWith(\"/reports/semantic-search\")",
  "handleMcpChatNlqRoutes :: endsWith(\"/mcp\")",
  "handleMcpChatNlqRoutes :: === \"/chat\"",
  "handleMcpChatNlqRoutes :: === \"/api/chat\"",
  "handleMcpChatNlqRoutes :: endsWith(\"/nlq\")",
  "handleSchemaRoutes :: endsWith(\"/schema/tables\")",
  "handleSchemaRoutes :: endsWith(\"/schema/query\")",
  "handleAdsRevenueReferralsRoutes :: endsWith(\"/categories\")",
  "handleAdsRevenueReferralsRoutes :: endsWith(\"/revenue\")",
  "handleAdsRevenueReferralsRoutes :: endsWith(\"/external-ads\")",
  "handleAdsRevenueReferralsRoutes :: endsWith(\"/external-ads/impression\")",
  "handleAdsRevenueReferralsRoutes :: endsWith(\"/external-ads/click\")",
  "handleAuditRoutes :: endsWith(\"/audit\")",
  "handleAuditRoutes :: endsWith(\"/audit\")",
  "handleAuditRoutes :: endsWith(\"/audit/event\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot/state\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot/kill-switch\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot/limits\")",
  "handleAutopilotRoutes :: endsWith(\"/autopilot/evaluate\")",
  "handleMemoryResetRoutes :: endsWith(\"/memory\")",
  "handleMemoryResetRoutes :: endsWith(\"/clear\")",
  "handleMemoryResetRoutes :: endsWith(\"/reset\")",
  "handleReferralsAdsRoutes :: endsWith(\"/referrals\")",
  "handleReferralsAdsRoutes :: endsWith(\"/referrals/click\")",
  "handleReferralsAdsRoutes :: endsWith(\"/ads\")",
  "handleReferralsAdsRoutes :: endsWith(\"/ads/click\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/gateways\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/status\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/dids\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/transactions\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/create\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/confirm\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/capture\")",
  "handlePaymentsRoutes :: endsWith(\"/payments/webhook\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/wallet\")",
  "handleAgenticPaymentsRoutes :: includes(\"/payments/agentic/wallet\")",
  "handleAgenticPaymentsRoutes :: endsWith(\"/payments/agentic/auto-approve-limit\")",
  "handleAgenticPaymentsRoutes :: includes(\"/payments/agentic/auto-approve-limit\")",
  "handlePremiumRoutes :: includes(\"/premium/options-scan\")",
  "handlePremiumRoutes :: includes(\"/premium/market-research\")",
  "handlePremiumRoutes :: includes(\"/premium/stock-signals\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/environment/switch\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/broker/etrade/environment\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/status\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/diagnostics\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/accounts\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/screen\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/quote\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/order/preview\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/order/execute\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/positions\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-risk\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-risk/evaluate\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-risk/correlation\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-risk/size\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/think/evaluate\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/hedge/analyze\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/portfolio-repair/analyze\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/orders\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/orders/remote\")",
  "handleEtradeBrokerRoutes :: endsWith(\"/etrade/orders/cancel\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/email/inbound\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/slack/event\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/slack/interaction\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/slack/command\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/browser/transaction-snap\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/browser/transaction-snap\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/voice/turn\")",
  "handleTradingIntegrationsRoutes :: endsWith(\"/trading/voice/greeting\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/etrade/transactions\")",
  "handleEtradeBrokerActivityRoutes :: includes(\"/etrade/transactions/\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/etrade/alerts\")",
  "handleEtradeBrokerActivityRoutes :: includes(\"/etrade/alerts/\")",
  "handleEtradeBrokerActivityRoutes :: includes(\"/etrade/alerts/\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/etrade/lookup\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/trading/setup-catalog\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/learnings\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/learnings\")",
  "handleEtradeBrokerActivityRoutes :: endsWith(\"/reflection/run\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/options/latest\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/chains\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/strategy\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/expire-dates\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/scans\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/scans/diff\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/discovery-runs\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/iv-history\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/profiles\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/etrade/options/profiles\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/llm-ideas\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/compare\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/compare\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/recommend\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/catalog\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/catalog\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/strategies\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/best-trade\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/best-trade\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/screen\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/unified\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/trading/options/config\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/options/strategy-reviews\")",
  "handleEtradeOptionsRoutes :: endsWith(\"/options/strategy-reviews/decide\")",
  "handleWatchlistsRoutes :: endsWith(\"/etrade/watchlists\")",
  "handleWatchlistsRoutes :: endsWith(\"/etrade/watchlist/details\")",
  "handleWatchlistsRoutes :: endsWith(\"/etrade/watchlist/create\")",
  "handleWatchlistsRoutes :: endsWith(\"/etrade/watchlist/save-screen\")",
  "handleWatchlistsRoutes :: endsWith(\"/etrade/watchlist/delete\")",
  "handleAlpacaTradingRoutes :: endsWith(\"/trading/alpaca/order\")",
  "handleAlpacaTradingRoutes :: endsWith(\"/trading/alpaca/account\")",
  "handleAlpacaTradingRoutes :: endsWith(\"/trading/alpaca/positions\")",
  "handleAlpacaTradingRoutes :: endsWith(\"/trading/alpaca/orders\")",
  "handleFossQuoteResearchRoutes :: endsWith(\"/foss/quote\")",
  "handleFossQuoteResearchRoutes :: endsWith(\"/foss/fundamentals\")",
  "handleFossQuoteResearchRoutes :: endsWith(\"/foss/bars\")",
  "handleFossQuoteResearchRoutes :: endsWith(\"/foss/research\")",
  "handleAlpacaFossRoutes :: endsWith(\"/foss/snapshot\")",
  "handleAlpacaFossRoutes :: endsWith(\"/foss/alpaca/account\")",
  "handleAlpacaFossRoutes :: endsWith(\"/foss/alpaca/positions\")",
  "handleAlpacaFossRoutes :: endsWith(\"/foss/alpaca/orders\")",
  "handleAlpacaFossRoutes :: endsWith(\"/foss/alpaca/order\")",
  "handleFossCompareScreenRoutes :: endsWith(\"/foss/compare\")",
  "handleFossCompareScreenRoutes :: endsWith(\"/foss/providers\")",
  "handleFossCompareScreenRoutes :: endsWith(\"/foss/screen\")",
  "handleFossCompareScreenRoutes :: endsWith(\"/yfinance/screen\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screener/latest\")",
  "handleScreenerResearchRoutes :: endsWith(\"/screener/report.pdf\")",
  "handleScreenerResearchRoutes :: endsWith(\"/options/report.pdf\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/report.pdf\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/run\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/scheduled-tick\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/latest\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/history\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/track-record\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/settings\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/settings\")",
  "handleScreenerResearchRoutes :: endsWith(\"/research/evaluate\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules\")",
  "handleSchedulesRoutes :: endsWith(\"/api/schedules\")",
  "handleSchedulesRoutes :: === \"/schedules\"",
  "handleSchedulesRoutes :: === \"/api/schedules\"",
  "handleSchedulesRoutes :: endsWith(\"/schedules/cancel\")",
  "handleSchedulesRoutes :: includes(\"/schedules/cancel/\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: endsWith(\"/pause\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: endsWith(\"/resume\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: endsWith(\"/trigger\")",
  "handleSchedulesRoutes :: includes(\"/schedules/\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/create\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-screen\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-renew\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-options-analysis\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-retention\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-iv-collection\")",
  "handleSchedulesRoutes :: endsWith(\"/schedules/trigger-discovery\")"
];

function routeRequestBody(orchSrc: string): string {
  const start = orchSrc.indexOf("private async routeRequest");
  expect(start, "routeRequest must exist").toBeGreaterThan(-1);
  return orchSrc.slice(start);
}

const COND_RE = /path\.(endsWith|includes|startsWith)\("([^"]+)"\)|path === "([^"]+)"/g;

function conditionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(COND_RE))
    out.push(m[3] !== undefined ? `=== "${m[3]}"` : `${m[1]}("${m[2]}")`);
  return out;
}

function handlerConditions(handler: string): string[] {
  const file = HANDLER_FILE[handler];
  expect(file, `no route module mapped for ${handler}`).toBeTruthy();
  const moduleSrc = src(`agents/routes/${file}`);
  const start = moduleSrc.indexOf(`export async function ${handler}(`);
  expect(start, `${handler} must be exported from routes/${file}`).toBeGreaterThan(-1);
  const rest = moduleSrc.slice(start);
  const nextExport = rest.indexOf("\nexport ", 10);
  const body = nextExport < 0 ? rest : rest.slice(0, nextExport);
  return conditionsIn(body).map((c) => `${handler} :: ${c}`);
}

describe("thin router inventory (#359-17)", () => {
  it("routeRequest delegates to the route modules in the pinned order, each one guarded", () => {
    const body = routeRequestBody(src("agents/orchestrator.ts"));
    const delegations = [...body.matchAll(/const (\w+) = await (handle\w+Routes)\(request, url, path, sessionId,/g)];
    expect(delegations.map((m) => m[2])).toEqual(EXPECTED_DELEGATIONS);
    // Every delegation is guarded by `if (<var>) return <var>;` in the
    // same order — a non-null return matched, exactly as the inline
    // blocks returned directly.
    const guards = [...body.matchAll(/if \((\w+)\) return \1;/g)].map((m) => m[1]);
    expect(guards).toEqual(delegations.map((m) => m[1]));
  });

  it("routeRequest contains NO inline path-matching conditions", () => {
    const body = routeRequestBody(src("agents/orchestrator.ts"));
    const inline = [...body.matchAll(/path\.(endsWith|includes|startsWith)\("/g)];
    expect(inline, "no path.endsWith/includes/startsWith conditions may remain inline").toHaveLength(0);
    const inlineEq = [...body.matchAll(/path === "/g)];
    expect(inlineEq, "no path === conditions may remain inline").toHaveLength(0);
  });

  it("the only logic left inline is the dispatcher prelude and the 404 terminus", () => {
    const body = routeRequestBody(src("agents/orchestrator.ts"));
    // Prelude: request-scoped bindings the delegations consume.
    expect(body).toContain("const url = new URL(request.url);");
    expect(body).toContain("const path = url.pathname;");
    expect(body).toContain("const sql = this.ensureTables();");
    expect(body).toContain("const sessionId = this.sessionKey();");
    // requestedEnv is computed once in the dispatcher and passed through
    // the context to the E*TRADE options and watchlists delegations.
    expect(body).toContain('const requestedEnv: "TEST" | "PROD" | undefined');
    // Terminus: exactly one Not-found fallthrough, after the last delegation.
    const notFound = [...body.matchAll(/return new Response\("Not found", \{ status: 404 \}\);/g)];
    expect(notFound).toHaveLength(1);
    const lastDelegation = body.lastIndexOf("handleSchedulesRoutes(request, url, path, sessionId,");
    expect(lastDelegation).toBeGreaterThan(-1);
    expect(body.indexOf('return new Response("Not found"')).toBeGreaterThan(lastDelegation);
  });

  it("the full ordered route inventory across all modules matches the pinned pre-breakup sequence", () => {
    const body = routeRequestBody(src("agents/orchestrator.ts"));
    const inventory: string[] = [];
    const tokenRe =
      /handle\w+Routes\(request, url, path, sessionId,|path\.(endsWith|includes|startsWith)\("([^"]+)"\)|path === "([^"]+)"/g;
    for (const m of body.matchAll(tokenRe)) {
      if (m[0].startsWith("handle")) {
        const name = m[0].slice(0, m[0].indexOf("("));
        inventory.push(...handlerConditions(name));
      } else if (m[3] !== undefined) inventory.push(`INLINE :: === "${m[3]}"`);
      else inventory.push(`INLINE :: ${m[1]}("${m[2]}")`);
    }
    expect(inventory).toEqual(EXPECTED_INVENTORY);
  });
});
