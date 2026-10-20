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
import { ETradeSlackTradingService } from "../trading";
import { ETradeEmailTradingService } from "../trading";
import { ETradeWebhookService } from "../services/tradingWebhooks";
import { runWithRouting } from "../models/router";
import { getWorkersAIModel } from "../agents/model";
import { generateText } from "ai";
import type { ScreenerAgent } from "../agents/screener-agent";
import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import {
  getCfpayConfig,
  cfpayPostToSlack,
  cfpaySendEmail,
  cfpaySendEmailWithAttachments,
} from "../services/cfpayA2A";
import { deliverScreenerToSlackA2A } from "../services/screenerSlackDelivery";

export interface ScreenerPublisherDeps {
  env: Env;
  orm?: DatabaseORM;
  userLogin: string;
}

const registeredBuses = new WeakSet<ScreenerEventBus>();

interface ScreenerPdf {
  bytes: Uint8Array;
  fileName: string;
}

/** Fetch this run's PDF, never another concurrent run's latest PDF.
 * #333: errors are logged, not swallowed — a null return means "no PDF
 * stored", never "something broke silently". */
export async function fetchScreenerPdf(deps: ScreenerPublisherDeps, pdfKey?: string): Promise<ScreenerPdf | null> {
  try {
    const ns = (deps.env as any).SCREENER_AGENT;
    if (!ns) {
      console.warn("[ScreenerPublishers] SCREENER_AGENT binding missing — cannot fetch PDF.");
      return null;
    }
    const agentName = deps.userLogin === "default_trader" ? "default" : `screener:${deps.userLogin}`;
    const agent = ns.get(ns.idFromName(agentName)) as unknown as ScreenerAgent;
    return pdfKey ? await agent.getPdfByKey(pdfKey) : await agent.getLatestPdf();
  } catch (err) {
    console.warn("[ScreenerPublishers] fetchScreenerPdf failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Upload the PDF to Slack via files.getUploadURLExternal (issue #269).
 * Falls back to posting the download link when no bot token is configured.
 */
async function deliverPdfToSlack(
  deps: ScreenerPublisherDeps,
  pdf: ScreenerPdf,
  event: ScreenerCompletedEvent,
  plainText: string
): Promise<void> {
  const botToken = deps.env.SLACK_BOT_TOKEN;
  const channel = (deps.env as any).SCREENER_SLACK_CHANNEL || (deps.env as any).SLACK_CHANNEL;
  const reportUrl = `${deps.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/screener/report.pdf${event.pdfKey ? `?key=${encodeURIComponent(event.pdfKey)}` : ""}`;

  if (!botToken) {
    // No bot token: link the downloadable report in the channel message.
    if (channel) {
      try {
        const slack = new ETradeSlackTradingService(deps.env, deps.orm, deps.userLogin);
        await slack.postSlackMessage({
          text: `📄 Screener report PDF: ${reportUrl}`,
          channel,
        } as any);
      } catch (err) {
        console.warn("[ScreenerPublishers] Slack PDF link failed:", err instanceof Error ? err.message : String(err));
      }
    }
    return;
  }

  try {
    // Step 1: get upload URL.
    const getUrl = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        filename: pdf.fileName,
        length: String(pdf.bytes.length),
      }),
    });
    const urlData = (await getUrl.json()) as any;
    if (!urlData.ok) throw new Error(urlData.error || "getUploadURLExternal failed");

    // Step 2: upload bytes.
    const put = await fetch(urlData.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: pdf.bytes as unknown as BodyInit,
    });
    if (!put.ok) throw new Error(`upload PUT failed: ${put.status}`);

    // Step 3: complete.
    const complete = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: `Screener report — ${event.sector} ${event.timestamp.slice(0, 10)}` }],
        channel_id: channel,
        initial_comment: `📄 Screener report PDF — ${event.opportunities.length} opportunities`,
      }),
    });
    const doneData = (await complete.json()) as any;
    if (!doneData.ok) throw new Error(doneData.error || "completeUploadExternal failed");
  } catch (err) {
    console.warn("[ScreenerPublishers] Slack PDF upload failed:", err instanceof Error ? err.message : String(err));
    // Fallback: link.
    try {
      const slack = new ETradeSlackTradingService(deps.env, deps.orm, deps.userLogin);
      await slack.postSlackMessage({
        text: `${plainText}\n\n📄 Report PDF: ${reportUrl}`,
        channel,
      } as any);
    } catch {
      // Already warned above; don't cascade.
    }
  }
}

/** Attach the PDF to the screener email (issue #269). */
async function deliverPdfToEmail(
  deps: ScreenerPublisherDeps,
  pdf: ScreenerPdf,
  event: ScreenerCompletedEvent,
  html: string,
  plainText: string
): Promise<void> {
  const emailTo = (deps.env as any).SCREENER_EMAIL_TO;
  if (!emailTo) return;
  try {
    let base64 = "";
    const chunk = 8192;
    for (let i = 0; i < pdf.bytes.length; i += chunk) {
      base64 += String.fromCharCode(...pdf.bytes.subarray(i, i + chunk));
    }
    const email = new ETradeEmailTradingService(deps.env, deps.orm, deps.userLogin);
    await email.sendOutboundEmail(
      emailTo,
      `📊 Market Screen [${event.sector}] — ${event.opportunities.length} opportunities (PDF attached)`,
      `${html}<p>Full report attached as PDF.</p>`,
      `${plainText}\n\nFull report attached as PDF.`,
      { fileName: pdf.fileName, contentType: "application/pdf", contentBase64: btoa(base64) }
    );
  } catch (err) {
    console.warn("[ScreenerPublishers] Email PDF delivery failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Register all screener publishers on the bus. Idempotent — call once
 * per service instance.
 */
export function registerScreenerPublishers(
  bus: ScreenerEventBus,
  deps: ScreenerPublisherDeps
): void {
  if (registeredBuses.has(bus)) return;
  registeredBuses.add(bus);

  bus.subscribe("screener.completed", (event) =>
    publishCompleted(deps, event as ScreenerCompletedEvent)
  );
  bus.subscribe("screener.failed", (event) =>
    publishFailed(deps, event as ScreenerFailedEvent)
  );
}

/**
 * Issue #218: LLM-generated digest of screener opportunities.
 * Best-effort — returns null if the model is unavailable. The structured
 * delivery path stays deterministic; this only adds a human-readable lead.
 */
export async function generateScreenerDigest(
  env: Env,
  event: ScreenerCompletedEvent
): Promise<string | null> {
  if (event.opportunities.length === 0) return null;
  const summary = event.opportunities.slice(0, 5).map(
    (o) => `${o.symbol} (${o.companyName}) — ${o.signal}, momentum ${o.momentumScore.toFixed(0)}, $${o.lastPrice.toFixed(2)} (${o.changePercent >= 0 ? "+" : ""}${o.changePercent.toFixed(2)}%)`
  ).join("\n");
  const prompt = `Summarize these screener results in one sentence for a trader. ` +
    `Lead with the count and the top names. Be specific, no hype.\n\n` +
    `Universe: ${event.universe || "TECH"}\n${summary}`;
  try {
    const { result } = await runWithRouting("summarize", async (modelName) => {
      const { text } = await generateText({
        model: getWorkersAIModel(env, modelName),
        prompt,
      });
      return text.trim();
    });
    return result || null;
  } catch {
    return null;
  }
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
  const universe = event.universe || "TECH";
  const sectorLabel = event.sector && event.sector !== "ALL" ? ` · ${event.sector}` : "";
  const triggerLabel = event.trigger === "manual" ? "Manual" : "Scheduled";
  const scanned = event.expectedCount && event.expectedCount > event.totalScanned
    ? `Scanned ${event.totalScanned} of ${event.expectedCount} ${universe} stocks, ${event.matchedCount} matched.`
    : `Scanned ${event.totalScanned} ${universe} stocks, ${event.matchedCount} matched.`;
  // Issue #462: a partial quote set yields a qualified partial report — the
  // qualification rides every delivery so it never reads as a complete screen.
  const partialLine = event.partial
    ? `⚠️ Partial screen — qualified results: ${event.partial.quotedCount} of ${event.partial.requestedCount} symbols quoted; ` +
      `${event.partial.failedSymbols.length} unavailable (${event.partial.failedSymbols.slice(0, 5).join(", ")}${event.partial.failedSymbols.length > 5 ? "…" : ""}). ` +
      `Results cover the quoted subset only; no fallback data substituted.`
    : null;
  const text = [
    `📊 Market Screen — ${universe}${sectorLabel} · ${triggerLabel}`,
    scanned,
    ...(partialLine ? [partialLine] : []),
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
    `<h2>📊 Market Screen — ${universe}${sectorLabel} · ${triggerLabel}</h2>`,
    `<p>${scanned}</p>`,
    ...(partialLine ? [`<p><b>${partialLine}</b></p>`] : []),
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

  // Issue #218: prepend an LLM-generated digest (best-effort).
  const digest = await generateScreenerDigest(deps.env, event);
  const textWithDigest = digest ? `💡 ${digest}\n\n${text}` : text;

  // 1. Resolve the exact run's PDF before sending one A2A Slack file
  // notification. Sending a separate summary and then a file generated a
  // duplicate pair of Slack messages for each screen.
  const cfpay = getCfpayConfig(deps.env);
  const slackChannel = (deps.env as any).SCREENER_SLACK_CHANNEL || (deps.env as any).SLACK_CHANNEL;
  const pdf = await fetchScreenerPdf(deps, event.pdfKey);
  const reportUrl = `${deps.env.APP_BASE_URL || "https://agent.openaimp.com"}/api/screener/report.pdf${event.pdfKey ? `?key=${encodeURIComponent(event.pdfKey)}` : ""}`;
  const plainTextWithDigest = digest ? `💡 ${digest}\n\n${plainText}` : plainText;
  const slackBody = pdf || cfpay
    ? plainTextWithDigest
    : `${plainTextWithDigest}${event.pdfKey ? `\n\n📄 PDF report: ${reportUrl}` : ""}`;
  if (cfpay) {
    const delivery = await deliverScreenerToSlackA2A(deps.env, {
      text: plainTextWithDigest,
      channel: slackChannel,
      ...(pdf ? {
        pdf: {
          ...pdf,
          title: `Market Screen — ${event.universe || "TECH"} ${event.timestamp.slice(0, 10)}`,
          comment: plainText,
        },
      } : {}),
    });
    if (!delivery.ok) {
      console.warn("[ScreenerPublishers] Slack A2A delivery failed:", delivery.error);
    }
  } else if (deps.env.SLACK_BOT_TOKEN || deps.env.SLACK_WEBHOOK_URL) {
    try {
      if (pdf && deps.env.SLACK_BOT_TOKEN) {
        await deliverPdfToSlack(deps, pdf, event, plainText);
      } else {
        const slack = new ETradeSlackTradingService(deps.env, deps.orm, deps.userLogin);
        await slack.postSlackMessage({ text: slackBody, channel: slackChannel } as any);
      }
    } catch (err) {
      console.warn("[ScreenerPublishers] Slack publish failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // 2. Email — try cfpay via A2A first, fall back to local.
  const emailTo = (deps.env as any).SCREENER_EMAIL_TO;
  if (emailTo) {
    let emailOk = false;
    if (cfpay) {
      let r;
      if (pdf) {
        let binary = "";
        for (let i = 0; i < pdf.bytes.length; i += 8192) binary += String.fromCharCode(...pdf.bytes.subarray(i, i + 8192));
        r = await cfpaySendEmailWithAttachments(cfpay, {
          to: emailTo,
          subject: `📊 Market Screen [${event.universe || event.sector}] — ${event.opportunities.length} opportunities`,
          body: plainText,
          attachments: [{ filename: pdf.fileName, contentB64: btoa(binary), contentType: "application/pdf" }],
        });
      } else {
        r = await cfpaySendEmail(cfpay, emailTo,
          `📊 Market Screen [${event.universe || event.sector}] — ${event.opportunities.length} opportunities`, plainText);
      }
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
          `📊 Market Screen [${event.universe || event.sector}] — ${event.opportunities.length} opportunities`,
          `${html}${pdf ? `<p>Full report attached: ${pdf.fileName}</p>` : ""}`,
          `${plainText}${reportUrl ? `\n\nPDF report: ${reportUrl}` : ""}`,
          pdf ? (() => {
            let binary = "";
            for (let i = 0; i < pdf.bytes.length; i += 8192) binary += String.fromCharCode(...pdf.bytes.subarray(i, i + 8192));
            return { fileName: pdf.fileName, contentType: "application/pdf", contentBase64: btoa(binary) };
          })() : undefined
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
          reportUrl: event.pdfKey ? reportUrl : undefined,
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
  const triggerLabel = event.trigger === "manual" ? "Manual" : "Scheduled";
  const text = `⚠️ Market Screen FAILED — ${event.universe || "TECH"}${event.sector && event.sector !== "ALL" ? ` · ${event.sector}` : ""} · ${triggerLabel}\nError: ${event.error}\n_Time: ${event.timestamp}_`;

  const cfpay = getCfpayConfig(deps.env);
  const slackChannel = (deps.env as any).SCREENER_SLACK_CHANNEL || (deps.env as any).SLACK_CHANNEL;
  if (cfpay) {
    const result = await deliverScreenerToSlackA2A(deps.env, { text });
    if (!result.ok) console.warn("[ScreenerPublishers] Slack A2A failure-notify failed:", result.error);
  } else if (deps.env.SLACK_BOT_TOKEN || deps.env.SLACK_WEBHOOK_URL) {
    try {
      const slack = new ETradeSlackTradingService(deps.env, deps.orm, deps.userLogin);
      await slack.postSlackMessage({ text, channel: slackChannel } as any);
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

/** Shared entry points for manual routes; scheduled runs use the same bus subscribers. */
export function publishScreenerCompleted(
  deps: ScreenerPublisherDeps,
  event: ScreenerCompletedEvent,
): Promise<void> {
  return publishCompleted(deps, event);
}

export function publishScreenerFailed(
  deps: ScreenerPublisherDeps,
  event: ScreenerFailedEvent,
): Promise<void> {
  return publishFailed(deps, event);
}
