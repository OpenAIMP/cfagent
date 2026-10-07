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

export type UnifiedOptionsAction =
  | "screen"
  | "strategies"
  | "best_trade"
  | "opportunities"
  | "recommend"
  | "compare";

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
            allowedStrategies: req.allowedStrategies || [],
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
            allowedStrategies: req.allowedStrategies || [],
          }, {
            riskProfile: req.riskProfile || "balanced",
          });
          executionData = scanResult;
          summary = `Opportunity scan across ${scanResult.scanned} symbols: found ${scanResult.withTrades} actionable trade setups.`;
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

    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? 0;

    if (bt && bt.label) {
      blocks.push({
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Top Strategy:*\n*${bt.label}*` },
          { type: "mrkdwn", text: `*Score:*\n${score}/100` },
          { type: "mrkdwn", text: `*Max Profit:*\n${bt.maxProfitUnbounded ? "Unlimited" : `$${bt.maxProfit?.toFixed(2) || "N/A"}`}` },
          { type: "mrkdwn", text: `*Max Loss:*\n$${bt.maxLoss?.toFixed(2) || "N/A"}` },
          { type: "mrkdwn", text: `*Net Debit/Credit:*\n$${bt.netDebit?.toFixed(2) || "0.00"}` },
          { type: "mrkdwn", text: `*Target R/R:*\n${bt.targetRewardRisk?.toFixed(2) || "N/A"}x` },
        ],
      });
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
    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? 0;

    if (bt && bt.label) {
      const legsHtml = (bt.legs || []).map((l: any) =>
        `<tr>
          <td style="padding: 8px; border-bottom: 1px solid #334155;"><strong>${l.side}</strong></td>
          <td style="padding: 8px; border-bottom: 1px solid #334155;">${l.quantity}</td>
          <td style="padding: 8px; border-bottom: 1px solid #334155;">$${l.strike}</td>
          <td style="padding: 8px; border-bottom: 1px solid #334155;">${l.optionType}</td>
          <td style="padding: 8px; border-bottom: 1px solid #334155;">${l.expirationDate}</td>
          <td style="padding: 8px; border-bottom: 1px solid #334155;">$${l.entryPrice?.toFixed(2)}</td>
        </tr>`
      ).join("");

      cardsHtml = `
        <div style="background: #1e293b; border-radius: 8px; padding: 20px; border: 1px solid #3b82f6; margin-bottom: 20px;">
          <h2 style="color: #60a5fa; margin-top: 0;">Top Recommendation: ${bt.label}</h2>
          <p style="color: #94a3b8; font-size: 14px;">Overall Quantitative Score: <strong style="color: #38bdf8; font-size: 18px;">${score}/100</strong></p>
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px;">
            <div style="background: #0f172a; padding: 10px; border-radius: 6px;">
              <span style="color: #64748b; font-size: 12px;">MAX PROFIT</span>
              <p style="color: #22c55e; font-weight: bold; margin: 4px 0 0 0;">${bt.maxProfitUnbounded ? "Unlimited" : `$${bt.maxProfit?.toFixed(2)}`}</p>
            </div>
            <div style="background: #0f172a; padding: 10px; border-radius: 6px;">
              <span style="color: #64748b; font-size: 12px;">MAX LOSS</span>
              <p style="color: #ef4444; font-weight: bold; margin: 4px 0 0 0;">$${bt.maxLoss?.toFixed(2)}</p>
            </div>
            <div style="background: #0f172a; padding: 10px; border-radius: 6px;">
              <span style="color: #64748b; font-size: 12px;">REWARD / RISK</span>
              <p style="color: #38bdf8; font-weight: bold; margin: 4px 0 0 0;">${bt.targetRewardRisk?.toFixed(2)}x</p>
            </div>
          </div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #cbd5e1; text-align: left;">
            <thead>
              <tr style="color: #94a3b8; border-bottom: 2px solid #334155;">
                <th style="padding: 8px;">Action</th>
                <th style="padding: 8px;">Qty</th>
                <th style="padding: 8px;">Strike</th>
                <th style="padding: 8px;">Type</th>
                <th style="padding: 8px;">Expiry</th>
                <th style="padding: 8px;">Entry</th>
              </tr>
            </thead>
            <tbody>${legsHtml}</tbody>
          </table>
        </div>
      `;
    }

    return `
      <!DOCTYPE html>
      <html>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f8fafc; padding: 24px;">
        <div style="max-width: 680px; margin: 0 auto; background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 24px;">
          <h1 style="color: #38bdf8; margin-top: 0; font-size: 22px;">📊 E*TRADE Options Intelligence: ${sym}</h1>
          <p style="color: #cbd5e1; font-size: 15px; line-height: 1.5;">${summary}</p>
          ${cardsHtml}
          <p style="color: #64748b; font-size: 12px; border-top: 1px solid #1f2937; padding-top: 12px;">
            Attested by DID <code>${AGENT_DIDS.TRADING}</code> • Generated at ${meta.generatedAt} [${meta.environment}]
          </p>
        </div>
      </body>
      </html>
    `;
  }

  private formatForEmailText(data: any, req: UnifiedOptionsRequest, summary: string, meta: any): string {
    const sym = (req.symbol || "OPTIONS").toUpperCase();
    let text = `E*TRADE Options Intelligence: ${sym}\n\n${summary}\n\n`;
    const bt = data.bestTrade?.best?.candidate || data.bestTrade?.candidate || data.bestTrade;
    const score = data.bestTrade?.best?.compositeScore ?? bt?.score ?? 0;

    if (bt && bt.label) {
      text += `Top Strategy: ${bt.label} (Score: ${score}/100)\n`;
      text += `Max Profit: ${bt.maxProfitUnbounded ? "Unlimited" : `$${bt.maxProfit}`}\n`;
      text += `Max Loss: $${bt.maxLoss}\n`;
      text += `Target Reward/Risk: ${bt.targetRewardRisk?.toFixed(2)}x\n`;
      text += `Net Debit: $${bt.netDebit?.toFixed(2)}\n\n`;
      text += "Option Legs:\n";
      for (const leg of bt.legs || []) {
        text += `- ${leg.side} ${leg.quantity}x $${leg.strike} ${leg.optionType} (exp ${leg.expirationDate}) @ $${leg.entryPrice}\n`;
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
