/**
 * Issue #210: Screener result publishers (Slack, email, webhook).
 *
 * These are the pub/sub subscribers that harvest the screener's value.
 * Each subscribes to the screener event bus; when a screen completes
 * (or fails), the publisher notifies its channel independently — a
 * failure in one never blocks the others (the bus catches per-handler
 * errors).
 *
 * Configuration (env vars):
 * - CFPAY_A2A_TOKEN: use cfpay's agents via A2A (tried first)
 * - SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL: local Slack fallback
 * - SCREENER_EMAIL_TO: enables email publishing (local fallback)
 * - OUTBOUND_WEBHOOK_URL: enables webhook publishing (local only;
 *   cfpay has no outbound webhook dispatch via A2A)
 *
 * Issue #215: cfpay via A2A is tried first; local services are the fallback.
 */

import {
  ScreenerEventBus,
  type ScreenerCompletedEvent,
  type ScreenerFailedEvent,
} from "./screenerEvents";
import { ETradeSlackTradingService } from "../trading/slack/agent";
import { ETradeEmailTradingService } from "../trading/email/agent";
import { ETradeWebhookService } from "../services/tradingWebhooks";
import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import {
  getCfpayConfig,
  cfpayPostToSlack,
  cfpaySendEmail,
} from "../services/cfpayA2A";

export interface ScreenerPublisherDeps {
  env: Env;
  orm?: DatabaseORM;
  userLogin: string;
}

/**
 * Register all screener publishers on the bus. Idempotent — call once
 * per service instance.
 */
export function registerScreenerPublishers(
  bus: ScreenerEventBus,
  deps: ScreenerPublisherDeps
): void {
  bus.subscribe("screener.completed", (event) =>
    publishCompleted(deps, event as ScreenerCompletedEvent)
  );
  bus.subscribe("screener.failed", (event) =>
    publishFailed(deps, event as ScreenerFailedEvent)
  );
}

function formatOpportunities(
  event: ScreenerCompletedEvent
): { text: string; html: string } {
  const lines = event.opportunities.map(
    (o, i) =>
      `${i + 1}. *${o.symbol}* (${o.companyName}) — ${o.signal} | ` +
      `momentum ${o.momentumScore.toFixed(0)} | $${o.lastPrice.toFixed(2)} ` +
      `(${o.changePercent >= 0 ? "+" : ""}${o.changePercent.toFixed(2)}%)`
  );
  const text = [
    `📊 Market Screen — ${event.sector} sector`,
    `Scanned ${event.totalScanned} stocks, ${event.matchedCount} matched.`,
    ``,
    ...lines,
    ``,
    `_Completed ${event.timestamp}_`,
  ].join("\n");

  const htmlRows = event.opportunities
    .map(
      (o) =>
        `<tr><td><b>${o.symbol}</b></td><td>${o.companyName}</td>` +
        `<td>${o.signal}</td><td>${o.momentumScore.toFixed(0)}</td>` +
        `<td>$${o.lastPrice.toFixed(2)}</td>` +
        `<td>${o.changePercent >= 0 ? "+" : ""}${o.changePercent.toFixed(2)}%</td></tr>`
    )
    .join("");
  const html = [
    `<h2>📊 Market Screen — ${event.sector} sector</h2>`,
    `<p>Scanned ${event.totalScanned} stocks, ${event.matchedCount} matched.</p>`,
    `<table border="1" cellpadding="6" cellspacing="0">`,
    `<tr><th>Symbol</th><th>Company</th><th>Signal</th><th>Momentum</th><th>Price</th><th>Change</th></tr>`,
    htmlRows,
    `</table>`,
    `<p><i>Completed ${event.timestamp}</i></p>`,
  ].join("\n");
  return { text, html };
}

async function publishCompleted(
  deps: ScreenerPublisherDeps,
  event: ScreenerCompletedEvent
): Promise<void> {
  const { text, html } = formatOpportunities(event);
  const plainText = text.replace(/\*/g, "");

  // 1. Slack — try cfpay via A2A first, fall back to local.
  const cfpay = getCfpayConfig(deps.env);
  let slackOk = false;
  if (cfpay) {
    const r = await cfpayPostToSlack(cfpay, plainText);
    slackOk = r.ok;
    if (!r.ok) {
      console.warn("[ScreenerPublishers] cfpay Slack failed, falling back to local:", r.error);
    }
  }
  if (!slackOk && (deps.env.SLACK_BOT_TOKEN || deps.env.SLACK_WEBHOOK_URL)) {
    try {
      const slack = new ETradeSlackTradingService(deps.env, deps.orm, deps.userLogin);
      await slack.postSlackMessage({
        text: plainText,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text },
          },
        ],
      } as any);
    } catch (err) {
      console.warn("[ScreenerPublishers] Slack publish failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // 2. Email — try cfpay via A2A first, fall back to local.
  const emailTo = (deps.env as any).SCREENER_EMAIL_TO;
  if (emailTo) {
    let emailOk = false;
    if (cfpay) {
      const r = await cfpaySendEmail(
        cfpay,
        emailTo,
        `📊 Market Screen [${event.sector}] — ${event.opportunities.length} opportunities`,
        plainText
      );
      emailOk = r.ok;
      if (!r.ok) {
        console.warn("[ScreenerPublishers] cfpay Email failed, falling back to local:", r.error);
      }
    }
    if (!emailOk) {
      try {
        const email = new ETradeEmailTradingService(deps.env, deps.orm, deps.userLogin);
        await email.sendOutboundEmail(
          emailTo,
          `📊 Market Screen [${event.sector}] — ${event.opportunities.length} opportunities`,
          html,
          plainText
        );
      } catch (err) {
        console.warn("[ScreenerPublishers] Email publish failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  // 3. Webhook
  const webhookUrl = (deps.env as any).OUTBOUND_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const webhook = new ETradeWebhookService(deps.orm, deps.env, deps.userLogin);
      await webhook.dispatchOutboundWebhook(
        "screener.completed",
        {
          sector: event.sector,
          totalScanned: event.totalScanned,
          matchedCount: event.matchedCount,
          opportunities: event.opportunities,
          timestamp: event.timestamp,
        },
        webhookUrl
      );
    } catch (err) {
      console.warn("[ScreenerPublishers] Webhook publish failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

async function publishFailed(
  deps: ScreenerPublisherDeps,
  event: ScreenerFailedEvent
): Promise<void> {
  const text = `⚠️ Market Screen FAILED — ${event.sector} sector\nError: ${event.error}\n_Time: ${event.timestamp}_`;

  if (deps.env.SLACK_BOT_TOKEN || deps.env.SLACK_WEBHOOK_URL) {
    try {
      const slack = new ETradeSlackTradingService(deps.env, deps.orm, deps.userLogin);
      await slack.postSlackMessage({ text } as any);
    } catch (err) {
      console.warn("[ScreenerPublishers] Slack failure-notify failed:", err instanceof Error ? err.message : String(err));
    }
  }

  const webhookUrl = (deps.env as any).OUTBOUND_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const webhook = new ETradeWebhookService(deps.orm, deps.env, deps.userLogin);
      await webhook.dispatchOutboundWebhook(
        "screener.failed",
        { sector: event.sector, error: event.error, timestamp: event.timestamp },
        webhookUrl
      );
    } catch (err) {
      console.warn("[ScreenerPublishers] Webhook failure-notify failed:", err instanceof Error ? err.message : String(err));
    }
  }
}
