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
  artifacts: Array<{ key: string; fileName: string; kind?: "pdf" | "xlsx" }>;
}

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function createFollowupDeliveryPort(deps: FollowupDeliveryDeps): {
  deliver: (input: FollowupDeliveryInput) => Promise<{ ok: boolean; error?: string; detail?: string }>;
  notify: (input: { channel: AsyncJobChannel; userLogin: string; text: string; emailTo?: string; slackChannel?: string }) => Promise<{ ok: boolean; error?: string; detail?: string }>;
} {
  return {
    deliver: async ({ channel, userLogin, outcome, artifacts }) => {
      const config = resolveScreenerFollowupConfig(deps.env as unknown as Record<string, unknown>);
      const text = formatFollowupDeliveryText(outcome);
      const agent = deps.getScreenerAgent(userLogin);
      // Issue #1191 (#1173 R3): fetch bytes per artifact kind — PDF
      // via the PDF getters, XLSX via the XLSX getter (stock runs;
      // options XLSX is R3b). A missing artifact is recorded in the
      // missing list and reported in the delivery detail — the rest
      // still sends; nothing is fabricated.
      const files: Array<{ bytes: Uint8Array; fileName: string; contentType: string }> = [];
      const missingArtifacts: string[] = [];
      for (const artifact of artifacts) {
        const kind = artifact.kind ?? (artifact.fileName.endsWith(".xlsx") ? "xlsx" : "pdf");
        const fetched = kind === "xlsx"
          ? (outcome.kind === "stock" ? await agent.getXlsxByKey(artifact.key) : null)
          : outcome.kind === "stock"
            ? await agent.getPdfByKey(artifact.key)
            : await agent.getOptionsPdfByKey(artifact.key);
        if (fetched) {
          files.push({
            bytes: fetched.bytes,
            fileName: fetched.fileName,
            contentType: kind === "xlsx" ? XLSX_CONTENT_TYPE : "application/pdf",
          });
        } else {
          missingArtifacts.push(artifact.key);
        }
      }
      const missingNote = missingArtifacts.length > 0
        ? `Artifact(s) missing from storage, not attached: ${missingArtifacts.join(", ")}`
        : undefined;
      if (channel === "slack") {
        const pdfFile = files.find((f) => f.contentType === "application/pdf");
        const rest = files.filter((f) => f !== pdfFile);
        const sent = await deliverScreenerToSlack(deps.env, {
          text,
          channel: outcome.slackChannel ?? config.channels.slack.channel,
          ...(pdfFile ? { pdf: { bytes: pdfFile.bytes, fileName: pdfFile.fileName, title: `Screener report — ${outcome.kind} screen`, comment: text } } : {}),
          ...(rest.length > 0 ? { files: rest.map((f) => ({ bytes: f.bytes, fileName: f.fileName, title: f.fileName })) } : {}),
        });
        return missingNote && sent.ok ? { ...sent, detail: missingNote } : sent;
      }
      if (channel === "email") {
        const to = outcome.emailTo ?? config.channels.email.to;
        if (!to) return { ok: false, error: "Email delivery is not configured (SCREENER_EMAIL_TO is unset)." };
        // Issue #1191: attach EVERY artifact (text + PDF + XLSX),
        // each with its own content type — the pre-R3 leg attached
        // only the first file, as PDF.
        const attachments = files.map((f) => {
          let binary = "";
          for (let i = 0; i < f.bytes.length; i += 8192) binary += String.fromCharCode(...f.bytes.subarray(i, i + 8192));
          return { fileName: f.fileName, contentType: f.contentType, contentBase64: btoa(binary) };
        });
        const scope = outcome.kind === "stock" ? outcome.universe : outcome.thesis;
        const email = new ETradeEmailTradingService(deps.env, deps.getOrm(), userLogin);
        await email.sendOutboundEmail(
          to,
          `📊 ${outcome.kind === "stock" ? "Stock" : "Options"} Screen${scope ? ` [${scope}]` : ""} — ${outcome.matchedCount ?? "?"} matched`,
          `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`,
          text,
          attachments.length > 0 ? attachments : undefined,
        );
        return { ok: true, ...(missingNote ? { detail: missingNote } : {}) };
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
    notify: async ({ channel, userLogin, text, emailTo, slackChannel }) => {
      const config = resolveScreenerFollowupConfig(deps.env as unknown as Record<string, unknown>);
      if (channel === "slack") {
        // Issue #1191: per-task channel wins, mirroring deliveries.
        return deliverScreenerToSlack(deps.env, { text, channel: slackChannel ?? config.channels.slack.channel });
      }
      if (channel === "email") {
        // Issue #1191 (#1173 R3): per-task recipient wins, mirroring
        // the executor's allowlist check on the same address.
        const to = emailTo ?? config.channels.email.to;
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
