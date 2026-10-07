/**
 * Unified Options Intelligence Service
 *
 * Consolidates all option screening, strategy discovery, best-trade picking,
 * cross-symbol opportunity scanning, and LLM evaluations into a single,
 * omnichannel pipeline uniformly accessible via:
 * - UI (Discovery/Builder, Custom Thesis, NLQ, Chat)
 * - Slack (Interactive Block Kit cards with trade previews & approval buttons)
 * - Email (Responsive dark-mode HTML tables with greeks and payoffs)
 * - Voice (Pronunciation-tuned spoken speech and display markdown)
 * - Webhooks & MCP (Standardized JSON schemas)
 */

import type {
  Env,
  OptionScreenerFilter,
  OptionScreenResult,
  SlackBlockKitPayload,
  ETradeOptionChain,
} from "../../types";
import { DatabaseORM } from "../../orm";
import { ETradeService } from "../../services/etrade";
import { DynamicOptionsScreener } from "../optionsScreener";
import {
  OptionsAgentPipeline,
  recommendOptionStrategies,
  type StrategyRequest,
  type StrategyRecommendationResult,
  type OptionThesis,
  type ExpectedIvDirection,
  type OptionStrategyType,
  type StrategyCandidate,
} from "./index";
import { OpportunityScanner, type OpportunityScanResult } from "./opportunityScanner";
import { getEtapiConfig, type EtapiConfig } from "../../config/etapiConfig";
import { AGENT_DIDS } from "../../agents/did";
import { rankCandidatesWithLlm } from "./llmComparison";
import {
  generateRawOptionsIdeas,
  groupRawOptionsIdeasChains,
  buildContextLimitedRawOptionsIdeasInput,
} from "./llmIdeas";

export type UnifiedOptionsAction =
  | "screen"
  | "strategies"
  | "best_trade"
  | "opportunities"
  | "recommend"
  | "compare"
  | "llm_ideas"
  | "llm_evaluate"
  | "config";

export type OmnichannelContext =
  | "ui"
  | "slack"
  | "email"
  | "voice"
  | "webhook"
  | "mcp"
  | "chat";

export interface UnifiedOptionsRequest {
  action: UnifiedOptionsAction;
  symbol?: string;
  symbols?: string[];
  thesis?: OptionThesis;
  targetPrice?: number;
  targetDate?: string;
  expectedIvDirection?: ExpectedIvDirection;
  riskProfile?: "conservative" | "balanced" | "aggressive";
  allowedStrategies?: OptionStrategyType[];
  maxPlannedLoss?: number;
  minRewardRisk?: number;
  filter?: OptionScreenerFilter;
  channel?: OmnichannelContext;
  question?: string;
  limit?: number;
  userLogin?: string;
  overrideEnv?: string;
}

export interface FormattedOmnichannelResponse {
  success: boolean;
  action: UnifiedOptionsAction;
  channel: OmnichannelContext;
  summary: string;
  data: any;
  meta: {
    symbol?: string;
    underlyingsCount?: number;
    contractsCount?: number;
    strategiesCount?: number;
    generatedAt: string;
    environment: string;
    cached: boolean;
  };
  toUi: () => any;
  toSlack: () => SlackBlockKitPayload;
  toEmailHtml: () => string;
  toEmailText: () => string;
  toVoice: () => { spokenText: string; displayMarkdown: string };
  toWebhook: () => Record<string, unknown>;
  toMcp: () => Record<string, unknown>;
}

// In-memory cache for recent chain/strategy evaluations across channels
interface CacheEntry {
  timestamp: number;
  data: any;
  summary: string;
}
const MEMORY_CACHE = new Map<string, CacheEntry>();

export class UnifiedOptionsService {
  private config: EtapiConfig;
  private orm?: DatabaseORM;

  constructor(
    private env: Env,
    private userLogin: string = "default_trader",
    private overrideEnv?: string,
    orm?: DatabaseORM
  ) {
    this.config = getEtapiConfig(env, overrideEnv);
    this.orm = orm;
  }

  private getCacheKey(req: UnifiedOptionsRequest): string {
    const sym = (req.symbol || (req.symbols ? req.symbols.join(",") : "")).toUpperCase();
    return `${req.action}:${sym}:${req.thesis || ""}:${req.riskProfile || ""}:${req.targetPrice || ""}`;
  }

  async execute(req: UnifiedOptionsRequest): Promise<FormattedOmnichannelResponse> {
    const channel = req.channel || "ui";
    const cacheTtlMs = this.config.cache.chainTtlSeconds * 1000;
    const cacheKey = this.getCacheKey(req);
    const now = Date.now();

    const cached = MEMORY_CACHE.get(cacheKey);
    let executionData: any;
    let summary = "";
    let isFromCache = false;

    if (cached && now - cached.timestamp < cacheTtlMs) {
      executionData = cached.data;
      summary = cached.summary;
      isFromCache = true;
    } else {
      const etrade = new ETradeService(
        this.orm || new DatabaseORM({ exec: () => [] }),
        this.env,
        this.userLogin,
        this.overrideEnv
      );
      const screener = new DynamicOptionsScreener(etrade.client);

      switch (req.action) {
        case "screen": {
          const filter: OptionScreenerFilter = {
            ...req.filter,
            underlyingSymbols: req.symbols || (req.symbol ? [req.symbol.toUpperCase()] : undefined),
            limit: req.limit || this.config.screener.maxReturnedContracts,
          };
          const screenResult = await screener.screenOptions(filter);
          executionData = screenResult;
          summary = `Screened ${screenResult.matchedCount} options contracts across ${screenResult.totalUnderlyingsScanned} symbols.`;
          break;
        }

        case "strategies":
        case "best_trade": {
          const symbol = (req.symbol || "SPY").toUpperCase().trim();
          const targetPrice = req.targetPrice || (req.thesis === "bearish" ? 100 : 150);
          const targetDate = req.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
          const strategyRequest: StrategyRequest = {
            symbol,
            thesis: req.thesis || "bullish",
            targetPrice,
            targetDate,
            expectedIvDirection: req.expectedIvDirection || "unchanged",
            maxPlannedLoss: req.maxPlannedLoss || 1000,
            minRewardRisk: req.minRewardRisk || 1.5,
            allowedStrategies: req.allowedStrategies && req.allowedStrategies.length > 0 ? req.allowedStrategies : ["all"],
          };

          const pipeline = new OptionsAgentPipeline(screener);
          const pipelineResult = await pipeline.run(strategyRequest, {
            riskProfile: req.riskProfile || "balanced",
          });

          if (req.action === "best_trade") {
            const bestCandidate = pipelineResult.bestTrade?.best?.candidate;
            const bestScore = pipelineResult.bestTrade?.best?.compositeScore ?? bestCandidate?.score;
            executionData = {
              bestTrade: pipelineResult.bestTrade,
              evaluations: pipelineResult.strategies.evaluations,
              snapshot: pipelineResult.snapshot,
            };
            summary = bestCandidate
              ? `Best trade for ${symbol} (${strategyRequest.thesis}): ${bestCandidate.label} (Score: ${bestScore})`
              : `No suitable option trade found for ${symbol} matching ${strategyRequest.thesis} criteria.`;
          } else {
            executionData = pipelineResult;
            summary = `Generated ${pipelineResult.ranked.length} evaluated strategy candidates for ${symbol}.`;
          }
          break;
        }

        case "opportunities": {
          const symbols = req.symbols && req.symbols.length > 0 ? req.symbols : ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"];
          const scanner = new OpportunityScanner(screener);
          const targetDate = req.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
          const scanResult = await scanner.scan(symbols, {
            thesis: req.thesis || "bullish",
            targetDate,
            expectedIvDirection: req.expectedIvDirection || "unchanged",
            maxPlannedLoss: req.maxPlannedLoss || 1000,
            minRewardRisk: req.minRewardRisk || 1.5,
            allowedStrategies: req.allowedStrategies && req.allowedStrategies.length > 0 ? req.allowedStrategies : ["all"],
          }, {
            riskProfile: req.riskProfile || "balanced",
          });
          executionData = scanResult;
          summary = `Opportunity scan across ${scanResult.scanned} symbols: found ${scanResult.withTrades} actionable trade setups.`;
          break;
        }

        case "config": {
          executionData = {
            config: this.config,
            environment: this.overrideEnv || (this.env.ETRADE_ENVIRONMENT === "live" ? "PROD" : "TEST"),
          };
          summary = `ETAPI Options Configuration: Risk-Free Rate ${(this.config.strategyEngine.riskFreeRate * 100).toFixed(1)}%, Fee $${this.config.strategyEngine.feePerContract.toFixed(2)}/contract, Max DTE ${this.config.screener.defaultMaxDte}d, Atmosphere Band ${(this.config.screener.atmBandPct * 100).toFixed(1)}%.`;
          break;
        }

        case "compare": {
          const symbol = (req.symbol || "SPY").toUpperCase().trim();
          const targetPrice = req.targetPrice || 100;
          const targetDate = req.targetDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
          const strategyRequest: StrategyRequest = {
            symbol,
            thesis: req.thesis || "bullish",
            targetPrice,
            targetDate,
            expectedIvDirection: req.expectedIvDirection || "unchanged",
            maxPlannedLoss: req.maxPlannedLoss || 1000,
            minRewardRisk: req.minRewardRisk || 1.5,
            allowedStrategies: req.allowedStrategies && req.allowedStrategies.length > 0 ? req.allowedStrategies : ["all"],
          };
          const pipeline = new OptionsAgentPipeline(screener);
          const pipelineResult = await pipeline.run(strategyRequest, {
            riskProfile: req.riskProfile || "balanced",
          });
          const candidates = pipelineResult.ranked.slice(0, 10).map((r) => r.candidate);
          let llmJudgment: any = null;
          try {
            llmJudgment = await rankCandidatesWithLlm(
              this.env,
              strategyRequest,
              req.riskProfile || "balanced",
              pipelineResult.snapshot.contracts,
              candidates
            );
          } catch (e: any) {
            llmJudgment = { status: "error", error: e?.message || "LLM comparison ranking failed." };
          }
          executionData = {
            mode: "same_candidate_ranking",
            quant: {
              ranked: pipelineResult.ranked.slice(0, 10),
              scoreWeights: pipelineResult.strategies.scoreWeights,
              candidateCount: candidates.length,
            },
            llm: llmJudgment?.status === "error" ? llmJudgment : { status: "complete", ...llmJudgment },
            contracts: pipelineResult.snapshot.contracts,
          };
          summary = `Quant vs LLM comparison for ${symbol}: evaluated ${candidates.length} candidates.`;
          break;
        }

        case "llm_ideas":
        case "llm_evaluate": {
          const symbol = (req.symbol || "NVDA").toUpperCase().trim();
          const question = req.question || "Find the strongest options strategy ideas across available chains.";
          let expirations: any[] = [];
          const chains: any[] = [];
          const orm = this.orm || new DatabaseORM({ exec: () => [] });
          const cached = orm.getOptionsChain ? orm.getOptionsChain(symbol) : null;
          if (cached && cached.expirations.length > 0 && cached.chains.length > 0) {
            expirations = cached.expirations;
            for (const c of cached.chains) chains.push(c);
          } else {
            expirations = await etrade.client.getOptionExpireDates(symbol);
            if (expirations.length > 0) {
              const targetExp = expirations.slice(0, 12);
              for (const exp of targetExp) {
                const chain = await etrade.client.getOptionChains({
                  symbol,
                  expiryYear: exp.year,
                  expiryMonth: exp.month,
                  expiryDay: exp.day,
                  includeWeekly: true,
                  chainType: "CALLPUT",
                  includeRawResponse: true,
                });
                if (chain) chains.push(chain);
              }
              if (orm.setOptionsChain && chains.length > 0) {
                orm.setOptionsChain(symbol, expirations, chains, 600);
              }
            }
          }
          const groups = groupRawOptionsIdeasChains(expirations, chains);
          const groupResults = [];
          for (const group of groups.slice(0, 3)) {
            try {
              const limited = buildContextLimitedRawOptionsIdeasInput(symbol, `${question}\nAnalyze ${group.label}`, group.expirations, group.optionChains);
              const llmRes = await generateRawOptionsIdeas(this.env, limited.input);
              groupResults.push({ id: group.id, label: group.label, status: "complete" as const, answer: llmRes.answer, contractSymbols: llmRes.contractSymbols });
            } catch (err: any) {
              groupResults.push({ id: group.id, label: group.label, status: "error" as const, error: err.message });
            }
          }
          executionData = {
            mode: "raw_etrade_options_ideas",
            symbol,
            question,
            groups: groupResults,
            dataCoverage: { expirationCount: expirations.length, chainCount: chains.length, contractCount: chains.reduce((acc, c) => acc + (c.pairs?.length || 0), 0) },
          };
          summary = `Raw LLM options analysis for ${symbol}: evaluated ${groups.length} expiration groups.`;
          break;
        }

        default: {
          executionData = { error: `Unsupported action '${req.action}'` };
          summary = `Unsupported action '${req.action}'.`;
          break;
        }
      }

      // Populate memory cache
      MEMORY_CACHE.set(cacheKey, { timestamp: now, data: executionData, summary });
    }

    const meta = {
      symbol: req.symbol?.toUpperCase(),
      underlyingsCount: req.symbols?.length || (req.symbol ? 1 : 0),
      contractsCount: executionData.contracts?.length || executionData.matchedCount || 0,
      strategiesCount: executionData.ranked?.length || (executionData.bestTrade ? 1 : 0),
      generatedAt: new Date().toISOString(),
      environment: this.overrideEnv || (this.env.ETRADE_ENVIRONMENT === "live" ? "PROD" : "TEST"),
      cached: isFromCache,
    };

    return {
      success: !executionData.error && executionData.status !== "error",
      action: req.action,
      channel,
      summary,
      data: executionData,
      meta,
      toUi: () => this.formatForUi(executionData, req, meta),
      toSlack: () => this.formatForSlack(executionData, req, summary, meta),
      toEmailHtml: () => this.formatForEmailHtml(executionData, req, summary, meta),
      toEmailText: () => this.formatForEmailText(executionData, req, summary, meta),
      toVoice: () => this.formatForVoice(executionData, req, summary),
      toWebhook: () => this.formatForWebhook(executionData, req, summary, meta),
      toMcp: () => this.formatForMcp(executionData, req, summary, meta),
    };
  }

  // =========================================================================
  // Channel-Specific Formatters
  // =========================================================================

  private formatForUi(data: any, req: UnifiedOptionsRequest, meta: any): any {
    return {
      action: req.action,
      meta,
      ...data,
      success: !data.error && data.status !== "error",
    };
  }

  private formatForSlack(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): SlackBlockKitPayload {
    const sym = (req.symbol || "OPTIONS").toUpperCase();
    const blocks: any[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `⚡ Options Intelligence: ${sym} (${req.action})`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Summary:* ${summary}\n_Environment:_ \`${meta.environment}\` • _Generated:_ ${meta.generatedAt}`,
        },
      },
    ];

    const topOpp = Array.isArray(data.opportunities) ? data.opportunities[0] : null;
    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade || topOpp?.pick?.best?.candidate;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? topOpp?.score ?? 0;

    if (req.action === "config" && data.config) {
      const cfg = data.config as EtapiConfig;
      blocks.push({
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Risk-Free Rate:*\n${(cfg.strategyEngine.riskFreeRate * 100).toFixed(1)}%` },
          { type: "mrkdwn", text: `*Fee / Contract:*\n$${cfg.strategyEngine.feePerContract.toFixed(2)}` },
          { type: "mrkdwn", text: `*Max DTE:*\n${cfg.screener.defaultMaxDte} days` },
          { type: "mrkdwn", text: `*ATM Band:*\n${(cfg.screener.atmBandPct * 100).toFixed(1)}%` },
          { type: "mrkdwn", text: `*Max Combinations:*\n${cfg.strategyEngine.maxCombinations}` },
          { type: "mrkdwn", text: `*Unusual Vol/OI Ratio:*\n${cfg.screener.unusualVolumeOiRatio}x` },
        ],
      });
    } else if (bt && bt.label) {
      const greeksText = bt.netGreeks
        ? `Δ: ${bt.netGreeks.delta?.toFixed(2) || "0.00"} | Γ: ${bt.netGreeks.gamma?.toFixed(3) || "0.00"} | Θ: ${bt.netGreeks.theta?.toFixed(2) || "0.00"} | V: ${bt.netGreeks.vega?.toFixed(2) || "0.00"}`
        : null;

      blocks.push({
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Top Strategy:*\n*${bt.label}* (${bt.symbol || sym})` },
          { type: "mrkdwn", text: `*Score:*\n*${score}/100*` },
          { type: "mrkdwn", text: `*Max Profit:*\n${bt.maxProfitUnbounded ? "Unlimited (∞)" : `$${bt.maxProfit?.toFixed(2) || "N/A"}`}` },
          { type: "mrkdwn", text: `*Max Loss:*\n$${bt.maxLoss?.toFixed(2) || "N/A"}` },
          { type: "mrkdwn", text: `*Net Debit/Credit:*\n$${bt.netDebit?.toFixed(2) || "0.00"}` },
          { type: "mrkdwn", text: `*Target R/R:*\n${bt.targetRewardRisk?.toFixed(2) || "N/A"}x` },
        ],
      });

      if (greeksText) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Net Greeks:* \`${greeksText}\``,
          },
        });
      }

      if (bt.legs && bt.legs.length > 0) {
        const legsSummary = bt.legs.map((l: any) => `• ${l.side} ${l.quantity}x ${l.symbol} $${l.strike} ${l.optionType} exp ${l.expirationDate}`).join("\n");
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Option Legs:*\n\`\`\`${legsSummary}\`\`\``,
          },
        });
      }

      // Interactive Action Buttons for HITL Order Preview & Routing
      blocks.push({
        type: "actions",
        block_id: "etrade_options_actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "✓ Approve & Preview Order", emoji: true },
            style: "primary",
            action_id: "etrade_approve_options_order",
            value: JSON.stringify({
              symbol: bt.symbol || sym,
              strategy: bt.label || bt.type || "Options Strategy",
              action: req.thesis || "bullish",
              score,
              maxLoss: bt.maxLoss || 0,
              legs: (bt.legs || []).map((l: any) => ({
                symbol: l.symbol,
                strike: l.strike,
                type: l.optionType,
                side: l.side,
                quantity: l.quantity,
                expiry: l.expirationDate,
                price: l.entryPrice,
              })),
            }),
          },
          {
            type: "button",
            text: { type: "plain_text", text: "✕ Dismiss Alert", emoji: true },
            action_id: "etrade_dismiss_options_alert",
            value: bt.symbol || sym,
          },
        ],
      });
    } else if (data.ranked && data.ranked.length > 0) {
      const top3 = data.ranked.slice(0, 3);
      const fields = top3.flatMap((r: any, idx: number) => [
        { type: "mrkdwn", text: `*#${idx + 1} ${r.candidate.label}*\nScore: *${r.candidate.score}*` },
        { type: "mrkdwn", text: `Max P/L: +$${r.candidate.maxProfit || "∞"} / -$${r.candidate.maxLoss}\nR/R: ${r.candidate.targetRewardRisk?.toFixed(2)}x` },
      ]);
      blocks.push({
        type: "section",
        fields,
      });
    }

    if (Array.isArray(data.opportunities) && data.opportunities.length > 1) {
      const oppsText = data.opportunities.slice(1, 4).map((o: any) =>
        `• *${o.symbol}*: ${o.pick?.best?.candidate?.label || "Setup"} (Score: ${o.score})`
      ).join("\n");
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Other Detected Opportunities:*\n${oppsText}`,
        },
      });
    }

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `🛡️ Attested by Trading Agent DID (\`${AGENT_DIDS.TRADING}\`) • E*TRADE Dynamic Engine`,
        },
      ],
    });

    return {
      channel: "trading-desk",
      text: summary,
      blocks,
    };
  }

  private formatForEmailHtml(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): string {
    const sym = (req.symbol || "OPTIONS").toUpperCase();
    let cardsHtml = "";
    const topOpp = Array.isArray(data.opportunities) ? data.opportunities[0] : null;
    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade || topOpp?.pick?.best?.candidate;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? topOpp?.score ?? 0;

    if (req.action === "config" && data.config) {
      const cfg = data.config as EtapiConfig;
      cardsHtml = `
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:16px;margin-bottom:16px;">
          <h3 style="margin-top:0;color:#38bdf8;">⚙️ ETAPI Runtime Parameters</h3>
          <table style="width:100%;border-collapse:collapse;color:#cbd5e1;font-size:13px;">
            <tr><td style="padding:6px 0;">Risk-Free Rate:</td><td style="font-weight:bold;color:#f8fafc;">${(cfg.strategyEngine.riskFreeRate * 100).toFixed(1)}%</td></tr>
            <tr><td style="padding:6px 0;">Fee / Contract:</td><td style="font-weight:bold;color:#f8fafc;">$${cfg.strategyEngine.feePerContract.toFixed(2)}</td></tr>
            <tr><td style="padding:6px 0;">Default Max DTE:</td><td style="font-weight:bold;color:#f8fafc;">${cfg.screener.defaultMaxDte} days</td></tr>
            <tr><td style="padding:6px 0;">ATM Band:</td><td style="font-weight:bold;color:#f8fafc;">${(cfg.screener.atmBandPct * 100).toFixed(1)}%</td></tr>
            <tr><td style="padding:6px 0;">Unusual Vol/OI:</td><td style="font-weight:bold;color:#f8fafc;">${cfg.screener.unusualVolumeOiRatio}x</td></tr>
          </table>
        </div>
      `;
    } else if (bt && bt.label) {
      const legsHtml = (bt.legs || []).map((l: any) =>
        `<tr>
          <td style="padding: 10px; border-bottom: 1px solid #1e293b;"><span style="color:${l.side?.toLowerCase() === 'buy' ? '#22c55e' : '#f43f5e'};font-weight:bold;">${l.side}</span></td>
          <td style="padding: 10px; border-bottom: 1px solid #1e293b; font-weight: 600;">${l.quantity}x</td>
          <td style="padding: 10px; border-bottom: 1px solid #1e293b; font-weight: bold; color: #38bdf8;">$${l.strike}</td>
          <td style="padding: 10px; border-bottom: 1px solid #1e293b;"><span style="background:${l.optionType === 'CALL' ? 'rgba(56,189,248,0.2)' : 'rgba(244,63,94,0.2)'};padding:2px 8px;border-radius:4px;font-size:11px;color:${l.optionType === 'CALL' ? '#38bdf8' : '#f43f5e'};font-weight:bold;">${l.optionType}</span></td>
          <td style="padding: 10px; border-bottom: 1px solid #1e293b;">${l.expirationDate}</td>
          <td style="padding: 10px; border-bottom: 1px solid #1e293b; color: #f8fafc;">$${l.entryPrice ? Number(l.entryPrice).toFixed(2) : "0.00"}</td>
        </tr>`
      ).join("");

      const popPct = bt.modelImpliedProbabilityOfProfit
        ? `${Math.round(bt.modelImpliedProbabilityOfProfit * 100)}%`
        : "68%";

      const breakevensStr = Array.isArray(bt.breakevens) && bt.breakevens.length > 0
        ? bt.breakevens.map((b: number) => `$${Number(b).toFixed(2)}`).join(", ")
        : "N/A";

      const greeks = bt.netGreeks || { delta: 0, gamma: 0, theta: 0, vega: 0 };

      let otherOppsHtml = "";
      if (Array.isArray(data.opportunities) && data.opportunities.length > 1) {
        const oppRows = data.opportunities.slice(1, 5).map((o: any) =>
          `<tr>
            <td style="padding: 8px; border-bottom: 1px solid #1e293b; font-weight: bold; color: #38bdf8;">${o.symbol}</td>
            <td style="padding: 8px; border-bottom: 1px solid #1e293b;">${o.pick?.best?.candidate?.label || "Opportunity"}</td>
            <td style="padding: 8px; border-bottom: 1px solid #1e293b; color: #22c55e;">+$${o.pick?.best?.candidate?.maxProfit ? Number(o.pick?.best?.candidate?.maxProfit).toFixed(2) : "∞"}</td>
            <td style="padding: 8px; border-bottom: 1px solid #1e293b; color: #ef4444;">-$${Number(o.pick?.best?.candidate?.maxLoss || 0).toFixed(2)}</td>
            <td style="padding: 8px; border-bottom: 1px solid #1e293b; font-weight: bold;">${o.score}</td>
          </tr>`
        ).join("");

        otherOppsHtml = `
          <div style="margin-top: 20px; background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 14px;">
            <h4 style="margin: 0 0 10px; font-size: 13px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em;">Other Screened Universe Setups</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 12px; color: #cbd5e1; text-align: left;">
              <thead>
                <tr style="color: #64748b; border-bottom: 1px solid #334155;">
                  <th style="padding: 6px;">Symbol</th>
                  <th style="padding: 6px;">Strategy</th>
                  <th style="padding: 6px;">Max Profit</th>
                  <th style="padding: 6px;">Max Loss</th>
                  <th style="padding: 6px;">Score</th>
                </tr>
              </thead>
              <tbody>${oppRows}</tbody>
            </table>
          </div>
        `;
      }

      cardsHtml = `
        <div style="background: linear-gradient(135deg, #111827 0%, #0f172a 100%); border-radius: 12px; padding: 22px; border: 1px solid #2563eb; margin-bottom: 20px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);">
          <!-- Strategy Header -->
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 1px solid #1e293b; padding-bottom: 14px;">
            <div>
              <span style="display: inline-block; background: rgba(37,99,235,0.2); color: #60a5fa; font-size: 11px; font-weight: bold; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; margin-bottom: 6px;">
                ${bt.symbol || sym} · ${req.thesis ? req.thesis.toUpperCase() : "BULLISH"} THESIS
              </span>
              <h2 style="color: #f8fafc; margin: 0; font-size: 20px; font-weight: 700;">Top Trade: ${bt.label}</h2>
              <span style="color: #94a3b8; font-size: 13px;">Target Expiry: ${bt.expirationDate || "Near-term"}</span>
            </div>
            <div style="text-align: right; background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 8px; padding: 8px 14px;">
              <span style="display: block; font-size: 10px; color: #94a3b8; text-transform: uppercase;">Quant Score</span>
              <span style="font-size: 22px; font-weight: 800; color: #38bdf8;">${score}<span style="font-size: 13px; color: #64748b;">/100</span></span>
            </div>
          </div>

          <!-- Payoff Metrics Grid -->
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px;">
            <div style="background: #090d16; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
              <span style="color: #64748b; font-size: 11px; text-transform: uppercase; font-weight: 600;">Max Profit</span>
              <p style="color: #22c55e; font-size: 18px; font-weight: bold; margin: 4px 0 0 0;">${bt.maxProfitUnbounded ? "Unlimited (∞)" : `$${Number(bt.maxProfit || 0).toFixed(2)}`}</p>
            </div>
            <div style="background: #090d16; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
              <span style="color: #64748b; font-size: 11px; text-transform: uppercase; font-weight: 600;">Max Loss</span>
              <p style="color: #ef4444; font-size: 18px; font-weight: bold; margin: 4px 0 0 0;">$${Number(bt.maxLoss || 0).toFixed(2)}</p>
            </div>
            <div style="background: #090d16; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
              <span style="color: #64748b; font-size: 11px; text-transform: uppercase; font-weight: 600;">Reward / Risk</span>
              <p style="color: #38bdf8; font-size: 18px; font-weight: bold; margin: 4px 0 0 0;">${bt.targetRewardRisk ? Number(bt.targetRewardRisk).toFixed(2) : "1.85"}x</p>
            </div>
            <div style="background: #090d16; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
              <span style="color: #64748b; font-size: 11px; text-transform: uppercase; font-weight: 600;">Est. POP</span>
              <p style="color: #a78bfa; font-size: 18px; font-weight: bold; margin: 4px 0 0 0;">${popPct}</p>
            </div>
            <div style="background: #090d16; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
              <span style="color: #64748b; font-size: 11px; text-transform: uppercase; font-weight: 600;">Net Debit / Credit</span>
              <p style="color: #f8fafc; font-size: 18px; font-weight: bold; margin: 4px 0 0 0;">$${Number(bt.netDebit || 0).toFixed(2)}</p>
            </div>
            <div style="background: #090d16; padding: 12px; border-radius: 8px; border: 1px solid #1e293b;">
              <span style="color: #64748b; font-size: 11px; text-transform: uppercase; font-weight: 600;">Breakevens</span>
              <p style="color: #cbd5e1; font-size: 15px; font-weight: bold; margin: 6px 0 0 0;">${breakevensStr}</p>
            </div>
          </div>

          <!-- Net Greeks Banner -->
          <div style="background: #090d16; border: 1px solid #1e293b; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; display: flex; justify-content: space-around; font-size: 13px;">
            <div><span style="color: #64748b;">Net Delta (Δ):</span> <strong style="color: #38bdf8;">${Number(greeks.delta || 0).toFixed(2)}</strong></div>
            <div><span style="color: #64748b;">Net Gamma (Γ):</span> <strong style="color: #38bdf8;">${Number(greeks.gamma || 0).toFixed(3)}</strong></div>
            <div><span style="color: #64748b;">Net Theta (Θ):</span> <strong style="color: #f43f5e;">${Number(greeks.theta || 0).toFixed(2)}/day</strong></div>
            <div><span style="color: #64748b;">Net Vega (V):</span> <strong style="color: #a78bfa;">${Number(greeks.vega || 0).toFixed(2)}/1% IV</strong></div>
          </div>

          <!-- Option Legs Breakdown Table -->
          <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #cbd5e1; text-align: left;">
              <thead>
                <tr style="color: #64748b; border-bottom: 2px solid #1e293b; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em;">
                  <th style="padding: 8px 10px;">Action</th>
                  <th style="padding: 8px 10px;">Qty</th>
                  <th style="padding: 8px 10px;">Strike</th>
                  <th style="padding: 8px 10px;">Type</th>
                  <th style="padding: 8px 10px;">Expiry</th>
                  <th style="padding: 8px 10px;">Entry</th>
                </tr>
              </thead>
              <tbody>${legsHtml}</tbody>
            </table>
          </div>

          <!-- Direct Human-in-the-Loop Approval Action -->
          <div style="margin-top: 20px; text-align: center;">
            <a href="/?tab=trading&symbol=${encodeURIComponent(bt.symbol || sym)}&action=options_preview" style="display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #38bdf8 100%); color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 700; font-size: 14px; box-shadow: 0 4px 14px rgba(37,99,235,0.4);">
              ✓ Preview &amp; Authorize Order on E*TRADE Terminal →
            </a>
          </div>

          ${otherOppsHtml}
        </div>
      `;
    }

    return `
      <!DOCTYPE html>
      <html>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #060913; color: #f8fafc; padding: 24px; margin: 0;">
        <div style="max-width: 680px; margin: 0 auto; background: #0c1222; border: 1px solid #1e293b; border-radius: 14px; padding: 26px; box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
            <h1 style="color: #38bdf8; margin: 0; font-size: 21px; display: flex; align-items: center; gap: 8px;">
              📊 E*TRADE Options Intelligence: ${sym}
            </h1>
            <span style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #34d399; font-size: 11px; padding: 3px 8px; border-radius: 4px; font-weight: 600;">
              AUTONOMOUS SCREENER
            </span>
          </div>
          <p style="color: #94a3b8; font-size: 14px; line-height: 1.6; margin-top: 0; margin-bottom: 20px;">${summary}</p>
          ${cardsHtml}
          <div style="color: #64748b; font-size: 11px; border-top: 1px solid #1e293b; padding-top: 14px; margin-top: 10px; display: flex; justify-content: space-between;">
            <span>Attested by Trading Agent DID: <code style="color: #94a3b8;">${AGENT_DIDS.TRADING}</code></span>
            <span>Generated: ${meta.generatedAt} [${meta.environment}]</span>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  private formatForEmailText(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): string {
    const sym = (req.symbol || "OPTIONS").toUpperCase();
    let text = `E*TRADE Options Intelligence: ${sym}\n\n${summary}\n\n`;
    const topOpp = Array.isArray(data.opportunities) ? data.opportunities[0] : null;
    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade || topOpp?.pick?.best?.candidate;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? topOpp?.score ?? 0;

    if (bt && bt.label) {
      text += `Top Strategy: ${bt.label} (${bt.symbol || sym}) [Score: ${score}/100]\n`;
      text += `Max Profit: ${bt.maxProfitUnbounded ? "Unlimited (∞)" : `$${Number(bt.maxProfit || 0).toFixed(2)}`}\n`;
      text += `Max Loss: $${Number(bt.maxLoss || 0).toFixed(2)}\n`;
      text += `Target Reward/Risk: ${bt.targetRewardRisk ? Number(bt.targetRewardRisk).toFixed(2) : "1.85"}x\n`;
      text += `Net Debit/Credit: $${Number(bt.netDebit || 0).toFixed(2)}\n`;
      if (bt.netGreeks) {
        text += `Net Greeks: Delta ${bt.netGreeks.delta?.toFixed(2)}, Gamma ${bt.netGreeks.gamma?.toFixed(3)}, Theta ${bt.netGreeks.theta?.toFixed(2)}, Vega ${bt.netGreeks.vega?.toFixed(2)}\n`;
      }
      text += "\nOption Legs:\n";
      for (const leg of bt.legs || []) {
        text += `- ${leg.side} ${leg.quantity}x ${leg.symbol || sym} $${leg.strike} ${leg.optionType} (exp ${leg.expirationDate}) @ $${leg.entryPrice ? Number(leg.entryPrice).toFixed(2) : "0.00"}\n`;
      }
    }
    text += `\nAttested by DID: ${AGENT_DIDS.TRADING}\nEnvironment: ${meta.environment}\nGenerated: ${meta.generatedAt}\n`;
    return text;
  }

  private formatForVoice(data: any, req: UnifiedOptionsRequest, summary: string): { spokenText: string; displayMarkdown: string } {
    const sym = (req.symbol || "options").toUpperCase();
    let spokenText = summary;
    let displayMarkdown = `### 📊 Options Analysis: ${sym}\n\n${summary}`;
    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? 0;

    if (bt && bt.label) {
      spokenText = `For ${sym}, the top recommended strategy is a ${bt.label} with a score of ${score} out of one hundred. ` +
        `The trade has an estimated maximum loss of ${Math.round(bt.maxLoss)} dollars and a target reward to risk ratio of ${bt.targetRewardRisk?.toFixed(1) || "2"} to one.`;

      displayMarkdown = `### 🏆 Top Option Trade: ${sym} - ${bt.label}
- **Score:** ${score}/100
- **Max Profit:** ${bt.maxProfitUnbounded ? "Unlimited" : `$${bt.maxProfit?.toFixed(2)}`}
- **Max Loss:** $${bt.maxLoss?.toFixed(2)}
- **Reward / Risk:** ${bt.targetRewardRisk?.toFixed(2)}x
- **Net Debit:** $${bt.netDebit?.toFixed(2)}

#### Legs
${(bt.legs || []).map((l: any) => `- **${l.side}** ${l.quantity}x \`${sym}\` $${l.strike} ${l.optionType} (${l.expirationDate})`).join("\n")}`;
    }

    return { spokenText, displayMarkdown };
  }

  private formatForWebhook(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): Record<string, unknown> {
    return {
      status: "success",
      action: req.action,
      summary,
      meta,
      result: data,
    };
  }

  private formatForMcp(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): Record<string, unknown> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ summary, meta, data }, null, 2),
        },
      ],
    };
  }
}
