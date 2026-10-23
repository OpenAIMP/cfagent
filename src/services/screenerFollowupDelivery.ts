/**
 * Issue #1123 S3: the delivery port behind followup.deliver jobs —
 * content + transport for one channel, sharing the single report
 * artifact the report sub-job secured. Kept out of orchestrator.ts
 * (size budget, #992): the class wires it into the async-job context
 * with its env/orm/ScreenerAgent accessors.
 *
 * Slack reuses the platform's unified delivery (A2A first, direct
 * fallback); email reuses the outbound email service with the report
 * attached; webhook reuses the outbound webhook service. The executor
 * owns policy (allowlist/skip); this module owns sending.
 */

import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import type { ScreenerAgent } from "../agents/screener-agent";
import { ETradeEmailTradingService } from "../trading";
import { ETradeWebhookService } from "./tradingWebhooks";
import { deliverScreenerToSlack } from "./screenerSlackDelivery";
import {
  formatFollowupDeliveryText,
  resolveScreenerFollowupConfig,
  type ScreenerRunOutcome,
} from "./screenerFollowups";
import type { AsyncJobChannel } from "../types";

export interface FollowupDeliveryDeps {
  env: Env;
  getOrm: () => DatabaseORM;
  getScreenerAgent: (userLogin?: string) => ScreenerAgent;
}

export interface FollowupDeliveryInput {
  channel: AsyncJobChannel;
  userLogin: string;
  outcome: ScreenerRunOutcome;
  artifacts: Array<{ key: string; fileName: string }>;
}

export function createFollowupDeliveryPort(deps: FollowupDeliveryDeps): {
  deliver: (input: FollowupDeliveryInput) => Promise<{ ok: boolean; error?: string; detail?: string }>;
  notify: (input: { channel: AsyncJobChannel; userLogin: string; text: string }) => Promise<{ ok: boolean; error?: string; detail?: string }>;
} {
  return {
    deliver: async ({ channel, userLogin, outcome, artifacts }) => {
      const config = resolveScreenerFollowupConfig(deps.env as unknown as Record<string, unknown>);
      const text = formatFollowupDeliveryText(outcome);
      const agent = deps.getScreenerAgent(userLogin);
      const files: Array<{ bytes: Uint8Array; fileName: string }> = [];
      for (const artifact of artifacts) {
        const pdf = outcome.kind === "stock"
          ? await agent.getPdfByKey(artifact.key)
          : await agent.getOptionsPdfByKey(artifact.key);
        if (pdf) files.push({ bytes: pdf.bytes, fileName: pdf.fileName });
      }
      if (channel === "slack") {
        const [first, ...rest] = files;
        return deliverScreenerToSlack(deps.env, {
          text,
          channel: outcome.slackChannel ?? config.channels.slack.channel,
          ...(first ? { pdf: { bytes: first.bytes, fileName: first.fileName, title: `Screener report — ${outcome.kind} screen`, comment: text } } : {}),
          ...(rest.length > 0 ? { files: rest.map((f) => ({ bytes: f.bytes, fileName: f.fileName, title: f.fileName })) } : {}),
        });
      }
      if (channel === "email") {
        const to = outcome.emailTo ?? config.channels.email.to;
        if (!to) return { ok: false, error: "Email delivery is not configured (SCREENER_EMAIL_TO is unset)." };
        const first = files[0];
        let attachment: { fileName: string; contentType: string; contentBase64: string } | undefined;
        if (first) {
          let binary = "";
          for (let i = 0; i < first.bytes.length; i += 8192) binary += String.fromCharCode(...first.bytes.subarray(i, i + 8192));
          attachment = { fileName: first.fileName, contentType: "application/pdf", contentBase64: btoa(binary) };
        }
        const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
        const email = new ETradeEmailTradingService(deps.env, deps.getOrm(), userLogin);
        await email.sendOutboundEmail(
          to,
          `📊 ${outcome.kind === "stock" ? "Stock" : "Options"} Screen${scope ? ` [${scope}]` : ""} — ${outcome.matchedCount ?? "?"} matched`,
          `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
          text,
          attachment,
        );
        return { ok: true };
      }
      const webhookUrl = outcome.webhookUrl ?? config.channels.webhook.url;
      if (!webhookUrl) return { ok: false, error: "Webhook delivery is not configured (SCREENER_WEBHOOK_URL is unset)." };
      const webhook = new ETradeWebhookService(deps.getOrm(), deps.env, userLogin);
      await webhook.dispatchOutboundWebhook(
        "screener.completed",
        {
          kind: outcome.kind,
          universe: outcome.universe,
          thesis: outcome.thesis,
          totalScanned: outcome.totalScanned,
          matchedCount: outcome.matchedCount,
          reportUrl: outcome.reportUrl,
          artifacts: artifacts.map((a) => a.key),
        },
        webhookUrl,
      );
      return { ok: true };
    },
    // Issue #1123 S4: text-only lifecycle notifications (no artifact).
    notify: async ({ channel, userLogin, text }) => {
      const config = resolveScreenerFollowupConfig(deps.env as unknown as Record<string, unknown>);
      if (channel === "slack") {
        return deliverScreenerToSlack(deps.env, { text, channel: config.channels.slack.channel });
      }
      if (channel === "email") {
        const to = config.channels.email.to;
        if (!to) return { ok: false, error: "Email notification is not configured (SCREENER_EMAIL_TO is unset)." };
        const email = new ETradeEmailTradingService(deps.env, deps.getOrm(), userLogin);
        await email.sendOutboundEmail(
          to,
          text.split("\n")[0].slice(0, 120),
          `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
          text,
        );
        return { ok: true };
      }
      return { ok: false, error: "Webhook is a delivery channel, not a notification channel." };
    },
  };
}
