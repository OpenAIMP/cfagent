/**
 * Unified Screener Slack delivery service.
 *
 * Implements both:
 * 1. Direct Slack Web API / Webhook delivery (primary direct integration).
 * 2. cfpay Agent-to-Agent (A2A) protocol delivery (additive option).
 *
 * Contract: A2A is an additive capability and never replaces or breaks direct
 * Slack delivery. Bi-directional fallback ensures reports reach the user
 * even if one transport encounters an error.
 */

import {
  cfpayPostFileToSlack,
  cfpayPostToSlack,
  getCfpayConfig,
} from "./cfpayA2A";
import { postFilesToSlack, type SlackFile, type SlackFilesEnv } from "./slackFiles";

export interface ScreenerSlackPdf {
  bytes: Uint8Array;
  fileName: string;
  title: string;
  comment: string;
}

export interface ScreenerSlackFile {
  bytes: Uint8Array;
  fileName: string;
  title: string;
  comment?: string;
}

export interface ScreenerSlackDelivery {
  text: string;
  channel?: string;
  pdf?: ScreenerSlackPdf;
  files?: ScreenerSlackFile[];
}

/** Deliver a screener result directly to Slack via Bot Web API or incoming webhook. */
export async function deliverScreenerToSlackDirect(
  env: unknown,
  delivery: ScreenerSlackDelivery,
): Promise<{ ok: boolean; error?: string }> {
  const e = env as Record<string, unknown> & SlackFilesEnv;
  const channel = delivery.channel ||
    e.SLACK_CHANNEL_ID ||
    (e.SCREENER_SLACK_CHANNEL as string | undefined) ||
    (e.SLACK_CHANNEL as string | undefined);

  const token = e.SLACK_BOT_TOKEN as string | undefined;
  const webhookUrl = e.SLACK_WEBHOOK_URL as string | undefined;

  if (!token && !webhookUrl) {
    return { ok: false, error: "Neither SLACK_BOT_TOKEN nor SLACK_WEBHOOK_URL is configured for direct delivery" };
  }

  // 1. If we have files to upload and a Bot Token is present, use external upload API
  const filesToUpload: ScreenerSlackFile[] = [
    ...(delivery.pdf ? [delivery.pdf] : []),
    ...(delivery.files ?? []),
  ];

  if (filesToUpload.length > 0 && token && channel) {
    const slackFiles: SlackFile[] = filesToUpload.map((f) => {
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < f.bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...f.bytes.subarray(i, i + chunkSize));
      }
      return {
        filename: f.fileName,
        contentB64: btoa(binary),
        title: f.title || f.fileName,
      };
    });

    const uploadRes = await postFilesToSlack(
      {
        SLACK_BOT_TOKEN: token,
        SLACK_CHANNEL_ID: channel,
        SCREENER_SLACK_CHANNEL: channel,
        SLACK_CHANNEL: channel,
      },
      delivery.text,
      slackFiles
    );

    if (uploadRes.posted > 0) {
      return { ok: true };
    }
    console.warn("[deliverScreenerToSlackDirect] Direct file upload failed, falling back to message text post:", uploadRes.error);
  }

  // 2. Fall back to posting plain text via Web API or webhook
  if (token && channel) {
    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel, text: delivery.text }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (data.ok) return { ok: true };
      console.warn("[deliverScreenerToSlackDirect] chat.postMessage failed:", data.error);
    } catch (err) {
      console.warn("[deliverScreenerToSlackDirect] chat.postMessage error:", err);
    }
  }

  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: delivery.text }),
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `Webhook returned HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { ok: false, error: "Direct Slack message post failed" };
}

/** Deliver a screener result through the Slack A2A agent, attaching its PDF when available. */
export async function deliverScreenerToSlackA2A(
  env: unknown,
  delivery: ScreenerSlackDelivery,
): Promise<{ ok: boolean; error?: string }> {
  const config = getCfpayConfig(env);
  if (!config) return { ok: false, error: "CFPAY_A2A_TOKEN is not configured" };

  const e = env as Record<string, unknown>;
  const channel = delivery.channel ||
    (e.SCREENER_SLACK_CHANNEL as string | undefined) ||
    (e.SLACK_CHANNEL as string | undefined);

  if (delivery.pdf && channel) {
    const bytes = delivery.pdf.bytes;
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const result = await cfpayPostFileToSlack(config, {
      channel,
      filename: delivery.pdf.fileName,
      contentB64: btoa(binary),
      title: delivery.pdf.title,
      initial_comment: delivery.pdf.comment,
    });
    if (result.ok) {
      return { ok: true };
    }
    console.warn("[deliverScreenerToSlackA2A] PDF upload via cfpay A2A failed, falling back to text post:", result.error);
  }

  const result = await cfpayPostToSlack(config, delivery.text, channel);
  return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
}

/**
 * Master Slack delivery entry point.
 *
 * Tries A2A if configured; automatically falls back to direct Slack (bot token
 * or webhook) if A2A is unavailable or encounters an error. If A2A is not configured,
 * directly uses direct Slack.
 */
export async function deliverScreenerToSlack(
  env: unknown,
  delivery: ScreenerSlackDelivery,
): Promise<{ ok: boolean; method: "a2a" | "direct"; error?: string }> {
  const cfpay = getCfpayConfig(env);
  if (cfpay) {
    const a2aRes = await deliverScreenerToSlackA2A(env, delivery);
    if (a2aRes.ok) return { ok: true, method: "a2a" };
    console.warn("[deliverScreenerToSlack] A2A delivery failed, attempting direct Slack fallback:", a2aRes.error);
  }

  const directRes = await deliverScreenerToSlackDirect(env, delivery);
  if (directRes.ok) return { ok: true, method: "direct" };

  return {
    ok: false,
    method: cfpay ? "a2a" : "direct",
    error: directRes.error || "Slack delivery failed on all channels",
  };
}
